"""Test local username validation. Run ./setup.sh up, then python scripts/test_username_validation.py."""

import argparse
import json
import secrets
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def request(base, path, method="GET", payload=None, token=None):
    headers = {}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        response = urlopen(Request(base + path, data=data, headers=headers, method=method), timeout=10)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            body = {"raw": raw[:200].decode("utf-8", errors="replace")}
        return response.status, body


def expect(label, actual, expected):
    status, body = actual
    print(f"{label}: HTTP {status}", flush=True)
    if status != expected:
        raise AssertionError(f"{label}: expected HTTP {expected}, got {status}: {body}")
    return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://localhost:8000", help="Local stack URL")
    base = parser.parse_args().base.rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Only local HTTP stack URLs are supported")

    users_path = "/api/auth/_test/users"
    before = expect("Local test routes", request(base, users_path), 200)["users"]
    existing_ids = {user["id"] for user in before}
    prefix = "uv" + secrets.token_hex(8)
    password = secrets.token_urlsafe(24)

    def register(name):
        return request(base, "/api/auth/register", "POST", {"username": name, "password": password})

    try:
        name32 = prefix + "a" * (32 - len(prefix))
        created = expect("32 characters", register(name32), 201)
        assert created.get("username") == name32
        expect("33 characters", register(name32 + "a"), 400)
        expect("200 characters", register(prefix + "a" * (200 - len(prefix))), 400)
        expect("20000 characters", register(prefix + "a" * (20000 - len(prefix))), 400)
        for label, character in (("NUL", "\u0000"), ("newline", "\n"),
                                 ("C1", "\u0085"), ("bidi override", "\u202e"),
                                 ("bidi isolate", "\u2066"), ("Arabic letter mark", "\u061c")):
            expect(label, register(prefix + character + "x"), 400)
        expect("leading control", register("\n" + prefix), 400)
        expect("trailing control", register(prefix + "\t"), 400)
        expect("lowercase expansion", register(prefix + "\u0130" * 8), 400)
        normalized = prefix + " mixed name"
        created = expect("trim and lowercase", register(" " + normalized.upper() + " "), 201)
        assert created.get("username") == normalized
        expect("case insensitive duplicate", register(normalized.upper()), 409)
        login = expect("login", request(base, "/api/auth/login", "POST",
                                       {"username": normalized.upper(), "password": password}), 200)
        expect("player state", request(base, "/api/backend/player/state", token=login["access_token"]), 200)
        print("Username validation checks passed.")
    finally:
        # Include unexpectedly accepted invalid names, but never delete existing users.
        users = expect("List users for cleanup", request(base, users_path), 200)["users"]
        for user in users:
            if user["id"] not in existing_ids and user["username"].startswith(prefix):
                expect("Delete test user", request(base, f"{users_path}/{user['id']}", "DELETE"), 200)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, ValueError, URLError, OSError) as error:
        print(f"Username validation test failed: {error}", file=sys.stderr)
        sys.exit(1)
