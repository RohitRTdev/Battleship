"""Create a Battleship game and play it as a bot against one human player."""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

from common.auth_client import AuthClientError, configure_production, login, register
from common.bot_names import DEFAULT_NAME_FILE, bot_password, claim_bot_names


# Re-export these helpers for callers that imported them from play_bot.
from common.game_bot import (
    ApiError, GameClient, BOARD_SIZE, SHIP_LENGTHS, random_fleet,
    coordinate_name, orthogonal_neighbours, connected_components,
    aggressive_target, bot_player,
)


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


def run_bot(client: GameClient, rng: random.Random, aggressive: bool = False) -> None:
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
                if status == "PLACEMENT" and game.get("placementDeadlineAt"):
                    print("Both players must submit their fleets before placement time expires.", flush=True)
                elif status == "ACTIVE" and game.get("turnDeadlineAt"):
                    print("Each move has a time limit; a player who times out loses.", flush=True)
                announced_status = status

            if status == "WAITING":
                game = wait_for_update(client, game)
                continue

            if status == "PLACEMENT":
                if not bot_player(game).get("fleetSubmitted"):
                    try:
                        response = client.request(
                            "PUT",
                            f"/api/backend/games/{code}/fleet",
                            {"ships": fleet},
                        )
                    except ApiError as error:
                        if error.code in {"GAME_CANCELLED", "GAME_ALREADY_FINISHED"}:
                            game = client.request("GET", f"/api/backend/games/{code}")["game"]
                            continue
                        raise
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

            if aggressive:
                target = aggressive_target(game, rng)
            else:
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
                if error.code in {"NOT_YOUR_TURN", "COORDINATE_ALREADY_ATTACKED", "TURN_TIMED_OUT", "GAME_ALREADY_FINISHED", "GAME_CANCELLED"}:
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
        elif reason == "TIMEOUT":
            if won:
                print("Bot won: you ran out of time.", flush=True)
            else:
                print("You won: the bot ran out of time.", flush=True)
        elif won:
            print("Bot won the game.", flush=True)
        else:
            print("You won the game.", flush=True)
    except KeyboardInterrupt:
        print("\nStopping bot and ending the game...", flush=True)
        finish_abandoned_game(client, game)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prod", action="store_true", help="Use the deployed Cognito environment")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("BATTLESHIP_BASE_URL", "http://localhost:8000"),
        help="Public Battleship URL (default: http://localhost:8000)",
    )
    parser.add_argument("--seed", type=int, help="Use repeatable ship and shot randomness")
    parser.add_argument(
        "--aggressive",
        action="store_true",
        help="Use intelligent ship hunting and probability-based targeting",
    )
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
    if args.prod:
        args.base_url = configure_production()
    rng: random.Random = random.Random(args.seed) if args.seed is not None else random.SystemRandom()
    try:
        username = claim_bot_names(1, args.names_file)[0]
        password = bot_password(username, args.password_seed)
        register(args.base_url, username, password)
        token = login(args.base_url, username, password).access_token
        print(f"Playing as {username}.", flush=True)
        run_bot(GameClient(args.base_url, token), rng, aggressive=args.aggressive)
        return 0
    except (ApiError, AuthClientError) as error:
        print(f"Bot stopped: {error}", file=sys.stderr)
        return 1
    except (KeyError, TypeError, ValueError) as error:
        print(f"Bot stopped after an unexpected API response: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
