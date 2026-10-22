import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";

type UpdatePayload = { gameId: string; version: number };

export class GameUpdateBus {
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
        const payload = JSON.parse(message.payload) as UpdatePayload;
        if (typeof payload.gameId === "string" && Number.isInteger(payload.version)) {
          this.events.emit(payload.gameId, payload.version);
        }
      } catch {
        console.error("Ignored malformed game_updates notification");
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
    this.events.on(gameId, listener);
  }

  off(gameId: string, listener: (version: number) => void): void {
    this.events.off(gameId, listener);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.listener?.release();
    this.listener = null;
  }
}
