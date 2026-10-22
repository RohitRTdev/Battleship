import assert from "node:assert/strict";
import test from "node:test";
import type { Coordinate, ShipPlacement } from "@battleship/game-contract";
import { applyGameCommand, createGame, projectGame, replayCommands, type GameCommand, type GameState, type PersistedCommand, type Player } from "./index.js";

const alice: Player = { id: "1", username: "alice" };
const bob: Player = { id: "2", username: "bob" };
const carol: Player = { id: "3", username: "carol" };
const validFleet: ShipPlacement[] = [
  { start: { row: 0, column: 0 }, end: { row: 0, column: 4 } },
  { start: { row: 2, column: 0 }, end: { row: 2, column: 3 } },
  { start: { row: 4, column: 0 }, end: { row: 4, column: 2 } },
  { start: { row: 6, column: 0 }, end: { row: 6, column: 2 } },
  { start: { row: 8, column: 0 }, end: { row: 8, column: 1 } }
];

function created(): { state: GameState; commands: PersistedCommand[] } {
  const command = { type: "CREATE_GAME" as const, gameId: "game-1", gameCode: "ABC12345", actor: alice, occurredAt: "2026-01-01T00:00:00.000Z" };
  const result = createGame(command);
  assert.equal(result.ok, true);
  return { state: result.value.state, commands: [command] };
}

function apply(state: GameState, command: GameCommand): GameState {
  const result = applyGameCommand(state, command);
  if (!result.ok) assert.fail(result.error.code);
  return result.value.state;
}

function activeGame(): GameState {
  let { state } = created();
  state = apply(state, { type: "JOIN_GAME", actor: bob, occurredAt: "2026-01-01T00:01:00.000Z" });
  state = apply(state, { type: "PLACE_FLEET", actor: alice, ships: validFleet, occurredAt: "2026-01-01T00:02:00.000Z" });
  return apply(state, { type: "PLACE_FLEET", actor: bob, ships: validFleet, occurredAt: "2026-01-01T00:03:00.000Z" });
}

test("creation, joining, placement, and versions follow the lifecycle", () => {
  let { state } = created();
  assert.equal(state.status, "WAITING");
  assert.equal(state.version, 1);
  state = apply(state, { type: "JOIN_GAME", actor: bob, occurredAt: "2026-01-01T00:01:00.000Z" });
  assert.equal(state.status, "PLACEMENT");
  state = apply(state, { type: "PLACE_FLEET", actor: alice, ships: validFleet, occurredAt: "2026-01-01T00:02:00.000Z" });
  assert.equal(state.status, "PLACEMENT");
  state = apply(state, { type: "PLACE_FLEET", actor: bob, ships: validFleet, occurredAt: "2026-01-01T00:03:00.000Z" });
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.currentTurn, alice.id);
  assert.equal(state.version, 4);
});

test("duplicate and third players are rejected without mutation", () => {
  let { state } = created();
  const duplicate = applyGameCommand(state, { type: "JOIN_GAME", actor: alice, occurredAt: "x" });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, "PLAYER_ALREADY_IN_GAME");
  state = apply(state, { type: "JOIN_GAME", actor: bob, occurredAt: "x" });
  const before = structuredClone(state);
  const third = applyGameCommand(state, { type: "JOIN_GAME", actor: carol, occurredAt: "x" });
  assert.equal(third.ok, false);
  assert.equal(third.error.code, "GAME_FULL");
  assert.deepEqual(state, before);
});

test("fleet validation reports composition, bounds, overlap, and adjacency", () => {
  let { state } = created();
  state = apply(state, { type: "JOIN_GAME", actor: bob, occurredAt: "x" });
  const cases: Array<[ShipPlacement[], string]> = [
    [validFleet.slice(0, 4), "INVALID_FLEET_COMPOSITION"],
    [[...validFleet.slice(0, 4), { start: { row: 9, column: 9 }, end: { row: 9, column: 10 } }], "SHIP_OUT_OF_BOUNDS"],
    [[validFleet[0], validFleet[1], validFleet[2], validFleet[3], { start: { row: 0, column: 0 }, end: { row: 0, column: 1 } }], "SHIPS_OVERLAP"],
    [[validFleet[0], validFleet[1], validFleet[2], validFleet[3], { start: { row: 1, column: 5 }, end: { row: 1, column: 6 } }], "SHIPS_ADJACENT"]
  ];
  for (const [ships, code] of cases) {
    const result = applyGameCommand(state, { type: "PLACE_FLEET", actor: alice, ships, occurredAt: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
});

test("placement is one-time and unauthorized actors are rejected", () => {
  let { state } = created();
  state = apply(state, { type: "JOIN_GAME", actor: bob, occurredAt: "x" });
  state = apply(state, { type: "PLACE_FLEET", actor: alice, ships: validFleet, occurredAt: "x" });
  const repeated = applyGameCommand(state, { type: "PLACE_FLEET", actor: alice, ships: validFleet, occurredAt: "x" });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.error.code, "FLEET_ALREADY_SUBMITTED");
  const outsider = applyGameCommand(state, { type: "PLACE_FLEET", actor: carol, ships: validFleet, occurredAt: "x" });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.error.code, "PLAYER_NOT_IN_GAME");
});

test("turns, invalid coordinates, misses, hits, and repeated shots are enforced", () => {
  let state = activeGame();
  const wrongTurn = applyGameCommand(state, { type: "FIRE", actor: bob, coordinate: { row: 9, column: 9 }, occurredAt: "x" });
  assert.equal(wrongTurn.ok, false);
  assert.equal(wrongTurn.error.code, "NOT_YOUR_TURN");
  const invalid = applyGameCommand(state, { type: "FIRE", actor: alice, coordinate: { row: 10, column: 0 }, occurredAt: "x" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_COORDINATE");
  state = apply(state, { type: "FIRE", actor: alice, coordinate: { row: 9, column: 9 }, occurredAt: "x" });
  assert.equal(state.attacks.at(-1)?.result, "MISS");
  state = apply(state, { type: "FIRE", actor: bob, coordinate: { row: 9, column: 8 }, occurredAt: "x" });
  state = apply(state, { type: "FIRE", actor: alice, coordinate: { row: 0, column: 0 }, occurredAt: "x" });
  assert.equal(state.attacks.at(-1)?.result, "HIT");
  state = apply(state, { type: "FIRE", actor: bob, coordinate: { row: 9, column: 7 }, occurredAt: "x" });
  const repeated = applyGameCommand(state, { type: "FIRE", actor: alice, coordinate: { row: 0, column: 0 }, occurredAt: "x" });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.error.code, "COORDINATE_ALREADY_ATTACKED");
});

test("cancel and surrender finish games and reject later commands", () => {
  let { state } = created();
  state = apply(state, { type: "CANCEL_GAME", actor: alice, occurredAt: "end" });
  assert.equal(state.completionReason, "CANCELLED");
  const join = applyGameCommand(state, { type: "JOIN_GAME", actor: bob, occurredAt: "later" });
  assert.equal(join.ok, false);
  assert.equal(join.error.code, "GAME_CANCELLED");

  state = activeGame();
  state = apply(state, { type: "SURRENDER", actor: bob, occurredAt: "end" });
  assert.equal(state.winnerPlayerId, alice.id);
  assert.equal(state.completionReason, "SURRENDER");
  const fire = applyGameCommand(state, { type: "FIRE", actor: alice, coordinate: { row: 0, column: 0 }, occurredAt: "later" });
  assert.equal(fire.ok, false);
  assert.equal(fire.error.code, "GAME_ALREADY_FINISHED");
});

test("a complete match produces sunk and win outcomes", () => {
  let state = activeGame();
  const targets = validFleet.flatMap((ship) => {
    const cells: Coordinate[] = [];
    for (let column = ship.start.column; column <= ship.end.column; column += 1) cells.push({ row: ship.start.row, column });
    return cells;
  });
  const misses = [
    ...Array.from({ length: 10 }, (_, column) => ({ row: 1, column })),
    ...Array.from({ length: 6 }, (_, column) => ({ row: 3, column }))
  ];
  for (let index = 0; index < targets.length; index += 1) {
    state = apply(state, { type: "FIRE", actor: alice, coordinate: targets[index], occurredAt: `a${index}` });
    if (index < misses.length) state = apply(state, { type: "FIRE", actor: bob, coordinate: misses[index], occurredAt: `b${index}` });
  }
  assert.equal(state.status, "FINISHED");
  assert.equal(state.winnerPlayerId, alice.id);
  assert.equal(state.completionReason, "FLEET_DESTROYED");
  assert.equal(state.attacks.at(-1)?.result, "WIN");
});

test("player projection never reveals the opponent fleet", () => {
  const state = activeGame();
  const view = projectGame(state, alice.id);
  assert.ok(view);
  assert.equal(view.yourFleet?.length, 5);
  assert.equal("opponentFleet" in view, false);
  assert.equal(JSON.stringify(view).includes('"playerTwoFleet"'), false);
});

test("replaying identical commands is deterministic", () => {
  const initial = created();
  const commands: PersistedCommand[] = [
    ...initial.commands,
    { type: "JOIN_GAME", actor: bob, occurredAt: "1" },
    { type: "PLACE_FLEET", actor: alice, ships: validFleet, occurredAt: "2" },
    { type: "PLACE_FLEET", actor: bob, ships: validFleet, occurredAt: "3" },
    { type: "FIRE", actor: alice, coordinate: { row: 9, column: 9 }, occurredAt: "4" }
  ];
  assert.deepEqual(replayCommands(commands), replayCommands(structuredClone(commands)));
});
