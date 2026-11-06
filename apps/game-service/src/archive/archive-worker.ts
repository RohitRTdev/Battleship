import type { ArchiveOutbox } from "../store/archive-outbox.js";
import type { MatchArchive } from "./match-archive.js";

export class ArchiveWorker {
  private running = false;
  private rerun = false;
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  private readonly onArchive = () => this.wake();

  constructor(
    private readonly outbox: ArchiveOutbox,
    private readonly archive: MatchArchive
  ) {}

  start(): void {
    this.closed = false;
    this.outbox.onJob(this.onArchive);
    this.safetyTimer = setInterval(() => this.wake(), 30_000);
    this.wake();
  }

  wake(): void {
    if (this.closed) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.drain().catch((error) => {
      console.error("Unexpected match archive worker error", error);
      this.scheduleRetry(1_000);
    });
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
    try {
      const result = await this.outbox.processNext((snapshot) => this.archive.archiveMatch(snapshot));
      if (result.kind === "empty") return false;
      if (result.kind === "failed") {
        console.error(`Match archive job ${result.gameId} failed; retrying in ${result.retryInMs / 1_000}s`, result.error);
        this.scheduleRetry(result.retryInMs);
      }
      return true;
    } catch (error) {
      console.error("Match archive worker store error", error);
      this.scheduleRetry(1_000);
      return false;
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
    this.outbox.offJob(this.onArchive);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.retryTimer = null;
    this.safetyTimer = null;
  }
}
