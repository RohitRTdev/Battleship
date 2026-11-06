import type { ArchiveOutbox } from "./archive-outbox.js";
import type { GameStore, UpdateBus } from "./game-store.js";

export type StoreOptions = { timeoutEnabled: boolean };

/** Everything the store provides, plus its lifecycle. */
export type StoreBackend = {
  store: GameStore;
  updates: UpdateBus;
  outbox: ArchiveOutbox;
  /** Connects and prepares storage, retrying until it succeeds. */
  start(): Promise<void>;
  /** Last known readiness, without doing I/O. */
  isReady(): boolean;
  /** Probes the storage and updates readiness. */
  checkHealth(): Promise<boolean>;
  /** True if `error` means the storage is unreachable, so the request should get a 503. */
  isUnavailableError(error: unknown): boolean;
  close(): Promise<void>;
};

export type { ArchiveJobResult, ArchiveOutbox } from "./archive-outbox.js";
export type { CommandResult, GameStore, UpdateBus } from "./game-store.js";
