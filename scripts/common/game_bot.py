"""Shared Battleship bot API and strategy helpers."""

from __future__ import annotations

import json
import random
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BOARD_SIZE = 10
SHIP_LENGTHS = (5, 4, 3, 3, 2)


class ApiError(RuntimeError):
    """Raised when the game API rejects a request or cannot be reached."""

    def __init__(self, message: str, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class GameClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> dict[str, Any]:
        encoded = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=encoded,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Cache-Control": "no-store",
                **({"Content-Type": "application/json"} if encoded is not None else {}),
            },
        )
        try:
            with urlopen(request, timeout=12) as response:
                status = response.status
                payload = json.loads(response.read() or b"{}")
        except HTTPError as error:
            status = error.code
            try:
                payload = json.loads(error.read() or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                payload = {}
        except URLError as error:
            raise ApiError(f"Could not reach the server: {error.reason}") from error

        if not isinstance(payload, dict):
            raise ApiError(f"{method} {path} returned invalid JSON", status)
        if status not in expected:
            raw_error = payload.get("error")
            if isinstance(raw_error, dict):
                code = raw_error.get("code") if isinstance(raw_error.get("code"), str) else None
                message = raw_error.get("message") if isinstance(raw_error.get("message"), str) else str(raw_error)
            else:
                code = None
                message = raw_error if isinstance(raw_error, str) else f"HTTP {status}"
            raise ApiError(f"{method} {path}: {message}", status, code)
        return payload


def random_fleet(rng: random.Random) -> list[dict[str, dict[str, int]]]:
    """Build a fleet whose ships do not overlap or touch, including diagonally."""

    occupied: set[tuple[int, int]] = set()
    ships: list[dict[str, dict[str, int]]] = []
    for length in SHIP_LENGTHS:
        for _ in range(5_000):
            horizontal = bool(rng.randrange(2))
            row = rng.randrange(BOARD_SIZE if horizontal else BOARD_SIZE - length + 1)
            column = rng.randrange(BOARD_SIZE - length + 1 if horizontal else BOARD_SIZE)
            cells = [
                (row, column + offset) if horizontal else (row + offset, column)
                for offset in range(length)
            ]
            touching = any(
                abs(candidate_row - occupied_row) <= 1
                and abs(candidate_column - occupied_column) <= 1
                for candidate_row, candidate_column in cells
                for occupied_row, occupied_column in occupied
            )
            if touching:
                continue
            occupied.update(cells)
            end_row, end_column = cells[-1]
            ships.append(
                {
                    "start": {"row": row, "column": column},
                    "end": {"row": end_row, "column": end_column},
                }
            )
            break
        else:
            return random_fleet(rng)
    return ships


def coordinate_name(coordinate: dict[str, int]) -> str:
    return f"{chr(ord('A') + coordinate['column'])}{coordinate['row'] + 1}"


def orthogonal_neighbours(cell: tuple[int, int]) -> list[tuple[int, int]]:
    row, column = cell
    return [
        (candidate_row, candidate_column)
        for candidate_row, candidate_column in (
            (row - 1, column),
            (row + 1, column),
            (row, column - 1),
            (row, column + 1),
        )
        if 0 <= candidate_row < BOARD_SIZE and 0 <= candidate_column < BOARD_SIZE
    ]


def connected_components(cells: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    remaining = set(cells)
    components: list[set[tuple[int, int]]] = []
    while remaining:
        component: set[tuple[int, int]] = set()
        pending = [remaining.pop()]
        while pending:
            cell = pending.pop()
            component.add(cell)
            for neighbour in orthogonal_neighbours(cell):
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    pending.append(neighbour)
        components.append(component)
    return components


def aggressive_target(game: dict[str, Any], rng: random.Random) -> dict[str, int]:
    """Choose a shot using hit pursuit and a remaining-ship probability map."""

    attacks = {
        (attack["coordinate"]["row"], attack["coordinate"]["column"]): attack["result"]
        for attack in game.get("yourAttacks", [])
    }
    available = {
        (row, column)
        for row in range(BOARD_SIZE)
        for column in range(BOARD_SIZE)
        if (row, column) not in attacks
    }
    if not available:
        raise ApiError("The bot ran out of legal target squares")

    hit_cells = {cell for cell, result in attacks.items() if result != "MISS"}
    hit_groups = connected_components(hit_cells)
    sunk_groups = [
        group
        for group in hit_groups
        if any(attacks[cell] in {"SUNK", "WIN"} for cell in group)
    ]
    unresolved_groups = [group for group in hit_groups if group not in sunk_groups]

    # Ships may not touch, so every square surrounding an already sunk ship is
    # known to be empty even if it has never been fired at.
    impossible = {
        (row, column)
        for group in sunk_groups
        for ship_row, ship_column in group
        for row in range(max(0, ship_row - 1), min(BOARD_SIZE, ship_row + 2))
        for column in range(max(0, ship_column - 1), min(BOARD_SIZE, ship_column + 2))
    }
    useful_available = available - impossible
    if not useful_available:
        useful_available = available

    remaining_lengths = list(SHIP_LENGTHS)
    for group in sunk_groups:
        if len(group) in remaining_lengths:
            remaining_lengths.remove(len(group))

    scores = {cell: 0 for cell in useful_available}
    misses = {cell for cell, result in attacks.items() if result == "MISS"}
    forbidden = misses | impossible

    # Count every placement still compatible with what the bot has learned.
    # Cells occurring in more possible placements receive a higher score.
    for length in remaining_lengths:
        for horizontal in (True, False):
            row_limit = BOARD_SIZE if horizontal else BOARD_SIZE - length + 1
            column_limit = BOARD_SIZE - length + 1 if horizontal else BOARD_SIZE
            for row in range(row_limit):
                for column in range(column_limit):
                    placement = {
                        (row, column + offset) if horizontal else (row + offset, column)
                        for offset in range(length)
                    }
                    if placement & forbidden:
                        continue
                    for cell in placement & useful_available:
                        scores[cell] += 1
                    matching_hit_groups = sum(
                        group <= placement for group in unresolved_groups
                    )
                    if matching_hit_groups:
                        for cell in placement & useful_available:
                            scores[cell] += 40 * matching_hit_groups

    # After a hit, restrict the next shot to that ship's neighbours. With two
    # aligned hits, only consider the two ends of the discovered line.
    pursuit: set[tuple[int, int]] = set()
    for group in unresolved_groups:
        rows = {row for row, _ in group}
        columns = {column for _, column in group}
        if len(group) > 1 and len(rows) == 1:
            row = next(iter(rows))
            ordered = sorted(column for _, column in group)
            pursuit.update({(row, ordered[0] - 1), (row, ordered[-1] + 1)})
        elif len(group) > 1 and len(columns) == 1:
            column = next(iter(columns))
            ordered = sorted(row for row, _ in group)
            pursuit.update({(ordered[0] - 1, column), (ordered[-1] + 1, column)})
        else:
            for cell in group:
                pursuit.update(orthogonal_neighbours(cell))
    pursuit &= useful_available

    candidates = pursuit or useful_available
    best_score = max(scores.get(cell, 0) for cell in candidates)
    best = sorted(cell for cell in candidates if scores.get(cell, 0) == best_score)
    row, column = rng.choice(best)
    return {"row": row, "column": column}


def bot_player(game: dict[str, Any]) -> dict[str, Any]:
    player_id = game.get("yourPlayerId")
    for player in game.get("players", []):
        if player.get("id") == player_id:
            return player
    raise ApiError("The game response did not contain the bot player")


