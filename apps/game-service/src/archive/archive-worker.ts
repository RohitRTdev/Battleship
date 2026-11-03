import type { Pool } from "pg";
import type { GameState } from "../game/index.js";
import type { GameUpdateBus } from "../store/postgres/update-bus.js";
import type { MatchArchive } from "./match-archive.js";

type ArchiveJobRow = { game_id: string; snapshot: GameState; attempts: number };

export class ArchiveWorker {
  private running = false;
  private rerun = false;
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  private readonly onArchive = () => this.wake();

  constructor(
    private readonly pool: Pool,
    private readonly archive: MatchArchive,
    private readonly updates: GameUpdateBus
  ) {}

  start(): void {
    this.closed = false;
    this.updates.onArchive(this.onArchive);
    this.safetyTimer = setInterval(() => this.wake(), 30_000);
    this.wake();
  }

  wake(): void {
    if (this.closed) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      do {
        this.rerun = false;
        while (!this.closed && await this.processOne()) {
          // Keep draining jobs that were already durable before this wake-up.
        }
      } while (!this.closed && this.rerun);
    } finally {
      this.running = false;
      if (!this.closed && this.rerun) this.wake();
    }
  }

  private async processOne(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ArchiveJobRow>(
        `SELECT game_id, snapshot, attempts
         FROM match_archive_jobs
         WHERE available_at <= clock_timestamp()
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );
      const job = result.rows[0];
      if (!job) {
        await client.query("COMMIT");
        return false;
      }
      try {
        await this.archive.archiveMatch(job.snapshot);
        await client.query("DELETE FROM match_archive_jobs WHERE game_id = $1", [job.game_id]);
        await client.query("COMMIT");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
        await client.query(
          `UPDATE match_archive_jobs
           SET attempts = attempts + 1,
               available_at = clock_timestamp() + ($2 * interval '1 second'),
               last_error = $3
           WHERE game_id = $1`,
          [job.game_id, delaySeconds, message.slice(0, 2_000)]
        );
        await client.query("COMMIT");
        console.error(`Match archive job ${job.game_id} failed; retrying in ${delaySeconds}s`, error);
        this.scheduleRetry(delaySeconds * 1_000);
        return true;
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Match archive worker database error", error);
      this.scheduleRetry(1_000);
      return false;
    } finally {
      client.release();
    }
  }

  private scheduleRetry(milliseconds: number): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.wake();
    }, milliseconds);
  }

  close(): void {
    this.closed = true;
    this.updates.offArchive(this.onArchive);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.retryTimer = null;
    this.safetyTimer = null;
  }
}
