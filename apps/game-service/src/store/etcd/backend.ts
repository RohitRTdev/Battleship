import { Etcd3 } from "etcd3";
import type { StoreBackend, StoreOptions } from "../index.js";
import { isEtcdUnavailable } from "./errors.js";
import { EtcdArchiveOutbox } from "./archive-outbox.js";
import { ClusterSet, readRegistry, registerIfAbsent } from "./clusters.js";
import { EtcdStore } from "./etcd-store.js";
import { EtcdUpdateBus } from "./watch-bus.js";
import { CONTROL_NAMESPACE, controlKeys, dataKeys } from "./keys.js";

const CALL_TIMEOUT_MS = 2_000;
const REACHABILITY_INTERVAL_MS = 2_000;

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
  let reachabilityTimer: NodeJS.Timeout | null = null;

  // A linearizable read needs a quorum, so it fails while a cluster has no leader. A node's health depends on the
  // control plane alone: a data cluster that is down only affects its own games, so it must not take every node
  // out of service. Data clusters are probed separately, so new games are placed on ones that answer.
  async function probe(): Promise<void> {
    await control.get(controlKeys.health).string();
  }

  async function probeDataClusters(): Promise<void> {
    await Promise.all(clusters.list().map(async (cluster) => {
      const reachable = await cluster.kv.get(dataKeys.health).string().then(() => true, () => false);
      if (reachable !== cluster.reachable) console.warn(`etcd data cluster ${cluster.id} is ${reachable ? "reachable again" : "unreachable"}`);
      cluster.reachable = reachable;
    }));
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
          await probeDataClusters();
          await updates.start();
          reachabilityTimer ??= setInterval(() => void probeDataClusters(), REACHABILITY_INTERVAL_MS).unref();
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
      if (reachabilityTimer) clearInterval(reachabilityTimer);
      await updates.close().catch(() => undefined);
      await clusters.close();
      client.close();
    }
  };
}
