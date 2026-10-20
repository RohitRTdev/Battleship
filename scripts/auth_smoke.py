#!/usr/bin/env python3

"""Concurrently register and log in a swarm of Battleship test bots."""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path

from common.auth_client import AuthClientError, LoginResult, list_users, login, register
from common.bot_names import DEFAULT_NAME_FILE, bot_password, claim_bot_names


@dataclass(frozen=True)
class BotResult:
    username: str
    created: bool
    login: LoginResult | None = None
    error: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python scripts/auth_smoke.py
  python scripts/auth_smoke.py --count 120 --workers 40
  python scripts/auth_smoke.py --base-url http://localhost:8000
  python scripts/auth_smoke.py --names-file scripts/bot_names.txt
""",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("BATTLESHIP_BASE_URL", "http://localhost:8000"),
        help="Public Battleship gateway URL",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=50,
        help="Number of distinct bots to run (default: 50)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=20,
        help="Maximum concurrent bots (default: 20)",
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


def run_bot(base_url: str, username: str, password_seed: str) -> BotResult:
    password = bot_password(username, password_seed)
    try:
        created = register(base_url, username, password)
        login_result = login(base_url, username, password)
        return BotResult(username, created, login=login_result)
    except AuthClientError as error:
        return BotResult(username, False, error=str(error))


def main() -> int:
    args = parse_args()
    if args.workers < 1:
        print("--workers must be at least one")
        return 2

    try:
        bot_names = claim_bot_names(args.count, args.names_file)
    except (OSError, ValueError) as error:
        print(f"Could not allocate bot names: {error}")
        return 2

    results: list[BotResult] = []
    with ThreadPoolExecutor(max_workers=min(args.workers, len(bot_names))) as executor:
        futures = {
            executor.submit(
                run_bot,
                args.base_url,
                username,
                args.password_seed,
            ): username
            for username in bot_names
        }
        for future in as_completed(futures):
            username = futures[future]
            try:
                result = future.result()
            except Exception as error:
                result = BotResult(
                    username,
                    False,
                    error=f"Unexpected bot failure: {error}",
                )
            results.append(result)
            if result.error:
                print(f"FAILED   {result.username}: {result.error}")
            elif result.created:
                print(f"CREATED  {result.username}: login succeeded")
            else:
                print(f"EXISTING {result.username}: login succeeded")

    successful = [result for result in results if result.login is not None]
    created_count = sum(result.created for result in successful)
    existing_count = len(successful) - created_count
    failed_count = len(results) - len(successful)
    print(
        f"\nBot summary: created={created_count}, existing={existing_count}, "
        f"failed={failed_count}"
    )

    if not successful:
        return 1

    try:
        users = list_users(args.base_url, successful[0].login.access_token)
    except AuthClientError as error:
        print(f"Could not retrieve final user list: {error}")
        return 1

    print("\nRegistered users:")
    print(json.dumps([asdict(user) for user in users], indent=2))
    return 1 if failed_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
