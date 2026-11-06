import { EventEmitter } from "node:events";
import type { IKeyValue, Namespace, Watcher } from "etcd3";
import type { UpdateBus } from "../game-store.js";
import type { ClusterSet, DataCluster } from "./clusters.js";
import { controlKeys, dataKeys } from "./keys.js";

/** The part of a raw etcd key after `prefix` (raw keys still carry the client's namespace). */
function after(prefix: string, kv: IKeyValue): string {
  const key = kv.key.toString();
  return key.slice(key.indexOf(prefix) + prefix.length);
}

/**
 * Wakes waiting long-polls on this node when a game or a player's state changes on any node, using one etcd watch
 * per key prefix.
 */
/** How long start() waits for the data-cluster watches before going ahead without the slow ones. */
const CLUSTER_WATCH_WAIT_MS = 2_000;

export class EtcdUpdateBus implements UpdateBus {
  private readonly events = new EventEmitter();
  private watchers: Watcher[] = [];
  private readonly clusterWatchers = new Map<string, Watcher[]>();
  /** Set once start() returns; from then on, a cluster watch that connects late may have missed changes. */
  private live = false;
  private closed = false;

  constructor(
    private readonly control: Namespace,
    private readonly clusters: ClusterSet
  ) {
    this.events.setMaxListeners(0);
  }

  async start(): Promise<void> {
    // A player's state changes when their claim or queue entry on the control plane is written or removed.
    for (const prefix of [controlKeys.playerPrefix, controlKeys.queuePrefix]) {
      const players = this.watch(this.control, prefix);
      const wake = (kv: IKeyValue) => this.events.emit(`player:${after(prefix, kv).split("/")[0]}`);
      players.watcher.on("put", wake).on("delete", wake);
      await players.connected;
    }
    // Games and their archive jobs live on the data clusters, including any registered later. A data cluster that
    // is down must not keep this node from starting, so these watches are waited for only briefly.
    const watchCluster = (cluster: DataCluster) =>
      this.watchCluster(cluster).catch((error) => console.error(`etcd watch on cluster ${cluster.id} failed`, error));
    const pending = Promise.all(this.clusters.list().map(watchCluster));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, CLUSTER_WATCH_WAIT_MS); })]);
    clearTimeout(timer);
    this.live = true;
    this.clusters.onAdded((cluster) => void watchCluster(cluster));
    this.clusters.onRemoved((cluster) => {
      for (const watcher of this.clusterWatchers.get(cluster.id) ?? []) void watcher.cancel().catch(() => undefined);
      this.clusterWatchers.delete(cluster.id);
    });
  }

  private async watchCluster(cluster: DataCluster): Promise<void> {
    if (this.closed) return;
    const games = this.watch(cluster.kv, dataKeys.gamePrefix);
    games.watcher.on("put", (kv) => this.events.emit(`game:${after(dataKeys.gamePrefix, kv).split("/")[0]}`));
    const jobs = this.watch(cluster.kv, dataKeys.archivePrefix);
    jobs.watcher.on("put", (kv) => this.events.emit("archive", after(dataKeys.archivePrefix, kv)));
    this.clusterWatchers.set(cluster.id, [games.watcher, jobs.watcher]);
    await Promise.all([games.connected, jobs.connected]);
    // Games may have changed while the watch was connecting, and the cluster may already hold archive jobs.
    if (this.live) this.wakeAll();
    this.events.emit("archive");
  }

  /** Starts a watch at once, so close() cancels it even while it is still connecting. */
  private watch(kv: Namespace, prefix: string): { watcher: Watcher; connected: Promise<void> } {
    const watcher = kv.watch().prefix(prefix).watcher();
    this.watchers.push(watcher);
    const connected = new Promise<void>((resolve, reject) => {
      watcher.once("connected", () => resolve());
      watcher.once("error", reject);
    });
    // After a dropped watch, events may have been missed; waking everyone makes them re-read current state.
    watcher.on("disconnected", () => watcher.once("connected", () => this.wakeAll()));
    watcher.on("error", (error) => console.error(`etcd watch on ${prefix} failed`, error));
    return { watcher, connected };
  }

  private wakeAll(): void {
    for (const event of this.events.eventNames()) this.events.emit(event);
  }

  on(gameId: string, listener: () => void): void {
    this.events.on(`game:${gameId}`, listener);
  }

  off(gameId: string, listener: () => void): void {
    this.events.off(`game:${gameId}`, listener);
  }

  onPlayer(playerId: string, listener: () => void): void {
    this.events.on(`player:${playerId}`, listener);
  }

  offPlayer(playerId: string, listener: () => void): void {
    this.events.off(`player:${playerId}`, listener);
  }

  onArchive(listener: () => void): void {
    this.events.on("archive", listener);
  }

  offArchive(listener: () => void): void {
    this.events.off("archive", listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.watchers.map((watcher) => watcher.cancel().catch(() => undefined)));
    this.watchers = [];
    this.clusterWatchers.clear();
  }
}
