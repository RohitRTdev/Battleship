import type { Namespace } from "etcd3";
import type { GameState } from "../../game/index.js";
import type { ArchiveJobResult, ArchiveOutbox } from "../archive-outbox.js";
import { decode, encode, keys } from "./keys.js";
import type { EtcdUpdateBus } from "./watch-bus.js";

/** Value of archive/jobs/<gameId>, written in the transaction that finishes the game. */
export type ArchiveJob = { snapshot: GameState; attempts: number; availableAt: string; lastError?: string };

/** How long a claim survives if the node holding it stops renewing it (for example because it crashed). */
const CLAIM_TTL_SECONDS = 30;
const SCAN_LIMIT = 100;

/**
 * Archive jobs as etcd keys. A job is held exclusively through a claim key bound to a lease: the lease is kept
 * alive while this node works on the job, and expires (freeing the job) if the node dies.
 */
export class EtcdArchiveOutbox implements ArchiveOutbox {
  constructor(
    private readonly kv: Namespace,
    private readonly updates: EtcdUpdateBus
  ) {}

  async processNext(archive: (snapshot: GameState) => Promise<void>): Promise<ArchiveJobResult> {
    const { kvs } = await this.kv.getAll().prefix(keys.archivePrefix).sort("Create", "Ascend").limit(SCAN_LIMIT).exec();
    for (const entry of kvs) {
      const job = decode<ArchiveJob>(entry.value);
      if (Date.parse(job.availableAt) > Date.now()) continue;
      const rawKey = entry.key.toString();
      const gameId = rawKey.slice(rawKey.indexOf(keys.archivePrefix) + keys.archivePrefix.length);

      const lease = this.kv.lease(CLAIM_TTL_SECONDS);
      try {
        const claim = await this.kv
          .if(keys.archiveJob(gameId), "Mod", "==", entry.mod_revision)
          .and(keys.archiveClaim(gameId), "Create", "==", 0)
          .then(this.kv.put(keys.archiveClaim(gameId)).value("").lease(lease.grant()))
          .commit();
        if (!claim.succeeded) continue;
        try {
          await archive(job.snapshot);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
          const retry: ArchiveJob = {
            ...job,
            attempts: job.attempts + 1,
            availableAt: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
            lastError: message.slice(0, 2_000)
          };
          await this.kv.put(keys.archiveJob(gameId)).value(encode(retry));
          return { kind: "failed", gameId, retryInMs: delaySeconds * 1_000, error };
        }
        await this.kv.delete().key(keys.archiveJob(gameId));
        return { kind: "archived", gameId };
      } finally {
        // Revoking the lease also deletes the claim key.
        await lease.revoke().catch(() => undefined);
      }
    }
    return { kind: "empty" };
  }

  onJob(listener: () => void): void {
    this.updates.onArchive(listener);
  }

  offJob(listener: () => void): void {
    this.updates.offArchive(listener);
  }
}
