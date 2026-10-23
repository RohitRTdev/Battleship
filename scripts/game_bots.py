#!/usr/bin/env python3

"""Run concurrent authenticated Battleship games and validate API behavior."""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from common.auth_client import login, register
from common.bot_names import DEFAULT_NAME_FILE, bot_password, claim_bot_names


FLEET = {
    "ships": [
        {"start": {"row": 0, "column": 0}, "end": {"row": 0, "column": 4}},
        {"start": {"row": 2, "column": 0}, "end": {"row": 2, "column": 3}},
        {"start": {"row": 4, "column": 0}, "end": {"row": 4, "column": 2}},
        {"start": {"row": 6, "column": 0}, "end": {"row": 6, "column": 2}},
        {"start": {"row": 8, "column": 0}, "end": {"row": 8, "column": 1}},
    ]
}
TARGETS = [
    {"row": row, "column": column}
    for row, length in [(0, 5), (2, 4), (4, 3), (6, 3), (8, 2)]
    for column in range(length)
]
MISSES = (
    [{"row": 1, "column": column} for column in range(10)]
    + [{"row": 3, "column": column} for column in range(6)]
)


@dataclass(frozen=True)
class Bot:
    username: str
    token: str


class ApiClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.nodes: set[str] = set()
        self.lock = threading.Lock()

    def request_any(
        self,
        method: str,
        path: str,
        bot: Bot,
        body: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {bot.token}",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            with urlopen(request, timeout=10) as response:
                payload = json.loads(response.read() or b"{}")
                status = response.status
                node = response.headers.get("X-Battleship-Node")
        except HTTPError as error:
            payload = json.loads(error.read() or b"{}")
            status = error.code
            node = error.headers.get("X-Battleship-Node")
        if node:
            with self.lock:
                self.nodes.add(node)
        if not isinstance(payload, dict):
            raise AssertionError(f"{method} {path}: response is not an object")
        return status, payload

    def request(
        self,
        method: str,
        path: str,
        bot: Bot,
        body: dict[str, Any] | None = None,
        expected: int = 200,
    ) -> dict[str, Any]:
        status, payload = self.request_any(method, path, bot, body)
        if status != expected:
            raise AssertionError(f"{method} {path}: expected HTTP {expected}, got {status}: {payload}")
        return payload

    def expect_error(self, method: str, path: str, bot: Bot, code: str, body: dict[str, Any] | None = None) -> None:
        payload = self.request(method, path, bot, body, expected=400 if code.startswith("INVALID_") or code.startswith("SHIP") else 409)
        actual = payload.get("error", {}).get("code")
        if actual != code:
            raise AssertionError(f"{method} {path}: expected {code}, got {actual}")


def make_bot(base_url: str, username: str, password_seed: str) -> Bot:
    password = bot_password(username, password_seed)
    register(base_url, username, password)
    return Bot(username, login(base_url, username, password).access_token)


def assert_private(game: dict[str, Any]) -> None:
    encoded = json.dumps(game)
    if "opponentFleet" in encoded or "playerTwoFleet" in encoded or "playerOneFleet" in encoded:
        raise AssertionError("Player projection exposed an authoritative opponent fleet field")


def setup_active(client: ApiClient, first: Bot, second: Bot) -> tuple[str, dict[str, Any]]:
    created = client.request("POST", "/api/backend/games", first, {}, expected=201)
    code = created["game"]["gameCode"]
    client.request("POST", f"/api/backend/games/{code}/join", second, {})
    client.request("PUT", f"/api/backend/games/{code}/fleet", first, FLEET)
    active = client.request("PUT", f"/api/backend/games/{code}/fleet", second, FLEET)
    if active["game"]["status"] != "ACTIVE" or active["game"]["isYourTurn"] is not False:
        raise AssertionError("Game did not activate with the creator's turn")
    return code, active


def run_race_checks(client: ApiClient, racers: list[Bot]) -> None:
    creator, joiner_one, joiner_two, shooter = racers
    with ThreadPoolExecutor(max_workers=2) as executor:
        creates = list(executor.map(lambda _: client.request_any("POST", "/api/backend/games", creator, {}), range(2)))
    if sorted(status for status, _ in creates) != [201, 409]:
        raise AssertionError(f"Concurrent creates had unexpected statuses: {creates}")
    rejected_create = next(payload for status, payload in creates if status == 409)
    if rejected_create.get("error", {}).get("code") != "PLAYER_ALREADY_PLAYING":
        raise AssertionError("Concurrent create did not enforce the active-player constraint")
    created_game = next(payload for status, payload in creates if status == 201)
    create_code = created_game["game"]["gameCode"]
    client.request("POST", f"/api/backend/games/{create_code}/cancel", creator, {})

    waiting = client.request("POST", "/api/backend/games", creator, {}, expected=201)
    join_code = waiting["game"]["gameCode"]
    with ThreadPoolExecutor(max_workers=2) as executor:
        joins = list(executor.map(
            lambda bot: client.request_any("POST", f"/api/backend/games/{join_code}/join", bot, {}),
            [joiner_one, joiner_two],
        ))
    if sorted(status for status, _ in joins) != [200, 409]:
        raise AssertionError(f"Competing joins had unexpected statuses: {joins}")
    rejected_join = next(payload for status, payload in joins if status == 409)
    if rejected_join.get("error", {}).get("code") != "GAME_FULL":
        raise AssertionError("Competing join did not report GAME_FULL")
    winner = joiner_one if joins[0][0] == 200 else joiner_two
    client.request("POST", f"/api/backend/games/{join_code}/cancel", winner, {})

    fire_code, _ = setup_active(client, creator, shooter)
    with ThreadPoolExecutor(max_workers=2) as executor:
        fires = list(executor.map(
            lambda target: client.request_any("POST", f"/api/backend/games/{fire_code}/fire", creator, {"coordinate": target}),
            [{"row": 9, "column": 8}, {"row": 9, "column": 9}],
        ))
    if sorted(status for status, _ in fires) != [200, 409]:
        raise AssertionError(f"Concurrent fires had unexpected statuses: {fires}")
    rejected_fire = next(payload for status, payload in fires if status == 409)
    if rejected_fire.get("error", {}).get("code") != "NOT_YOUR_TURN":
        raise AssertionError("Concurrent fire did not serialize turn ownership")
    client.request("POST", f"/api/backend/games/{fire_code}/surrender", shooter, {})


def run_game(client: ApiClient, first: Bot, second: Bot, outsider: Bot) -> str:
    if client.request("GET", "/api/backend/player/state", first)["state"] != "NOT_PLAYING":
        raise AssertionError("Fresh bot unexpectedly has an active game")
    created = client.request("POST", "/api/backend/games", first, {}, expected=201)
    code = created["game"]["gameCode"]
    client.expect_error("POST", "/api/backend/games", first, "PLAYER_ALREADY_PLAYING", {})
    client.request("POST", f"/api/backend/games/{code}/join", second, {})
    client.expect_error("POST", f"/api/backend/games/{code}/join", second, "PLAYER_ALREADY_IN_GAME", {})

    adjacent = {"ships": [*FLEET["ships"][:-1], {"start": {"row": 1, "column": 5}, "end": {"row": 1, "column": 6}}]}
    client.expect_error("PUT", f"/api/backend/games/{code}/fleet", first, "SHIPS_ADJACENT", adjacent)
    client.request("PUT", f"/api/backend/games/{code}/fleet", first, FLEET)
    client.expect_error("PUT", f"/api/backend/games/{code}/fleet", first, "FLEET_ALREADY_SUBMITTED", FLEET)
    active = client.request("PUT", f"/api/backend/games/{code}/fleet", second, FLEET)
    version = active["game"]["version"]
    client.expect_error("POST", f"/api/backend/games/{code}/join", outsider, "GAME_ALREADY_STARTED", {})
    client.expect_error("POST", f"/api/backend/games/{code}/fire", second, "NOT_YOUR_TURN", {"coordinate": {"row": 9, "column": 9}})

    heartbeat = client.request("GET", f"/api/backend/games/{code}/updates?afterVersion={version}", second)
    if heartbeat.get("type") != "HEARTBEAT" or heartbeat.get("version") != version:
        raise AssertionError("Unchanged long poll did not return the expected heartbeat")

    with ThreadPoolExecutor(max_workers=1) as waiter:
        pending = waiter.submit(client.request, "GET", f"/api/backend/games/{code}/updates?afterVersion={version}", second)
        time.sleep(0.2)
        client.request("POST", f"/api/backend/games/{code}/fire", first, {"coordinate": TARGETS[0]})
        update = pending.result(timeout=5)
    if update.get("type") != "GAME_UPDATED":
        raise AssertionError("Long poll was not awakened by the committed move")
    client.expect_error("POST", f"/api/backend/games/{code}/fire", first, "NOT_YOUR_TURN", {"coordinate": TARGETS[0]})
    client.request("POST", f"/api/backend/games/{code}/fire", second, {"coordinate": MISSES[0]})
    client.expect_error("POST", f"/api/backend/games/{code}/fire", first, "COORDINATE_ALREADY_ATTACKED", {"coordinate": TARGETS[0]})

    for index, target in enumerate(TARGETS[1:], start=1):
        result = client.request("POST", f"/api/backend/games/{code}/fire", first, {"coordinate": target})
        if index < len(TARGETS) - 1:
            client.request("POST", f"/api/backend/games/{code}/fire", second, {"coordinate": MISSES[index]})
    game = result["game"]
    if game["status"] != "FINISHED" or game["winnerPlayerId"] != game["yourPlayerId"]:
        raise AssertionError("Completed match has the wrong winner")
    assert_private(game)
    assert_private(client.request("GET", f"/api/backend/games/{code}", second)["game"])
    if client.request("GET", "/api/backend/player/state", first)["state"] != "NOT_PLAYING":
        raise AssertionError("Winner remained reserved after game completion")

    cancel_code = client.request("POST", "/api/backend/games", first, {}, expected=201)["game"]["gameCode"]
    client.request("POST", f"/api/backend/games/{cancel_code}/join", second, {})
    cancelled = client.request("POST", f"/api/backend/games/{cancel_code}/cancel", second, {})
    if cancelled["game"]["completionReason"] != "CANCELLED":
        raise AssertionError("Cancellation did not finish the game")

    surrender_code, _ = setup_active(client, first, second)
    surrendered = client.request("POST", f"/api/backend/games/{surrender_code}/surrender", second, {})
    if surrendered["game"]["completionReason"] != "SURRENDER":
        raise AssertionError("Surrender did not finish the game")
    return code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("BATTLESHIP_BASE_URL", "http://localhost:8000"))
    parser.add_argument("--games", type=int, default=4, help="Concurrent games to run (default: 4)")
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
    if args.games < 2:
        print("--games must be at least 2")
        return 2
    bot_count = args.games * 2 + 5
    try:
        names = claim_bot_names(bot_count, args.names_file)
    except (OSError, ValueError) as error:
        print(f"Could not allocate bot names: {error}")
        return 2
    bots = [
        make_bot(args.base_url, username, args.password_seed)
        for username in names
    ]
    outsider = bots[args.games * 2]
    client = ApiClient(args.base_url)
    failures: list[str] = []
    try:
        run_race_checks(client, bots[-4:])
        print("PASSED transactional race checks")
    except Exception as error:
        print(f"FAILED transactional race checks: {error}")
        return 1
    with ThreadPoolExecutor(max_workers=args.games) as executor:
        futures = {
            executor.submit(run_game, client, bots[index * 2], bots[index * 2 + 1], outsider): index
            for index in range(args.games)
        }
        for future in as_completed(futures):
            index = futures[future]
            try:
                print(f"PASSED game {index + 1}: {future.result()}")
            except Exception as error:
                failures.append(f"game {index + 1}: {error}")
                print(f"FAILED game {index + 1}: {error}")
    print(f"Backend nodes observed: {sorted(client.nodes)}")
    if len(client.nodes) < 2:
        failures.append("gateway responses did not demonstrate multiple backend replicas")
    if failures:
        print("Failures:\n- " + "\n- ".join(failures))
        return 1
    print(f"All {args.games} concurrent games passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
