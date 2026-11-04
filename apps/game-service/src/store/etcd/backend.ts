import { Etcd3 } from "etcd3";
import type { StoreBackend, StoreOptions } from "../index.js";
import { isEtcdUnavailable } from "./errors.js";
import { EtcdArchiveOutbox } from "./archive-outbox.js";
import { EtcdStore, type DataCluster } from "./etcd-store.js";
import { EtcdUpdateBus } from "./watch-bus.js";
import { CONTROL_NAMESPACE, controlKeys, dataKeys, dataNamespace } from "./keys.js";

const CALL_TIMEOUT_MS = 2_000;

export function createEtcdBackend(options: StoreOptions): StoreBackend {
  const endpoints = (process.env.ETCD_ENDPOINTS ?? "").split(",").map((endpoint) => endpoint.trim()).filter(Boolean);
  if (endpoints.length === 0) throw new Error("ETCD_ENDPOINTS is required, e.g. etcd-1:2379,etcd-2:2379,etcd-3:2379");

  const client = new Etcd3({
    hosts: endpoints,
    dialTimeout: CALL_TIMEOUT_MS,
    // Deadlines fail fast when etcd is unreachable, but must not apply to long-lived streams (watches, lease
    // keep-alives), which would otherwise be cut and re-established every CALL_TIMEOUT_MS.
    defaultCallOptions: (context) => (context.isStream ? {} : { deadline: Date.now() + CALL_TIMEOUT_MS })
  });
  // One etcd cluster serves as both the control plane and the single data cluster, under separate namespaces.
  const control = client.namespace(CONTROL_NAMESPACE);
  const clusters: DataCluster[] = [{ id: "main", kv: client.namespace(dataNamespace("main")) }];
  const updates = new EtcdUpdateBus(control, clusters);
  let ready = false;

  // A linearizable read needs a quorum, so it fails while a cluster has no leader.
  async function probe(): Promise<void> {
    await control.get(controlKeys.health).string();
    await Promise.all(clusters.map((cluster) => cluster.kv.get(dataKeys.health).string()));
  }

  return {
    store: new EtcdStore(control, clusters, options.timeoutEnabled),
    updates,
    outbox: new EtcdArchiveOutbox(clusters, updates),

    async start() {
      while (true) {
        try {
          await probe();
          await updates.start();
          ready = true;
          return;
        } catch (error) {
          ready = false;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`etcd initialization failed; retrying in 1 second: ${message}`);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    },

    isReady: () => ready,

    async checkHealth() {
      try {
        await probe();
        ready = true;
      } catch {
        ready = false;
      }
      return ready;
    },

    isUnavailableError: isEtcdUnavailable,

    async close() {
      ready = false;
      await updates.close().catch(() => undefined);
      client.close();
    }
  };
}
