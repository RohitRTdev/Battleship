import { randomUUID } from "node:crypto";
import type { ConnectionStatus, PlayerStateResponse } from "@battleship/game-contract";
import type { IKeyValue, IRangeResponse, Namespace } from "etcd3";
import {
  createGame,
  domainError,
  generateGameCode,
  type GameCommand,
  type GameState,
  type Player,
  type Result
} from "../../game/index.js";
import type { ArchiveJobResult, ArchiveOutbox } from "../archive-outbox.js";
import type { CommandResult, GameStore, UpdateBus } from "../game-store.js";
import { decode, encode, keys } from "./keys.js";

/** Value of players/<id>/active: the one game the player is in. */
export type ActiveGame = { gameId: string; gameCode: string };
/** Value of matchmaking/queue/<id>. */
export type QueueEntry = { username: string; enqueuedAt: string };

const CODE_ATTEMPTS = 8;

function notImplemented(operation: string): never {
  throw new Error(`etcd store: ${operation} is not implemented yet`);
}

function failed<T>(code: Parameters<typeof domainError>[0]): Result<T> {
  return { ok: false, error: domainError(code) };
}

function firstKv(response: IRangeResponse | undefined): IKeyValue | undefined {
  return response?.kvs[0];
}

/** GameStore on etcd. Operations are filled in one at a time; the rest reject. */
export class EtcdStore implements GameStore {
  constructor(
    private readonly kv: Namespace,
    private readonly timeoutEnabled: boolean
  ) {}

  /** etcd has no clock, so each node's own (NTP-synchronised) clock is the time source. */
  async currentTime(): Promise<string> {
    return new Date().toISOString();
  }

  async create(actor: Player): Promise<Result<CommandResult>> {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const command = {
        type: "CREATE_GAME" as const,
        gameId: randomUUID(),
        gameCode: generateGameCode(),
        turnTimeoutEnabled: this.timeoutEnabled,
        actor,
        occurredAt: await this.currentTime()
      };
      const created = createGame(command);
      if (!created.ok) throw new Error(created.error.code);
      const state = created.value.state;
      const active: ActiveGame = { gameId: state.gameId, gameCode: state.gameCode };

      // One transaction claims the code and the player's only active-game slot, and checks they are not searching.
      const result = await this.kv
        .if(keys.code(state.gameCode), "Create", "==", 0)
        .and(keys.activeGame(actor.id), "Create", "==", 0)
        .and(keys.queueEntry(actor.id), "Create", "==", 0)
        .then(
          this.kv.put(keys.game(state.gameId)).value(encode(state)),
          this.kv.put(keys.code(state.gameCode)).value(state.gameId),
          this.kv.put(keys.activeGame(actor.id)).value(encode(active))
        )
        .else(this.kv.get(keys.queueEntry(actor.id)), this.kv.get(keys.activeGame(actor.id)))
        .commit();
      if (result.succeeded) return { ok: true, value: { state, outcome: created.value.outcome } };

      const [searching, playing] = result.responses.map((response) => firstKv(response.response_range));
      if (searching) return failed("PLAYER_ALREADY_SEARCHING");
      if (playing) return failed("PLAYER_ALREADY_PLAYING");
      // Otherwise the generated code was taken; try another.
    }
    throw new Error("Could not allocate a unique game code");
  }

  async command(
    _gameCode: string,
    _actor: Player,
    _buildCommand: (state: GameState, occurredAt: string) => GameCommand
  ): Promise<Result<CommandResult>> {
    return notImplemented("command");
  }

  async getState(gameCode: string): Promise<Result<GameState>> {
    const game = await this.readGame(gameCode);
    return game ? { ok: true, value: game.state } : failed("GAME_NOT_FOUND");
  }

  async getPlayerState(playerId: string): Promise<PlayerStateResponse> {
    const active = await this.kv.get(keys.activeGame(playerId)).exec();
    const revision = active.header.revision;
    const activeKv = firstKv(active);
    if (activeKv) {
      const { gameId, gameCode } = decode<ActiveGame>(activeKv.value);
      // Read the game at the same revision so both keys come from one consistent snapshot.
      const game = await this.kv.get(keys.game(gameId)).revision(revision).string();
      if (game) return { state: "PLAYING", gameCode, gameStatus: decode<GameState>(game).status };
    }
    const queued = await this.kv.get(keys.queueEntry(playerId)).revision(revision).string();
    if (queued) return { state: "SEARCHING", searchStartedAt: decode<QueueEntry>(queued).enqueuedAt };
    return { state: "NOT_PLAYING" };
  }

  /** Reads a game by code, with the revision its key was last modified at (for compare-and-swap). */
  private async readGame(gameCode: string): Promise<{ state: GameState; modRevision: string; revision: string } | null> {
    const code = await this.kv.get(keys.code(gameCode)).exec();
    const gameId = firstKv(code)?.value.toString();
    if (!gameId) return null;
    const game = firstKv(await this.kv.get(keys.game(gameId)).revision(code.header.revision).exec());
    if (!game) return null;
    return { state: decode<GameState>(game.value), modRevision: game.mod_revision, revision: code.header.revision };
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
