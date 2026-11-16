import type { RequestHandler } from "express";
import type { Pool } from "pg";

const COMMAND_ROUTES: ReadonlyArray<[string, RegExp]> = [
  ["POST", /^\/matchmaking\/?$/i],
  ["DELETE", /^\/matchmaking\/?$/i],
  ["POST", /^\/games\/?$/i],
  ["POST", /^\/games\/[^/]+\/(join|fire|cancel|surrender)\/?$/i],
  ["PUT", /^\/games\/[^/]+\/fleet\/?$/i]
];

export function isCommand(method: string, path: string): boolean {
  return COMMAND_ROUTES.some(([verb, pattern]) => method === verb && pattern.test(path));
}

export async function takeCommandSlot(database: Pool, playerId: string): Promise<boolean> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    // The no-op update also locks an existing row until this transaction ends.
    await client.query(`
      INSERT INTO command_rate_limits (player_id) VALUES ($1)
      ON CONFLICT (player_id) DO UPDATE SET player_id = EXCLUDED.player_id
    `, [playerId]);
    // Evaluate the clock only after acquiring the lock, including under contention.
    const result = await client.query<{ allowed: boolean }>(`
      WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now),
      recent AS MATERIALIZED (
        SELECT instant.now, ARRAY(
          SELECT stamp FROM unnest(limits.accepted_at) AS stamp
          WHERE stamp > instant.now - interval '1 second'
          ORDER BY stamp
        ) AS stamps
        FROM command_rate_limits AS limits CROSS JOIN instant
        WHERE limits.player_id = $1
      )
      UPDATE command_rate_limits AS limits
      SET accepted_at = CASE WHEN cardinality(recent.stamps) < 20
        THEN array_append(recent.stamps, recent.now) ELSE recent.stamps END
      FROM recent WHERE limits.player_id = $1
      RETURNING cardinality(recent.stamps) < 20 AS allowed
    `, [playerId]);
    if (result.rows.length !== 1) throw new Error("Rate limit row disappeared");
    await client.query("COMMIT");
    return result.rows[0].allowed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function commandRateLimiter(database: Pool): RequestHandler {
  return async (request, response, next) => {
    if (!isCommand(request.method, request.path)) return next();
    try {
      if (await takeCommandSlot(database, request.user!.id)) return next();
      console.warn(JSON.stringify({
        event: "command_rate_limit_exceeded", playerId: request.user!.id,
        method: request.method, route: request.path, timestamp: new Date().toISOString()
      }));
      response.setHeader("Retry-After", "1");
      response.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many commands. Please try again shortly." } });
    } catch (error) {
      console.error("Command rate limiter database error", error);
      response.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "The game database is unavailable." } });
    }
  };
}

export async function cleanupCommandRateLimits(database: Pool): Promise<void> {
  await database.query(`
    DELETE FROM command_rate_limits
    WHERE accepted_at[cardinality(accepted_at)] < clock_timestamp() - interval '1 hour'
  `);
}
