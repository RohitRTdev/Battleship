import type { GameState } from "../game/index.js";

export type ArchiveJobResult =
  | { kind: "empty" }
  | { kind: "archived"; gameId: string }
  | { kind: "failed"; gameId: string; retryInMs: number; error: unknown };

/** Durable queue of finished games waiting to be written to the match archive. */
export interface ArchiveOutbox {
  /**
   * Runs `archive` on the next due job while holding it exclusively, so no other node processes it
   * concurrently. The job is removed if `archive` succeeds and rescheduled with backoff if it throws.
   * Rejects only if the store itself fails.
   */
  processNext(archive: (snapshot: GameState) => Promise<void>): Promise<ArchiveJobResult>;
  /** Registers a listener woken when a new job may be available. */
  onJob(listener: () => void): void;
  offJob(listener: () => void): void;
}
