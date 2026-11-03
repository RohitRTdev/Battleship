import { randomBytes, randomUUID } from "node:crypto";
import type { ConnectionStatus, GameStatus, PlayerStateResponse } from "@battleship/game-contract";
import type { Pool, PoolClient } from "pg";
import type { CommandResult, GameStore } from "../game-store.js";
import {
  applyGameCommand,
  createGame,
  domainError,
  eventCommand,
  replayCommands,
  type DomainError,
  type GameCommand,
  type GameState,
  type PersistedCommand,
  type Player,
  type Result
} from "../../game/index.js";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type GameRow = { id: string };
type EventRow = { payload: PersistedCommand };
type TimestampRow = { now: Date };
type ConstraintError = Error & { code?: string; constraint?: string };
type QueueRow = { player_id: string; username: string; enqueued_at: Date };
type PlayerStateRow = {
  activity: "PLAYING" | "SEARCHING";
  code: string | null;
  status: GameStatus | null;
  enqueued_at: Date | null;
};

const MATCHMAKING_LOCK_KEY = "1947452302";
const PLAYER_LOCK_NAMESPACE = "1947452303";

function generateGameCode(): string {
  return [...randomBytes(8)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function normalizeTime(value: Date): string {
  return value.toISOString();
}

async function databaseTime(client: PoolClient): Promise<string> {
  const result = await client.query<TimestampRow>("SELECT clock_timestamp() AS now");
  return normalizeTime(result.rows[0].now);
}

async function loadState(client: PoolClient, gameId: string): Promise<GameState> {
  const events = await client.query<EventRow>(
    "SELECT payload FROM game_events WHERE game_id = $1 ORDER BY version",
    [gameId]
  );
  return replayCommands(events.rows.map((row) => row.payload));
}

async function insertEvent(client: PoolClient, state: GameState, command: PersistedCommand): Promise<void> {
  await client.query(
    `INSERT INTO game_events (game_id, version, event_type, actor_player_id, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [state.gameId, state.version, command.type, command.actor.id, JSON.stringify(command), command.occurredAt]
  );
}

async function updateMetadata(client: PoolClient, state: GameState): Promise<void> {
  await client.query(
    `UPDATE games SET
       status = $2, version = $3,
       player_two_id = $4, player_two_username = $5,
       winner_player_id = $6, completion_reason = $7,
       started_at = $8, ended_at = $9
     WHERE id = $1`,
    [
      state.gameId,
      state.status,
      state.version,
      state.playerTwo?.id ?? null,
      state.playerTwo?.username ?? null,
      state.winnerPlayerId,
      state.completionReason,
      state.startedAt,
      state.endedAt
    ]
  );
}

async function notifyUpdate(client: PoolClient, state: GameState): Promise<void> {
  await client.query("SELECT pg_notify('game_updates', $1)", [
    JSON.stringify({ gameId: state.gameId, version: state.version })
  ]);
}

async function notifyPlayerUpdate(client: PoolClient, playerId: string): Promise<void> {
  await client.query("SELECT pg_notify('player_state_updates', $1)", [JSON.stringify({ playerId })]);
}

async function enqueueArchive(client: PoolClient, state: GameState): Promise<void> {
  if (state.status !== "FINISHED" || state.completionReason === "CANCELLED") return;
  await client.query(
    `INSERT INTO match_archive_jobs (game_id, snapshot)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (game_id) DO NOTHING`,
    [state.gameId, JSON.stringify(state)]
  );
  await client.query("SELECT pg_notify('match_archive_jobs', $1)", [JSON.stringify({ gameId: state.gameId })]);
}

async function lockMatchmaking(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MATCHMAKING_LOCK_KEY]);
}

async function lockPlayer(client: PoolClient, playerId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2::bigint))", [playerId, PLAYER_LOCK_NAMESPACE]);
}

async function isSearching(client: PoolClient, playerId: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM matchmaking_queue WHERE player_id = $1", [playerId]);
  return result.rowCount !== 0;
}

async function playerState(client: PoolClient, playerId: string): Promise<PlayerStateResponse> {
  const result = await client.query<PlayerStateRow>(
    `SELECT 'PLAYING'::text AS activity, games.code, games.status, NULL::timestamptz AS enqueued_at, 1 AS priority
     FROM active_player_games
     JOIN games ON games.id = active_player_games.game_id
     WHERE active_player_games.player_id = $1
     UNION ALL
     SELECT 'SEARCHING'::text, NULL, NULL, enqueued_at, 2
     FROM matchmaking_queue
     WHERE player_id = $1
     ORDER BY priority
     LIMIT 1`,
    [playerId]
  );
  const row = result.rows[0];
  if (!row) return { state: "NOT_PLAYING" };
  if (row.activity === "SEARCHING") {
    return { state: "SEARCHING", searchStartedAt: normalizeTime(row.enqueued_at!) };
  }
  return { state: "PLAYING", gameCode: row.code!, gameStatus: row.status! };
}

function failed<T>(error: DomainError): Result<T> {
  return { ok: false, error };
}

export class GameRepository implements GameStore {
  constructor(private readonly pool: Pool) {}

  async create(actor: Player): Promise<Result<CommandResult>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await lockPlayer(client, actor.id);
        if (await isSearching(client, actor.id)) {
          await client.query("ROLLBACK");
          return failed(domainError("PLAYER_ALREADY_SEARCHING"));
        }
        const command = {
          type: "CREATE_GAME" as const,
          gameId: randomUUID(),
          gameCode: generateGameCode(),
          actor,
          occurredAt: await databaseTime(client)
        };
        const created = createGame(command);
        if (!created.ok) throw new Error(created.error.code);
        const state = created.value.state;
        await client.query(
          `INSERT INTO games (
             id, code, status, version, player_one_id, player_one_username,
             created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [state.gameId, state.gameCode, state.status, state.version, actor.id, actor.username, state.createdAt]
        );
        await client.query(
          "INSERT INTO active_player_games (player_id, game_id, slot) VALUES ($1, $2, 1)",
          [actor.id, state.gameId]
        );
        await insertEvent(client, state, eventCommand(created.value.event));
        await notifyUpdate(client, state);
        await client.query("COMMIT");
        return { ok: true, value: { state, outcome: created.value.outcome } };
      } catch (error) {
        await client.query("ROLLBACK");
        const constraint = error as ConstraintError;
        if (constraint.code === "23505" && constraint.constraint === "games_code_unique") continue;
        if (constraint.code === "23505" && constraint.constraint === "active_player_games_pkey") {
          return failed(domainError("PLAYER_ALREADY_PLAYING"));
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new Error("Could not allocate a unique game code");
  }

  async command(
    gameCode: string,
    actor: Player,
    buildCommand: (state: GameState, occurredAt: string) => GameCommand
  ): Promise<Result<CommandResult>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayer(client, actor.id);
      if (await isSearching(client, actor.id)) {
        await client.query("ROLLBACK");
        return failed(domainError("PLAYER_ALREADY_SEARCHING"));
      }
      const game = await client.query<GameRow>("SELECT id FROM games WHERE code = $1 FOR UPDATE", [gameCode]);
      if (!game.rows[0]) {
        await client.query("ROLLBACK");
        return failed(domainError("GAME_NOT_FOUND"));
      }
      const state = await loadState(client, game.rows[0].id);
      const command = buildCommand(state, await databaseTime(client));
      const applied = applyGameCommand(state, command);
      if (!applied.ok) {
        await client.query("ROLLBACK");
        return applied;
      }
      const next = applied.value.state;
      if (command.type === "JOIN_GAME") {
        try {
          await client.query(
            "INSERT INTO active_player_games (player_id, game_id, slot) VALUES ($1, $2, 2)",
            [actor.id, next.gameId]
          );
        } catch (error) {
          const constraint = error as ConstraintError;
          if (constraint.code === "23505" && constraint.constraint === "active_player_games_pkey") {
            await client.query("ROLLBACK");
            return failed(domainError("PLAYER_ALREADY_PLAYING"));
          }
          throw error;
        }
      }
      await insertEvent(client, next, eventCommand(applied.value.event));
      await updateMetadata(client, next);
      if (next.status === "FINISHED") {
        await client.query("DELETE FROM active_player_games WHERE game_id = $1", [next.gameId]);
        await enqueueArchive(client, next);
      }
      await notifyUpdate(client, next);
      await client.query("COMMIT");
      return { ok: true, value: { state: next, outcome: applied.value.outcome } };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getState(gameCode: string): Promise<Result<GameState>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const game = await client.query<GameRow>("SELECT id FROM games WHERE code = $1", [gameCode]);
      if (!game.rows[0]) {
        await client.query("ROLLBACK");
        return failed(domainError("GAME_NOT_FOUND"));
      }
      const state = await loadState(client, game.rows[0].id);
      await client.query("COMMIT");
      return { ok: true, value: state };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getPlayerState(playerId: string): Promise<PlayerStateResponse> {
    const client = await this.pool.connect();
    try {
      return await playerState(client, playerId);
    } finally {
      client.release();
    }
  }

  async startMatchmaking(actor: Player): Promise<Result<PlayerStateResponse>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockMatchmaking(client);
      await lockPlayer(client, actor.id);
      const current = await playerState(client, actor.id);
      if (current.state === "PLAYING") {
        await client.query("ROLLBACK");
        return failed(domainError("PLAYER_ALREADY_PLAYING"));
      }
      if (current.state === "SEARCHING") {
        await client.query("ROLLBACK");
        return failed(domainError("PLAYER_ALREADY_SEARCHING"));
      }

      let opponent: QueueRow | undefined;
      while (true) {
        const queued = await client.query<QueueRow>(
          `SELECT player_id, username, enqueued_at
           FROM matchmaking_queue
           ORDER BY queue_id
           LIMIT 1
           FOR UPDATE`,
        );
        opponent = queued.rows[0];
        if (!opponent) break;
        await lockPlayer(client, opponent.player_id);
        const opponentState = await playerState(client, opponent.player_id);
        if (opponentState.state === "SEARCHING") break;
        await client.query("DELETE FROM matchmaking_queue WHERE player_id = $1", [opponent.player_id]);
        opponent = undefined;
      }

      if (!opponent) {
        const queued = await client.query<{ enqueued_at: Date }>(
          `INSERT INTO matchmaking_queue (player_id, username)
           VALUES ($1, $2)
           RETURNING enqueued_at`,
          [actor.id, actor.username]
        );
        const state: PlayerStateResponse = {
          state: "SEARCHING",
          searchStartedAt: normalizeTime(queued.rows[0].enqueued_at)
        };
        await notifyPlayerUpdate(client, actor.id);
        await client.query("COMMIT");
        return { ok: true, value: state };
      }

      const queuedPlayer: Player = { id: opponent.player_id, username: opponent.username };
      let matchedState: GameState | null = null;
      for (let attempt = 0; attempt < 8 && !matchedState; attempt += 1) {
        const createCommand = {
          type: "CREATE_GAME" as const,
          gameId: randomUUID(),
          gameCode: generateGameCode(),
          actor: queuedPlayer,
          occurredAt: await databaseTime(client)
        };
        const created = createGame(createCommand);
        if (!created.ok) throw new Error(created.error.code);
        const joinCommand = { type: "JOIN_GAME" as const, actor, occurredAt: await databaseTime(client) };
        const joined = applyGameCommand(created.value.state, joinCommand);
        if (!joined.ok) throw new Error(joined.error.code);
        const state = joined.value.state;
        const inserted = await client.query(
          `INSERT INTO games (
             id, code, status, version, player_one_id, player_one_username,
             player_two_id, player_two_username, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (code) DO NOTHING
           RETURNING id`,
          [state.gameId, state.gameCode, state.status, state.version, queuedPlayer.id, queuedPlayer.username,
            actor.id, actor.username, state.createdAt]
        );
        if (!inserted.rows[0]) continue;
        await insertEvent(client, created.value.state, eventCommand(created.value.event));
        await insertEvent(client, state, eventCommand(joined.value.event));
        matchedState = state;
      }
      if (!matchedState) throw new Error("Could not allocate a unique game code");

      await client.query(
        `INSERT INTO active_player_games (player_id, game_id, slot)
         VALUES ($1, $3, 1), ($2, $3, 2)`,
        [queuedPlayer.id, actor.id, matchedState.gameId]
      );
      await client.query("DELETE FROM matchmaking_queue WHERE player_id = $1", [queuedPlayer.id]);
      await notifyUpdate(client, matchedState);
      await notifyPlayerUpdate(client, queuedPlayer.id);
      await notifyPlayerUpdate(client, actor.id);
      await client.query("COMMIT");
      return {
        ok: true,
        value: { state: "PLAYING", gameCode: matchedState.gameCode, gameStatus: matchedState.status }
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const constraint = error as ConstraintError;
      if (constraint.code === "23505" && constraint.constraint === "active_player_games_pkey") {
        return failed(domainError("PLAYER_ALREADY_PLAYING"));
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelMatchmaking(playerId: string): Promise<PlayerStateResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockMatchmaking(client);
      await lockPlayer(client, playerId);
      const removed = await client.query("DELETE FROM matchmaking_queue WHERE player_id = $1", [playerId]);
      const state = removed.rowCount === 0 ? await playerState(client, playerId) : { state: "NOT_PLAYING" as const };
      await notifyPlayerUpdate(client, playerId);
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async touchPresence(gameId: string, playerId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO game_presence (game_id, player_id, last_seen_at)
       VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (game_id, player_id)
       DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [gameId, playerId]
    );
  }

  async presence(gameId: string, state: GameState): Promise<Record<string, ConnectionStatus>> {
    const result = await this.pool.query<{ player_id: string; connection_status: ConnectionStatus }>(
      `SELECT player_id,
         CASE WHEN clock_timestamp() - last_seen_at <= interval '10 seconds'
              THEN 'CONNECTED' ELSE 'LAGGING' END AS connection_status
       FROM game_presence WHERE game_id = $1`,
      [gameId]
    );
    const presence: Record<string, ConnectionStatus> = { [state.playerOne.id]: "UNKNOWN" };
    if (state.playerTwo) presence[state.playerTwo.id] = "UNKNOWN";
    for (const row of result.rows) presence[row.player_id] = row.connection_status;
    return presence;
  }
}
