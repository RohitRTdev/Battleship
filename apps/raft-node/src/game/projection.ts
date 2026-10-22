import type { AttackView, ConnectionStatus, PlayerGameView, PlayerSummary, ShipView } from "@battleship/game-contract";
import { coordinatesEqual } from "./rules.js";
import type { Fleet, GameState } from "./types.js";

export type PresenceByPlayer = Record<string, ConnectionStatus>;

function shipViews(state: GameState, ownerId: string, fleet: Fleet): ShipView[] {
  const opponentId = ownerId === state.playerOne.id ? state.playerTwo?.id : state.playerOne.id;
  const hits = state.attacks.filter((attack) => attack.attackerId === opponentId && attack.result !== "MISS");
  return fleet.ships.map((ship) => {
    const shipHits = ship.cells.filter((cell) => hits.some((attack) => coordinatesEqual(attack.coordinate, cell)));
    return { length: ship.length, cells: ship.cells, hits: shipHits, sunk: shipHits.length === ship.length };
  });
}

function attackViews(state: GameState, attackerId: string): AttackView[] {
  return state.attacks.filter((attack) => attack.attackerId === attackerId).map(({ coordinate, result, sunkShipLength }) => ({
    coordinate,
    result,
    ...(sunkShipLength ? { sunkShipLength } : {})
  }));
}

export function projectGame(state: GameState, viewerId: string, presence: PresenceByPlayer = {}): PlayerGameView | null {
  const viewerIsOne = state.playerOne.id === viewerId;
  const viewerIsTwo = state.playerTwo?.id === viewerId;
  if (!viewerIsOne && !viewerIsTwo) return null;
  const ownFleet = viewerIsOne ? state.playerOneFleet : state.playerTwoFleet;
  const players: PlayerSummary[] = [
    {
      ...state.playerOne,
      slot: 1,
      fleetSubmitted: Boolean(state.playerOneFleet),
      connectionStatus: presence[state.playerOne.id] ?? "UNKNOWN"
    }
  ];
  if (state.playerTwo) {
    players.push({
      ...state.playerTwo,
      slot: 2,
      fleetSubmitted: Boolean(state.playerTwoFleet),
      connectionStatus: presence[state.playerTwo.id] ?? "UNKNOWN"
    });
  }
  return {
    gameCode: state.gameCode,
    status: state.status,
    version: state.version,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    players,
    yourPlayerId: viewerId,
    currentTurn: state.currentTurn,
    isYourTurn: state.currentTurn === viewerId,
    yourFleet: ownFleet ? shipViews(state, viewerId, ownFleet) : null,
    yourAttacks: attackViews(state, viewerId),
    opponentAttacks: attackViews(state, viewerIsOne ? state.playerTwo?.id ?? "" : state.playerOne.id),
    winnerPlayerId: state.winnerPlayerId,
    completionReason: state.completionReason
  };
}
