import { authorizeUser } from "@battleship/auth-token";
import { startInternalGrpcServer } from "@battleship/protocol";
import express from "express";
import { Pool } from "pg";

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

await database.query("SELECT 1");
databaseReady = true;

const grpcServer = await startInternalGrpcServer(grpcPort, {
  serviceName,
  nodeId,
  isReady: () => ready && databaseReady
});

const app = express();

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

app.use((_request, response) => response.status(404).json({ error: "Not found" }));

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
      void database.end().finally(() => process.exit(0));
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
