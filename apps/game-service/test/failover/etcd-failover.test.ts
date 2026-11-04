import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Coordinate, ShipPlacement } from "@battleship/game-contract";
import { Etcd3 } from "etcd3";
import type { GameState, Player } from "../../src/game/index.js";
import type { GameStore } from "../../src/store/index.js";
import { createEtcdBackend } from "../../src/store/etcd/backend.js";

const spec = process.env.TEST_ETCD_CLUSTER;
if (!spec) throw new Error("TEST_ETCD_CLUSTER is required; run with `npm run test:failover`");
const members = spec.split(",").map((entry) => {
  const [name, host] = entry.split("=");
  return { name, host };
});

const run = promisify(execFile);
const docker = (args: string[]) => run("docker", args);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const FLEET: ShipPlacement[] = [
  { start: { row: 0, column: 0 }, end: { row: 0, column: 4 } },
  { start: { row: 2, column: 0 }, end: { row: 2, column: 3 } },
  { start: { row: 4, column: 0 }, end: { row: 4, column: 2 } },
  { start: { row: 6, column: 0 }, end: { row: 6, column: 2 } },
  { start: { row: 8, column: 0 }, end: { row: 8, column: 1 } }
];
const HITS: Coordinate[] = FLEET.flatMap(({ start, end }) =>
  Array.from({ length: end.column - start.column + 1 }, (_, offset) => ({ row: start.row, column: start.column + offset })));
const MISSES: Coordinate[] = [1, 3, 5, 7, 9].flatMap((row) => Array.from({ length: 10 }, (_, column) => ({ row, column })));
const same = (left: Coordinate, right: Coordinate) => left.row === right.row && left.column === right.column;

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) assert.fail(`expected success, got ${result.error.code}`);
  return result.value;
}

/** Name of the member that is currently the Raft leader, or null during an election. */
async function currentLeader(): Promise<string | null> {
  for (const member of members) {
    const client = new Etcd3({ hosts: member.host, dialTimeout: 500, defaultCallOptions: () => ({ deadline: Date.now() + 500 }) });
    try {
      const status = await client.maintenance.status();
      if (status.leader === status.header.member_id) return member.name;
    } catch {
      // Killed or unreachable member.
    } finally {
      client.close();
    }
  }
  return null;
}

async function waitForLeader(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const leader = await currentLeader();
    if (leader) return leader;
    await sleep(200);
  }
  throw new Error("no etcd leader within 20 s");
}

/** Retries a read until the cluster answers, like a client re-syncing after an error. */
async function untilAvailable<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 150) throw error;
      await sleep(200);
    }
  }
}

type Attempt = { attackerId: string; coordinate: Coordinate; outcome: string; sentAt: number; doneAt: number };
type Kill = { startedAt: number; doneAt: number };

const PAIRS = 20;
const KILLS = 10;
const MIN_IN_FLIGHT = 5;

/** Kills the leader KILLS times, restarting each victim once a new leader is elected. */
async function killLeaders(kills: Kill[]): Promise<void> {
  while (kills.length < KILLS) {
    const leader = await waitForLeader();
    const startedAt = Date.now();
    await docker(["kill", leader]);
    kills.push({ startedAt, doneAt: Date.now() });
    await sleep(1_500);
    await waitForLeader();
    await docker(["start", leader]);
    await sleep(500);
  }
}

/** Plays one game between `first` and `second`, firing until it ends; returns the attempts and the final state. */
async function playGame(store: GameStore, first: Player, second: Player, isUnavailable: (error: unknown) => boolean) {
  const code = ok(await untilAvailable(() => store.create(first))).state.gameCode;
  ok(await untilAvailable(() => store.command(code, second, (occurredAt) => ({ type: "JOIN_GAME", actor: second, occurredAt }))));
  for (const player of [first, second]) {
    ok(await untilAvailable(() => store.command(code, player, (occurredAt) => ({ type: "PLACE_FLEET", actor: player, ships: FLEET, occurredAt }))));
  }
  const attempts: Attempt[] = [];
  while (true) {
    await sleep(50);
    const state = ok(await untilAvailable(() => store.getState(code)));
    if (state.status === "FINISHED") return { attempts, final: state };
    const mover = state.currentTurn === first.id ? first : second;
    const coordinate = (mover === first ? HITS : MISSES)
      .find((target) => !state.attacks.some((attack) => attack.attackerId === mover.id && same(attack.coordinate, target)))!;
    const sentAt = Date.now();
    let outcome: string;
    try {
      const result = await store.command(code, mover, (occurredAt) => ({ type: "FIRE", actor: mover, coordinate, occurredAt }));
      outcome = result.ok ? "ok" : result.error.code;
    } catch (error) {
      outcome = isUnavailable(error) ? "unavailable" : `threw ${String(error)}`;
    }
    attempts.push({ attackerId: mover.id, coordinate, outcome, sentAt, doneAt: Date.now() });
  }
}

/** Checks one finished game against what its players sent and were told. Returns moves stored despite an error. */
function checkGame(label: string, first: Player, second: Player, attempts: Attempt[], final: GameState): number {
  const failures = `${label}: ${JSON.stringify(attempts.filter((attempt) => attempt.outcome !== "ok"))}`;
  assert.equal(final.winnerPlayerId, first.id, failures);
  assert.equal(final.version, 4 + final.attacks.length, `version and move count disagree; ${failures}`);
  final.attacks.forEach((attack, index) => {
    assert.equal(attack.attackerId, index % 2 === 0 ? first.id : second.id, `turns out of order at ${index}; ${failures}`);
  });
  // Every attempt either succeeded or reported that the store was unavailable; nothing was wrongly rejected.
  for (const attempt of attempts) assert.ok(["ok", "unavailable"].includes(attempt.outcome), `${attempt.outcome}; ${failures}`);
  // No acknowledged move was lost.
  for (const attempt of attempts.filter((candidate) => candidate.outcome === "ok")) {
    assert.ok(final.attacks.some((attack) => attack.attackerId === attempt.attackerId && same(attack.coordinate, attempt.coordinate)),
      `acknowledged move lost: ${JSON.stringify(attempt)}`);
  }
  // Every stored move came from an attempt; count the ones whose request reported an error.
  let committedDespiteError = 0;
  for (const attack of final.attacks) {
    const matching = attempts.filter((attempt) => attempt.attackerId === attack.attackerId && same(attempt.coordinate, attack.coordinate));
    assert.ok(matching.length > 0, `stored move nobody sent: ${JSON.stringify(attack)}`);
    if (!matching.some((attempt) => attempt.outcome === "ok")) committedDespiteError += 1;
  }
  return committedDespiteError;
}

test("games survive the etcd leader being killed mid-game", { timeout: 600_000 }, async () => {
  process.env.ETCD_ENDPOINTS = members.map((member) => member.host).join(",");
  const backend = createEtcdBackend({ timeoutEnabled: false });
  await backend.start();
  const isUnavailable = (error: unknown) => backend.isUnavailableError(error);
  const kills: Kill[] = [];
  const attempts: Attempt[] = [];
  let games = 0;
  let committedDespiteError = 0;

  try {
    // Many pairs play at once, starting new games until the killer is done, so most kills land on moves in flight.
    const killer = killLeaders(kills);
    let killing = true;
    void killer.finally(() => { killing = false; });
    await Promise.all([killer, ...Array.from({ length: PAIRS }, async (_, pair) => {
      for (let round = 0; killing; round += 1) {
        const first: Player = { id: `failover-${pair}-${round}-first`, username: "first" };
        const second: Player = { id: `failover-${pair}-${round}-second`, username: "second" };
        const game = await playGame(backend.store, first, second, isUnavailable);
        committedDespiteError += checkGame(`pair ${pair} round ${round}`, first, second, game.attempts, game.final);
        attempts.push(...game.attempts);
        games += 1;
      }
    })]);
  } finally {
    await backend.close();
  }

  // A move was in flight when the leader died if it was sent before the kill finished and answered after it began.
  const inFlight = attempts.filter((attempt) => kills.some((kill) => attempt.sentAt < kill.doneAt && attempt.doneAt > kill.startedAt));
  const unavailable = attempts.filter((attempt) => attempt.outcome === "unavailable").length;
  console.log(`games: ${games}; moves: ${attempts.length}; leader kills: ${kills.length}; ` +
    `moves in flight when a leader died: ${inFlight.length} (${inFlight.filter((attempt) => attempt.outcome === "ok").length} ok, ` +
    `${inFlight.filter((attempt) => attempt.outcome === "unavailable").length} unavailable); ` +
    `requests answered unavailable: ${unavailable}; moves committed although reported unavailable: ${committedDespiteError}`);
  assert.equal(kills.length, KILLS);
  assert.ok(inFlight.length >= MIN_IN_FLIGHT, `only ${inFlight.length} moves were in flight when a leader died; the run proves little`);
  assert.equal(committedDespiteError, 0, "a move committed although its request reported an error");
});
