import { randomUUID } from "node:crypto";
import type { ConnectionStatus, PlayerStateResponse } from "@battleship/game-contract";
import type { ComparatorBuilder, IKeyValue, IOperation, IRangeResponse, IResponseOp, Namespace } from "etcd3";
import {
  applyGameCommand,
  createGame,
  domainError,
  dueTimeout,
  generateGameCode,
  lateMoveTimeout,
  TIMEOUT_GRACE_MS,
  type GameCommand,
  type GameState,
  type Player,
  type Result
} from "../../game/index.js";
import type { CommandResult, GameStore } from "../game-store.js";
import type { ArchiveJob } from "./archive-outbox.js";
import type { ClusterSet, DataCluster } from "./clusters.js";
import { isEtcdUnavailable } from "./errors.js";
import { controlKeys, dataKeys, decode, encode } from "./keys.js";

/**
 * Value of players/<id>/active on the control plane: a player's claim on one game. The game on its data cluster is
 * the truth; `validate` completes or releases a claim the game does not (yet) agree with.
 */
export type ActiveGame = { gameId: string; gameCode: string; clusterId: string; username: string };
/** Value of routes/<code>: where a game lives, and its first state, so a creation cut short by a crash can finish. */
export type Route = { gameId: string; clusterId: string; initial: GameState };
/** Value of matchmaking/queue/<id>. */
export type QueueEntry = { username: string; enqueuedAt: string };

type StoredGame = { state: GameState; modRevision: string; cluster: DataCluster };

const PRESENCE_WINDOW_MS = 10_000;
const ATTEMPTS = 50;

/** Short random wait before retrying a conflicting write, so racing requests spread out. */
function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(50, 2 * attempt)));
}

function failed<T>(code: Parameters<typeof domainError>[0]): Result<T> {
  return { ok: false, error: domainError(code) };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function firstKv(response: IRangeResponse | undefined): IKeyValue | undefined {
  return response?.kvs[0];
}

function isParticipant(state: GameState, playerId: string): boolean {
  return state.playerOne.id === playerId || state.playerTwo?.id === playerId;
}

/**
 * GameStore on etcd. The control plane holds players' claims, the matchmaking queue and game routes; each game and
 * its deadlines, presence and archive job live on one data cluster. No transaction spans both, so cross-cluster
 * changes go in an order that a crash cannot leave stuck: claim on the control plane first, then write the game,
 * and treat the game as the truth when the two disagree.
 */
export class EtcdStore implements GameStore {
  /** Tail of this node's matchmaking requests; see `oneAtATime`. */
  private matchmakingTail: Promise<unknown> = Promise.resolve();
  /** Routes never change once written, so they are cached for good. */
  private readonly routes = new Map<string, Route>();
  private readonly gameClusters = new Map<string, string>();
  private nextExpiryCluster = 0;

  constructor(
    private readonly control: Namespace,
    private readonly clusters: ClusterSet,
    private readonly timeoutEnabled: boolean
  ) {}

  /** etcd has no clock, so each node's own (NTP-synchronised) clock is the time source. */
  async currentTime(): Promise<string> {
    return new Date().toISOString();
  }

  async create(actor: Player): Promise<Result<CommandResult>> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      const cluster = this.pickCluster();
      const created = createGame({
        type: "CREATE_GAME",
        gameId: randomUUID(),
        gameCode: generateGameCode(),
        turnTimeoutEnabled: this.timeoutEnabled,
        actor,
        occurredAt: await this.currentTime()
      });
      if (!created.ok) throw new Error(created.error.code);
      const state = created.value.state;
      const route: Route = { gameId: state.gameId, clusterId: cluster.id, initial: state };

      // Claim the code and the player's one game on the control plane, then write the game to its cluster.
      const reserve = this.control
        .if(controlKeys.route(state.gameCode), "Create", "==", 0)
        .and(controlKeys.activeGame(actor.id), "Create", "==", 0)
        .and(controlKeys.queueEntry(actor.id), "Create", "==", 0)
        .then(...this.routeWrites(route), this.claimWrite(actor, route))
        .else(this.control.get(controlKeys.queueEntry(actor.id)), this.control.get(controlKeys.activeGame(actor.id)));
      const result = await this.commitConfirmed(this.control, reserve, controlKeys.route(state.gameCode), encode(route));
      if (result.succeeded) {
        this.remember(state.gameCode, route);
        await this.materialize(cluster, state);
        return { ok: true, value: { state, outcome: created.value.outcome } };
      }

      const [searching, playing] = result.responses.map((response) => firstKv(response.response_range));
      if (searching) return failed("PLAYER_ALREADY_SEARCHING");
      if (playing && (await this.validate(actor.id, playing))) return failed("PLAYER_ALREADY_PLAYING");
      // Otherwise the code was taken, or the player's claim was stale and has been released: try again.
    }
    throw new Error("etcd store: could not create a game");
  }

  async command(
    gameCode: string,
    actor: Player,
    buildCommand: (occurredAt: string) => GameCommand
  ): Promise<Result<CommandResult>> {
    const route = await this.readRoute(gameCode);
    if (!route) return failed("GAME_NOT_FOUND");
    let claimed = false;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      // No control-plane read here, so games in progress keep working while the control plane is down. A queued
      // player cannot move in a game: only participants can, and joining the queue needs no game in progress. Joins
      // check the queue in their claim (claimForJoin).
      const game = await this.loadGame(route);

      const now = await this.currentTime();
      const requested = buildCommand(now);
      const late = lateMoveTimeout(game.state, requested, now);
      const command = late?.timeout ?? requested;
      const applied = applyGameCommand(game.state, command);
      if (!applied.ok) {
        if (late) throw new Error(applied.error.code);
        if (claimed && !isParticipant(game.state, actor.id)) await this.releaseClaim(actor.id, route.gameId);
        return applied;
      }
      const next = applied.value.state;

      // A joiner claims their one game on the control plane before the join is written to the game.
      if (command.type === "JOIN_GAME" && !claimed) {
        const claim = await this.claimForJoin(actor, route);
        if (claim === "retry") continue;
        if (claim !== "claimed") return claim;
        claimed = true;
      }

      // Commit only if nobody changed the game since we read it.
      const kv = game.cluster.kv;
      const transaction = kv
        .if(dataKeys.game(next.gameId), "Mod", "==", game.modRevision)
        .then(...this.transitionWrites(game.cluster, game.state, next));
      const result = await this.commitConfirmed(kv, transaction, dataKeys.game(next.gameId), encode(next));
      if (result.succeeded) {
        return late ? failed(late.error) : { ok: true, value: { state: next, outcome: applied.value.outcome } };
      }
      // The game changed underneath us: retry against the new state.
    }
    throw new Error(`etcd store: too many conflicting writes to game ${gameCode}`);
  }

  async getState(gameCode: string): Promise<Result<GameState>> {
    const route = await this.readRoute(gameCode);
    return route ? { ok: true, value: (await this.loadGame(route)).state } : failed("GAME_NOT_FOUND");
  }

  async getPlayerState(playerId: string): Promise<PlayerStateResponse> {
    const active = firstKv(await this.control.get(controlKeys.activeGame(playerId)).exec());
    if (active) {
      const state = await this.validate(playerId, active);
      if (state) return { state: "PLAYING", gameCode: state.gameCode, gameStatus: state.status };
    }
    const queued = await this.control.get(controlKeys.queueEntry(playerId)).string();
    if (queued) return { state: "SEARCHING", searchStartedAt: decode<QueueEntry>(queued).enqueuedAt };
    return { state: "NOT_PLAYING" };
  }

  /**
   * Every matchmaking request races for the same queue head, so concurrent requests mostly waste each other's
   * work. Running this node's requests one at a time leaves compare-and-swap conflicts only between nodes.
   */
  private oneAtATime<T>(run: () => Promise<T>): Promise<T> {
    const result = this.matchmakingTail.then(run, run);
    this.matchmakingTail = result.catch(() => undefined);
    return result;
  }

  startMatchmaking(actor: Player): Promise<Result<PlayerStateResponse>> {
    return this.oneAtATime(() => this.matchmake(actor));
  }

  private async matchmake(actor: Player): Promise<Result<PlayerStateResponse>> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (attempt > 0) await backoff(attempt);
      // Also releases a stale claim, so a player whose last game ended can queue.
      const current = await this.getPlayerState(actor.id);
      if (current.state === "PLAYING") return failed("PLAYER_ALREADY_PLAYING");
      if (current.state === "SEARCHING") return failed("PLAYER_ALREADY_SEARCHING");

      // Read the epoch and the head of the queue from one snapshot.
      const epoch = await this.control.get(controlKeys.queueEpoch).exec();
      const epochRevision = firstKv(epoch)?.mod_revision ?? "0";
      const [head] = (await this.control.getAll().prefix(controlKeys.queuePrefix).sort("Create", "Ascend").limit(1)
        .revision(epoch.header.revision).exec()).kvs;

      if (!head) {
        const entry: QueueEntry = { username: actor.username, enqueuedAt: await this.currentTime() };
        const enqueue = this.control
          .if(controlKeys.queueEpoch, "Mod", "==", epochRevision)
          .and(controlKeys.activeGame(actor.id), "Create", "==", 0)
          .and(controlKeys.queueEntry(actor.id), "Create", "==", 0)
          .then(this.control.put(controlKeys.queueEpoch).value(""), this.control.put(controlKeys.queueEntry(actor.id)).value(encode(entry)));
        const queued = await this.commitConfirmed(this.control, enqueue, controlKeys.queueEntry(actor.id), encode(entry));
        if (queued.succeeded) return { ok: true, value: { state: "SEARCHING", searchStartedAt: entry.enqueuedAt } };
        continue;
      }

      const rawKey = head.key.toString();
      const opponent: Player = {
        id: rawKey.slice(rawKey.indexOf(controlKeys.queuePrefix) + controlKeys.queuePrefix.length),
        username: decode<QueueEntry>(head.value).username
      };
      const now = await this.currentTime();
      const created = createGame({
        type: "CREATE_GAME",
        gameId: randomUUID(),
        gameCode: generateGameCode(),
        turnTimeoutEnabled: this.timeoutEnabled,
        actor: opponent,
        occurredAt: now
      });
      if (!created.ok) throw new Error(created.error.code);
      const joined = applyGameCommand(created.value.state, { type: "JOIN_GAME", actor, occurredAt: now });
      if (!joined.ok) throw new Error(joined.error.code);
      const state = joined.value.state;
      const cluster = this.pickCluster();
      const route: Route = { gameId: state.gameId, clusterId: cluster.id, initial: state };

      // Commit only if the opponent is still waiting and neither player has entered a game meanwhile.
      const match = this.control
        .if(controlKeys.queueEntry(opponent.id), "Mod", "==", head.mod_revision)
        .and(controlKeys.activeGame(opponent.id), "Create", "==", 0)
        .and(controlKeys.activeGame(actor.id), "Create", "==", 0)
        .and(controlKeys.queueEntry(actor.id), "Create", "==", 0)
        .and(controlKeys.route(state.gameCode), "Create", "==", 0)
        .then(
          ...this.routeWrites(route),
          this.claimWrite(opponent, route),
          this.claimWrite(actor, route),
          this.control.delete().key(controlKeys.queueEntry(opponent.id))
        );
      const matched = await this.commitConfirmed(this.control, match, controlKeys.route(state.gameCode), encode(route));
      if (matched.succeeded) {
        this.remember(state.gameCode, route);
        await this.materialize(cluster, state);
        return { ok: true, value: { state: "PLAYING", gameCode: state.gameCode, gameStatus: state.status } };
      }
    }
    throw new Error("etcd store: too many conflicting matchmaking attempts");
  }

  async cancelMatchmaking(playerId: string): Promise<PlayerStateResponse> {
    const removed = await this.control.delete().key(controlKeys.queueEntry(playerId)).exec();
    return Number(removed.deleted) > 0 ? { state: "NOT_PLAYING" } : this.getPlayerState(playerId);
  }

  /** Records when a player last polled the game; the value is this node's clock, like every other etcd timestamp. */
  async touchPresence(gameId: string, playerId: string): Promise<void> {
    const cluster = await this.clusterOfGame(gameId);
    await cluster.kv.put(dataKeys.presence(gameId, playerId)).value(await this.currentTime());
  }

  /** Players seen in the last 10 s are CONNECTED, others seen before are LAGGING, the rest UNKNOWN (as in Postgres). */
  async presence(gameId: string, state: GameState): Promise<Record<string, ConnectionStatus>> {
    const cluster = await this.clusterOfGame(gameId);
    const now = Date.parse(await this.currentTime());
    const presence: Record<string, ConnectionStatus> = { [state.playerOne.id]: "UNKNOWN" };
    if (state.playerTwo) presence[state.playerTwo.id] = "UNKNOWN";
    const prefix = dataKeys.presencePrefix(gameId);
    for (const kv of (await cluster.kv.getAll().prefix(prefix).exec()).kvs) {
      const key = kv.key.toString();
      const lastSeen = Date.parse(kv.value.toString());
      presence[key.slice(key.indexOf(prefix) + prefix.length)] = now - lastSeen <= PRESENCE_WINDOW_MS ? "CONNECTED" : "LAGGING";
    }
    return presence;
  }

  /** Expires one overdue game, trying each data cluster (draining ones too) in turn. */
  async expireOneTurn(): Promise<boolean> {
    const clusters = this.clusters.list();
    for (let offset = 0; offset < clusters.length; offset += 1) {
      const cluster = clusters[(this.nextExpiryCluster + offset) % clusters.length];
      if (await this.expireOneTurnIn(cluster)) return true;
    }
    this.nextExpiryCluster = clusters.length === 0 ? 0 : (this.nextExpiryCluster + 1) % clusters.length;
    return false;
  }

  private async expireOneTurnIn(cluster: DataCluster): Promise<boolean> {
    const now = await this.currentTime();
    // Index keys sort by deadline, so the first one is the most overdue.
    const [entry] = (await cluster.kv.getAll().prefix(dataKeys.deadlinePrefix).sort("Key", "Ascend").limit(1).exec()).kvs;
    if (!entry) return false;
    const raw = entry.key.toString();
    const [deadlineAt, gameId] = raw.slice(raw.indexOf(dataKeys.deadlinePrefix) + dataKeys.deadlinePrefix.length).split("/");
    if (Date.parse(now) < Date.parse(deadlineAt) + TIMEOUT_GRACE_MS) return false;

    const route = await this.readRoute(entry.value.toString());
    const game = route ? await this.loadGame(route) : null;
    const timeout = game ? dueTimeout(game.state, now) : null;
    if (!game || !timeout) {
      // The index entry no longer matches the game; drop it unless it has just been rewritten.
      const key = dataKeys.deadline(deadlineAt, gameId);
      await cluster.kv.if(key, "Mod", "==", entry.mod_revision).then(cluster.kv.delete().key(key)).commit();
      return true;
    }
    const applied = applyGameCommand(game.state, timeout);
    if (!applied.ok) throw new Error(applied.error.code);
    // If a move or another node got there first, the compare fails and the next call sees the new state.
    await cluster.kv
      .if(dataKeys.game(gameId), "Mod", "==", game.modRevision)
      .then(...this.transitionWrites(cluster, game.state, applied.value.state))
      .commit();
    return true;
  }

  /**
   * Checks a player's claim against the game it names, and returns the game if the claim stands. A claim whose game
   * was never written is completed from its route (in loadGame); one whose join never reached a game still waiting
   * for a second player is completed by joining. A claim that can no longer lead anywhere (the game finished, or
   * moved on without the player) is released.
   */
  private async validate(playerId: string, active: IKeyValue): Promise<GameState | null> {
    const claim = decode<ActiveGame>(active.value);
    const route = await this.readRoute(claim.gameCode);
    for (let attempt = 0; route && attempt < ATTEMPTS; attempt += 1) {
      const game = await this.loadGame(route);
      if (isParticipant(game.state, playerId)) {
        if (game.state.status !== "FINISHED") return game.state;
        break;
      }
      if (game.state.status !== "WAITING") break;
      const joined = applyGameCommand(game.state, { type: "JOIN_GAME", actor: { id: playerId, username: claim.username }, occurredAt: await this.currentTime() });
      if (!joined.ok) break;
      const kv = game.cluster.kv;
      const transaction = kv.if(dataKeys.game(route.gameId), "Mod", "==", game.modRevision).then(...this.transitionWrites(game.cluster, game.state, joined.value.state));
      if ((await this.commitConfirmed(kv, transaction, dataKeys.game(route.gameId), encode(joined.value.state))).succeeded) return joined.value.state;
    }
    // Release the claim, unless it has been rewritten meanwhile.
    const key = controlKeys.activeGame(playerId);
    await this.control.if(key, "Mod", "==", active.mod_revision).then(this.control.delete().key(key)).commit();
    return null;
  }

  /** Claims the joiner's one game. Returns "claimed", "retry" (a stale claim was released), or the error to report. */
  private async claimForJoin(actor: Player, route: Route): Promise<"claimed" | "retry" | Result<CommandResult>> {
    const transaction = this.control
      .if(controlKeys.activeGame(actor.id), "Create", "==", 0)
      .and(controlKeys.queueEntry(actor.id), "Create", "==", 0)
      .then(this.claimWrite(actor, route))
      .else(this.control.get(controlKeys.queueEntry(actor.id)), this.control.get(controlKeys.activeGame(actor.id)));
    const result = await this.commitConfirmed(this.control, transaction, controlKeys.activeGame(actor.id), encode(this.claimFor(actor, route)));
    if (result.succeeded) return "claimed";
    const [searching, playing] = result.responses.map((response) => firstKv(response.response_range));
    if (searching) return failed("PLAYER_ALREADY_SEARCHING");
    if (playing) {
      if (decode<ActiveGame>(playing.value).gameId === route.gameId) return "claimed";
      if (await this.validate(actor.id, playing)) return failed("PLAYER_ALREADY_PLAYING");
    }
    return "retry";
  }

  /** Releases a join claim on `gameId` after the join failed. */
  private async releaseClaim(playerId: string, gameId: string): Promise<void> {
    const key = controlKeys.activeGame(playerId);
    const active = firstKv(await this.control.get(key).exec());
    if (!active || decode<ActiveGame>(active.value).gameId !== gameId) return;
    await this.control.if(key, "Mod", "==", active.mod_revision).then(this.control.delete().key(key)).commit();
  }

  /** Reads a game, creating it from its route first if the creation never reached the data cluster. */
  private async loadGame(route: Route): Promise<StoredGame> {
    const cluster = this.cluster(route.clusterId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const game = firstKv(await cluster.kv.get(dataKeys.game(route.gameId)).exec());
      if (game) return { state: decode<GameState>(game.value), modRevision: game.mod_revision, cluster };
      await this.materialize(cluster, route.initial);
    }
    throw new Error(`etcd store: game ${route.gameId} is missing from cluster ${cluster.id}`);
  }

  /** Writes a game's first state to its data cluster, unless it is already there. */
  private async materialize(cluster: DataCluster, state: GameState): Promise<void> {
    const blank = { ...state, turnDeadlineAt: null, placementDeadlineAt: null };
    await cluster.kv
      .if(dataKeys.game(state.gameId), "Create", "==", 0)
      .then(...this.transitionWrites(cluster, blank, state))
      .commit();
  }

  /**
   * The route for a game code, or null if there is none, or if it points at a data cluster this node does not have
   * (for example one that has been removed): such a game cannot be reached, and claims on it are stale.
   */
  private async readRoute(gameCode: string): Promise<Route | null> {
    let route = this.routes.get(gameCode);
    if (!route) {
      const stored = await this.control.get(controlKeys.route(gameCode)).string();
      if (!stored) return null;
      route = decode<Route>(stored);
      this.remember(gameCode, route);
    }
    return this.clusters.get(route.clusterId) ? route : null;
  }

  private remember(gameCode: string, route: Route): void {
    this.routes.set(gameCode, route);
    this.gameClusters.set(route.gameId, route.clusterId);
  }

  private async clusterOfGame(gameId: string): Promise<DataCluster> {
    let clusterId = this.gameClusters.get(gameId);
    if (!clusterId) {
      const stored = await this.control.get(controlKeys.gameCluster(gameId)).string();
      if (!stored) throw new Error(`etcd store: no route for game ${gameId}`);
      clusterId = stored;
      this.gameClusters.set(gameId, clusterId);
    }
    return this.cluster(clusterId);
  }

  private cluster(clusterId: string): DataCluster {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) throw new Error(`etcd store: unknown data cluster ${clusterId}`);
    return cluster;
  }

  /** The data cluster for a new game: a random ACTIVE one, so draining clusters get no new games. */
  private pickCluster(): DataCluster {
    const active = this.clusters.active();
    if (active.length === 0) throw new Error("etcd store: no ACTIVE data cluster to place a new game on");
    return active[Math.floor(Math.random() * active.length)];
  }

  private routeWrites(route: Route): IOperation[] {
    return [
      this.control.put(controlKeys.route(route.initial.gameCode)).value(encode(route)),
      this.control.put(controlKeys.gameCluster(route.gameId)).value(route.clusterId)
    ];
  }

  private claimFor(player: Player, route: Route): ActiveGame {
    return { gameId: route.gameId, gameCode: route.initial.gameCode, clusterId: route.clusterId, username: player.username };
  }

  private claimWrite(player: Player, route: Route): IOperation {
    return this.control.put(controlKeys.activeGame(player.id)).value(encode(this.claimFor(player, route)));
  }

  /**
   * Commits a transaction whose success means `key` now holds `value`, a value no other request writes. If etcd
   * drops the connection, or the compare fails, the write may still have landed: a leader can commit and die before
   * replying, and the client library may retry a commit that already succeeded. Reading `key` back tells us.
   */
  private async commitConfirmed(
    kv: Namespace,
    transaction: ComparatorBuilder,
    key: string,
    value: string
  ): Promise<{ succeeded: boolean; responses: IResponseOp[] }> {
    try {
      const result = await transaction.commit();
      if (result.succeeded || (await kv.get(key).string()) !== value) return result;
    } catch (error) {
      if (!isEtcdUnavailable(error) || !(await this.landedAfterOutage(kv, key, value, error))) throw error;
    }
    return { succeeded: true, responses: [] };
  }

  /** Reads `key` until etcd answers again (for up to 5 s), then reports whether it holds `value`. */
  private async landedAfterOutage(kv: Namespace, key: string, value: string, outage: unknown): Promise<boolean> {
    const giveUpAt = Date.now() + 5_000;
    while (true) {
      try {
        return (await kv.get(key).string()) === value;
      } catch (error) {
        if (!isEtcdUnavailable(error) || Date.now() > giveUpAt) throw outage;
        await sleep(250);
      }
    }
  }

  /**
   * The writes on a game's data cluster that move it from `previous` to `next`: the game itself, its entries in the
   * deadline index, and, once it finishes, dropping its presence and queueing the archive job. Players' claims on the
   * control plane are released lazily (see `validate`).
   */
  private transitionWrites(cluster: DataCluster, previous: GameState, next: GameState): IOperation[] {
    const kv = cluster.kv;
    const writes: IOperation[] = [kv.put(dataKeys.game(next.gameId)).value(encode(next))];
    for (const field of ["turnDeadlineAt", "placementDeadlineAt"] as const) {
      const before = previous[field];
      const after = next[field];
      if (before === after) continue;
      if (before) writes.push(kv.delete().key(dataKeys.deadline(before, next.gameId)));
      if (after) writes.push(kv.put(dataKeys.deadline(after, next.gameId)).value(next.gameCode));
    }
    if (next.status === "FINISHED") {
      writes.push(kv.delete().prefix(dataKeys.presencePrefix(next.gameId)));
      // Cancelled games are not archived (as in the Postgres store).
      if (next.completionReason !== "CANCELLED") {
        const job: ArchiveJob = { snapshot: next, attempts: 0, availableAt: next.endedAt ?? new Date().toISOString() };
        writes.push(kv.put(dataKeys.archiveJob(next.gameId)).value(encode(job)));
      }
    }
    return writes;
  }
}
