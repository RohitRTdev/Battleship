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
 * per key prefix. Plays the role LISTEN/NOTIFY plays for Postgres.
 */
export class EtcdUpdateBus implements UpdateBus {
  private readonly events = new EventEmitter();
  private watchers: Watcher[] = [];
  private readonly clusterWatchers = new Map<string, Watcher[]>();

  constructor(
    private readonly control: Namespace,
    private readonly clusters: ClusterSet
  ) {
    this.events.setMaxListeners(0);
  }

  async start(): Promise<void> {
    // A player's state changes when their claim or queue entry on the control plane is written or removed.
    for (const prefix of [controlKeys.playerPrefix, controlKeys.queuePrefix]) {
      const players = await this.watch(this.control, prefix);
      const wake = (kv: IKeyValue) => this.events.emit(`player:${after(prefix, kv).split("/")[0]}`);
      players.on("put", wake).on("delete", wake);
    }
    // Games and their archive jobs live on the data clusters, including any registered later.
    for (const cluster of this.clusters.list()) await this.watchCluster(cluster);
    this.clusters.onAdded((cluster) => void this.watchCluster(cluster).catch((error) => console.error(`etcd watch on cluster ${cluster.id} failed`, error)));
    this.clusters.onRemoved((cluster) => {
      for (const watcher of this.clusterWatchers.get(cluster.id) ?? []) void watcher.cancel().catch(() => undefined);
      this.clusterWatchers.delete(cluster.id);
    });
  }

  private async watchCluster(cluster: DataCluster): Promise<void> {
    const games = await this.watch(cluster.kv, dataKeys.gamePrefix);
    games.on("put", (kv) => this.events.emit(`game:${after(dataKeys.gamePrefix, kv).split("/")[0]}`));
    const jobs = await this.watch(cluster.kv, dataKeys.archivePrefix);
    jobs.on("put", (kv) => this.events.emit("archive", after(dataKeys.archivePrefix, kv)));
    this.clusterWatchers.set(cluster.id, [games, jobs]);
    // A new cluster may already hold archive jobs; let the worker look.
    this.events.emit("archive");
  }

  private async watch(kv: Namespace, prefix: string): Promise<Watcher> {
    const watcher = await kv.watch().prefix(prefix).create();
    // After a dropped watch, events may have been missed; waking everyone makes them re-read current state.
    watcher.on("disconnected", () => watcher.once("connected", () => this.wakeAll()));
    watcher.on("error", (error) => console.error(`etcd watch on ${prefix} failed`, error));
    this.watchers.push(watcher);
    return watcher;
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
    await Promise.all(this.watchers.map((watcher) => watcher.cancel().catch(() => undefined)));
    this.watchers = [];
    this.clusterWatchers.clear();
  }
}
