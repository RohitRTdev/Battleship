import type { Coordinate, GameErrorCode, ShipPlacement } from "@battleship/game-contract";
import { Router, type Request, type Response } from "express";
import { domainError, type DomainError, type GameState, type Player, type Result } from "../game/index.js";
import { GameRepository } from "../database/game-repository.js";
import { GameUpdateBus } from "../database/update-bus.js";

const GAME_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

function statusFor(code: GameErrorCode): number {
  if (code === "GAME_NOT_FOUND") return 404;
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

export function createGameRouter(repository: GameRepository, updates: GameUpdateBus): Router {
  const router = Router();

  router.post("/games", async (request, response) => {
    const result = await repository.create(actor(request));
    if (!result.ok) return sendError(response, result.error);
    await sendGame(response, repository, result.value.state, request.user!.id, 201);
  });

  router.post("/games/:gameCode/join", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const player = actor(request);
    const result = await repository.command(code, player, (_state, occurredAt) => ({ type: "JOIN_GAME", actor: player, occurredAt }));
    if (!result.ok) return sendError(response, result.error);
    await sendGame(response, repository, result.value.state, player.id);
  });

  router.put("/games/:gameCode/fleet", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const ships = fleet(request.body);
    if (!ships) return sendError(response, domainError("INVALID_REQUEST"));
    const player = actor(request);
    const result = await repository.command(code, player, (_state, occurredAt) => ({ type: "PLACE_FLEET", actor: player, ships, occurredAt }));
    if (!result.ok) return sendError(response, result.error);
    await sendGame(response, repository, result.value.state, player.id);
  });

  router.post("/games/:gameCode/fire", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const shot = coordinate(request.body?.coordinate);
    if (!shot) return sendError(response, domainError("INVALID_REQUEST"));
    const player = actor(request);
    const result = await repository.command(code, player, (_state, occurredAt) => ({ type: "FIRE", actor: player, coordinate: shot, occurredAt }));
    if (!result.ok) return sendError(response, result.error);
    const view = await repository.view(result.value.state, player.id);
    if (!view.ok) return sendError(response, view.error);
    const outcome = repository.attackOutcome(result.value.outcome);
    if (!outcome) return sendError(response, domainError("INTERNAL_ERROR"));
    response.json({ game: view.value, outcome });
  });

  for (const action of ["cancel", "surrender"] as const) {
    router.post(`/games/:gameCode/${action}`, async (request, response) => {
      const code = gameCode(request, response); if (!code) return;
      const player = actor(request);
      const result = await repository.command(code, player, (_state, occurredAt) => ({
        type: action === "cancel" ? "CANCEL_GAME" : "SURRENDER",
        actor: player,
        occurredAt
      }));
      if (!result.ok) return sendError(response, result.error);
      await sendGame(response, repository, result.value.state, player.id);
    });
  }

  router.get("/player/state", async (request, response) => {
    response.json(await repository.getPlayerState(request.user!.id));
  });

  router.get("/games/:gameCode", async (request, response) => {
    const code = gameCode(request, response); if (!code) return;
    const result = await readParticipantGame(repository, code, request.user!.id);
    if (!result.ok) return sendError(response, result.error);
    await sendGame(response, repository, result.value.state, request.user!.id);
  });

  router.get("/games/:gameCode/updates", async (request, response) => {
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
    let wake: ((reason: "update" | "timeout" | "closed") => void) | null = null;
    const onUpdate = () => wake?.("update");
    const onClose = () => { closed = true; wake?.("closed"); };
    updates.on(initial.value.state.gameId, onUpdate);
    response.on("close", onClose);
    const secondRead = await readParticipantGame(repository, code, request.user!.id);
    if (!secondRead.ok) {
      updates.off(initial.value.state.gameId, onUpdate);
      response.off("close", onClose);
      return sendError(response, secondRead.error);
    }
    let reason: "update" | "timeout" | "closed" = "update";
    if (secondRead.value.state.version <= afterVersion && !closed) {
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
