import { authorizeUser, createTokenVerifierFromEnvironment } from "@battleship/auth-token";
import express from "express";
import path from "node:path";
import { Pool } from "pg";
import { runMigrations } from "./database/migrations.js";
import { GameRepository } from "./database/game-repository.js";
import { GameUpdateBus } from "./database/update-bus.js";
import { createGameRouter } from "./http/game-router.js";
import { backendErrorHandler } from "./http/error-handler.js";
import { createMatchArchive } from "./archive/index.js";
import { ArchiveWorker } from "./archive/archive-worker.js";
import { RetentionWorker } from "./archive/retention-worker.js";
import { cleanupCommandRateLimits, commandRateLimiter } from "./http/rate-limit.js";

const serviceName = process.env.SERVICE_NAME ?? "raft-backend";
const nodeId = process.env.NODE_ID ?? "backend-node-unknown";
const httpPort = Number(process.env.HTTP_PORT ?? 8080);
const databaseUrl = process.env.DATABASE_URL;
const tokenVerifier = await createTokenVerifierFromEnvironment();
const production = process.env.APP_ENV === "prod";
const frontendDirectory = path.resolve(process.cwd(), "apps/frontend/dist");

if (!databaseUrl && !(process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE)) {
  throw new Error("DATABASE_URL or PostgreSQL PG* environment variables are required");
}

let ready = false;
let databaseReady = false;
let shuttingDown = false;

const database = new Pool({
  ...(databaseUrl ? { connectionString: databaseUrl } : {}),
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_000
});

database.on("error", (error) => {
  databaseReady = false;
  console.error("PostgreSQL pool error", error);
});

const disableTimeout = process.env.DISABLE_TIMEOUT ?? "false";
if (disableTimeout !== "true" && disableTimeout !== "false") throw new Error("DISABLE_TIMEOUT must be true or false");
const timeoutEnabled = disableTimeout === "false";
const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED ?? "true";
if (rateLimitEnabled !== "true" && rateLimitEnabled !== "false") throw new Error("RATE_LIMIT_ENABLED must be true or false");
const repository = new GameRepository(database, timeoutEnabled);
let timeoutWorkerRunning = false;
let timeoutWorkerClosed = false;
async function expireTurns(): Promise<void> {
  if (timeoutWorkerRunning || timeoutWorkerClosed) return;
  timeoutWorkerRunning = true;
  try {
    // Keep each sweep bounded; the next tick resumes any remaining work.
    for (let processed = 0; processed < 100 && !timeoutWorkerClosed; processed += 1) {
      if (!await repository.expireOneTurn()) break;
    }
  }
  catch (error) { console.error("Turn timeout worker failed", error); }
  finally { timeoutWorkerRunning = false; }
}
let timeoutTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatRunning = false;
async function recordHeartbeat(): Promise<void> {
  if (heartbeatRunning || shuttingDown) return;
  heartbeatRunning = true;
  try { await repository.recordHeartbeat(); }
  catch (error) { console.error("Database heartbeat failed", error); }
  finally { heartbeatRunning = false; }
}
let matchmakingCleanupTimer: NodeJS.Timeout | null = null;
let matchmakingCleanupRunning = false;
async function expireMatchmaking(): Promise<void> {
  if (matchmakingCleanupRunning || shuttingDown) return;
  matchmakingCleanupRunning = true;
  try { await repository.expireMatchmaking(); }
  catch (error) { console.error("Matchmaking cleanup failed", error); }
  finally { matchmakingCleanupRunning = false; }
}
const updates = new GameUpdateBus(database);
const archive = createMatchArchive();
const archiveWorker = new ArchiveWorker(database, archive, updates);
const retentionWorker = new RetentionWorker(database, archive);
let rateLimitCleanupTimer: NodeJS.Timeout | null = null;

async function initializeDatabase(): Promise<void> {
  while (true) {
    try {
      await database.query("SELECT 1");
      const res = await database.query("SHOW max_connections");
      if (res) {
        console.log(`PostgreSQL max_connections: ${res.rows[0].max_connections}`);
      }
      const migrationClient = await database.connect();
      try {
        await runMigrations(migrationClient);
      } finally {
        migrationClient.release();
      }
      await updates.start();
      archiveWorker.start();
      retentionWorker.start();
      if (rateLimitEnabled === "true" && !rateLimitCleanupTimer) {
        rateLimitCleanupTimer = setInterval(() => {
          void cleanupCommandRateLimits(database).catch((error: unknown) => console.error("Rate limit cleanup failed", error));
        }, 15 * 60_000);
      }
      if (timeoutEnabled && !timeoutTimer) {
        void recordHeartbeat();
        heartbeatTimer = setInterval(() => void recordHeartbeat(), 1_000);
        void expireTurns();
        timeoutTimer = setInterval(() => void expireTurns(), 1_000);
      }
      if (!matchmakingCleanupTimer) { void expireMatchmaking(); matchmakingCleanupTimer = setInterval(() => void expireMatchmaking(), 1_000); }
      databaseReady = true;
      return;
    } catch (error) {
      databaseReady = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`PostgreSQL initialization failed; retrying in 1 second: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

await initializeDatabase();

const app = express();
app.disable("etag");
app.use((_request, response, next) => {
  response.setHeader("X-Battleship-Node", nodeId);
  next();
});

app.get("/healthz", async (_request, response) => {
  try {
    await database.query("SELECT 1");
    databaseReady = true;
  } catch {
    databaseReady = false;
  }

  const healthy = ready && databaseReady;
  response.status(healthy ? 200 : 503).json({
    service: serviceName,
    nodeId,
    ready: healthy,
    databaseReady
  });
});

if (production) {
  app.get("/config.json", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      environment: "prod",
      region: process.env.AWS_REGION,
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      userPoolClientId: process.env.COGNITO_APP_CLIENT_ID
    });
  });
  app.use(express.static(frontendDirectory));
}

app.use("/api/backend", authorizeUser(tokenVerifier),
  ...(rateLimitEnabled === "true" ? [commandRateLimiter(database)] : []),
  express.json({ limit: "32kb" }), createGameRouter(repository, updates, archive));

app.use((_request, response) => response.status(404).json({ error: "Not found" }));
app.use(backendErrorHandler);

const httpServer = app.listen(httpPort, "0.0.0.0");
// Behind the AWS load balancer (idle timeout 60 s), Node must keep idle connections open longer than the balancer
// does. With Node's 5 s default, the balancer can reuse a connection Node has just closed and answer 502.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;
await new Promise<void>((resolve, reject) => {
  httpServer.once("listening", resolve);
  httpServer.once("error", reject);
});
ready = true;

console.log(`${serviceName}/${nodeId} ready on HTTP ${httpPort}`);

function shutdown(): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  ready = false;
  databaseReady = false;
  httpServer.close(() => {
    timeoutWorkerClosed = true;
    if (timeoutTimer) clearInterval(timeoutTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (matchmakingCleanupTimer) clearInterval(matchmakingCleanupTimer);
    retentionWorker.close();
    if (rateLimitCleanupTimer) clearInterval(rateLimitCleanupTimer);
    archiveWorker.close();
    updates.close();
    void database.end().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
