import type { PoolClient } from "pg";

const MIGRATION_LOCK_ID = 1_947_452_301;

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE games (
        id UUID PRIMARY KEY,
        code VARCHAR(8) NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('WAITING', 'PLACEMENT', 'ACTIVE', 'FINISHED')),
        version INTEGER NOT NULL CHECK (version >= 1),
        player_one_id TEXT NOT NULL,
        player_one_username TEXT NOT NULL,
        player_two_id TEXT,
        player_two_username TEXT,
        winner_player_id TEXT,
        completion_reason TEXT CHECK (completion_reason IS NULL OR completion_reason IN ('FLEET_DESTROYED', 'SURRENDER', 'CANCELLED')),
        created_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        CONSTRAINT games_code_unique UNIQUE (code),
        CONSTRAINT games_second_player_complete CHECK ((player_two_id IS NULL) = (player_two_username IS NULL)),
        CONSTRAINT games_players_distinct CHECK (player_two_id IS NULL OR player_one_id <> player_two_id)
      );

      CREATE INDEX games_player_one_status_idx ON games (player_one_id, status);
      CREATE INDEX games_player_two_status_idx ON games (player_two_id, status);

      CREATE TABLE game_events (
        game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN ('CREATE_GAME', 'JOIN_GAME', 'PLACE_FLEET', 'FIRE', 'CANCEL_GAME', 'SURRENDER')),
        actor_player_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (game_id, version)
      );

      CREATE TABLE active_player_games (
        player_id TEXT PRIMARY KEY,
        game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        slot SMALLINT NOT NULL CHECK (slot IN (1, 2)),
        CONSTRAINT active_player_game_slot_unique UNIQUE (game_id, slot)
      );

      CREATE TABLE game_presence (
        game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (game_id, player_id)
      );
    `
  }
] as const;

export async function runMigrations(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const applied = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const appliedVersions = new Set(applied.rows.map((row) => row.version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
