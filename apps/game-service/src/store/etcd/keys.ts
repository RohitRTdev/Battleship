/**
 * Every etcd key the store uses, relative to its role's namespace.
 *
 * The control plane holds what spans games: which game each player is in, the matchmaking queue, and each game's
 * route (which data cluster holds it). A data cluster holds the games themselves and everything per game. With a
 * single etcd cluster both roles share it, under separate namespaces.
 */
export const controlKeys = {
  /** A player's claim on the one game they are in; checked against the game itself (see EtcdStore.validate). */
  activeGame: (playerId: string) => `players/${playerId}/active`,
  playerPrefix: "players/",
  queueEntry: (playerId: string) => `matchmaking/queue/${playerId}`,
  queuePrefix: "matchmaking/queue/",
  /** Rewritten by every enqueue, so two players can't both join an empty queue without seeing each other. */
  queueEpoch: "matchmaking/epoch",
  /** Claims a game code and says where the game lives. Never changes once written, so it can be cached forever. */
  route: (gameCode: string) => `routes/${gameCode}`,
  /** The data cluster of a game, by id (presence is looked up by game id). */
  gameCluster: (gameId: string) => `game-clusters/${gameId}`,
  health: "health"
} as const;

export const dataKeys = {
  game: (gameId: string) => `games/${gameId}`,
  gamePrefix: "games/",
  presence: (gameId: string, playerId: string) => `presence/${gameId}/${playerId}`,
  presencePrefix: (gameId: string) => `presence/${gameId}/`,
  archiveJob: (gameId: string) => `archive/jobs/${gameId}`,
  archivePrefix: "archive/jobs/",
  /** Exists (bound to a lease) while a node is archiving the game. */
  archiveClaim: (gameId: string) => `archive/claims/${gameId}`,
  /** Sorts by deadline: ISO-8601 UTC timestamps compare correctly as strings. */
  deadline: (deadlineAt: string, gameId: string) => `deadlines/${deadlineAt}/${gameId}`,
  deadlinePrefix: "deadlines/",
  health: "health"
} as const;

/** Root of everything the store writes; tests clear it between cases. */
export const NAMESPACE = "/battleship/";
export const CONTROL_NAMESPACE = `${NAMESPACE}control/`;
export const dataNamespace = (clusterId: string) => `${NAMESPACE}data/${clusterId}/`;

export function encode(value: unknown): string {
  return JSON.stringify(value);
}

export function decode<T>(value: string | Buffer): T {
  return JSON.parse(value.toString()) as T;
}
