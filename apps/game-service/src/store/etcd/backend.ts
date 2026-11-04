import { Etcd3 } from "etcd3";
import type { StoreBackend, StoreOptions } from "../index.js";
import { isEtcdUnavailable } from "./errors.js";
import { EtcdArchiveOutbox } from "./archive-outbox.js";
import { ClusterSet, readRegistry, registerIfAbsent } from "./clusters.js";
import { EtcdStore } from "./etcd-store.js";
import { EtcdUpdateBus } from "./watch-bus.js";
import { CONTROL_NAMESPACE, controlKeys, dataKeys } from "./keys.js";

const CALL_TIMEOUT_MS = 2_000;

function hosts(list: string): string[] {
  return list.split(",").map((endpoint) => endpoint.trim()).filter(Boolean);
}

function connect(endpoints: string[]): Etcd3 {
  return new Etcd3({
    hosts: endpoints,
    dialTimeout: CALL_TIMEOUT_MS,
    // Deadlines fail fast when etcd is unreachable, but must not apply to long-lived streams (watches, lease
    // keep-alives), which would otherwise be cut and re-established every CALL_TIMEOUT_MS.
    defaultCallOptions: (context) => (context.isStream ? {} : { deadline: Date.now() + CALL_TIMEOUT_MS })
  });
}

/**
 * ETCD_ENDPOINTS is the control-plane cluster. The data clusters are registered on it (see clusters.ts) and followed
 * live. The first node to start against an empty registry seeds it from ETCD_DATA_CLUSTERS
 * (`id=host:port,host:port;id=...`), or, if that is unset, with one cluster "main" on the control-plane cluster.
 * After that the registry is authoritative: change it with `npm run clusters`.
 */
export function createEtcdBackend(options: StoreOptions): StoreBackend {
  const endpoints = hosts(process.env.ETCD_ENDPOINTS ?? "");
  if (endpoints.length === 0) throw new Error("ETCD_ENDPOINTS is required, e.g. etcd-1:2379,etcd-2:2379,etcd-3:2379");
  const client = connect(endpoints);
  const control = client.namespace(CONTROL_NAMESPACE);

  const declared: Array<[string, string[]]> = (process.env.ETCD_DATA_CLUSTERS ?? "").split(";").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => {
      const [id, list] = entry.split("=");
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || hosts(list ?? "").length === 0) {
        throw new Error(`ETCD_DATA_CLUSTERS entry "${entry}" must look like id=host:port,host:port`);
      }
      return [id, hosts(list)];
    });
  if (new Set(declared.map(([id]) => id)).size !== declared.length) throw new Error("ETCD_DATA_CLUSTERS ids must be unique");
  const seed: Array<[string, string[]]> = declared.length > 0 ? declared : [["main", endpoints]];

  const clusters = new ClusterSet(connect);
  const updates = new EtcdUpdateBus(control, clusters);
  let ready = false;
  let following = false;

  // A linearizable read needs a quorum, so it fails while a cluster has no leader.
  async function probe(): Promise<void> {
    await control.get(controlKeys.health).string();
    await Promise.all(clusters.list().map((cluster) => cluster.kv.get(dataKeys.health).string()));
  }

  return {
    store: new EtcdStore(control, clusters, options.timeoutEnabled),
    updates,
    outbox: new EtcdArchiveOutbox(clusters, updates),

    async start() {
      while (true) {
        try {
          await control.get(controlKeys.health).string();
          if (!following) {
            if ((await readRegistry(control)).size === 0) await registerIfAbsent(control, seed);
            await clusters.follow(control);
            following = true;
          }
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
      await clusters.close();
      client.close();
    }
  };
}
