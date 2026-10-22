export const GAME_STATUSES = ["WAITING", "PLACEMENT", "ACTIVE", "FINISHED"] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const COMPLETION_REASONS = ["FLEET_DESTROYED", "SURRENDER", "CANCELLED"] as const;
export type CompletionReason = (typeof COMPLETION_REASONS)[number];

export const ATTACK_RESULTS = ["MISS", "HIT", "SUNK", "WIN"] as const;
export type AttackResult = (typeof ATTACK_RESULTS)[number];

export const CONNECTION_STATUSES = ["NOT_JOINED", "UNKNOWN", "CONNECTED", "LAGGING"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const GAME_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_GAME_CODE",
  "GAME_NOT_FOUND",
  "PLAYER_ALREADY_PLAYING",
  "PLAYER_ALREADY_IN_GAME",
  "PLAYER_NOT_IN_GAME",
  "GAME_FULL",
  "GAME_ALREADY_STARTED",
  "GAME_CANCELLED",
  "GAME_ALREADY_FINISHED",
  "GAME_NOT_IN_PLACEMENT",
  "GAME_NOT_ACTIVE",
  "FLEET_ALREADY_SUBMITTED",
  "INVALID_FLEET_COMPOSITION",
  "SHIP_OUT_OF_BOUNDS",
  "SHIPS_OVERLAP",
  "SHIPS_ADJACENT",
  "INVALID_COORDINATE",
  "NOT_YOUR_TURN",
  "COORDINATE_ALREADY_ATTACKED",
  "DATABASE_UNAVAILABLE",
  "INTERNAL_ERROR"
] as const;
export type GameErrorCode = (typeof GAME_ERROR_CODES)[number];

export type Coordinate = { row: number; column: number };
export type ShipPlacement = { start: Coordinate; end: Coordinate };

export type ApiError = {
  error: { code: GameErrorCode; message: string };
};

export type PlayerSummary = {
  id: string;
  username: string;
  slot: 1 | 2;
  fleetSubmitted: boolean;
  connectionStatus: ConnectionStatus;
};

export type ShipView = {
  length: number;
  cells: Coordinate[];
  hits: Coordinate[];
  sunk: boolean;
};

export type AttackView = {
  coordinate: Coordinate;
  result: AttackResult;
  sunkShipLength?: number;
};

export type PlayerGameView = {
  gameCode: string;
  status: GameStatus;
  version: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  players: PlayerSummary[];
  yourPlayerId: string;
  currentTurn: string | null;
  isYourTurn: boolean;
  yourFleet: ShipView[] | null;
  yourAttacks: AttackView[];
  opponentAttacks: AttackView[];
  winnerPlayerId: string | null;
  completionReason: CompletionReason | null;
};

export type PlayerStateResponse =
  | { state: "NOT_PLAYING" }
  | { state: "PLAYING"; gameCode: string; gameStatus: GameStatus };

export type GameResponse = { game: PlayerGameView };
export type FireResponse = { game: PlayerGameView; outcome: AttackView };
export type UpdateResponse =
  | { type: "GAME_UPDATED"; game: PlayerGameView }
  | {
      type: "HEARTBEAT";
      version: number;
      players: PlayerSummary[];
    };
