import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";
import { Etcd3 } from "etcd3";
import { createEtcdBackend } from "../src/store/etcd/backend.js";
import { createGame, type GameCommand, type Player } from "../src/game/index.js";
import { CONTROL_NAMESPACE, controlKeys, dataKeys, dataNamespace, decode, encode, NAMESPACE } from "../src/store/etcd/keys.js";
import type { Route } from "../src/store/etcd/etcd-store.js";
import { readRegistry } from "../src/store/etcd/clusters.js";
import type { StoreBackend } from "../src/store/index.js";
import { defineStoreContract } from "./store-contract.js";

// A control-plane cluster plus two data clusters, each a single throwaway etcd node.
const control = process.env.TEST_ETCD_CONTROL;
const dataClusters = process.env.TEST_ETCD_DATA_CLUSTERS;
if (!control || !dataClusters) throw new Error("TEST_ETCD_CONTROL and TEST_ETCD_DATA_CLUSTERS are required; run the tests with `npm test`");

const clusters = dataClusters.split(";").map((entry) => {
  const [id, hosts] = entry.split("=");
  return { id, admin: new Etcd3({ hosts }) };
});
const admins = [new Etcd3({ hosts: control }), ...clusters.map((cluster) => cluster.admin)];
after(() => { for (const admin of admins) admin.close(); });

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) assert.fail(`expected success, got ${result.error.code}`);
  return result.value;
}

function shardedBackend(timeoutEnabled = false): StoreBackend {
  process.env.ETCD_ENDPOINTS = control;
  process.env.ETCD_DATA_CLUSTERS = dataClusters;
  return createEtcdBackend({ timeoutEnabled });
}

defineStoreContract("etcd (sharded)", {
  async open(options) {
    const backend = shardedBackend(options?.timeoutEnabled ?? false);
    await backend.start();
    return backend;
  },
  async reset() {
    await Promise.all(admins.map((admin) => admin.namespace(NAMESPACE).delete().all()));
  }
});

describe("etcd data clusters", () => {
  test("games are spread over the data clusters, and any node finds each one", async () => {
    const nodes = [shardedBackend(), shardedBackend()];
    for (const node of nodes) await node.start();
    try {
      await Promise.all(admins.map((admin) => admin.namespace(NAMESPACE).delete().all()));
      const codes: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        codes.push(ok(await nodes[0].store.create({ id: `spread-${index}`, username: `spread${index}` })).state.gameCode);
      }

      // Each game is stored on exactly one data cluster, and both clusters got some.
      const perCluster: Record<string, number> = {};
      for (const { id, admin } of clusters) {
        perCluster[id] = (await admin.namespace(dataNamespace(id)).getAll().prefix(dataKeys.gamePrefix).keys()).length;
      }
      assert.equal(Object.values(perCluster).reduce((sum, count) => sum + count, 0), codes.length, JSON.stringify(perCluster));
      assert.ok(Object.values(perCluster).every((count) => count > 0), `a data cluster got no games: ${JSON.stringify(perCluster)}`);

      // The second node has an empty route cache, so it reads every route from the control plane.
      for (const code of codes) assert.equal(ok(await nodes[1].store.getState(code)).gameCode, code);
    } finally {
      for (const node of nodes) await node.close();
    }
  });

  test("a game on a data cluster this node does not have is not found, and claims on it are released", async () => {
    const node = shardedBackend();
    await node.start();
    try {
      await Promise.all(admins.map((admin) => admin.namespace(NAMESPACE).delete().all()));
      const player = { id: "orphan-player", username: "orphan" };
      const created = createGame({ type: "CREATE_GAME", gameId: crypto.randomUUID(), gameCode: "GONE0001", actor: player, occurredAt: new Date().toISOString() });
      assert.ok(created.ok);
      const state = created.value.state;
      const controlKv = admins[0].namespace(CONTROL_NAMESPACE);
      await controlKv.put(controlKeys.route("GONE0001")).value(encode({ gameId: state.gameId, clusterId: "retired", initial: state }));
      await controlKv.put(controlKeys.activeGame(player.id)).value(encode({ gameId: state.gameId, gameCode: "GONE0001", clusterId: "retired", username: player.username }));

      const missing = await node.store.getState("GONE0001");
      assert.equal(missing.ok ? "found" : missing.error.code, "GAME_NOT_FOUND");
      assert.deepEqual(await node.store.getPlayerState(player.id), { state: "NOT_PLAYING" });
      assert.equal(ok(await node.store.create(player)).state.playerOne.id, player.id);
    } finally {
      await node.close();
    }
  });

  test("games in progress keep going while the control plane is down", { timeout: 60_000 }, async () => {
    const container = process.env.TEST_ETCD_CONTROL_CONTAINER;
    assert.ok(container, "TEST_ETCD_CONTROL_CONTAINER is required");
    const docker = (...args: string[]) => promisify(execFile)("docker", args);
    const node = shardedBackend();
    await node.start();
    const first: Player = { id: "outage-first", username: "first" };
    const second: Player = { id: "outage-second", username: "second" };
    const ships = [
      { start: { row: 0, column: 0 }, end: { row: 0, column: 4 } }, { start: { row: 2, column: 0 }, end: { row: 2, column: 3 } },
      { start: { row: 4, column: 0 }, end: { row: 4, column: 2 } }, { start: { row: 6, column: 0 }, end: { row: 6, column: 2 } },
      { start: { row: 8, column: 0 }, end: { row: 8, column: 1 } }];
    const play = (code: string, actor: Player, build: (occurredAt: string) => GameCommand) => node.store.command(code, actor, build);
    let paused = false;
    try {
      await Promise.all(admins.map((admin) => admin.namespace(NAMESPACE).delete().all()));
      const code = ok(await node.store.create(first)).state.gameCode;
      ok(await play(code, second, (occurredAt) => ({ type: "JOIN_GAME", actor: second, occurredAt })));
      for (const player of [first, second]) ok(await play(code, player, (occurredAt) => ({ type: "PLACE_FLEET", actor: player, ships, occurredAt })));

      await docker("pause", container);
      paused = true;
      assert.equal(await node.checkHealth(), false, "the control plane should be unreachable");
      // Both players keep firing; their game's data cluster is still up.
      for (let column = 0; column < 4; column += 1) {
        ok(await play(code, first, (occurredAt) => ({ type: "FIRE", actor: first, coordinate: { row: 0, column }, occurredAt })));
        ok(await play(code, second, (occurredAt) => ({ type: "FIRE", actor: second, coordinate: { row: 9, column }, occurredAt })));
      }
      const state = ok(await node.store.getState(code));
      assert.equal(state.attacks.length, 8);
      assert.equal(state.status, "ACTIVE");
    } finally {
      if (paused) await docker("unpause", container);
      await node.close();
    }
  });

  test("a data cluster that is down takes only its own games with it", { timeout: 60_000 }, async () => {
    const container = process.env.TEST_ETCD_DATA_B_CONTAINER;
    assert.ok(container, "TEST_ETCD_DATA_B_CONTAINER is required");
    const docker = (...args: string[]) => promisify(execFile)("docker", args);
    const controlKv = admins[0].namespace(CONTROL_NAMESPACE);
    const clusterOf = async (code: string) => decode<Route>((await controlKv.get(controlKeys.route(code)).string())!).clusterId;
    const nodes: StoreBackend[] = [shardedBackend()];
    await nodes[0].start();
    let paused = false;
    try {
      await Promise.all(admins.map((admin) => admin.namespace(NAMESPACE).delete().all()));
      await docker("pause", container);
      paused = true;

      // Nodes stay healthy, and a node can still start.
      assert.equal(await nodes[0].checkHealth(), true);
      nodes.push(shardedBackend());
      await nodes[1].start();
      assert.equal(await nodes[1].checkHealth(), true);

      // Once the probes notice, new games go to the cluster that is up, and they can be played.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const first: Player = { id: "split-first", username: "first" };
      const second: Player = { id: "split-second", username: "second" };
      for (let index = 0; index < 10; index += 1) {
        const node = nodes[index % nodes.length];
        const code = ok(await node.store.create({ id: `split-${index}`, username: `split${index}` })).state.gameCode;
        assert.equal(await clusterOf(code), "a");
      }
      const code = ok(await nodes[0].store.create(first)).state.gameCode;
      ok(await nodes[1].store.command(code, second, (occurredAt) => ({ type: "JOIN_GAME", actor: second, occurredAt })));
      assert.equal(ok(await nodes[0].store.getState(code)).status, "PLACEMENT");
    } finally {
      if (paused) await docker("unpause", container);
      for (const node of nodes) await node.close();
    }
  });

  test("clusters can be drained, removed and registered while nodes run", { timeout: 120_000 }, async () => {
    const run = promisify(execFile);
    const cli = (...args: string[]) => run("npx", ["tsx", "src/cli/clusters.ts", ...args], { env: { ...process.env, ETCD_ENDPOINTS: control } });
    const controlKv = admins[0].namespace(CONTROL_NAMESPACE);
    const clusterOf = async (code: string) => decode<Route>((await controlKv.get(controlKeys.route(code)).string())!).clusterId;
    const until = async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 50 && !(await check()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    };
    const node = shardedBackend();
    let player = 0;
    const someone = (): Player => { player += 1; return { id: `registry-${player}`, username: `registry${player}` }; };
    try {
      await Promise.all(admins.map((admin) => admin.namespace(NAMESPACE).delete().all()));
      await node.start();
      assert.deepEqual([...(await readRegistry(controlKv)).entries()].map(([id, record]) => `${id}:${record.state}`).sort(), ["a:ACTIVE", "b:ACTIVE"]);

      // A game in progress on b.
      let onB: { code: string; first: Player } | null = null;
      while (!onB) {
        const first = someone();
        const code = ok(await node.store.create(first)).state.gameCode;
        if (await clusterOf(code) === "b") onB = { code, first };
      }
      const second = someone();
      ok(await node.store.command(onB.code, second, (occurredAt) => ({ type: "JOIN_GAME", actor: second, occurredAt })));

      await cli("drain", "b");
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let index = 0; index < 10; index += 1) {
        assert.equal(await clusterOf(ok(await node.store.create(someone())).state.gameCode), "a", "a draining cluster must get no new games");
      }
      // The draining cluster still serves its game.
      ok(await node.store.command(onB.code, second, (occurredAt) => ({ type: "CANCEL_GAME", actor: second, occurredAt })));

      // Cancelled games have no archive job, so b is now empty and can go.
      const removed = await cli("remove", "b");
      assert.match(removed.stdout, /b: DRAINING -> REMOVED/);
      await until(async () => !(await node.store.getState(onB!.code)).ok);
      const gone = await node.store.getState(onB.code);
      assert.equal(gone.ok ? "found" : gone.error.code, "GAME_NOT_FOUND");
      assert.deepEqual(await node.store.getPlayerState(onB.first.id), { state: "NOT_PLAYING" });

      // A newly registered cluster takes new games once the old one drains.
      const bHosts = dataClusters!.split(";").find((entry) => entry.startsWith("b="))!.slice(2);
      await cli("register", "c", bHosts);
      await cli("drain", "a");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const onC = ok(await node.store.create(someone())).state;
      assert.equal(await clusterOf(onC.gameCode), "c");
      assert.ok(await clusters[1].admin.namespace(dataNamespace("c")).get(dataKeys.game(onC.gameId)).string(), "game written under c's namespace");
      assert.equal(ok(await node.store.getState(onC.gameCode)).gameId, onC.gameId);
    } finally {
      await node.close();
    }
  });

  test("a cluster is not removed while it has unfinished games", { timeout: 60_000 }, async () => {
    const run = promisify(execFile);
    const cli = (...args: string[]) => run("npx", ["tsx", "src/cli/clusters.ts", ...args], { env: { ...process.env, ETCD_ENDPOINTS: control } });
    const node = shardedBackend();
    try {
      await Promise.all(admins.map((admin) => admin.namespace(NAMESPACE).delete().all()));
      await node.start();
      await cli("drain", "a");
      await new Promise((resolve) => setTimeout(resolve, 300));
      ok(await node.store.create({ id: "unfinished", username: "unfinished" }));
      await cli("activate", "a");
      await cli("drain", "b");
      const refused = await cli("remove", "b").then(() => null, (error: { stderr: string }) => error.stderr);
      assert.match(refused ?? "", /still has 1 unfinished games/);
    } finally {
      await node.close();
    }
  });
});
