#!/usr/bin/env python3

"""Create a Battleship game and play it as a bot against one human player."""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from common.auth_client import AuthClientError, login, register
from common.bot_names import DEFAULT_NAME_FILE, bot_password, claim_bot_names


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


def bot_player(game: dict[str, Any]) -> dict[str, Any]:
    player_id = game.get("yourPlayerId")
    for player in game.get("players", []):
        if player.get("id") == player_id:
            return player
    raise ApiError("The game response did not contain the bot player")


def wait_for_update(client: GameClient, game: dict[str, Any]) -> dict[str, Any]:
    failures = 0
    while True:
        try:
            update = client.request(
                "GET",
                f"/api/backend/games/{game['gameCode']}/updates?afterVersion={game['version']}",
            )
            if update.get("type") == "GAME_UPDATED" and isinstance(update.get("game"), dict):
                return update["game"]
            if update.get("type") == "HEARTBEAT":
                game = {**game, "version": update.get("version", game["version"]), "players": update.get("players", game["players"])}
            failures = 0
        except ApiError as error:
            if error.status == 401:
                raise
            failures += 1
            wait_seconds = min(2 ** (failures - 1), 4)
            print(f"Connection problem; retrying in {wait_seconds}s...", file=sys.stderr, flush=True)
            time.sleep(wait_seconds)


def finish_abandoned_game(client: GameClient, game: dict[str, Any]) -> None:
    status = game.get("status")
    try:
        if status in {"WAITING", "PLACEMENT"}:
            client.request("POST", f"/api/backend/games/{game['gameCode']}/cancel", {})
        elif status == "ACTIVE":
            client.request("POST", f"/api/backend/games/{game['gameCode']}/surrender", {})
    except ApiError:
        pass


def run_bot(client: GameClient, rng: random.Random) -> None:
    created = client.request("POST", "/api/backend/games", {}, expected=(201,))
    game = created["game"]
    code = game["gameCode"]
    fleet = random_fleet(rng)
    targets = [{"row": row, "column": column} for row in range(BOARD_SIZE) for column in range(BOARD_SIZE)]
    rng.shuffle(targets)

    print("\nBattleship bot is ready.")
    print(f"Join code: {code}", flush=True)
    print("Open the website, sign in, and join using that code.")

    announced_status: str | None = None
    try:
        while game.get("status") != "FINISHED":
            status = game.get("status")
            if status != announced_status:
                messages = {
                    "WAITING": "Waiting for you to join...",
                    "PLACEMENT": "Player joined. Waiting for ship placement...",
                    "ACTIVE": "Game started.",
                }
                if status in messages:
                    print(messages[status], flush=True)
                announced_status = status

            if status == "WAITING":
                game = wait_for_update(client, game)
                continue

            if status == "PLACEMENT":
                if not bot_player(game).get("fleetSubmitted"):
                    response = client.request(
                        "PUT",
                        f"/api/backend/games/{code}/fleet",
                        {"ships": fleet},
                    )
                    game = response["game"]
                    print("Bot ships placed.", flush=True)
                else:
                    game = wait_for_update(client, game)
                continue

            if status != "ACTIVE":
                raise ApiError(f"Unexpected game status: {status}")

            if not game.get("isYourTurn"):
                game = wait_for_update(client, game)
                continue

            previously_attacked = {
                (attack["coordinate"]["row"], attack["coordinate"]["column"])
                for attack in game.get("yourAttacks", [])
            }
            while targets and (targets[-1]["row"], targets[-1]["column"]) in previously_attacked:
                targets.pop()
            if not targets:
                raise ApiError("The bot ran out of legal target squares")

            target = targets.pop()
            try:
                response = client.request(
                    "POST",
                    f"/api/backend/games/{code}/fire",
                    {"coordinate": target},
                )
            except ApiError as error:
                if error.code in {"NOT_YOUR_TURN", "COORDINATE_ALREADY_ATTACKED"}:
                    game = client.request("GET", f"/api/backend/games/{code}")["game"]
                    continue
                raise
            game = response["game"]
            outcome = response["outcome"]
            print(f"Bot fired at {coordinate_name(target)}: {outcome['result']}", flush=True)

        won = game.get("winnerPlayerId") == game.get("yourPlayerId")
        reason = game.get("completionReason")
        if reason == "CANCELLED":
            print("Game cancelled.", flush=True)
        elif won:
            print("Bot won the game.", flush=True)
        else:
            print("You won the game.", flush=True)
    except KeyboardInterrupt:
        print("\nStopping bot and ending the game...", flush=True)
        finish_abandoned_game(client, game)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default=os.environ.get("BATTLESHIP_BASE_URL", "http://localhost:8000"),
        help="Public Battleship URL (default: http://localhost:8000)",
    )
    parser.add_argument("--seed", type=int, help="Use repeatable ship and shot randomness")
    parser.add_argument(
        "--names-file",
        type=Path,
        default=DEFAULT_NAME_FILE,
        help="File containing one available bot name per line",
    )
    parser.add_argument(
        "--password-seed",
        default=os.environ.get(
            "BATTLESHIP_BOT_PASSWORD_SEED", "battleship-local-bot-seed"
        ),
        help="Stable seed used to recreate bot passwords across runs",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rng: random.Random = random.Random(args.seed) if args.seed is not None else random.SystemRandom()
    try:
        username = claim_bot_names(1, args.names_file)[0]
        password = bot_password(username, args.password_seed)
        register(args.base_url, username, password)
        token = login(args.base_url, username, password).access_token
        print(f"Playing as {username}.", flush=True)
        run_bot(GameClient(args.base_url, token), rng)
        return 0
    except (ApiError, AuthClientError) as error:
        print(f"Bot stopped: {error}", file=sys.stderr)
        return 1
    except (KeyError, TypeError, ValueError) as error:
        print(f"Bot stopped after an unexpected API response: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
