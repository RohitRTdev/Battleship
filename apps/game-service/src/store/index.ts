import type { ArchiveOutbox } from "./archive-outbox.js";
import type { GameStore, UpdateBus } from "./game-store.js";
import { createPostgresBackend } from "./postgres/backend.js";

export type StoreOptions = { timeoutEnabled: boolean };

/** Everything one storage mode provides, plus its lifecycle. */
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
  close(): Promise<void>;
};

export const STORE_MODES = ["postgres"] as const;
export type StoreMode = (typeof STORE_MODES)[number];

export function createStoreBackend(mode: string, options: StoreOptions): StoreBackend {
  switch (mode as StoreMode) {
    case "postgres":
      return createPostgresBackend(options);
    default:
      throw new Error(`STORE_MODE must be one of: ${STORE_MODES.join(", ")}`);
  }
}

export type { ArchiveJobResult, ArchiveOutbox } from "./archive-outbox.js";
export type { CommandResult, GameStore, UpdateBus } from "./game-store.js";
