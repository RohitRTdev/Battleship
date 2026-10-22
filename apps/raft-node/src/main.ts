import { authorizeUser } from "@battleship/auth-token";
import { startInternalGrpcServer } from "@battleship/protocol";
import express from "express";
import { Pool } from "pg";
import { runMigrations } from "./database/migrations.js";
import { GameRepository } from "./database/game-repository.js";
import { GameUpdateBus } from "./database/update-bus.js";
import { createGameRouter } from "./http/game-router.js";

const serviceName = process.env.SERVICE_NAME ?? "raft-backend";
const nodeId = process.env.NODE_ID ?? "backend-node-unknown";
const httpPort = Number(process.env.HTTP_PORT ?? 8080);
const grpcPort = Number(process.env.GRPC_PORT ?? 9090);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

let ready = false;
let databaseReady = false;
let shuttingDown = false;

const database = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_000
});

database.on("error", (error) => {
  databaseReady = false;
  console.error("PostgreSQL pool error", error);
});

const repository = new GameRepository(database);
const updates = new GameUpdateBus(database);

async function initializeDatabase(): Promise<void> {
  while (true) {
    try {
      await database.query("SELECT 1");
      const migrationClient = await database.connect();
      try {
        await runMigrations(migrationClient);
      } finally {
        migrationClient.release();
      }
      await updates.start();
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

const grpcServer = await startInternalGrpcServer(grpcPort, {
  serviceName,
  nodeId,
  isReady: () => ready && databaseReady
});

const app = express();
app.use(express.json({ limit: "32kb" }));
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

app.use(authorizeUser);
app.use("/api/backend", createGameRouter(repository, updates));

app.use((_request, response) => response.status(404).json({ error: "Not found" }));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled backend request error", error);
  const candidate = error as { code?: unknown; status?: unknown; type?: unknown };
  if (candidate.status === 400 || candidate.type === "entity.parse.failed") {
    response.status(400).json({ error: { code: "INVALID_REQUEST", message: "The request body is invalid." } });
    return;
  }
  const databaseFailure = typeof candidate.code === "string" &&
    (/^\d{5}$/.test(candidate.code) || candidate.code.startsWith("ECONN"));
  response.status(databaseFailure ? 503 : 500).json({
    error: databaseFailure
      ? { code: "DATABASE_UNAVAILABLE", message: "The game database is unavailable." }
      : { code: "INTERNAL_ERROR", message: "An internal error occurred." }
  });
});

const httpServer = app.listen(httpPort, "0.0.0.0");
await new Promise<void>((resolve, reject) => {
  httpServer.once("listening", resolve);
  httpServer.once("error", reject);
});
ready = true;

console.log(`${serviceName}/${nodeId} ready on HTTP ${httpPort} and gRPC ${grpcPort}`);

function shutdown(): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  ready = false;
  databaseReady = false;
  httpServer.close(() => {
    grpcServer.tryShutdown(() => {
      updates.close();
      void database.end().finally(() => process.exit(0));
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
