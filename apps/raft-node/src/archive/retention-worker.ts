import type { Pool } from "pg";
import type { MatchArchive } from "./match-archive.js";

const INTERVAL_MS = 12 * 60 * 60 * 1_000;
const S3_RETENTION_LOCK = 1_947_452_304;
const BATCH_SIZE = 100;

export class RetentionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;

  constructor(private readonly pool: Pool, private readonly archive: MatchArchive) {}

  start(): void {
    if (this.timer) return;
    this.closed = false;
    this.wake();
    this.timer = setInterval(() => this.wake(), INTERVAL_MS);
  }

  private wake(): void {
    if (this.closed || this.running) return;
    this.running = true;
    void this.run().catch((error) => console.error("Retention cleanup failed", error))
      .finally(() => { this.running = false; });
  }

  private async run(): Promise<void> {
    // Each DELETE is atomic and holds row locks only for a single small batch.
    while (!this.closed) {
      const result = await this.pool.query(`
        WITH expired AS (
          SELECT id FROM games
          WHERE status = 'FINISHED' AND ended_at <= clock_timestamp() - interval '7 days'
          ORDER BY ended_at LIMIT $1 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM games WHERE id IN (SELECT id FROM expired)
      `, [BATCH_SIZE]);
      if ((result.rowCount ?? 0) < BATCH_SIZE) break;
    }
    if (this.closed || !this.archive.deleteExpired) return;
    const client = await this.pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean; now: Date }>(
        "SELECT pg_try_advisory_lock($1) AS locked, clock_timestamp() AS now", [S3_RETENTION_LOCK]
      );
      locked = result.rows[0].locked;
      if (locked) await this.archive.deleteExpired(result.rows[0].now.getTime());
    } finally {
      if (locked) {
        try { await client.query("SELECT pg_advisory_unlock($1)", [S3_RETENTION_LOCK]); }
        catch (error) { client.release(true); throw error; }
      }
      client.release();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
