import type { GameErrorCode } from "@battleship/game-contract";
import type { DomainError, Result } from "./types.js";

const messages: Record<GameErrorCode, string> = {
  INVALID_REQUEST: "The request body is invalid.",
  INVALID_GAME_CODE: "The game code is invalid.",
  GAME_NOT_FOUND: "The game was not found.",
  PLAYER_ALREADY_PLAYING: "The player is already in an unfinished game.",
  PLAYER_ALREADY_IN_GAME: "The player is already in this game.",
  PLAYER_NOT_IN_GAME: "The player is not a participant in this game.",
  GAME_FULL: "The game already has two players.",
  GAME_ALREADY_STARTED: "The game has already started.",
  GAME_CANCELLED: "The game was cancelled.",
  GAME_ALREADY_FINISHED: "The game has already finished.",
  GAME_NOT_IN_PLACEMENT: "The game is not accepting fleet placements.",
  GAME_NOT_ACTIVE: "The game is not active.",
  FLEET_ALREADY_SUBMITTED: "The player's fleet has already been submitted.",
  INVALID_FLEET_COMPOSITION: "The fleet must contain ships of lengths 5, 4, 3, 3, and 2.",
  SHIP_OUT_OF_BOUNDS: "A ship extends outside the board.",
  SHIPS_OVERLAP: "Ships cannot overlap.",
  SHIPS_ADJACENT: "Ships cannot touch, including diagonally.",
  INVALID_COORDINATE: "The coordinate must be on the 10 by 10 board.",
  NOT_YOUR_TURN: "It is the other player's turn.",
  COORDINATE_ALREADY_ATTACKED: "That coordinate has already been attacked.",
  DATABASE_UNAVAILABLE: "The game database is unavailable.",
  INTERNAL_ERROR: "An internal error occurred."
};

export function domainError(code: GameErrorCode): DomainError {
  return { code, message: messages[code] };
}

export function failure<T>(code: GameErrorCode): Result<T> {
  return { ok: false, error: domainError(code) };
}

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}
