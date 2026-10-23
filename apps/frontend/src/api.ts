import type {
  FireResponse,
  GameResponse,
  PlayerStateResponse,
  ShipPlacement,
  UpdateResponse
} from "@battleship/game-contract";

export class ApiFailure extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    signal: options.signal,
    cache: "no-store",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });

  const payload = await response.json().catch(() => ({})) as {
    error?: string | { code?: string; message?: string };
  };

  if (!response.ok) {
    const structured = typeof payload.error === "object" ? payload.error : undefined;
    const message = structured?.message ?? (typeof payload.error === "string" ? payload.error : "Request failed");
    throw new ApiFailure(message, response.status, structured?.code);
  }

  return payload as T;
}

export type LoginResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
};

export const api = {
  register: (username: string, password: string) =>
    request<{ created: true; username: string }>("/api/auth/register", {
      method: "POST",
      body: { username, password }
    }),

  login: (username: string, password: string) =>
    request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: { username, password }
    }),

  playerState: (token: string) =>
    request<PlayerStateResponse>("/api/backend/player/state", { token }),

  getGame: (token: string, gameCode: string) =>
    request<GameResponse>(`/api/backend/games/${gameCode}`, { token }),

  createGame: (token: string) =>
    request<GameResponse>("/api/backend/games", { method: "POST", token, body: {} }),

  joinGame: (token: string, gameCode: string) =>
    request<GameResponse>(`/api/backend/games/${gameCode}/join`, { method: "POST", token, body: {} }),

  placeFleet: (token: string, gameCode: string, ships: ShipPlacement[]) =>
    request<GameResponse>(`/api/backend/games/${gameCode}/fleet`, {
      method: "PUT",
      token,
      body: { ships }
    }),

  fire: (token: string, gameCode: string, row: number, column: number) =>
    request<FireResponse>(`/api/backend/games/${gameCode}/fire`, {
      method: "POST",
      token,
      body: { coordinate: { row, column } }
    }),

  cancel: (token: string, gameCode: string) =>
    request<GameResponse>(`/api/backend/games/${gameCode}/cancel`, { method: "POST", token, body: {} }),

  surrender: (token: string, gameCode: string) =>
    request<GameResponse>(`/api/backend/games/${gameCode}/surrender`, { method: "POST", token, body: {} }),

  updates: (token: string, gameCode: string, version: number, signal: AbortSignal) =>
    request<UpdateResponse>(`/api/backend/games/${gameCode}/updates?afterVersion=${version}`, {
      token,
      signal
    })
};
