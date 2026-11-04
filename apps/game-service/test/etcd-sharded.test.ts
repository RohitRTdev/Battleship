import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";
import { Etcd3 } from "etcd3";
import { createEtcdBackend } from "../src/store/etcd/backend.js";
import { createGame, type GameCommand, type Player } from "../src/game/index.js";
import { CONTROL_NAMESPACE, controlKeys, dataKeys, dataNamespace, encode, NAMESPACE } from "../src/store/etcd/keys.js";
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
});
