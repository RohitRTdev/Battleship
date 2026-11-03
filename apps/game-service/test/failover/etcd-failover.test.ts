import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Coordinate, ShipPlacement } from "@battleship/game-contract";
import { Etcd3 } from "etcd3";
import type { Player } from "../../src/game/index.js";
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

type Attempt = { attackerId: string; coordinate: Coordinate; outcome: string; detail?: string };

test("games survive the etcd leader being killed mid-game", { timeout: 600_000 }, async () => {
  process.env.ETCD_ENDPOINTS = members.map((member) => member.host).join(",");
  const backend = createEtcdBackend({ timeoutEnabled: false });
  await backend.start();
  const { store } = backend;
  const GAMES = 5;
  const MIN_KILLS = 8;
  let kills = 0;
  let committedDespiteError = 0;
  let unavailable = 0;

  try {
    for (let gameIndex = 0; gameIndex < GAMES; gameIndex += 1) {
      const first: Player = { id: `failover-${gameIndex}-first`, username: "first" };
      const second: Player = { id: `failover-${gameIndex}-second`, username: "second" };
      const code = ok(await store.create(first)).state.gameCode;
      ok(await store.command(code, second, (_state, occurredAt) => ({ type: "JOIN_GAME", actor: second, occurredAt })));
      for (const player of [first, second]) {
        ok(await store.command(code, player, (_state, occurredAt) => ({ type: "PLACE_FLEET", actor: player, ships: FLEET, occurredAt })));
      }

      const attempts: Attempt[] = [];
      let outage: { name: string; startedAt: number; done: boolean; kill: Promise<unknown> } | null = null;
      let nextKillMove = 3;
      const endOutage = async (move: number) => {
        if (!outage) return;
        await outage.kill;
        kills += 1;
        await waitForLeader();
        await docker(["start", outage.name]);
        outage = null;
        nextKillMove = move + 2;
      };
      for (let move = 1; ; move += 1) {
        // Pace moves normally, but keep sending during an outage so requests are in flight when the leader dies.
        if (!outage) await sleep(50);
        const state = ok(await untilAvailable(() => store.getState(code)));
        if (state.status === "FINISHED") break;
        const mover = state.currentTurn === first.id ? first : second;
        const coordinate = (mover === first ? HITS : MISSES)
          .find((target) => !state.attacks.some((attack) => attack.attackerId === mover.id && same(attack.coordinate, target)))!;

        if (!outage && move >= nextKillMove) {
          // Kill the leader in the background and keep playing straight through the outage.
          const name = await waitForLeader();
          const pending = { name, startedAt: Date.now(), done: false, kill: docker(["kill", name]) };
          pending.kill.then(() => { pending.done = true; }, () => { pending.done = true; });
          outage = pending;
        }

        let outcome: string;
        let detail: string | undefined;
        const sentAt = Date.now();
        try {
          const result = await store.command(code, mover, (_state, occurredAt) => ({ type: "FIRE", actor: mover, coordinate, occurredAt }));
          outcome = result.ok ? "ok" : result.error.code;
        } catch (error) {
          outcome = backend.isUnavailableError(error) ? "unavailable" : `threw ${String(error)}`;
          detail = `${(error as Error).name}: ${(error as Error).message.slice(0, 120)} after ${Date.now() - sentAt} ms`;
          console.log(`move ${move} failed: ${detail}`);
        }
        attempts.push({ attackerId: mover.id, coordinate, outcome, ...(detail ? { detail } : {}) });
        if (outcome === "unavailable") unavailable += 1;

        if (outage?.done && Date.now() - outage.startedAt > 1_500) await endOutage(move);
      }

      await endOutage(0);
      const final = ok(await untilAvailable(() => store.getState(code)));
      const label = `game ${gameIndex}: ${JSON.stringify(attempts.filter((attempt) => attempt.outcome !== "ok"))}`;
      assert.equal(final.winnerPlayerId, first.id, label);
      assert.equal(final.version, 4 + final.attacks.length, `version and move count disagree; ${label}`);
      final.attacks.forEach((attack, index) => {
        assert.equal(attack.attackerId, index % 2 === 0 ? first.id : second.id, `turns out of order at ${index}; ${label}`);
      });
      // Every attempt either succeeded or reported that the store was unavailable; nothing was wrongly rejected.
      for (const attempt of attempts) assert.ok(["ok", "unavailable"].includes(attempt.outcome), `${attempt.outcome}; ${label}`);
      // No acknowledged move was lost.
      for (const attempt of attempts.filter((candidate) => candidate.outcome === "ok")) {
        assert.ok(final.attacks.some((attack) => attack.attackerId === attempt.attackerId && same(attack.coordinate, attempt.coordinate)),
          `acknowledged move lost: ${JSON.stringify(attempt)}`);
      }
      // Every stored move came from an attempt; count the ones whose request reported an error.
      for (const attack of final.attacks) {
        const matching = attempts.filter((attempt) => attempt.attackerId === attack.attackerId && same(attempt.coordinate, attack.coordinate));
        assert.ok(matching.length > 0, `stored move nobody sent: ${JSON.stringify(attack)}`);
        if (!matching.some((attempt) => attempt.outcome === "ok")) committedDespiteError += 1;
      }
    }
  } finally {
    await backend.close();
  }
  console.log(`leader kills: ${kills}; requests that hit the outage: ${unavailable}; ` +
    `of those, moves that committed anyway: ${committedDespiteError}`);
  assert.ok(kills >= MIN_KILLS, `only ${kills} leader kills happened`);
  assert.equal(committedDespiteError, 0, "a move committed although its request reported an error");
});
