import { coordinatesEqual, isValidCoordinate, validateFleet } from "./rules.js";
import { failure, success } from "./errors.js";
import type {
  Attack,
  CommandOutcome,
  CreateGameCommand,
  Fleet,
  GameCommand,
  GameEvent,
  GameState,
  PersistedCommand,
  Player,
  Result,
  Transition
} from "./types.js";

function participant(state: GameState, playerId: string): Player | null {
  if (state.playerOne.id === playerId) return state.playerOne;
  if (state.playerTwo?.id === playerId) return state.playerTwo;
  return null;
}

function opponent(state: GameState, playerId: string): Player | null {
  if (state.playerOne.id === playerId) return state.playerTwo;
  if (state.playerTwo?.id === playerId) return state.playerOne;
  return null;
}

function fleetFor(state: GameState, playerId: string): Fleet | null {
  if (state.playerOne.id === playerId) return state.playerOneFleet;
  if (state.playerTwo?.id === playerId) return state.playerTwoFleet;
  return null;
}

function transition(state: GameState, command: GameCommand, outcome: CommandOutcome): Result<Transition> {
  return success({
    state: { ...state, version: state.version + 1 },
    event: { type: command.type, command },
    outcome
  });
}

export function createGame(command: CreateGameCommand): Result<Transition> {
  const state: GameState = {
    gameId: command.gameId,
    gameCode: command.gameCode,
    status: "WAITING",
    version: 1,
    playerOne: command.actor,
    playerTwo: null,
    playerOneFleet: null,
    playerTwoFleet: null,
    attacks: [],
    currentTurn: null,
    winnerPlayerId: null,
    completionReason: null,
    createdAt: command.occurredAt,
    startedAt: null,
    endedAt: null
  };
  return success({ state, event: { type: command.type, command }, outcome: { type: "GAME_CREATED" } });
}

export function applyGameCommand(state: GameState, command: GameCommand): Result<Transition> {
  switch (command.type) {
    case "JOIN_GAME": {
      if (participant(state, command.actor.id)) return failure("PLAYER_ALREADY_IN_GAME");
      if (state.status === "FINISHED") {
        return failure(state.completionReason === "CANCELLED" ? "GAME_CANCELLED" : "GAME_ALREADY_FINISHED");
      }
      if (state.status === "ACTIVE") return failure("GAME_ALREADY_STARTED");
      if (state.status !== "WAITING" || state.playerTwo) return failure("GAME_FULL");
      const next = { ...state, status: "PLACEMENT" as const, playerTwo: command.actor };
      return transition(next, command, { type: "GAME_JOINED" });
    }
    case "PLACE_FLEET": {
      if (!participant(state, command.actor.id)) return failure("PLAYER_NOT_IN_GAME");
      if (fleetFor(state, command.actor.id)) return failure("FLEET_ALREADY_SUBMITTED");
      if (state.status === "FINISHED") {
        return failure(state.completionReason === "CANCELLED" ? "GAME_CANCELLED" : "GAME_ALREADY_FINISHED");
      }
      if (state.status !== "PLACEMENT") return failure("GAME_NOT_IN_PLACEMENT");
      const fleet = validateFleet(command.ships);
      if (!fleet.ok) return fleet;
      const isPlayerOne = state.playerOne.id === command.actor.id;
      const next: GameState = {
        ...state,
        playerOneFleet: isPlayerOne ? fleet.value : state.playerOneFleet,
        playerTwoFleet: isPlayerOne ? state.playerTwoFleet : fleet.value
      };
      if (next.playerOneFleet && next.playerTwoFleet) {
        next.status = "ACTIVE";
        next.currentTurn = next.playerOne.id;
        next.startedAt = command.occurredAt;
      }
      return transition(next, command, { type: "FLEET_ACCEPTED" });
    }
    case "FIRE": {
      if (!participant(state, command.actor.id)) return failure("PLAYER_NOT_IN_GAME");
      if (state.status === "FINISHED") return failure("GAME_ALREADY_FINISHED");
      if (state.status !== "ACTIVE") return failure("GAME_NOT_ACTIVE");
      if (state.currentTurn !== command.actor.id) return failure("NOT_YOUR_TURN");
      if (!isValidCoordinate(command.coordinate)) return failure("INVALID_COORDINATE");
      if (state.attacks.some((attack) => attack.attackerId === command.actor.id && coordinatesEqual(attack.coordinate, command.coordinate))) {
        return failure("COORDINATE_ALREADY_ATTACKED");
      }

      const target = opponent(state, command.actor.id)!;
      const targetFleet = fleetFor(state, target.id)!;
      const hitShip = targetFleet.ships.find((ship) => ship.cells.some((cell) => coordinatesEqual(cell, command.coordinate)));
      const previousHits = state.attacks.filter((attack) => attack.attackerId === command.actor.id && attack.result !== "MISS");
      const hitCoordinates = [...previousHits.map((attack) => attack.coordinate), command.coordinate];
      const sunk = hitShip?.cells.every((cell) => hitCoordinates.some((hit) => coordinatesEqual(hit, cell))) ?? false;
      const won = Boolean(hitShip) && targetFleet.ships.every((ship) =>
        ship.cells.every((cell) => hitCoordinates.some((hit) => coordinatesEqual(hit, cell))));
      const result = won ? "WIN" : sunk ? "SUNK" : hitShip ? "HIT" : "MISS";
      const attack: Attack = {
        attackerId: command.actor.id,
        coordinate: command.coordinate,
        result,
        ...(sunk && hitShip ? { sunkShipLength: hitShip.length } : {})
      };
      const next: GameState = {
        ...state,
        attacks: [...state.attacks, attack],
        currentTurn: won ? null : target.id,
        status: won ? "FINISHED" : state.status,
        winnerPlayerId: won ? command.actor.id : null,
        completionReason: won ? "FLEET_DESTROYED" : null,
        endedAt: won ? command.occurredAt : null
      };
      return transition(next, command, {
        type: result,
        coordinate: command.coordinate,
        ...(attack.sunkShipLength ? { sunkShipLength: attack.sunkShipLength } : {})
      });
    }
    case "CANCEL_GAME": {
      if (!participant(state, command.actor.id)) return failure("PLAYER_NOT_IN_GAME");
      if (state.status === "FINISHED") {
        return failure(state.completionReason === "CANCELLED" ? "GAME_CANCELLED" : "GAME_ALREADY_FINISHED");
      }
      if (state.status === "ACTIVE") return failure("GAME_ALREADY_STARTED");
      const next: GameState = {
        ...state,
        status: "FINISHED",
        winnerPlayerId: null,
        completionReason: "CANCELLED",
        endedAt: command.occurredAt
      };
      return transition(next, command, { type: "GAME_CANCELLED" });
    }
    case "SURRENDER": {
      if (!participant(state, command.actor.id)) return failure("PLAYER_NOT_IN_GAME");
      if (state.status === "FINISHED") return failure("GAME_ALREADY_FINISHED");
      if (state.status !== "ACTIVE") return failure("GAME_NOT_ACTIVE");
      const winner = opponent(state, command.actor.id)!;
      const next: GameState = {
        ...state,
        status: "FINISHED",
        currentTurn: null,
        winnerPlayerId: winner.id,
        completionReason: "SURRENDER",
        endedAt: command.occurredAt
      };
      return transition(next, command, { type: "GAME_SURRENDERED" });
    }
  }
}

export function replayCommands(commands: PersistedCommand[]): GameState {
  if (commands.length === 0 || commands[0].type !== "CREATE_GAME") {
    throw new Error("Game event stream does not begin with CREATE_GAME");
  }
  const created = createGame(commands[0]);
  if (!created.ok) throw new Error(created.error.code);
  let state = created.value.state;
  for (const command of commands.slice(1)) {
    if (command.type === "CREATE_GAME") throw new Error("Duplicate CREATE_GAME event");
    const applied = applyGameCommand(state, command);
    if (!applied.ok) throw new Error(`Invalid stored event: ${applied.error.code}`);
    state = applied.value.state;
  }
  return state;
}

export function eventCommand(event: GameEvent): PersistedCommand {
  return event.command;
}
