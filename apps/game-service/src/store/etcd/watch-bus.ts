import { EventEmitter } from "node:events";
import type { IKeyValue, Namespace, Watcher } from "etcd3";
import type { GameState } from "../../game/index.js";
import type { UpdateBus } from "../game-store.js";
import { decode, keys } from "./keys.js";

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

  constructor(private readonly kv: Namespace) {
    this.events.setMaxListeners(0);
  }

  async start(): Promise<void> {
    const games = await this.watch(keys.gamePrefix);
    games.on("put", (kv) => {
      this.events.emit(`game:${after(keys.gamePrefix, kv).split("/")[0]}`, decode<GameState>(kv.value).version);
    });
    // A player's state changes when their active game or queue entry is written or removed.
    for (const prefix of [keys.playerPrefix, keys.queuePrefix]) {
      const players = await this.watch(prefix);
      const wake = (kv: IKeyValue) => this.events.emit(`player:${after(prefix, kv).split("/")[0]}`);
      players.on("put", wake).on("delete", wake);
    }
    const jobs = await this.watch(keys.archivePrefix);
    jobs.on("put", (kv) => this.events.emit("archive", after(keys.archivePrefix, kv)));
  }

  private async watch(prefix: string): Promise<Watcher> {
    const watcher = await this.kv.watch().prefix(prefix).create();
    // After a dropped watch, events may have been missed; waking everyone makes them re-read current state.
    watcher.on("disconnected", () => watcher.once("connected", () => this.wakeAll()));
    watcher.on("error", (error) => console.error(`etcd watch on ${prefix} failed`, error));
    this.watchers.push(watcher);
    return watcher;
  }

  private wakeAll(): void {
    for (const event of this.events.eventNames()) {
      // The version is unknown here; listeners re-read the game anyway.
      if (typeof event === "string" && event.startsWith("game:")) this.events.emit(event, Number.MAX_SAFE_INTEGER);
      else this.events.emit(event);
    }
  }

  on(gameId: string, listener: (version: number) => void): void {
    this.events.on(`game:${gameId}`, listener);
  }

  off(gameId: string, listener: (version: number) => void): void {
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
    await Promise.all(this.watchers.map((watcher) => watcher.cancel()));
    this.watchers = [];
  }
}
