import { randomUUID } from "node:crypto";
import type { ConnectionStatus, PlayerStateResponse } from "@battleship/game-contract";
import type { IKeyValue, IOperation, IRangeResponse, Namespace } from "etcd3";
import {
  applyGameCommand,
  createGame,
  domainError,
  dueTimeout,
  generateGameCode,
  lateMoveTimeout,
  TIMEOUT_GRACE_MS,
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
const COMMAND_ATTEMPTS = 50;
const MATCHMAKING_ATTEMPTS = 50;

/** Short random wait before retrying a conflicting write, so racing requests spread out. */
function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(50, 2 * attempt)));
}

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
    gameCode: string,
    actor: Player,
    buildCommand: (state: GameState, occurredAt: string) => GameCommand
  ): Promise<Result<CommandResult>> {
    for (let attempt = 0; attempt < COMMAND_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      if (await this.kv.get(keys.queueEntry(actor.id)).string()) return failed("PLAYER_ALREADY_SEARCHING");
      const game = await this.readGame(gameCode);
      if (!game) return failed("GAME_NOT_FOUND");

      const now = await this.currentTime();
      const requested = buildCommand(game.state, now);
      const late = lateMoveTimeout(game.state, requested, now);
      const command = late?.timeout ?? requested;
      const applied = applyGameCommand(game.state, command);
      if (!applied.ok) {
        if (late) throw new Error(applied.error.code);
        return applied;
      }
      const next = applied.value.state;

      // Commit only if nobody changed the game (or started this player searching) since we read it.
      let transaction = this.kv
        .if(keys.game(next.gameId), "Mod", "==", game.modRevision)
        .and(keys.queueEntry(actor.id), "Create", "==", 0);
      const writes = this.transitionWrites(game.state, next);
      if (command.type === "JOIN_GAME") {
        transaction = transaction.and(keys.activeGame(actor.id), "Create", "==", 0);
        const active: ActiveGame = { gameId: next.gameId, gameCode: next.gameCode };
        writes.push(this.kv.put(keys.activeGame(actor.id)).value(encode(active)));
      }

      const result = await transaction
        .then(...writes)
        .else(this.kv.get(keys.queueEntry(actor.id)), this.kv.get(keys.activeGame(actor.id)))
        .commit();
      if (result.succeeded) {
        return late ? failed(late.error) : { ok: true, value: { state: next, outcome: applied.value.outcome } };
      }

      const [searching, playing] = result.responses.map((response) => firstKv(response.response_range));
      if (searching) return failed("PLAYER_ALREADY_SEARCHING");
      if (command.type === "JOIN_GAME" && playing) return failed("PLAYER_ALREADY_PLAYING");
      // The game changed underneath us: retry against the new state.
    }
    throw new Error(`etcd store: too many conflicting writes to game ${gameCode}`);
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
  private async readGame(gameCode: string): Promise<{ state: GameState; modRevision: string } | null> {
    const code = await this.kv.get(keys.code(gameCode)).exec();
    const gameId = firstKv(code)?.value.toString();
    if (!gameId) return null;
    const game = firstKv(await this.kv.get(keys.game(gameId)).revision(code.header.revision).exec());
    if (!game) return null;
    return { state: decode<GameState>(game.value), modRevision: game.mod_revision };
  }

  async startMatchmaking(actor: Player): Promise<Result<PlayerStateResponse>> {
    for (let attempt = 0; attempt < MATCHMAKING_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      const current = await this.getPlayerState(actor.id);
      if (current.state === "PLAYING") return failed("PLAYER_ALREADY_PLAYING");
      if (current.state === "SEARCHING") return failed("PLAYER_ALREADY_SEARCHING");

      // Read the epoch and the head of the queue from one snapshot.
      const epoch = await this.kv.get(keys.queueEpoch).exec();
      const epochRevision = firstKv(epoch)?.mod_revision ?? "0";
      const [head] = (await this.kv.getAll().prefix(keys.queuePrefix).sort("Create", "Ascend").limit(1)
        .revision(epoch.header.revision).exec()).kvs;

      if (!head) {
        const entry: QueueEntry = { username: actor.username, enqueuedAt: await this.currentTime() };
        const queued = await this.kv
          .if(keys.queueEpoch, "Mod", "==", epochRevision)
          .and(keys.activeGame(actor.id), "Create", "==", 0)
          .and(keys.queueEntry(actor.id), "Create", "==", 0)
          .then(this.kv.put(keys.queueEpoch).value(""), this.kv.put(keys.queueEntry(actor.id)).value(encode(entry)))
          .commit();
        if (queued.succeeded) return { ok: true, value: { state: "SEARCHING", searchStartedAt: entry.enqueuedAt } };
        continue;
      }

      const rawKey = head.key.toString();
      const opponent: Player = {
        id: rawKey.slice(rawKey.indexOf(keys.queuePrefix) + keys.queuePrefix.length),
        username: decode<QueueEntry>(head.value).username
      };
      const now = await this.currentTime();
      const created = createGame({
        type: "CREATE_GAME",
        gameId: randomUUID(),
        gameCode: generateGameCode(),
        turnTimeoutEnabled: this.timeoutEnabled,
        actor: opponent,
        occurredAt: now
      });
      if (!created.ok) throw new Error(created.error.code);
      const joined = applyGameCommand(created.value.state, { type: "JOIN_GAME", actor, occurredAt: now });
      if (!joined.ok) throw new Error(joined.error.code);
      const state = joined.value.state;
      const active: ActiveGame = { gameId: state.gameId, gameCode: state.gameCode };

      // Commit only if the opponent is still waiting and neither player has entered a game meanwhile.
      const matched = await this.kv
        .if(keys.queueEntry(opponent.id), "Mod", "==", head.mod_revision)
        .and(keys.activeGame(opponent.id), "Create", "==", 0)
        .and(keys.activeGame(actor.id), "Create", "==", 0)
        .and(keys.queueEntry(actor.id), "Create", "==", 0)
        .and(keys.code(state.gameCode), "Create", "==", 0)
        .then(
          ...this.transitionWrites(created.value.state, state),
          this.kv.put(keys.code(state.gameCode)).value(state.gameId),
          this.kv.put(keys.activeGame(opponent.id)).value(encode(active)),
          this.kv.put(keys.activeGame(actor.id)).value(encode(active)),
          this.kv.delete().key(keys.queueEntry(opponent.id))
        )
        .else(this.kv.get(keys.activeGame(opponent.id)))
        .commit();
      if (matched.succeeded) return { ok: true, value: { state: "PLAYING", gameCode: state.gameCode, gameStatus: state.status } };
      if (firstKv(matched.responses[0]?.response_range)) {
        // A queued player who is already in a game would block the queue head forever; drop the stale entry.
        await this.kv.if(keys.queueEntry(opponent.id), "Mod", "==", head.mod_revision)
          .then(this.kv.delete().key(keys.queueEntry(opponent.id))).commit();
      }
    }
    throw new Error("etcd store: too many conflicting matchmaking attempts");
  }

  async cancelMatchmaking(playerId: string): Promise<PlayerStateResponse> {
    const removed = await this.kv.delete().key(keys.queueEntry(playerId)).exec();
    return Number(removed.deleted) > 0 ? { state: "NOT_PLAYING" } : this.getPlayerState(playerId);
  }

  async touchPresence(_gameId: string, _playerId: string): Promise<void> {
    return notImplemented("touchPresence");
  }

  async presence(_gameId: string, _state: GameState): Promise<Record<string, ConnectionStatus>> {
    return notImplemented("presence");
  }

  async expireOneTurn(): Promise<boolean> {
    const now = await this.currentTime();
    // Index keys sort by deadline, so the first one is the most overdue.
    const [entry] = (await this.kv.getAll().prefix(keys.deadlinePrefix).sort("Key", "Ascend").limit(1).exec()).kvs;
    if (!entry) return false;
    const raw = entry.key.toString();
    const [deadlineAt, gameId] = raw.slice(raw.indexOf(keys.deadlinePrefix) + keys.deadlinePrefix.length).split("/");
    if (Date.parse(now) < Date.parse(deadlineAt) + TIMEOUT_GRACE_MS) return false;

    const game = await this.readGame(entry.value.toString());
    const timeout = game ? dueTimeout(game.state, now) : null;
    if (!game || !timeout) {
      // The index entry no longer matches the game; drop it unless it has just been rewritten.
      const key = keys.deadline(deadlineAt, gameId);
      await this.kv.if(key, "Mod", "==", entry.mod_revision).then(this.kv.delete().key(key)).commit();
      return true;
    }
    const applied = applyGameCommand(game.state, timeout);
    if (!applied.ok) throw new Error(applied.error.code);
    // If a move or another node got there first, the compare fails and the next call sees the new state.
    await this.kv
      .if(keys.game(gameId), "Mod", "==", game.modRevision)
      .then(...this.transitionWrites(game.state, applied.value.state))
      .commit();
    return true;
  }

  /**
   * The writes that move a stored game from `previous` to `next`: the game itself, its entries in the
   * deadline index, and, once it finishes, freeing both players.
   */
  private transitionWrites(previous: GameState, next: GameState): IOperation[] {
    const writes: IOperation[] = [this.kv.put(keys.game(next.gameId)).value(encode(next))];
    for (const field of ["turnDeadlineAt", "placementDeadlineAt"] as const) {
      const before = previous[field];
      const after = next[field];
      if (before === after) continue;
      if (before) writes.push(this.kv.delete().key(keys.deadline(before, next.gameId)));
      if (after) writes.push(this.kv.put(keys.deadline(after, next.gameId)).value(next.gameCode));
    }
    if (next.status === "FINISHED") {
      for (const player of [next.playerOne, next.playerTwo]) {
        if (player) writes.push(this.kv.delete().key(keys.activeGame(player.id)));
      }
    }
    return writes;
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
