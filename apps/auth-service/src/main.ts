import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { authorizeUser, createToken } from "@battleship/auth-token";
import { startInternalGrpcServer } from "@battleship/protocol";
import Database from "better-sqlite3";
import express from "express";

import * as types from "./types.js";

const serviceName = process.env.SERVICE_NAME ?? "auth-service";
const nodeId = process.env.NODE_ID ?? "auth-node-1";
const httpPort = Number(process.env.HTTP_PORT ?? 8080);
const grpcPort = Number(process.env.GRPC_PORT ?? 9090);
const databasePath = process.env.DATABASE_PATH ?? "/data/auth.db";

let ready = false;
mkdirSync(dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("synchronous = FULL");
database.pragma("user_version = 0");

// Create the user db schema
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const insertUser = database.prepare<[string, string]>(
  "INSERT INTO users (username, password) VALUES (?, ?)"
);

const getUser = database.prepare<[string], types.UserRow>(
  "SELECT id, username, password FROM users WHERE username = ?"
);

const getAllUserSummaries = database.prepare<[], types.UserSummaryRow>(
  "SELECT id, username, created_at FROM users ORDER BY id"
);

const deleteUserById = database.prepare<[number]>(
  "DELETE FROM users WHERE id = ?"
);

const deleteAllUsers = database.prepare("DELETE FROM users");

const grpcServer = await startInternalGrpcServer(grpcPort, {
  serviceName,
  nodeId,
  isReady: () => ready
});

const app = express();
app.use(express.json());

app.get("/healthz", (_request, response) => {
  response.status(ready ? 200 : 503).json({ service: serviceName, nodeId, ready });
});


function isCredentials(value: unknown): value is types.Credentials {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;

  return (
    typeof body.username === "string" &&
    typeof body.password === "string" &&
    body.username.trim().length > 0 &&
    body.password.length > 0
  );
}

app.post("/api/auth/register", (request, response) => {
  if (!isCredentials(request.body)) {
    response.status(400).json({
      error: "Username and password must be strings"
    });
    return;
  }

  const { username, password } = request.body;
  const normUserName = username.trim().toLowerCase();

  // Insert new user into database
  try {
    insertUser.run(normUserName, password);
  }
  catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      response.status(409).json({
        error: "Username already exists"
      });
      return;
    }

    console.error(error);

    response.status(500).json({
      error: "Could not create user"
    });
    return;
  }

  response.status(201).json({ created: true, username: normUserName });
});

app.post("/api/auth/login", (request, response) => {
  if (!isCredentials(request.body)) {
    response.status(400).json({
      error: "Username and password must be strings"
    });
    return;
  }

  const { username, password } = request.body;
  const normUser = username.trim().toLowerCase();
  const userInfo = getUser.get(normUser);
  if (!userInfo) {
    response.status(400).json({
      error: "Invalid user"
    });
    return;
  }

  if (password !== userInfo.password) {
    response.status(400).json({
      error: "Invalid credentials"
    });
    return;
  }

  const token = createToken({
    id: String(userInfo.id),
    username: userInfo.username
  });

  response.status(200).json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 3600
  });
});

// These database-control endpoints are intentionally unauthenticated so they
// remain usable even when the database is empty. They only exist when the
// service is explicitly started with ENABLE_TEST_ROUTES=true.
app.use("/api/auth/_test", (_request, response, next) => {
  if (process.env.ENABLE_TEST_ROUTES !== "true") {
    response.status(404).json({ error: "Not found" });
    return;
  }

  next();
});

app.get("/api/auth/_test/users", (_request, response) => {
  response.status(200).json({ users: getAllUserSummaries.all() });
});

app.delete("/api/auth/_test/users", (_request, response) => {
  const result = deleteAllUsers.run();
  response.status(200).json({ deleted: result.changes });
});

app.delete("/api/auth/_test/users/:userId", (request, response) => {
  const userId = Number(request.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    response.status(400).json({ error: "User ID must be a positive integer" });
    return;
  }

  const result = deleteUserById.run(userId);
  if (result.changes === 0) {
    response.status(404).json({ error: "User not found" });
    return;
  }

  response.status(200).json({ deleted: result.changes, id: userId });
});

// Registration, login, and health checks stay public. Any auth-service routes
// registered below this point require a valid access token.
app.use(authorizeUser);

app.use((_request, response) => response.status(404).json({ error: "Not found" }));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled auth request error", error);
  const candidate = error as { status?: unknown; type?: unknown };
  if (candidate.status === 400 || candidate.type === "entity.parse.failed") {
    response.status(400).json({ error: "The request body is invalid" });
    return;
  }

  response.status(500).json({ error: "Internal server error" });
});

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
