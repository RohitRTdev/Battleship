import type { ErrorRequestHandler } from "express";

// These messages are emitted by pg and pg-pool without an error code.
const databaseTimeoutMessages = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Query read timeout"
]);

export const backendErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  console.error("Unhandled backend request error", error);
  const candidate = (error && typeof error === "object" ? error : {}) as {
    code?: unknown; status?: unknown; type?: unknown; message?: unknown;
  };
  if (candidate.status === 413 || candidate.type === "entity.too.large") {
    response.status(413).json({ error: { code: "INVALID_REQUEST", message: "The request body is too large." } });
    return;
  }
  if (candidate.status === 400 || candidate.type === "entity.parse.failed") {
    response.status(400).json({ error: { code: "INVALID_REQUEST", message: "The request body is invalid." } });
    return;
  }
  const databaseFailure = (typeof candidate.code === "string" &&
    (/^\d{5}$/.test(candidate.code) || candidate.code.startsWith("ECONN"))) ||
    (typeof candidate.message === "string" && databaseTimeoutMessages.has(candidate.message));
  response.status(databaseFailure ? 503 : 500).json({
    error: databaseFailure
      ? { code: "DATABASE_UNAVAILABLE", message: "The game database is unavailable." }
      : { code: "INTERNAL_ERROR", message: "An internal error occurred." }
  });
};
