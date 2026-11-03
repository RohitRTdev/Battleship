import type {
  ArchivedAttack,
  ArchivedFleet,
  ArchivedMatchDetail,
  ArchivedPlayer,
  PlayerMatchSummary,
  PlayerStatistics,
  ShipView
} from "@battleship/game-contract";
import type { GameState } from "../game/index.js";

export type ArchivePage = {
  statistics: PlayerStatistics;
  matches: PlayerMatchSummary[];
  nextCursor: string | null;
};

export interface MatchArchive {
  archiveMatch(state: GameState): Promise<void>;
  listPlayerMatches(playerId: string, cursor: string | null, limit: number): Promise<ArchivePage>;
  getPlayerMatch(playerId: string, matchId: string): Promise<ArchivedMatchDetail | null>;
}

export const EMPTY_STATISTICS: PlayerStatistics = { matchesPlayed: 0, wins: 0, losses: 0, surrenders: 0 };

export function playerPathPart(playerId: string): string {
  return encodeURIComponent(playerId);
}

export function historyFileName(summary: PlayerMatchSummary): string {
  const reverseTime = String(9_999_999_999_999 - Date.parse(summary.endedAt)).padStart(13, "0");
  return `${reverseTime}_${summary.matchId}_${summary.outcome}_${summary.surrendered ? 1 : 0}.json`;
}

export function statisticsFromHistoryNames(names: string[]): PlayerStatistics {
  const statistics = { ...EMPTY_STATISTICS };
  for (const name of names) {
    const match = /_([^_]+)_(WIN|LOSS)_([01])\.json$/.exec(name);
    if (!match) continue;
    statistics.matchesPlayed += 1;
    if (match[2] === "WIN") statistics.wins += 1;
    else statistics.losses += 1;
    if (match[3] === "1") statistics.surrenders += 1;
  }
  return statistics;
}

export function encodeCursor(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    return decoded && !decoded.includes("/") && decoded.endsWith(".json") ? decoded : null;
  } catch {
    return null;
  }
}

function coordinatesEqual(left: { row: number; column: number }, right: { row: number; column: number }): boolean {
  return left.row === right.row && left.column === right.column;
}

function fleetView(state: GameState, ownerId: string, ships: GameState["playerOneFleet"]): ShipView[] {
  if (!ships) return [];
  const opponentId = ownerId === state.playerOne.id ? state.playerTwo?.id : state.playerOne.id;
  const hits = state.attacks.filter((attack) => attack.attackerId === opponentId && attack.result !== "MISS");
  return ships.ships.map((ship) => {
    const shipHits = ship.cells.filter((cell) => hits.some((attack) => coordinatesEqual(attack.coordinate, cell)));
    return { length: ship.length, cells: ship.cells, hits: shipHits, sunk: shipHits.length === ship.length };
  });
}

export function playerArchive(state: GameState, viewerPlayerId: string): ArchivedMatchDetail {
  if (state.status !== "FINISHED" || !state.completionReason || state.completionReason === "CANCELLED" || !state.playerTwo ||
      !state.startedAt || !state.endedAt || !state.winnerPlayerId) {
    throw new Error("Only completed two-player matches can be archived");
  }
  const players: ArchivedPlayer[] = [
    { ...state.playerOne, slot: 1 },
    { ...state.playerTwo, slot: 2 }
  ];
  const surrendered = state.completionReason === "SURRENDER" && state.winnerPlayerId !== viewerPlayerId;
  const summary: PlayerMatchSummary = {
    matchId: state.gameId,
    gameCode: state.gameCode,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    players,
    outcome: state.winnerPlayerId === viewerPlayerId ? "WIN" : "LOSS",
    completionReason: state.completionReason,
    surrendered
  };
  const fleets: ArchivedFleet[] = [
    { playerId: state.playerOne.id, ships: fleetView(state, state.playerOne.id, state.playerOneFleet) },
    { playerId: state.playerTwo.id, ships: fleetView(state, state.playerTwo.id, state.playerTwoFleet) }
  ];
  const attacks: ArchivedAttack[] = state.attacks.map(({ attackerId, coordinate, result, sunkShipLength }) => ({
    attackerPlayerId: attackerId,
    coordinate,
    result,
    ...(sunkShipLength ? { sunkShipLength } : {})
  }));
  return { ...summary, viewerPlayerId, winnerPlayerId: state.winnerPlayerId, fleets, attacks };
}

export function matchSummary(detail: ArchivedMatchDetail): PlayerMatchSummary {
  const { matchId, gameCode, startedAt, endedAt, players, outcome, completionReason, surrendered } = detail;
  return { matchId, gameCode, startedAt, endedAt, players, outcome, completionReason, surrendered };
}
