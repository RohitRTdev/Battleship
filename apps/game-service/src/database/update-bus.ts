import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import type { UpdateBus } from "../store/game-store.js";

type UpdatePayload = { gameId: string; version: number };
type PlayerUpdatePayload = { playerId: string };
type ArchiveUpdatePayload = { gameId: string };

export class GameUpdateBus implements UpdateBus {
  private readonly events = new EventEmitter();
  private listener: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly pool: Pool) {
    this.events.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const listener = await this.pool.connect();
    this.listener = listener;
    listener.on("notification", (message) => {
      if (!message.payload) return;
      try {
        if (message.channel === "game_updates") {
          const payload = JSON.parse(message.payload) as UpdatePayload;
          if (typeof payload.gameId === "string" && Number.isInteger(payload.version)) {
            this.events.emit(`game:${payload.gameId}`, payload.version);
          }
        } else if (message.channel === "player_state_updates") {
          const payload = JSON.parse(message.payload) as PlayerUpdatePayload;
          if (typeof payload.playerId === "string") this.events.emit(`player:${payload.playerId}`);
        } else if (message.channel === "match_archive_jobs") {
          const payload = JSON.parse(message.payload) as ArchiveUpdatePayload;
          if (typeof payload.gameId === "string") this.events.emit("archive", payload.gameId);
        }
      } catch {
        console.error(`Ignored malformed ${message.channel} notification`);
      }
    });
    listener.on("error", (error) => {
      console.error("PostgreSQL notification connection error", error);
      if (this.listener === listener) this.listener = null;
      listener.release(true);
      this.scheduleReconnect();
    });
    try {
      await listener.query("LISTEN game_updates");
      await listener.query("LISTEN player_state_updates");
      await listener.query("LISTEN match_archive_jobs");
      this.events.emit("archive");
    } catch (error) {
      if (this.listener === listener) this.listener = null;
      listener.release(true);
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        console.error("Could not restore PostgreSQL notification connection", error);
        this.scheduleReconnect();
      });
    }, 1_000);
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

  onArchive(listener: (gameId?: string) => void): void {
    this.events.on("archive", listener);
  }

  offArchive(listener: (gameId?: string) => void): void {
    this.events.off("archive", listener);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.listener?.release();
    this.listener = null;
  }
}
