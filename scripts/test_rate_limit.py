"""Exercise the rate limiter against an already-running local or production deployment."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from common.auth_client import (
    AuthClientError, configure_production, delete_production_user, delete_user,
    list_users, login, provision_user, register,
)

ROOT = Path(__file__).resolve().parent.parent
COMMAND_PATH = f"/api/backend/games/{secrets.token_hex(4).upper()}/fire"


def request(base_url: str, token: str, method: str, path: str) -> tuple[int, dict, dict]:
    data = b'{"coordinate":{"row":0,"column":0}}' if method == "POST" else None
    req = Request(base_url.rstrip("/") + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json",
    })
    try:
        response = urlopen(req, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = {}
        return response.status, payload, dict(response.headers.items())


def error_code(payload: dict) -> str | None:
    error = payload.get("error")
    return error.get("code") if isinstance(error, dict) else None


def expect_missing_game(result: tuple[int, dict, dict], context: str) -> None:
    status, payload, _ = result
    if status != 404 or error_code(payload) != "GAME_NOT_FOUND":
        raise AssertionError(f"{context}: expected 404 GAME_NOT_FOUND, got {status} {payload}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prod", action="store_true", help="Use .deployment/prod.json and Cognito")
    parser.add_argument("--base-url", default=os.environ.get("BATTLESHIP_BASE_URL", "http://localhost:8000"),
                        help="Local gateway URL (ignored with --prod)")
    args = parser.parse_args()
    created: list[str] = []
    errors: list[str] = []
    try:
        base_url = configure_production(ROOT / ".deployment" / "prod.json") if args.prod else args.base_url
        run_id = secrets.token_hex(8)
        password = "RateTest!" + secrets.token_hex(12) + "aA1"
        tokens = []
        for suffix in ("a", "b"):
            username = f"rate-test-{run_id}-{suffix}"
            if args.prod:
                # The helper may create the account before setting its password.
                created.append(username)
                provision_user(username, password)
            else:
                if not register(base_url, username, password):
                    raise RuntimeError(f"Temporary account {username} unexpectedly exists")
                created.append(username)
            tokens.append(login(base_url, username, password).access_token)

        print(f"Testing {'production' if args.prod else 'local'} deployment at {base_url}", flush=True)
        start = time.monotonic()
        with ThreadPoolExecutor(max_workers=100) as executor:
            results = list(executor.map(lambda _: request(base_url, tokens[0], "POST", COMMAND_PATH), range(100)))
        elapsed = time.monotonic() - start
        counts = Counter(status for status, _, _ in results)
        nodes = sorted({headers.get("X-Battleship-Node", "") for _, _, headers in results} - {""})
        print(f"Burst: 100 commands in {elapsed:.3f}s; HTTP statuses: {dict(sorted(counts.items()))}")
        if nodes:
            print(f"Backend nodes observed: {', '.join(nodes)}")
        limited = [result for result in results if result[0] == 429]
        if not limited:
            raise AssertionError("No requests were rate-limited; check RATE_LIMIT_ENABLED and the deployed version")
        for status, payload, headers in results:
            if status == 429:
                if error_code(payload) != "RATE_LIMITED" or not headers.get("Retry-After"):
                    raise AssertionError(f"Invalid 429 response: {payload}, Retry-After={headers.get('Retry-After')}")
            else:
                expect_missing_game((status, payload, headers), "Burst command")
        if elapsed < 1 and counts[404] != 20:
            raise AssertionError(f"Expected exactly 20 admitted commands in a sub-second burst, got {counts[404]}")
        if elapsed >= 1:
            print("Burst took at least one second; exact rolling-window count cannot be inferred from client timing.")

        expect_missing_game(request(base_url, tokens[1], "POST", COMMAND_PATH), "Independent player")
        status, payload, _ = request(base_url, tokens[0], "GET", "/api/backend/player/state")
        if status != 200:
            raise AssertionError(f"Read while throttled: expected 200, got {status} {payload}")
        time.sleep(1.1)
        expect_missing_game(request(base_url, tokens[0], "POST", COMMAND_PATH), "Recovery after rolling window")
        print("PASS: throttling, 429 response, player isolation, reads and recovery")
    except (AuthClientError, OSError, URLError, AssertionError, RuntimeError) as error:
        errors.append(str(error))
    finally:
        if created:
            try:
                if args.prod:
                    for username in created:
                        try:
                            delete_production_user(username)
                        except Exception as error:
                            errors.append(f"Could not delete temporary account {username}: {error}")
                else:
                    users = {user.username: user.id for user in list_users(args.base_url)}
                    for username in created:
                        if username in users:
                            delete_user(args.base_url, int(users[username]))
            except Exception as error:
                errors.append(f"Could not clean up temporary accounts {', '.join(created)}: {error}")
    for error in errors:
        print(f"FAIL: {error}", file=sys.stderr)
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
