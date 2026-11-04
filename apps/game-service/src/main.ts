import { authorizeUser, createTokenVerifierFromEnvironment } from "@battleship/auth-token";
import express from "express";
import path from "node:path";
import { createStoreBackend } from "./store/index.js";
import { createGameRouter } from "./http/game-router.js";
import { createMatchArchive } from "./archive/index.js";
import { ArchiveWorker } from "./archive/archive-worker.js";

const serviceName = process.env.SERVICE_NAME ?? "game-service";
const nodeId = process.env.NODE_ID ?? "backend-node-unknown";
const httpPort = Number(process.env.HTTP_PORT ?? 8080);
const storeMode = process.env.STORE_MODE ?? "postgres";
const tokenVerifier = await createTokenVerifierFromEnvironment();
const production = process.env.APP_ENV === "prod";
const frontendDirectory = path.resolve(process.cwd(), "apps/frontend/dist");

const disableTimeout = process.env.DISABLE_TIMEOUT ?? "false";
if (disableTimeout !== "true" && disableTimeout !== "false") throw new Error("DISABLE_TIMEOUT must be true or false");
const timeoutEnabled = disableTimeout === "false";

let ready = false;
let shuttingDown = false;

const backend = createStoreBackend(storeMode, { timeoutEnabled });
const { store, updates } = backend;
let timeoutWorkerRunning = false;
let timeoutWorkerClosed = false;
async function expireTurns(): Promise<void> {
  if (timeoutWorkerRunning || timeoutWorkerClosed) return;
  timeoutWorkerRunning = true;
  try { while (!timeoutWorkerClosed && await store.expireOneTurn()) { /* drain expired games */ } }
  catch (error) { console.error("Turn timeout worker failed", error); }
  finally { timeoutWorkerRunning = false; }
}
let timeoutTimer: NodeJS.Timeout | null = null;
const archive = createMatchArchive();
const archiveWorker = new ArchiveWorker(backend.outbox, archive);

await backend.start();
archiveWorker.start();
if (timeoutEnabled) { void expireTurns(); timeoutTimer = setInterval(() => void expireTurns(), 1_000); }


const app = express();
app.disable("etag");
app.use(express.json({ limit: "32kb" }));
app.use((_request, response, next) => {
  response.setHeader("X-Battleship-Node", nodeId);
  next();
});

app.get("/healthz", async (_request, response) => {
  const databaseReady = await backend.checkHealth();
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

app.use("/api/backend", authorizeUser(tokenVerifier), createGameRouter(store, updates, archive));

app.use((_request, response) => response.status(404).json({ error: "Not found" }));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled backend request error", error);
  const candidate = error as { code?: unknown; status?: unknown; type?: unknown };
  if (candidate.status === 400 || candidate.type === "entity.parse.failed") {
    response.status(400).json({ error: { code: "INVALID_REQUEST", message: "The request body is invalid." } });
    return;
  }
  const databaseFailure = backend.isUnavailableError(error);
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

console.log(`${serviceName}/${nodeId} ready on HTTP ${httpPort} (store: ${storeMode})`);

function shutdown(): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  ready = false;
  httpServer.close(() => {
    timeoutWorkerClosed = true;
    if (timeoutTimer) clearInterval(timeoutTimer);
    archiveWorker.close();
    void backend.close().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
