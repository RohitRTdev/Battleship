import { randomBytes, randomUUID } from "node:crypto";
import type {
  AttackView,
  ConnectionStatus,
  GameStatus,
  PlayerGameView,
  PlayerStateResponse
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
type ConstraintError = Error & { code?: string; constraint?: string };

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

function failed<T>(error: DomainError): Result<T> {
  return { ok: false, error };
}

export class GameRepository {
  constructor(private readonly pool: Pool) {}

  async create(actor: Player): Promise<Result<CommandResult>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
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
    const result = await this.pool.query<{ code: string; status: GameStatus }>(
      `SELECT games.code, games.status
       FROM active_player_games
       JOIN games ON games.id = active_player_games.game_id
       WHERE active_player_games.player_id = $1`,
      [playerId]
    );
    const game = result.rows[0];
    return game ? { state: "PLAYING", gameCode: game.code, gameStatus: game.status } : { state: "NOT_PLAYING" };
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
