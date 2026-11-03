import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Coordinate, ShipPlacement } from "@battleship/game-contract";
import type { GameCommand, GameState, Player } from "../src/game/index.js";
import type { CommandResult, GameStore, StoreBackend } from "../src/store/index.js";

/** Store-specific setup for the contract suite. */
export type StoreHarness = {
  /** Creates a started backend. Turn timeouts are disabled so tests are not time-dependent. */
  open(): Promise<StoreBackend>;
  /** Deletes all game, matchmaking, presence and archive data. */
  reset(): Promise<void>;
  /** Called once after all tests, after the backend is closed. */
  dispose?(): Promise<void>;
  /** Names of tests this store does not support yet; they run as todo and cannot fail the suite. */
  pending?: string[];
};

const FLEET: ShipPlacement[] = [
  { start: { row: 0, column: 0 }, end: { row: 0, column: 4 } },
  { start: { row: 2, column: 0 }, end: { row: 2, column: 3 } },
  { start: { row: 4, column: 0 }, end: { row: 4, column: 2 } },
  { start: { row: 6, column: 0 }, end: { row: 6, column: 2 } },
  { start: { row: 8, column: 0 }, end: { row: 8, column: 1 } }
];
const FLEET_CELLS: Coordinate[] = FLEET.flatMap(({ start, end }) =>
  Array.from({ length: end.column - start.column + 1 }, (_, offset) => ({ row: start.row, column: start.column + offset })));
const MISSES: Coordinate[] = [1, 3, 5, 7, 9].flatMap((row) => Array.from({ length: 10 }, (_, column) => ({ row, column })));

let nextPlayer = 0;
function player(): Player {
  nextPlayer += 1;
  return { id: `player-${nextPlayer}`, username: `player${nextPlayer}` };
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) assert.fail(`expected success, got ${result.error.code}`);
  return result.value;
}

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

type Build = (state: GameState, occurredAt: string) => GameCommand;
const join = (actor: Player): Build => (_state, occurredAt) => ({ type: "JOIN_GAME", actor, occurredAt });
const place = (actor: Player): Build => (_state, occurredAt) => ({ type: "PLACE_FLEET", actor, ships: FLEET, occurredAt });
const fire = (actor: Player, coordinate: Coordinate): Build => (_state, occurredAt) => ({ type: "FIRE", actor, coordinate, occurredAt });
const cancel = (actor: Player): Build => (_state, occurredAt) => ({ type: "CANCEL_GAME", actor, occurredAt });
const surrender = (actor: Player): Build => (_state, occurredAt) => ({ type: "SURRENDER", actor, occurredAt });

async function activeGame(store: GameStore): Promise<{ code: string; first: Player; second: Player; state: GameState }> {
  const first = player();
  const second = player();
  const code = ok(await store.create(first)).state.gameCode;
  ok(await store.command(code, second, join(second)));
  ok(await store.command(code, first, place(first)));
  const state = ok(await store.command(code, second, place(second))).state;
  return { code, first, second, state };
}

/** Behaviour every GameStore implementation must share. */
export function defineStoreContract(name: string, harness: StoreHarness): void {
  const pending = new Set(harness.pending ?? []);
  const defined = new Set<string>();
  const it = (title: string, body: () => Promise<void>) => {
    defined.add(title);
    test(title, pending.has(title) ? { todo: "not implemented in this store yet" } : {}, body);
  };

  describe(`${name} store contract`, () => {
    let backend: StoreBackend;
    let store: GameStore;

    before(async () => {
      backend = await harness.open();
      store = backend.store;
    });
    beforeEach(() => harness.reset());
    after(async () => {
      await backend?.close();
      await harness.dispose?.();
    });

    it("create makes a waiting game owned by its creator", async () => {
      const creator = player();
      const { state } = ok(await store.create(creator));
      assert.equal(state.status, "WAITING");
      assert.equal(state.version, 1);
      assert.match(state.gameCode, /^[0-9A-HJKMNP-TV-Z]{8}$/);
      assert.deepEqual(ok(await store.getState(state.gameCode)), state);
      assert.deepEqual(await store.getPlayerState(creator.id), { state: "PLAYING", gameCode: state.gameCode, gameStatus: "WAITING" });
    });

    it("a player can be in only one active game", async () => {
      const creator = player();
      ok(await store.create(creator));
      assert.equal(errorCode(await store.create(creator)), "PLAYER_ALREADY_PLAYING");

      const other = player();
      const otherCode = ok(await store.create(other)).state.gameCode;
      assert.equal(errorCode(await store.command(otherCode, creator, join(creator))), "PLAYER_ALREADY_PLAYING");
    });

    it("commands are validated against the stored state", async () => {
      assert.equal(errorCode(await store.getState("ZZZZZZZZ")), "GAME_NOT_FOUND");
      const { code, first, second } = await activeGame(store);
      const outsider = player();
      assert.equal(errorCode(await store.command(code, second, fire(second, { row: 0, column: 0 }))), "NOT_YOUR_TURN");
      assert.equal(errorCode(await store.command(code, outsider, fire(outsider, { row: 0, column: 0 }))), "PLAYER_NOT_IN_GAME");
      ok(await store.command(code, first, fire(first, { row: 0, column: 0 })));
      ok(await store.command(code, second, fire(second, MISSES[0])));
      assert.equal(errorCode(await store.command(code, first, fire(first, { row: 0, column: 0 }))), "COORDINATE_ALREADY_ATTACKED");
    });

    it("a full game finishes once and frees both players", async () => {
      const { code, first, second } = await activeGame(store);
      let last: CommandResult | undefined;
      for (const [index, target] of FLEET_CELLS.entries()) {
        last = ok(await store.command(code, first, fire(first, target)));
        if (index < FLEET_CELLS.length - 1) ok(await store.command(code, second, fire(second, MISSES[index])));
      }
      assert.equal(last?.outcome.type, "WIN");
      const finished = ok(await store.getState(code));
      assert.equal(finished.status, "FINISHED");
      assert.equal(finished.winnerPlayerId, first.id);
      assert.equal(finished.completionReason, "FLEET_DESTROYED");
      assert.equal(errorCode(await store.command(code, second, fire(second, MISSES[20]))), "GAME_ALREADY_FINISHED");
      assert.deepEqual(await store.getPlayerState(first.id), { state: "NOT_PLAYING" });
      assert.deepEqual(await store.getPlayerState(second.id), { state: "NOT_PLAYING" });
      ok(await store.create(first));
    });

    it("a finished game queues exactly one archive job", async () => {
      const { code, second } = await activeGame(store);
      const finished = ok(await store.command(code, second, surrender(second))).state;
      const archived: GameState[] = [];
      const result = await backend.outbox.processNext(async (snapshot) => { archived.push(snapshot); });
      assert.equal(result.kind, "archived");
      assert.equal(archived.length, 1);
      assert.equal(archived[0].gameId, finished.gameId);
      assert.equal(archived[0].version, finished.version);
      assert.equal((await backend.outbox.processNext(async () => assert.fail("job archived twice"))).kind, "empty");
    });

    it("a failed archive write is retried later instead of being lost", async () => {
      const { code, second } = await activeGame(store);
      ok(await store.command(code, second, surrender(second)));
      const failed = await backend.outbox.processNext(async () => { throw new Error("archive unavailable"); });
      assert.equal(failed.kind, "failed");
      assert.ok(failed.kind === "failed" && failed.retryInMs > 0);
      assert.equal((await backend.outbox.processNext(async () => assert.fail("retried before its backoff"))).kind, "empty");
    });

    it("cancelling a game in placement frees both players", async () => {
      const first = player();
      const second = player();
      const code = ok(await store.create(first)).state.gameCode;
      ok(await store.command(code, second, join(second)));
      const cancelled = ok(await store.command(code, second, cancel(second))).state;
      assert.equal(cancelled.completionReason, "CANCELLED");
      assert.deepEqual(await store.getPlayerState(first.id), { state: "NOT_PLAYING" });
      assert.equal((await backend.outbox.processNext(async () => assert.fail("cancelled games are not archived"))).kind, "empty");
    });

    it("concurrent attacks on one turn commit exactly one move", async () => {
      const { code, first, state } = await activeGame(store);
      const results = await Promise.all(Array.from({ length: 5 }, (_, column) => store.command(code, first, fire(first, { row: 1, column }))));
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.deepEqual(results.filter((result) => !result.ok).map(errorCode), ["NOT_YOUR_TURN", "NOT_YOUR_TURN", "NOT_YOUR_TURN", "NOT_YOUR_TURN"]);
      const after = ok(await store.getState(code));
      assert.equal(after.version, state.version + 1);
      assert.equal(after.attacks.length, 1);
    });

    it("matchmaking pairs two searching players into one game", async () => {
      const first = player();
      const second = player();
      const waiting = ok(await store.startMatchmaking(first));
      assert.equal(waiting.state, "SEARCHING");
      assert.equal(errorCode(await store.startMatchmaking(first)), "PLAYER_ALREADY_SEARCHING");
      const matched = ok(await store.startMatchmaking(second));
      assert.equal(matched.state, "PLAYING");
      assert.ok(matched.state === "PLAYING");
      assert.deepEqual(await store.getPlayerState(first.id), matched);
      const game = ok(await store.getState(matched.gameCode));
      assert.deepEqual([game.playerOne.id, game.playerTwo?.id], [first.id, second.id]);
      assert.equal(game.status, "PLACEMENT");
    });

    it("cancelling matchmaking leaves the queue", async () => {
      const searcher = player();
      ok(await store.startMatchmaking(searcher));
      assert.deepEqual(await store.cancelMatchmaking(searcher.id), { state: "NOT_PLAYING" });
      assert.equal(ok(await store.startMatchmaking(player())).state, "SEARCHING");
    });

    it("simultaneous matchmaking requests pair every player exactly once", async () => {
      const players = Array.from({ length: 40 }, player);
      const results = await Promise.all(players.map((searcher) => store.startMatchmaking(searcher)));
      assert.ok(results.every((result) => result.ok));
      const games = new Map<string, string[]>();
      for (const searcher of players) {
        const state = await store.getPlayerState(searcher.id);
        assert.equal(state.state, "PLAYING", `${searcher.id} was not matched`);
        if (state.state !== "PLAYING") continue;
        games.set(state.gameCode, [...(games.get(state.gameCode) ?? []), searcher.id]);
      }
      assert.equal(games.size, 20);
      assert.ok([...games.values()].every((members) => members.length === 2));
    });

    it("updates wake listeners for the changed game", async () => {
      const first = player();
      const second = player();
      const created = ok(await store.create(first)).state;
      // Notifications are asynchronous, so the one for the create itself may still arrive after this point.
      let listener: (version: number) => void = () => {};
      let timer: NodeJS.Timeout | undefined;
      const woke = new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("no update within 2s")), 2_000);
        listener = (version) => { if (version >= 2) resolve(version); };
        backend.updates.on(created.gameId, listener);
      });
      try {
        ok(await store.command(created.gameCode, second, join(second)));
        assert.equal(await woke, 2);
      } finally {
        clearTimeout(timer);
        backend.updates.off(created.gameId, listener);
        woke.catch(() => undefined);
      }
    });

    it("presence reports recently seen players as connected", async () => {
      const { first, state } = await activeGame(store);
      await store.touchPresence(state.gameId, first.id);
      const presence = await store.presence(state.gameId, state);
      assert.equal(presence[first.id], "CONNECTED");
      assert.equal(presence[state.playerTwo!.id], "UNKNOWN");
    });

    it("expireOneTurn does nothing when no deadline has passed", async () => {
      await activeGame(store);
      assert.equal(await store.expireOneTurn(), false);
    });
  });

  const unknown = [...pending].filter((title) => !defined.has(title));
  if (unknown.length > 0) throw new Error(`Unknown pending tests for ${name}: ${unknown.join(", ")}`);
}
