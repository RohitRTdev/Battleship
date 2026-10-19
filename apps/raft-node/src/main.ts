import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { startInternalGrpcServer } from "@battleship/protocol";
import Database from "better-sqlite3";
import express from "express";

const serviceName = process.env.SERVICE_NAME ?? "raft-backend";
const nodeId = process.env.NODE_ID ?? "backend-node-unknown";
const httpPort = Number(process.env.HTTP_PORT ?? 8080);
const grpcPort = Number(process.env.GRPC_PORT ?? 9090);
const databasePath = process.env.DATABASE_PATH ?? "/data/game.db";

let ready = false;
mkdirSync(dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("synchronous = FULL");
database.pragma("user_version = 0");

const grpcServer = await startInternalGrpcServer(grpcPort, {
  serviceName,
  nodeId,
  isReady: () => ready
});

const app = express();

app.get("/healthz", (_request, response) => {
  response.status(ready ? 200 : 503).json({ service: serviceName, nodeId, ready });
});

app.use((_request, response) => response.status(404).json({ error: "Not found" }));

const httpServer = app.listen(httpPort, "0.0.0.0");
await new Promise<void>((resolve, reject) => {
  httpServer.once("listening", resolve);
  httpServer.once("error", reject);
});
ready = true;

console.log(`${serviceName}/${nodeId} ready on HTTP ${httpPort} and gRPC ${grpcPort}`);

function shutdown(): void {
  ready = false;
  httpServer.close(() => {
    grpcServer.tryShutdown(() => {
      database.close();
      process.exit(0);
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
