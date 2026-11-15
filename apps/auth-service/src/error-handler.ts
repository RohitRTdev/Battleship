import type { ErrorRequestHandler } from "express";

export const authErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  console.error("Unhandled auth request error", error);
  const candidate = (error && typeof error === "object" ? error : {}) as { status?: unknown; type?: unknown };
  if (candidate.status === 413 || candidate.type === "entity.too.large") {
    response.status(413).json({ error: "The request body is too large" });
    return;
  }
  if (candidate.status === 400 || candidate.type === "entity.parse.failed") {
    response.status(400).json({ error: "The request body is invalid" });
    return;
  }

  response.status(500).json({ error: "Internal server error" });
};
