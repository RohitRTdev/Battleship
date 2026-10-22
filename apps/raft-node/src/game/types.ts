import type {
  AttackResult,
  CompletionReason,
  Coordinate,
  GameErrorCode,
  GameStatus,
  ShipPlacement
} from "@battleship/game-contract";

export type Player = { id: string; username: string };
export type Ship = { length: number; cells: Coordinate[] };
export type Fleet = { ships: Ship[] };
export type Attack = {
  attackerId: string;
  coordinate: Coordinate;
  result: AttackResult;
  sunkShipLength?: number;
};

export type GameState = {
  gameId: string;
  gameCode: string;
  status: GameStatus;
  version: number;
  playerOne: Player;
  playerTwo: Player | null;
  playerOneFleet: Fleet | null;
  playerTwoFleet: Fleet | null;
  attacks: Attack[];
  currentTurn: string | null;
  winnerPlayerId: string | null;
  completionReason: CompletionReason | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};

export type CreateGameCommand = {
  type: "CREATE_GAME";
  gameId: string;
  gameCode: string;
  actor: Player;
  occurredAt: string;
};

export type GameCommand =
  | { type: "JOIN_GAME"; actor: Player; occurredAt: string }
  | { type: "PLACE_FLEET"; actor: Player; ships: ShipPlacement[]; occurredAt: string }
  | { type: "FIRE"; actor: Player; coordinate: Coordinate; occurredAt: string }
  | { type: "CANCEL_GAME"; actor: Player; occurredAt: string }
  | { type: "SURRENDER"; actor: Player; occurredAt: string };

export type PersistedCommand = CreateGameCommand | GameCommand;
export type GameEvent = { type: PersistedCommand["type"]; command: PersistedCommand };

export type CommandOutcome =
  | { type: "GAME_CREATED" }
  | { type: "GAME_JOINED" }
  | { type: "FLEET_ACCEPTED" }
  | { type: "GAME_CANCELLED" }
  | { type: "GAME_SURRENDERED" }
  | {
      type: AttackResult;
      coordinate: Coordinate;
      sunkShipLength?: number;
    };

export type DomainError = { code: GameErrorCode; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError };
export type Transition = { state: GameState; event: GameEvent; outcome: CommandOutcome };
