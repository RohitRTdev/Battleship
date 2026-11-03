import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Etcd3 } from "etcd3";
import { createEtcdBackend } from "../src/store/etcd/backend.js";
import { encode, keys, NAMESPACE } from "../src/store/etcd/keys.js";
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
  },
  pending: [
    "a finished game queues exactly one archive job",
    "a failed archive write is retried later instead of being lost",
    "updates wake listeners for the changed game",
    "presence reports recently seen players as connected"
  ]
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

  test("matchmaking skips a stale queue entry for a player already in a game", async () => {
    const backend = backendFor(endpoints);
    await backend.start();
    try {
      await admin.namespace(NAMESPACE).delete().all();
      const stale = { id: "stale-player", username: "stale" };
      ok(await backend.store.create(stale));
      // Force the impossible state: the player is in a game and also queued.
      await admin.namespace(NAMESPACE).put(keys.queueEntry(stale.id)).value(encode({ username: stale.username, enqueuedAt: new Date().toISOString() }));
      const result = ok(await backend.store.startMatchmaking({ id: "fresh-player", username: "fresh" }));
      assert.equal(result.state, "SEARCHING");
      assert.equal(await admin.namespace(NAMESPACE).get(keys.queueEntry(stale.id)).string(), null);
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
      assert.equal(unreachable.isUnavailableError(new Error("unrelated")), false);
    } finally {
      client.close();
    }
  });
});
