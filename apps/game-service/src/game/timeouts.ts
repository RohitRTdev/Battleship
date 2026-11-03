import type { GameErrorCode } from "@battleship/game-contract";
import type { GameCommand, GameState } from "./types.js";

/** How long after a deadline the server still accepts the move that was racing it. */
export const TIMEOUT_GRACE_MS = 500;

function overdue(deadline: string | null, now: string): deadline is string {
  return deadline !== null && Date.parse(now) >= Date.parse(deadline) + TIMEOUT_GRACE_MS;
}

/** The timeout to apply to a game whose turn or placement deadline has passed, or null if none is due. */
export function dueTimeout(state: GameState, now: string): GameCommand | null {
  if (state.status === "ACTIVE" && state.currentTurn && overdue(state.turnDeadlineAt, now)) {
    const actor = state.currentTurn === state.playerOne.id ? state.playerOne : state.playerTwo!;
    return { type: "TURN_TIMEOUT", actor, deadline: state.turnDeadlineAt, occurredAt: now };
  }
  if (state.status === "PLACEMENT" && overdue(state.placementDeadlineAt, now)) {
    return { type: "PLACEMENT_TIMEOUT", actor: state.playerOne, deadline: state.placementDeadlineAt, occurredAt: now };
  }
  return null;
}

/**
 * A participant's move that arrives after the deadline it was racing applies the timeout instead.
 * Returns the timeout and the error the move should fail with, or null if the move goes ahead.
 */
export function lateMoveTimeout(
  state: GameState,
  command: GameCommand,
  now: string
): { timeout: GameCommand; error: GameErrorCode } | null {
  const participant = state.playerOne.id === command.actor.id || state.playerTwo?.id === command.actor.id;
  const timeout = participant ? dueTimeout(state, now) : null;
  if (timeout?.type === "TURN_TIMEOUT" && (command.type === "FIRE" || command.type === "SURRENDER")) {
    return { timeout, error: "TURN_TIMED_OUT" };
  }
  if (timeout?.type === "PLACEMENT_TIMEOUT" && command.type === "PLACE_FLEET") return { timeout, error: "GAME_CANCELLED" };
  return null;
}
