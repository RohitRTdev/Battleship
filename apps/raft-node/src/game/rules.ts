import type { Coordinate, ShipPlacement } from "@battleship/game-contract";
import { failure, success } from "./errors.js";
import type { Fleet, Result, Ship } from "./types.js";

export const BOARD_SIZE = 10;
export const FLEET_LENGTHS = [2, 3, 3, 4, 5] as const;

export function coordinateKey(coordinate: Coordinate): string {
  return `${coordinate.row}:${coordinate.column}`;
}

export function coordinatesEqual(left: Coordinate, right: Coordinate): boolean {
  return left.row === right.row && left.column === right.column;
}

export function isValidCoordinate(value: Coordinate): boolean {
  return Number.isInteger(value.row) && Number.isInteger(value.column) &&
    value.row >= 0 && value.row < BOARD_SIZE && value.column >= 0 && value.column < BOARD_SIZE;
}

function cellsForPlacement(placement: ShipPlacement): Result<Coordinate[]> {
  const { start, end } = placement;
  if (!isValidCoordinate(start) || !isValidCoordinate(end)) {
    return failure("SHIP_OUT_OF_BOUNDS");
  }
  if (start.row !== end.row && start.column !== end.column) {
    return failure("INVALID_FLEET_COMPOSITION");
  }

  const rowStep = Math.sign(end.row - start.row);
  const columnStep = Math.sign(end.column - start.column);
  const length = Math.max(Math.abs(end.row - start.row), Math.abs(end.column - start.column)) + 1;
  const cells = Array.from({ length }, (_, index) => ({
    row: start.row + rowStep * index,
    column: start.column + columnStep * index
  }));
  return success(cells);
}

export function validateFleet(placements: ShipPlacement[]): Result<Fleet> {
  if (placements.length !== FLEET_LENGTHS.length) {
    return failure("INVALID_FLEET_COMPOSITION");
  }

  const ships: Ship[] = [];
  for (const placement of placements) {
    const result = cellsForPlacement(placement);
    if (!result.ok) return result;
    ships.push({ length: result.value.length, cells: result.value });
  }

  const lengths = ships.map((ship) => ship.length).sort((a, b) => a - b);
  if (lengths.some((length, index) => length !== FLEET_LENGTHS[index])) {
    return failure("INVALID_FLEET_COMPOSITION");
  }

  const occupied = new Map<string, number>();
  for (let shipIndex = 0; shipIndex < ships.length; shipIndex += 1) {
    for (const cell of ships[shipIndex].cells) {
      const key = coordinateKey(cell);
      if (occupied.has(key)) return failure("SHIPS_OVERLAP");
      occupied.set(key, shipIndex);
    }
  }

  for (const [key, shipIndex] of occupied) {
    const [row, column] = key.split(":").map(Number);
    for (let rowDelta = -1; rowDelta <= 1; rowDelta += 1) {
      for (let columnDelta = -1; columnDelta <= 1; columnDelta += 1) {
        const neighbour = occupied.get(`${row + rowDelta}:${column + columnDelta}`);
        if (neighbour !== undefined && neighbour !== shipIndex) {
          return failure("SHIPS_ADJACENT");
        }
      }
    }
  }

  return success({ ships });
}
