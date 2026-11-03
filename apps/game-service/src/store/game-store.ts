import type { ConnectionStatus, PlayerStateResponse } from "@battleship/game-contract";
import type { CommandOutcome, GameCommand, GameState, Player, Result } from "../game/index.js";

export type CommandResult = { state: GameState; outcome: CommandOutcome };

/** Durable storage for games, matchmaking and presence. */
export interface GameStore {
  /** The store's authoritative clock, used for turn deadlines. */
  currentTime(): Promise<string>;
  create(actor: Player): Promise<Result<CommandResult>>;
  /**
   * Applies a command to the game with the given code atomically. `buildCommand` receives the current
   * state and the store's authoritative timestamp.
   */
  command(
    gameCode: string,
    actor: Player,
    buildCommand: (state: GameState, occurredAt: string) => GameCommand
  ): Promise<Result<CommandResult>>;
  getState(gameCode: string): Promise<Result<GameState>>;
  getPlayerState(playerId: string): Promise<PlayerStateResponse>;
  startMatchmaking(actor: Player): Promise<Result<PlayerStateResponse>>;
  cancelMatchmaking(playerId: string): Promise<PlayerStateResponse>;
  touchPresence(gameId: string, playerId: string): Promise<void>;
  presence(gameId: string, state: GameState): Promise<Record<string, ConnectionStatus>>;
  /** Applies a timeout to one game whose deadline has passed. Returns false when none is due. */
  expireOneTurn(): Promise<boolean>;
}

/** Wakes waiting long-polls on any node when a game or a player's state changes. */
export interface UpdateBus {
  on(gameId: string, listener: (version: number) => void): void;
  off(gameId: string, listener: (version: number) => void): void;
  onPlayer(playerId: string, listener: () => void): void;
  offPlayer(playerId: string, listener: () => void): void;
}
