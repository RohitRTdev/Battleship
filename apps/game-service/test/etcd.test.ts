import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Etcd3, GRPCCancelledError } from "etcd3";
import { createEtcdBackend } from "../src/store/etcd/backend.js";
import { createGame } from "../src/game/index.js";
import { CONTROL_NAMESPACE, controlKeys, dataKeys as keys, dataNamespace, encode, NAMESPACE } from "../src/store/etcd/keys.js";

/** Namespace of the single data cluster that single-cluster etcd mode uses. */
const DATA = dataNamespace("main");
import type { StoreBackend } from "../src/store/index.js";
import { defineStoreContract } from "./store-contract.js";

const endpoints = process.env.TEST_ETCD_ENDPOINTS;
if (!endpoints) throw new Error("TEST_ETCD_ENDPOINTS is required; run the tests with `npm test`");

const admin = new Etcd3({ hosts: endpoints.split(",") });

// Shared by every suite in this file, so it is closed only after all of them.
after(() => admin.close());

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) assert.fail(`expected success, got ${result.error.code}`);
  return result.value;
}

function backendFor(hosts: string, timeoutEnabled = false): StoreBackend {
  process.env.ETCD_ENDPOINTS = hosts;
  return createEtcdBackend({ timeoutEnabled });
}

defineStoreContract("etcd", {
  async open(options) {
    const backend = backendFor(endpoints, options?.timeoutEnabled ?? false);
    await backend.start();
    return backend;
  },
  async reset() {
    await admin.namespace(NAMESPACE).delete().all();
  }
});

describe("etcd store", () => {
  test("two nodes matchmaking at once never leave both players waiting", async () => {
    const nodes = [backendFor(endpoints), backendFor(endpoints)];
    for (const node of nodes) await node.start();
    try {
      for (let round = 0; round < 25; round += 1) {
        await admin.namespace(NAMESPACE).delete().all();
        const players = [{ id: `left-${round}`, username: "left" }, { id: `right-${round}`, username: "right" }];
        const results = await Promise.all(players.map((searcher, index) => nodes[index].store.startMatchmaking(searcher)));
        const states = results.map((result) => ok(result).state).sort();
        assert.deepEqual(states, ["PLAYING", "SEARCHING"], `round ${round}: ${states.join(", ")}`);
      }
    } finally {
      for (const node of nodes) await node.close();
    }
  });

  // A crash can split a cross-cluster change: the control-plane half lands, the data-cluster half does not.
  function newGame(creator: { id: string; username: string }, gameCode: string) {
    const created = createGame({ type: "CREATE_GAME", gameId: crypto.randomUUID(), gameCode, actor: creator, occurredAt: new Date().toISOString() });
    assert.ok(created.ok);
    return created.value.state;
  }
  const control = () => admin.namespace(CONTROL_NAMESPACE);
  const claim = (state: { gameId: string; gameCode: string }, username: string) =>
    encode({ gameId: state.gameId, gameCode: state.gameCode, clusterId: "main", username });

  test("a creation that never reached its data cluster is completed from its route", async () => {
    const backend = backendFor(endpoints);
    await backend.start();
    try {
      await admin.namespace(NAMESPACE).delete().all();
      const creator = { id: "crash-creator", username: "creator" };
      const state = newGame(creator, "CRASH001");
      await control().put(controlKeys.route(state.gameCode)).value(encode({ gameId: state.gameId, clusterId: "main", initial: state }));
      await control().put(controlKeys.gameCluster(state.gameId)).value("main");
      await control().put(controlKeys.activeGame(creator.id)).value(claim(state, creator.username));

      assert.deepEqual(await backend.store.getPlayerState(creator.id), { state: "PLAYING", gameCode: "CRASH001", gameStatus: "WAITING" });
      assert.equal(ok(await backend.store.getState("CRASH001")).gameId, state.gameId);
      assert.ok(await admin.namespace(DATA).get(keys.game(state.gameId)).string(), "the game was written to its data cluster");
    } finally {
      await backend.close();
    }
  });

  test("a join that never reached its game is completed while the game still waits", async () => {
    const backend = backendFor(endpoints);
    await backend.start();
    try {
      await admin.namespace(NAMESPACE).delete().all();
      const creator = { id: "join-creator", username: "creator" };
      const joiner = { id: "join-joiner", username: "joiner" };
      const state = ok(await backend.store.create(creator)).state;
      await control().put(controlKeys.activeGame(joiner.id)).value(claim(state, joiner.username));

      assert.deepEqual(await backend.store.getPlayerState(joiner.id), { state: "PLAYING", gameCode: state.gameCode, gameStatus: "PLACEMENT" });
      assert.equal(ok(await backend.store.getState(state.gameCode)).playerTwo?.id, joiner.id);
    } finally {
      await backend.close();
    }
  });

  test("a claim on a game that moved on without the player is released", async () => {
    const backend = backendFor(endpoints);
    await backend.start();
    try {
      await admin.namespace(NAMESPACE).delete().all();
      const creator = { id: "stale-creator", username: "creator" };
      const joiner = { id: "stale-joiner", username: "joiner" };
      const latecomer = { id: "stale-latecomer", username: "latecomer" };
      const state = ok(await backend.store.create(creator)).state;
      ok(await backend.store.command(state.gameCode, joiner, (occurredAt) => ({ type: "JOIN_GAME", actor: joiner, occurredAt })));
      await control().put(controlKeys.activeGame(latecomer.id)).value(claim(state, latecomer.username));

      assert.deepEqual(await backend.store.getPlayerState(latecomer.id), { state: "NOT_PLAYING" });
      assert.equal(await control().get(controlKeys.activeGame(latecomer.id)).string(), null);
      assert.equal(ok(await backend.store.create(latecomer)).state.playerOne.id, latecomer.id);
    } finally {
      await backend.close();
    }
  });

  test("presence turns LAGGING after 10 s and is dropped when the game finishes", async () => {
    const backend = backendFor(endpoints);
    await backend.start();
    try {
      await admin.namespace(NAMESPACE).delete().all();
      const first = { id: "presence-first", username: "first" };
      const second = { id: "presence-second", username: "second" };
      const created = ok(await backend.store.create(first)).state;
      ok(await backend.store.command(created.gameCode, second, (occurredAt) => ({ type: "JOIN_GAME", actor: second, occurredAt })));
      const state = ok(await backend.store.getState(created.gameCode));
      await admin.namespace(DATA).put(keys.presence(state.gameId, first.id)).value(new Date(Date.now() - 11_000).toISOString());
      await backend.store.touchPresence(state.gameId, second.id);
      assert.deepEqual(await backend.store.presence(state.gameId, state), { [first.id]: "LAGGING", [second.id]: "CONNECTED" });

      ok(await backend.store.command(created.gameCode, second, (occurredAt) => ({ type: "CANCEL_GAME", actor: second, occurredAt })));
      assert.deepEqual(await admin.namespace(DATA).getAll().prefix(keys.presencePrefix(state.gameId)).keys(), []);
    } finally {
      await backend.close();
    }
  });

  async function finishedGame(backend: StoreBackend, tag: string): Promise<string> {
    const first = { id: `${tag}-first`, username: "first" };
    const second = { id: `${tag}-second`, username: "second" };
    const code = ok(await backend.store.create(first)).state.gameCode;
    ok(await backend.store.command(code, second, (occurredAt) => ({ type: "JOIN_GAME", actor: second, occurredAt })));
    for (const player of [first, second]) {
      ok(await backend.store.command(code, player, (occurredAt) => ({ type: "PLACE_FLEET", actor: player, ships: [
        { start: { row: 0, column: 0 }, end: { row: 0, column: 4 } }, { start: { row: 2, column: 0 }, end: { row: 2, column: 3 } },
        { start: { row: 4, column: 0 }, end: { row: 4, column: 2 } }, { start: { row: 6, column: 0 }, end: { row: 6, column: 2 } },
        { start: { row: 8, column: 0 }, end: { row: 8, column: 1 } }], occurredAt })));
    }
    return ok(await backend.store.command(code, second, (occurredAt) => ({ type: "SURRENDER", actor: second, occurredAt }))).state.gameId;
  }

  test("two nodes never archive the same game at the same time", async () => {
    const nodes = [backendFor(endpoints), backendFor(endpoints)];
    for (const node of nodes) await node.start();
    try {
      await admin.namespace(NAMESPACE).delete().all();
      await finishedGame(nodes[0], "exclusive");
      let release = () => {};
      const slowArchive = new Promise<void>((resolve) => { release = resolve; });
      const first = nodes[0].outbox.processNext(() => slowArchive);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await nodes[1].outbox.processNext(async () => assert.fail("archived twice"))).kind, "empty");
      release();
      assert.equal((await first).kind, "archived");
      assert.equal((await nodes[1].outbox.processNext(async () => assert.fail("archived twice"))).kind, "empty");
    } finally {
      for (const node of nodes) await node.close();
    }
  });

  test("a claim left by a crashed node expires and the job is archived", async () => {
    const backend = backendFor(endpoints);
    await backend.start();
    try {
      await admin.namespace(NAMESPACE).delete().all();
      const gameId = await finishedGame(backend, "crashed");
      // A claim whose lease nobody renews, as if its node died mid-archive.
      const orphan = admin.namespace(DATA).lease(2, { autoKeepAlive: false });
      await orphan.put(keys.archiveClaim(gameId)).value("");
      assert.equal((await backend.outbox.processNext(async () => assert.fail("claimed job processed"))).kind, "empty");
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      assert.equal((await backend.outbox.processNext(async () => {})).kind, "archived");
    } finally {
      await backend.close();
    }
  });

});

describe("etcd backend", () => {
  const unreachable = backendFor("127.0.0.1:1");
  after(() => unreachable.close());

  test("reports healthy against a running cluster", async () => {
    const backend = backendFor(endpoints);
    try {
      await backend.start();
      assert.equal(backend.isReady(), true);
      assert.equal(await backend.checkHealth(), true);
    } finally {
      await backend.close();
    }
  });

  test("watches stay connected, so idle listeners are not woken", async () => {
    // Call deadlines once applied to the watch stream too, cutting it every 2 s and waking every listener.
    const backend = backendFor(endpoints);
    await backend.start();
    let wakes = 0;
    const listener = () => { wakes += 1; };
    try {
      backend.updates.on("idle-game", listener);
      backend.updates.onPlayer("idle-player", listener);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      assert.equal(wakes, 0);
    } finally {
      backend.updates.off("idle-game", listener);
      backend.updates.offPlayer("idle-player", listener);
      await backend.close();
    }
  });

  test("reports unhealthy within a few seconds when etcd is unreachable", async () => {
    const started = Date.now();
    assert.equal(await unreachable.checkHealth(), false);
    assert.equal(unreachable.isReady(), false);
    assert.ok(Date.now() - started < 8_000, `health check took ${Date.now() - started} ms`);
  });

  test("classifies connection failures as unavailable", async () => {
    const client = new Etcd3({ hosts: "127.0.0.1:1", dialTimeout: 500, defaultCallOptions: () => ({ deadline: Date.now() + 500 }) });
    try {
      // Enough calls to trip the client's circuit breaker, whose error is classified separately.
      for (let call = 0; call < 6; call += 1) {
        const failure = await client.get("x").string().then(() => assert.fail("expected a connection failure"), (caught: unknown) => caught);
        assert.equal(unreachable.isUnavailableError(failure), true, `call ${call} not classified: ${String(failure)}`);
      }
      // A call cancelled because the library reset its connection is just as unresolved as one that failed outright.
      assert.equal(unreachable.isUnavailableError(new GRPCCancelledError("1 CANCELLED: Call cancelled")), true);
      assert.equal(unreachable.isUnavailableError(new Error("unrelated")), false);
    } finally {
      client.close();
    }
  });
});
