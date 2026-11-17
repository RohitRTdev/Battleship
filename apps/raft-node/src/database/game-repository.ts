import { randomBytes, randomUUID } from "node:crypto";
import type {
  AttackView,
  CommandMetadata,
  FireResponse,
  GameResponse,
  ConnectionStatus,
  GameStatus,
  PlayerGameView,
  PlayerStateResponse,
  PlayerStatistics
} from "@battleship/game-contract";
import type { Pool, PoolClient } from "pg";
import {
  applyGameCommand,
  createGame,
  domainError,
  eventCommand,
  projectGame,
  replayCommands,
  type CommandOutcome,
  type DomainError,
  type GameCommand,
  type GameState,
  type PersistedCommand,
  type Player,
  type Result
} from "../game/index.js";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type GameRow = { id: string };
type EventRow = { payload: PersistedCommand };
type TimestampRow = { now: Date };
type RecoveryRow = { id: string; last_success_before_gap: Date; recovered_at: Date };
type ConstraintError = Error & { code?: string; constraint?: string };
type QueueRow = { player_id: string; username: string; enqueued_at: Date };
type PlayerStateRow = {
  activity: "PLAYING" | "SEARCHING";
  code: string | null;
  status: GameStatus | null;
  enqueued_at: Date | null;
  search_id: string | null;
};

const MATCHMAKING_LOCK_KEY = "1947452302";
const PLAYER_LOCK_NAMESPACE = "1947452303";

export type CommandResult = { state: GameState; outcome: CommandOutcome };

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
    [state.gameId, state.version, command.type, command.actor?.id ?? null, JSON.stringify(command), command.occurredAt]
  );
}

async function updateMetadata(client: PoolClient, state: GameState): Promise<void> {
  await client.query(
    `UPDATE games SET
       status = $2, version = $3,
       player_two_id = $4, player_two_username = $5,
       winner_player_id = $6, completion_reason = $7,
       started_at = $8, ended_at = $9, turn_deadline_at = $10, placement_deadline_at = $11
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
      state.endedAt,
      state.turnDeadlineAt,
      state.placementDeadlineAt
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
  const result = await client.query("SELECT 1 FROM matchmaking_queue WHERE player_id = $1 AND lease_expires_at > clock_timestamp()", [playerId]);
  return result.rowCount !== 0;
}

async function playerState(client: PoolClient, playerId: string): Promise<PlayerStateResponse> {
  const result = await client.query<PlayerStateRow>(
    `SELECT 'PLAYING'::text AS activity, games.code, games.status, NULL::timestamptz AS enqueued_at, NULL::text AS search_id, 1 AS priority
     FROM active_player_games
     JOIN games ON games.id = active_player_games.game_id
     WHERE active_player_games.player_id = $1
     UNION ALL
     SELECT 'SEARCHING'::text, NULL, NULL, enqueued_at, queue_id::text, 2
     FROM matchmaking_queue
     WHERE player_id = $1 AND lease_expires_at > clock_timestamp()
     ORDER BY priority
     LIMIT 1`,
    [playerId]
  );
  const row = result.rows[0];
  if (!row) return { state: "NOT_PLAYING" };
  if (row.activity === "SEARCHING") {
    return { state: "SEARCHING", searchStartedAt: normalizeTime(row.enqueued_at!), searchId: row.search_id! };
  }
  return { state: "PLAYING", gameCode: row.code!, gameStatus: row.status! };
}

function failed<T>(error: DomainError): Result<T> {
  return { ok: false, error };
}

export class GameRepository {
  constructor(private readonly pool: Pool, private readonly timeoutEnabled = true) {}

  // This row is also the cross-replica recovery lock. Hold it until the
  // transaction has finished checking or changing a game's deadlines.
  private async heartbeat(client: PoolClient): Promise<void> {
    const result = await client.query<{ last_success_at: Date }>(
      "SELECT last_success_at FROM database_heartbeat WHERE id = true FOR UPDATE"
    );
    const last = result.rows[0].last_success_at;
    // Read the clock after acquiring the lock, not before waiting for it.
    const now = (await client.query<TimestampRow>("SELECT clock_timestamp() AS now")).rows[0].now;
    if (now.getTime() - last.getTime() > 5_000) {
      await client.query("INSERT INTO database_recoveries (last_success_before_gap, recovered_at) VALUES ($1, $2)", [last, now]);
    }
    await client.query("UPDATE database_heartbeat SET last_success_at = $1 WHERE id = true", [now]);
  }

  async recordHeartbeat(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.heartbeat(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async applyRecoveries(client: PoolClient, state: GameState): Promise<GameState> {
    const recoveries = await client.query<RecoveryRow>(
      `SELECT r.id, r.last_success_before_gap, r.recovered_at FROM database_recoveries r
       JOIN games g ON g.id = $1
       WHERE r.id > g.last_processed_recovery_id ORDER BY r.id`, [state.gameId]
    );
    for (const recovery of recoveries.rows) {
      const oldDeadline = state.status === "ACTIVE" ? state.turnDeadlineAt : state.status === "PLACEMENT" ? state.placementDeadlineAt : null;
      if (oldDeadline && Date.parse(state.createdAt) <= recovery.recovered_at.getTime() &&
          Date.parse(oldDeadline) + 500 > recovery.last_success_before_gap.getTime()) {
        const now = await databaseTime(client);
        const duration = state.status === "ACTIVE" ? 30_000 : 60_000;
        const command: GameCommand = { type: "DEADLINE_RESET", actor: null, recoveryId: recovery.id,
          deadline: new Date(Date.parse(now) + duration).toISOString(), occurredAt: now };
        const result = applyGameCommand(state, command);
        if (!result.ok) throw new Error(result.error.code);
        state = result.value.state;
        await this.persistTransition(client, state, command);
      }
      await client.query("UPDATE games SET last_processed_recovery_id = $2 WHERE id = $1", [state.gameId, recovery.id]);
    }
    return state;
  }

  async currentTime(): Promise<string> {
    const result = await this.pool.query<TimestampRow>("SELECT clock_timestamp() AS now");
    return normalizeTime(result.rows[0].now);
  }

  async create(actor: Player): Promise<Result<CommandResult>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        if (this.timeoutEnabled) await this.heartbeat(client);
        await lockPlayer(client, actor.id);
        if (await isSearching(client, actor.id)) {
          await client.query("ROLLBACK");
          return failed(domainError("PLAYER_ALREADY_SEARCHING"));
        }
        const command = {
          type: "CREATE_GAME" as const,
          gameId: randomUUID(),
          gameCode: generateGameCode(),
          turnTimeoutEnabled: this.timeoutEnabled,
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
    metadata: CommandMetadata,
    request: object,
    buildCommand: (state: GameState, occurredAt: string) => GameCommand
  ): Promise<Result<GameResponse | FireResponse>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (this.timeoutEnabled) await this.heartbeat(client);
      await lockPlayer(client, actor.id);
      const game = await client.query<GameRow>("SELECT id FROM games WHERE code = $1 FOR UPDATE", [gameCode]);
      if (!game.rows[0]) {
        await client.query("ROLLBACK");
        return failed(domainError("GAME_NOT_FOUND"));
      }
      const identity = { expectedVersion: metadata.expectedVersion, ...request };
      const prior = await client.query<{ matches: boolean; response: GameResponse | FireResponse }>(
        `SELECT request = $4::jsonb AS matches, response FROM game_command_results
         WHERE game_id = $1 AND actor_player_id = $2 AND command_id = $3`,
        [game.rows[0].id, actor.id, metadata.commandId, JSON.stringify(identity)]
      );
      if (prior.rows[0]) {
        await client.query("ROLLBACK");
        return prior.rows[0].matches ? { ok: true, value: prior.rows[0].response } : failed(domainError("COMMAND_ID_CONFLICT"));
      }
      if (await isSearching(client, actor.id)) {
        await client.query("ROLLBACK");
        return failed(domainError("PLAYER_ALREADY_SEARCHING"));
      }
      let state = await loadState(client, game.rows[0].id);
      // Only participants may learn the current version; joining is validated by the state machine.
      if (request && (request as { type?: string }).type !== "JOIN_GAME" && state.playerOne.id !== actor.id && state.playerTwo?.id !== actor.id) {
        await client.query("ROLLBACK");
        return failed(domainError("PLAYER_NOT_IN_GAME"));
      }
      if (this.timeoutEnabled) state = await this.applyRecoveries(client, state);
      const intervening = state.version === metadata.expectedVersion ? null : await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM game_events WHERE game_id = $1 AND version > $2 AND event_type <> 'DEADLINE_RESET'`,
        [state.gameId, metadata.expectedVersion]
      );
      if (metadata.expectedVersion > state.version || (intervening && Number(intervening.rows[0].count) !== 0)) {
        await client.query("ROLLBACK");
        return failed(domainError("STALE_VERSION"));
      }
      const now = await databaseTime(client);
      const command = buildCommand(state, now);
      if ((command.type === "FIRE" || command.type === "SURRENDER") && state.status === "ACTIVE" && state.turnDeadlineAt && (state.playerOne.id === actor.id || state.playerTwo?.id === actor.id) && Date.parse(now) >= Date.parse(state.turnDeadlineAt) + 500) {
        const timedOut = state.currentTurn === state.playerOne.id ? state.playerOne : state.playerTwo!;
        const timeoutCommand: GameCommand = { type: "TURN_TIMEOUT", actor: timedOut, deadline: state.turnDeadlineAt, occurredAt: now };
        const timeout = applyGameCommand(state, timeoutCommand);
        if (!timeout.ok) throw new Error(timeout.error.code);
        await this.persistTransition(client, timeout.value.state, timeoutCommand);
        await client.query("COMMIT");
        return failed(domainError("TURN_TIMED_OUT"));
      }
      if (command.type === "PLACE_FLEET" && state.status === "PLACEMENT" && state.placementDeadlineAt && (state.playerOne.id === actor.id || state.playerTwo?.id === actor.id) && Date.parse(now) >= Date.parse(state.placementDeadlineAt) + 500) {
        const timeoutCommand: GameCommand = { type: "PLACEMENT_TIMEOUT", actor: state.playerOne, deadline: state.placementDeadlineAt, occurredAt: now };
        const timeout = applyGameCommand(state, timeoutCommand);
        if (!timeout.ok) throw new Error(timeout.error.code);
        await this.persistTransition(client, timeout.value.state, timeoutCommand);
        await client.query("COMMIT");
        return failed(domainError("GAME_CANCELLED"));
      }
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
      await this.persistTransition(client, next, eventCommand(applied.value.event));
      const presence = await this.presence(next.gameId, next, client);
      const view = projectGame(next, actor.id, presence);
      if (!view) throw new Error("Cannot project command response for actor");
      const outcome = command.type === "FIRE" ? this.attackOutcome(applied.value.outcome) : null;
      if (command.type === "FIRE" && !outcome) throw new Error("Missing fire outcome");
      const response = outcome ? { game: view, outcome } : { game: view };
      await client.query(
        `INSERT INTO game_command_results (game_id, actor_player_id, command_id, request, response)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [next.gameId, actor.id, metadata.commandId, JSON.stringify(identity), JSON.stringify(response)]
      );
      await client.query("COMMIT");
      return { ok: true, value: response };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistTransition(client: PoolClient, state: GameState, command: PersistedCommand): Promise<void> {
    await insertEvent(client, state, command);
    await updateMetadata(client, state);
    if (state.status === "FINISHED") {
      await client.query("DELETE FROM active_player_games WHERE game_id = $1", [state.gameId]);
      if (state.completionReason !== "CANCELLED" && state.playerTwo && state.winnerPlayerId) {
        // Stable ordering prevents deadlocks when different games finish concurrently.
        for (const player of [state.playerOne, state.playerTwo].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
          const won = player.id === state.winnerPlayerId;
          await client.query(
            `INSERT INTO player_statistics (player_id, matches_played, wins, losses, surrenders)
             VALUES ($1, 1, $2, $3, $4)
             ON CONFLICT (player_id) DO UPDATE SET
               matches_played = player_statistics.matches_played + 1,
               wins = player_statistics.wins + EXCLUDED.wins,
               losses = player_statistics.losses + EXCLUDED.losses,
               surrenders = player_statistics.surrenders + EXCLUDED.surrenders`,
            [player.id, Number(won), Number(!won), Number(state.completionReason === "SURRENDER" && !won)]
          );
        }
      }
      await enqueueArchive(client, state);
    }
    await notifyUpdate(client, state);
  }

  async expireOneTurn(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.heartbeat(client);
      const pending = await client.query<GameRow>(`SELECT g.id FROM games g
        WHERE g.status <> 'FINISHED' AND EXISTS (
          SELECT 1 FROM database_recoveries r WHERE r.id > g.last_processed_recovery_id
        ) ORDER BY g.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (pending.rows[0]) {
        await this.applyRecoveries(client, await loadState(client, pending.rows[0].id));
        await client.query("COMMIT");
        return true;
      }
      await client.query(`DELETE FROM database_recoveries r WHERE NOT EXISTS (
        SELECT 1 FROM games g WHERE g.status <> 'FINISHED' AND g.last_processed_recovery_id < r.id
      )`);
      const rows = await client.query<GameRow>(`SELECT id FROM games
        WHERE (status = 'ACTIVE' AND turn_deadline_at <= clock_timestamp() - interval '500 milliseconds')
           OR (status = 'PLACEMENT' AND placement_deadline_at <= clock_timestamp() - interval '500 milliseconds')
        ORDER BY COALESCE(turn_deadline_at, placement_deadline_at) LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!rows.rows[0]) { await client.query("COMMIT"); return false; }
      const state = await loadState(client, rows.rows[0].id);
      const now = await databaseTime(client);
      if (state.status === "ACTIVE" && state.turnDeadlineAt && state.currentTurn && Date.parse(now) >= Date.parse(state.turnDeadlineAt) + 500) {
        const actor = state.currentTurn === state.playerOne.id ? state.playerOne : state.playerTwo!;
        const command: GameCommand = { type: "TURN_TIMEOUT", actor, deadline: state.turnDeadlineAt, occurredAt: now };
        const result = applyGameCommand(state, command);
        if (!result.ok) throw new Error(result.error.code);
        await this.persistTransition(client, result.value.state, command);
      }
      else if (state.status === "PLACEMENT" && state.placementDeadlineAt && Date.parse(now) >= Date.parse(state.placementDeadlineAt) + 500) {
        const command: GameCommand = { type: "PLACEMENT_TIMEOUT", actor: state.playerOne, deadline: state.placementDeadlineAt, occurredAt: now };
        const result = applyGameCommand(state, command);
        if (!result.ok) throw new Error(result.error.code);
        await this.persistTransition(client, result.value.state, command);
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
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

  async getPlayerStatistics(playerId: string): Promise<PlayerStatistics> {
    const result = await this.pool.query<{ matches_played: number; wins: number; losses: number; surrenders: number }>(
      "SELECT matches_played, wins, losses, surrenders FROM player_statistics WHERE player_id = $1", [playerId]
    );
    const row = result.rows[0];
    return row ? { matchesPlayed: row.matches_played, wins: row.wins, losses: row.losses, surrenders: row.surrenders }
      : { matchesPlayed: 0, wins: 0, losses: 0, surrenders: 0 };
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
      if (this.timeoutEnabled) await this.heartbeat(client);
      await lockMatchmaking(client);
      await this.deleteExpiredSearches(client);
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
        const queued = await client.query<{ enqueued_at: Date; search_id: string }>(
          `INSERT INTO matchmaking_queue (player_id, username)
           VALUES ($1, $2)
           RETURNING enqueued_at, queue_id::text AS search_id`,
          [actor.id, actor.username]
        );
        const state: PlayerStateResponse = {
          state: "SEARCHING",
          searchStartedAt: normalizeTime(queued.rows[0].enqueued_at),
          searchId: queued.rows[0].search_id
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
          turnTimeoutEnabled: this.timeoutEnabled,
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
             player_two_id, player_two_username, created_at, placement_deadline_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (code) DO NOTHING
           RETURNING id`,
          [state.gameId, state.gameCode, state.status, state.version, queuedPlayer.id, queuedPlayer.username,
            actor.id, actor.username, state.createdAt, state.placementDeadlineAt]
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

  private async deleteExpiredSearches(client: PoolClient): Promise<void> {
    const removed = await client.query<{ player_id: string }>(
      "DELETE FROM matchmaking_queue WHERE lease_expires_at <= clock_timestamp() RETURNING player_id"
    );
    for (const row of removed.rows) await notifyPlayerUpdate(client, row.player_id);
  }

  async expireMatchmaking(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockMatchmaking(client);
      await this.deleteExpiredSearches(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async beginMatchmakingPoll(playerId: string, searchId: string): Promise<{ token: string | null; state: PlayerStateResponse }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockMatchmaking(client);
      await this.deleteExpiredSearches(client);
      const token = randomUUID();
      const updated = await client.query(
        `UPDATE matchmaking_queue SET poll_token = $3, lease_expires_at = clock_timestamp() + interval '9 seconds'
         WHERE player_id = $1 AND queue_id::text = $2 AND lease_expires_at > clock_timestamp()`,
        [playerId, searchId, token]
      );
      const state = await playerState(client, playerId);
      await client.query("COMMIT");
      // A request for a previous search must not observe or affect a newer one.
      return { token: updated.rowCount ? token : null, state: state.state === "SEARCHING" && state.searchId !== searchId ? { state: "NOT_PLAYING" } : state };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async finishMatchmakingPoll(playerId: string, searchId: string, token: string): Promise<PlayerStateResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockMatchmaking(client);
      await this.deleteExpiredSearches(client);
      await client.query(
        `UPDATE matchmaking_queue SET lease_expires_at = clock_timestamp() + interval '6 seconds'
         WHERE player_id = $1 AND queue_id::text = $2 AND poll_token = $3 AND lease_expires_at > clock_timestamp()`,
        [playerId, searchId, token]
      );
      const state = await playerState(client, playerId);
      await client.query("COMMIT");
      return state.state === "SEARCHING" && state.searchId !== searchId ? { state: "NOT_PLAYING" } : state;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
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

  async presence(gameId: string, state: GameState, client: Pool | PoolClient = this.pool): Promise<Record<string, ConnectionStatus>> {
    const result = await client.query<{ player_id: string; connection_status: ConnectionStatus }>(
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

  async view(state: GameState, viewerId: string): Promise<Result<PlayerGameView>> {
    const view = projectGame(state, viewerId, await this.presence(state.gameId, state));
    return view ? { ok: true, value: view } : failed(domainError("PLAYER_NOT_IN_GAME"));
  }

  attackOutcome(outcome: CommandOutcome): AttackView | null {
    if (!["MISS", "HIT", "SUNK", "WIN"].includes(outcome.type)) return null;
    const attack = outcome as Extract<CommandOutcome, { coordinate: unknown }>;
    return {
      coordinate: attack.coordinate,
      result: attack.type,
      ...(attack.sunkShipLength ? { sunkShipLength: attack.sunkShipLength } : {})
    };
  }
}
