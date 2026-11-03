import { Pool } from "pg";
import type { StoreBackend, StoreOptions } from "../index.js";
import { PostgresArchiveOutbox } from "./archive-outbox.js";
import { GameRepository } from "./game-repository.js";
import { runMigrations } from "./migrations.js";
import { GameUpdateBus } from "./update-bus.js";

export function createPostgresBackend(options: StoreOptions): StoreBackend {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !(process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE)) {
    throw new Error("DATABASE_URL or PostgreSQL PG* environment variables are required");
  }

  let ready = false;
  const pool = new Pool({
    ...(databaseUrl ? { connectionString: databaseUrl } : {}),
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000
  });
  pool.on("error", (error) => {
    ready = false;
    console.error("PostgreSQL pool error", error);
  });

  const updates = new GameUpdateBus(pool);

  return {
    store: new GameRepository(pool, options.timeoutEnabled),
    updates,
    outbox: new PostgresArchiveOutbox(pool, updates),

    async start() {
      while (true) {
        try {
          await pool.query("SELECT 1");
          const migrationClient = await pool.connect();
          try {
            await runMigrations(migrationClient);
          } finally {
            migrationClient.release();
          }
          await updates.start();
          ready = true;
          return;
        } catch (error) {
          ready = false;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`PostgreSQL initialization failed; retrying in 1 second: ${message}`);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    },

    isReady: () => ready,

    async checkHealth() {
      try {
        await pool.query("SELECT 1");
        ready = true;
      } catch {
        ready = false;
      }
      return ready;
    },

    isUnavailableError(error) {
      // SQLSTATE codes are five characters; ECONN* are connection failures.
      const code = (error as { code?: unknown }).code;
      return typeof code === "string" && (/^\d{5}$/.test(code) || code.startsWith("ECONN"));
    },

    async close() {
      ready = false;
      updates.close();
      await pool.end();
    }
  };
}
