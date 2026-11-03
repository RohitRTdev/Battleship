import type { Pool } from "pg";
import type { GameState } from "../../game/index.js";
import type { ArchiveJobResult, ArchiveOutbox } from "../archive-outbox.js";
import type { GameUpdateBus } from "./update-bus.js";

type ArchiveJobRow = { game_id: string; snapshot: GameState; attempts: number };

/** Archive jobs in the match_archive_jobs table; the row lock is held while the job is processed. */
export class PostgresArchiveOutbox implements ArchiveOutbox {
  constructor(
    private readonly pool: Pool,
    private readonly updates: GameUpdateBus
  ) {}

  async processNext(archive: (snapshot: GameState) => Promise<void>): Promise<ArchiveJobResult> {
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
        return { kind: "empty" };
      }
      try {
        await archive(job.snapshot);
        await client.query("DELETE FROM match_archive_jobs WHERE game_id = $1", [job.game_id]);
        await client.query("COMMIT");
        return { kind: "archived", gameId: job.game_id };
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
        return { kind: "failed", gameId: job.game_id, retryInMs: delaySeconds * 1_000, error };
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  onJob(listener: () => void): void {
    this.updates.onArchive(listener);
  }

  offJob(listener: () => void): void {
    this.updates.offArchive(listener);
  }
}
