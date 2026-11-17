import type { CommandMetadata, Coordinate, GameErrorCode, PlayerStateResponse, ShipPlacement } from "@battleship/game-contract";
import { Router, type Request, type Response } from "express";
import { domainError, type DomainError, type GameState, type Player, type Result } from "../game/index.js";
import { GameRepository } from "../database/game-repository.js";
import { GameUpdateBus } from "../database/update-bus.js";
import type { MatchArchive } from "../archive/index.js";

const GAME_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

function statusFor(code: GameErrorCode): number {
  if (code === "GAME_NOT_FOUND" || code === "MATCH_NOT_FOUND") return 404;
  if (code === "PLAYER_NOT_IN_GAME") return 403;
  if (code === "DATABASE_UNAVAILABLE") return 503;
  if (["INVALID_REQUEST", "INVALID_GAME_CODE", "INVALID_FLEET_COMPOSITION", "SHIP_OUT_OF_BOUNDS", "SHIPS_OVERLAP", "SHIPS_ADJACENT", "INVALID_COORDINATE"].includes(code)) return 400;
  if (code === "INTERNAL_ERROR") return 500;
  return 409;
}

function sendError(response: Response, error: DomainError): void {
  response.status(statusFor(error.code)).json({ error });
}

function actor(request: Request): Player {
  return { id: request.user!.id, username: request.user!.username };
}

function gameCode(request: Request, response: Response): string | null {
  const raw = String(request.params.gameCode ?? "").trim().toUpperCase();
  if (!GAME_CODE_PATTERN.test(raw)) {
    sendError(response, domainError("INVALID_GAME_CODE"));
    return null;
  }
  return raw;
}

function commandMetadata(value: unknown): CommandMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.commandId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.commandId) || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) return null;
  return { commandId: body.commandId, expectedVersion: body.expectedVersion as number };
}

function coordinate(value: unknown): Coordinate | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.row) || !Number.isInteger(candidate.column)) return null;
  return { row: candidate.row as number, column: candidate.column as number };
}

function fleet(value: unknown): ShipPlacement[] | null {
  if (typeof value !== "object" || value === null) return null;
  const ships = (value as Record<string, unknown>).ships;
  if (!Array.isArray(ships)) return null;
  const parsed: ShipPlacement[] = [];
  for (const ship of ships) {
    if (typeof ship !== "object" || ship === null) return null;
    const candidate = ship as Record<string, unknown>;
    const start = coordinate(candidate.start);
    const end = coordinate(candidate.end);
    if (!start || !end) return null;
    parsed.push({ start, end });
  }
  return parsed;
}

async function sendGame(response: Response, repository: GameRepository, state: GameState, viewerId: string, status = 200): Promise<void> {
  const view = await repository.view(state, viewerId);
  if (!view.ok) return sendError(response, view.error);
  response.status(status).json({ game: view.value });
}

async function readParticipantGame(
  repository: GameRepository,
  code: string,
  playerId: string
): Promise<Result<{ state: GameState }>> {
  const state = await repository.getState(code);
  if (!state.ok) return state;
  const view = await repository.view(state.value, playerId);
  if (!view.ok) return view;
  return { ok: true, value: { state: state.value } };
}

export function createGameRouter(repository: GameRepository, updates: GameUpdateBus, archive: MatchArchive): Router {
  const router = Router();

  router.get("/time", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ serverNow: await repository.currentTime() });
  });

  const matchmakingUpdate = (response: Response, state: PlayerStateResponse): void => {
    if (state.state === "PLAYING") {
      response.json({ type: "MATCH_FOUND", gameCode: state.gameCode, gameStatus: state.gameStatus });
    } else if (state.state === "SEARCHING") {
      response.json({ type: "HEARTBEAT", searchStartedAt: state.searchStartedAt });
    } else {
      response.json({ type: "NOT_SEARCHING" });
    }
  };

  router.post("/matchmaking", async (request, response) => {
    const result = await repository.startMatchmaking(actor(request));
    if (!result.ok) return sendError(response, result.error);
    response.status(result.value.state === "SEARCHING" ? 202 : 200).json(result.value);
  });

  router.delete("/matchmaking", async (request, response) => {
    response.json(await repository.cancelMatchmaking(request.user!.id));
  });

  router.get("/matchmaking/updates", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const playerId = request.user!.id;
    const searchId = request.query.searchId;
    if (typeof searchId !== "string" || !/^[1-9][0-9]*$/.test(searchId)) return sendError(response, domainError("INVALID_REQUEST"));

    let closed = false;
    let notified = false;
    let wake: ((reason: "update" | "timeout" | "closed") => void) | null = null;
    const onUpdate = () => { notified = true; wake?.("update"); };
    const onClose = () => { closed = true; wake?.("closed"); };
    updates.onPlayer(playerId, onUpdate);
    response.on("close", onClose);
    let token: string | null = null;
    try {
      const initial = await repository.beginMatchmakingPoll(playerId, searchId);
      token = initial.token;
      if (!token) {
        if (!closed) matchmakingUpdate(response, initial.state);
        return;
      }
      const secondRead = await repository.getPlayerState(playerId);
      if (secondRead.state === "SEARCHING" && secondRead.searchId === searchId && !closed && !notified) {
        await new Promise<"update" | "timeout" | "closed">((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 3_000);
          wake = (value) => { clearTimeout(timer); resolve(value); };
        });
      }
      const state = await repository.finishMatchmakingPoll(playerId, searchId, token);
      token = null;
      if (!closed && !response.writableEnded) matchmakingUpdate(response, state);
    } finally {
      updates.offPlayer(playerId, onUpdate);
      response.off("close", onClose);
      if (token) await repository.finishMatchmakingPoll(playerId, searchId, token);
    }
  });

  router.post("/games", async (request, response) => {
    const result = await repository.create(actor(request));
    if (!result.ok) return sendError(response, result.error);
    await sendGame(response, repository, result.value.state, request.user!.id, 201);
  });

  router.post("/games/:gameCode/join", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const metadata = commandMetadata(request.body); if (!metadata) return sendError(response, domainError("INVALID_REQUEST"));
    const player = actor(request);
    const result = await repository.command(code, player, metadata, { type: "JOIN_GAME" }, (_state, occurredAt) => ({ type: "JOIN_GAME", actor: player, occurredAt }));
    if (!result.ok) return sendError(response, result.error);
    response.json(result.value);
  });

  router.put("/games/:gameCode/fleet", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const ships = fleet(request.body);
    if (!ships) return sendError(response, domainError("INVALID_REQUEST"));
    const metadata = commandMetadata(request.body); if (!metadata) return sendError(response, domainError("INVALID_REQUEST"));
    const player = actor(request);
    const result = await repository.command(code, player, metadata, { type: "PLACE_FLEET", ships }, (_state, occurredAt) => ({ type: "PLACE_FLEET", actor: player, ships, occurredAt }));
    if (!result.ok) return sendError(response, result.error);
    response.json(result.value);
  });

  router.post("/games/:gameCode/fire", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const shot = coordinate(request.body?.coordinate);
    if (!shot) return sendError(response, domainError("INVALID_REQUEST"));
    const metadata = commandMetadata(request.body); if (!metadata) return sendError(response, domainError("INVALID_REQUEST"));
    const player = actor(request);
    const result = await repository.command(code, player, metadata, { type: "FIRE", coordinate: shot }, (_state, occurredAt) => ({ type: "FIRE", actor: player, coordinate: shot, occurredAt }));
    if (!result.ok) return sendError(response, result.error);
    response.json(result.value);
  });

  for (const action of ["cancel", "surrender"] as const) {
    router.post(`/games/:gameCode/${action}`, async (request, response) => {
      const code = gameCode(request, response); if (!code) return;
      const metadata = commandMetadata(request.body); if (!metadata) return sendError(response, domainError("INVALID_REQUEST"));
      const player = actor(request);
      const result = await repository.command(code, player, metadata, { type: action === "cancel" ? "CANCEL_GAME" : "SURRENDER" }, (_state, occurredAt) => ({
        type: action === "cancel" ? "CANCEL_GAME" : "SURRENDER",
        actor: player,
        occurredAt
      }));
      if (!result.ok) return sendError(response, result.error);
      response.json(result.value);
    });
  }

  router.get("/player/state", async (request, response) => {
    response.json(await repository.getPlayerState(request.user!.id));
  });

  router.get("/player/profile", async (request, response) => {
    const rawLimit = request.query.limit === undefined ? 20 : Number(request.query.limit);
    const cursor = request.query.cursor === undefined ? null : String(request.query.cursor);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50 || (cursor !== null && cursor.length > 1_024)) {
      return sendError(response, domainError("INVALID_REQUEST"));
    }
    try {
      const page = await archive.listPlayerMatches(request.user!.id, cursor, rawLimit);
      response.json({
        player: { id: request.user!.id, username: request.user!.username },
        ...page,
        statistics: await repository.getPlayerStatistics(request.user!.id)
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_CURSOR") {
        return sendError(response, domainError("INVALID_REQUEST"));
      }
      throw error;
    }
  });

  router.get("/player/matches/:matchId", async (request, response) => {
    const matchId = String(request.params.matchId ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(matchId)) {
      return sendError(response, domainError("INVALID_REQUEST"));
    }
    const match = await archive.getPlayerMatch(request.user!.id, matchId);
    if (!match) return sendError(response, domainError("MATCH_NOT_FOUND"));
    response.json({ match });
  });

  router.get("/games/:gameCode", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const result = await readParticipantGame(repository, code, request.user!.id);
    if (!result.ok) return sendError(response, result.error);
    await sendGame(response, repository, result.value.state, request.user!.id);
  });

  router.get("/games/:gameCode/updates", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const code = gameCode(request, response); if (!code) return;
    const afterVersion = Number(request.query.afterVersion);
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0) {
      return sendError(response, domainError("INVALID_REQUEST"));
    }
    const initial = await readParticipantGame(repository, code, request.user!.id);
    if (!initial.ok) return sendError(response, initial.error);
    await repository.touchPresence(initial.value.state.gameId, request.user!.id);
    if (initial.value.state.version > afterVersion) {
      const view = await repository.view(initial.value.state, request.user!.id);
      if (!view.ok) return sendError(response, view.error);
      return response.json({ type: "GAME_UPDATED", game: view.value });
    }

    let closed = false;
    let notified = false;
    let wake: ((reason: "update" | "timeout" | "closed") => void) | null = null;
    const onUpdate = () => { notified = true; wake?.("update"); };
    const onClose = () => { closed = true; wake?.("closed"); };
    updates.on(initial.value.state.gameId, onUpdate);
    response.on("close", onClose);
    // If the read fails, unsubscribe before the error propagates, or the listeners leak.
    const secondRead = await readParticipantGame(repository, code, request.user!.id).catch((error: unknown) => {
      updates.off(initial.value.state.gameId, onUpdate);
      response.off("close", onClose);
      throw error;
    });
    if (!secondRead.ok) {
      updates.off(initial.value.state.gameId, onUpdate);
      response.off("close", onClose);
      return sendError(response, secondRead.error);
    }
    let reason: "update" | "timeout" | "closed" = "update";
    if (secondRead.value.state.version <= afterVersion && !closed && !notified) {
      reason = await new Promise((resolve) => {
        wake = resolve;
        const timer = setTimeout(() => resolve("timeout"), 3_000);
        const originalWake = wake;
        wake = (value) => { clearTimeout(timer); originalWake(value); };
      });
    }
    updates.off(initial.value.state.gameId, onUpdate);
    response.off("close", onClose);
    if (reason === "closed" || response.writableEnded) return;

    const latest = await readParticipantGame(repository, code, request.user!.id);
    if (!latest.ok) return sendError(response, latest.error);
    const view = await repository.view(latest.value.state, request.user!.id);
    if (!view.ok) return sendError(response, view.error);
    if (latest.value.state.version > afterVersion) {
      return response.json({ type: "GAME_UPDATED", game: view.value });
    }
    response.json({ type: "HEARTBEAT", version: view.value.version, players: view.value.players });
  });

  return router;
}
