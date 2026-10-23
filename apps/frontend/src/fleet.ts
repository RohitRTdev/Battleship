import type { Coordinate, ShipPlacement } from "@battleship/game-contract";

export const BOARD_SIZE = 10;

export type Orientation = "horizontal" | "vertical";
export type FleetShip = {
  id: string;
  name: string;
  length: number;
};
export type PlacedShip = FleetShip & {
  row: number;
  column: number;
  orientation: Orientation;
};

export const FLEET: FleetShip[] = [
  { id: "carrier", name: "Carrier", length: 5 },
  { id: "battleship", name: "Battleship", length: 4 },
  { id: "cruiser", name: "Cruiser", length: 3 },
  { id: "submarine", name: "Submarine", length: 3 },
  { id: "destroyer", name: "Destroyer", length: 2 }
];

export function cellsFor(ship: PlacedShip): Coordinate[] {
  return Array.from({ length: ship.length }, (_, index) => ({
    row: ship.row + (ship.orientation === "vertical" ? index : 0),
    column: ship.column + (ship.orientation === "horizontal" ? index : 0)
  }));
}

export function validatePlacement(candidate: PlacedShip, placed: PlacedShip[]): string | null {
  const cells = cellsFor(candidate);
  if (cells.some(({ row, column }) => row < 0 || row >= BOARD_SIZE || column < 0 || column >= BOARD_SIZE)) {
    return "That ship would go outside the board.";
  }

  const others = placed.filter((ship) => ship.id !== candidate.id);
  for (const cell of cells) {
    for (const other of others) {
      for (const occupied of cellsFor(other)) {
        if (cell.row === occupied.row && cell.column === occupied.column) {
          return "Ships cannot overlap.";
        }
        if (Math.abs(cell.row - occupied.row) <= 1 && Math.abs(cell.column - occupied.column) <= 1) {
          return "Ships need one cell of clearance, including diagonally.";
        }
      }
    }
  }
  return null;
}

export function toPlacements(ships: PlacedShip[]): ShipPlacement[] {
  return ships.map((ship) => {
    const cells = cellsFor(ship);
    return { start: cells[0], end: cells[cells.length - 1] };
  });
}

export function autoPlaceFleet(): PlacedShip[] {
  const placed: PlacedShip[] = [];
  for (const ship of FLEET) {
    let accepted: PlacedShip | null = null;
    for (let attempt = 0; attempt < 400 && !accepted; attempt += 1) {
      const candidate: PlacedShip = {
        ...ship,
        orientation: Math.random() > 0.5 ? "horizontal" : "vertical",
        row: Math.floor(Math.random() * BOARD_SIZE),
        column: Math.floor(Math.random() * BOARD_SIZE)
      };
      if (!validatePlacement(candidate, placed)) accepted = candidate;
    }
    if (!accepted) {
      return [
        { ...FLEET[0], row: 0, column: 0, orientation: "horizontal" },
        { ...FLEET[1], row: 2, column: 0, orientation: "horizontal" },
        { ...FLEET[2], row: 4, column: 0, orientation: "horizontal" },
        { ...FLEET[3], row: 6, column: 0, orientation: "horizontal" },
        { ...FLEET[4], row: 8, column: 0, orientation: "horizontal" }
      ];
    }
    placed.push(accepted);
  }
  return placed;
}
