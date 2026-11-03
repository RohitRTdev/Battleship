import { Etcd3 } from "etcd3";
import type { StoreBackend, StoreOptions } from "../index.js";
import { isEtcdUnavailable } from "./errors.js";
import { EtcdArchiveOutbox, EtcdStore, EtcdUpdateBus } from "./etcd-store.js";
import { keys, NAMESPACE } from "./keys.js";

const CALL_TIMEOUT_MS = 2_000;

export function createEtcdBackend(options: StoreOptions): StoreBackend {
  const endpoints = (process.env.ETCD_ENDPOINTS ?? "").split(",").map((endpoint) => endpoint.trim()).filter(Boolean);
  if (endpoints.length === 0) throw new Error("ETCD_ENDPOINTS is required, e.g. etcd-1:2379,etcd-2:2379,etcd-3:2379");

  const client = new Etcd3({
    hosts: endpoints,
    dialTimeout: CALL_TIMEOUT_MS,
    defaultCallOptions: () => ({ deadline: Date.now() + CALL_TIMEOUT_MS })
  });
  const kv = client.namespace(NAMESPACE);
  let ready = false;

  // A linearizable read needs a quorum, so it fails while the cluster has no leader.
  async function probe(): Promise<void> {
    await kv.get(keys.health).string();
  }

  return {
    store: new EtcdStore(kv, options.timeoutEnabled),
    updates: new EtcdUpdateBus(),
    outbox: new EtcdArchiveOutbox(),

    async start() {
      while (true) {
        try {
          await probe();
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
      client.close();
    }
  };
}
