/**
 * Every etcd key the store uses. All keys live under the client's "/battleship/" namespace, so these
 * paths are relative to it.
 */
export const keys = {
  game: (gameId: string) => `games/${gameId}`,
  gamePrefix: "games/",
  code: (gameCode: string) => `codes/${gameCode}`,
  activeGame: (playerId: string) => `players/${playerId}/active`,
  playerPrefix: "players/",
  queueEntry: (playerId: string) => `matchmaking/queue/${playerId}`,
  queuePrefix: "matchmaking/queue/",
  /** Rewritten by every enqueue, so two players can't both join an empty queue without seeing each other. */
  queueEpoch: "matchmaking/epoch",
  presence: (gameId: string, playerId: string) => `presence/${gameId}/${playerId}`,
  presencePrefix: (gameId: string) => `presence/${gameId}/`,
  archiveJob: (gameId: string) => `archive/jobs/${gameId}`,
  archivePrefix: "archive/jobs/",
  /** Sorts by deadline: ISO-8601 UTC timestamps compare correctly as strings. */
  deadline: (deadlineAt: string, gameId: string) => `deadlines/${deadlineAt}/${gameId}`,
  deadlinePrefix: "deadlines/",
  health: "health"
} as const;

export const NAMESPACE = "/battleship/";

export function encode(value: unknown): string {
  return JSON.stringify(value);
}

export function decode<T>(value: string | Buffer): T {
  return JSON.parse(value.toString()) as T;
}
