import type { ArchivedMatchResponse, FireResponse, GameResponse, MatchmakingUpdateResponse, PlayerProfileResponse, PlayerStateResponse, ShipPlacement, UpdateResponse } from "@battleship/game-contract";
import type { AuthProvider } from "./auth";

export class ApiFailure extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "ApiFailure";
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Your session expired. Sign in again to continue.");
    this.name = "SessionExpiredError";
  }
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };
const REQUEST_TIMEOUT_MS = 10_000;

export function createApi(auth: AuthProvider) {
  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    const send = async (token: string) => fetch(path, {
      method: options.method ?? "GET",
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });

    try {
      let response = await send(await auth.getAccessToken());
      if (response.status === 401) {
        const refreshedToken = await auth.refreshSession();
        if (!refreshedToken) throw new SessionExpiredError();
        response = await send(refreshedToken);
      }

      const payload = await response.json().catch(() => ({})) as { error?: string | { code?: string; message?: string } };
      if (!response.ok) {
        const structured = typeof payload.error === "object" ? payload.error : undefined;
        const message = structured?.message ?? (typeof payload.error === "string" ? payload.error : "Request failed");
        throw new ApiFailure(message, response.status, structured?.code);
      }
      return payload as T;
    } catch (error) {
      if (timedOut) throw new Error("Request timed out. Please try again.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  return {
    playerState: () => request<PlayerStateResponse>("/api/backend/player/state"),
    playerProfile: (cursor?: string, limit = 20) => request<PlayerProfileResponse>(`/api/backend/player/profile?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    archivedMatch: (matchId: string, signal?: AbortSignal) => request<ArchivedMatchResponse>(`/api/backend/player/matches/${encodeURIComponent(matchId)}`, { signal }),
    startMatchmaking: () => request<PlayerStateResponse>("/api/backend/matchmaking", { method: "POST", body: {} }),
    cancelMatchmaking: () => request<PlayerStateResponse>("/api/backend/matchmaking", { method: "DELETE" }),
    matchmakingUpdates: (signal: AbortSignal) => request<MatchmakingUpdateResponse>("/api/backend/matchmaking/updates", { signal }),
    getGame: (gameCode: string, signal?: AbortSignal) => request<GameResponse>(`/api/backend/games/${gameCode}`, { signal }),
    createGame: () => request<GameResponse>("/api/backend/games", { method: "POST", body: {} }),
    joinGame: (gameCode: string) => request<GameResponse>(`/api/backend/games/${gameCode}/join`, { method: "POST", body: {} }),
    placeFleet: (gameCode: string, ships: ShipPlacement[]) => request<GameResponse>(`/api/backend/games/${gameCode}/fleet`, { method: "PUT", body: { ships } }),
    fire: (gameCode: string, row: number, column: number) => request<FireResponse>(`/api/backend/games/${gameCode}/fire`, { method: "POST", body: { coordinate: { row, column } } }),
    cancel: (gameCode: string) => request<GameResponse>(`/api/backend/games/${gameCode}/cancel`, { method: "POST", body: {} }),
    surrender: (gameCode: string) => request<GameResponse>(`/api/backend/games/${gameCode}/surrender`, { method: "POST", body: {} }),
    updates: (gameCode: string, version: number, signal: AbortSignal) => request<UpdateResponse>(`/api/backend/games/${gameCode}/updates?afterVersion=${version}`, { signal })
  };
}
