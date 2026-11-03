import type { ConnectionStatus, PlayerStateResponse } from "@battleship/game-contract";
import type { Namespace } from "etcd3";
import type { GameCommand, GameState, Player, Result } from "../../game/index.js";
import type { ArchiveJobResult, ArchiveOutbox } from "../archive-outbox.js";
import type { CommandResult, GameStore, UpdateBus } from "../game-store.js";

function notImplemented(operation: string): never {
  throw new Error(`etcd store: ${operation} is not implemented yet`);
}

/** GameStore on etcd. Operations are filled in one at a time; the rest reject. */
export class EtcdStore implements GameStore {
  constructor(
    private readonly kv: Namespace,
    private readonly timeoutEnabled: boolean
  ) {}

  async currentTime(): Promise<string> {
    return notImplemented("currentTime");
  }

  async create(_actor: Player): Promise<Result<CommandResult>> {
    return notImplemented("create");
  }

  async command(
    _gameCode: string,
    _actor: Player,
    _buildCommand: (state: GameState, occurredAt: string) => GameCommand
  ): Promise<Result<CommandResult>> {
    return notImplemented("command");
  }

  async getState(_gameCode: string): Promise<Result<GameState>> {
    return notImplemented("getState");
  }

  async getPlayerState(_playerId: string): Promise<PlayerStateResponse> {
    return notImplemented("getPlayerState");
  }

  async startMatchmaking(_actor: Player): Promise<Result<PlayerStateResponse>> {
    return notImplemented("startMatchmaking");
  }

  async cancelMatchmaking(_playerId: string): Promise<PlayerStateResponse> {
    return notImplemented("cancelMatchmaking");
  }

  async touchPresence(_gameId: string, _playerId: string): Promise<void> {
    return notImplemented("touchPresence");
  }

  async presence(_gameId: string, _state: GameState): Promise<Record<string, ConnectionStatus>> {
    return notImplemented("presence");
  }

  /** No game can have a deadline until create is implemented, so nothing is ever due yet. */
  async expireOneTurn(): Promise<boolean> {
    void this.kv;
    void this.timeoutEnabled;
    return false;
  }
}

/** Placeholder until the watch-based bus: listeners are never woken, so long-polls fall back to their timeout. */
export class EtcdUpdateBus implements UpdateBus {
  on(): void {}
  off(): void {}
  onPlayer(): void {}
  offPlayer(): void {}
}

/** Placeholder until archive jobs are written to etcd: there are never any jobs. */
export class EtcdArchiveOutbox implements ArchiveOutbox {
  async processNext(): Promise<ArchiveJobResult> {
    return { kind: "empty" };
  }
  onJob(): void {}
  offJob(): void {}
}
