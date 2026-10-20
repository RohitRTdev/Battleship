#!/usr/bin/env python3

"""Control users in a development Battleship auth database through its API."""

from __future__ import annotations

import argparse
import os
import secrets
import string

from common.auth_client import (
    AuthClientError,
    delete_all_users,
    delete_user,
    list_users,
    register,
)


def random_text(prefix: str, length: int = 10) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return prefix + "".join(secrets.choice(alphabet) for _ in range(length))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python scripts/control_db.py add
  python scripts/control_db.py add --username admiral --password secret
  python scripts/control_db.py list
  python scripts/control_db.py delete admiral
  python scripts/control_db.py delete 3
  python scripts/control_db.py delete-all
  python scripts/control_db.py delete-all --yes

The list and delete commands require ENABLE_TEST_ROUTES=true on the auth service.
""",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("BATTLESHIP_BASE_URL", "http://localhost:8000"),
        help="Public Battleship gateway URL (default: http://localhost:8000)",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    add_parser = commands.add_parser("add", help="Add a user with random defaults")
    add_parser.add_argument("--username", help="Username (generated when omitted)")
    add_parser.add_argument("--password", help="Password (generated when omitted)")

    commands.add_parser("list", help="List all users")

    delete_parser = commands.add_parser("delete", help="Delete one user by ID or username")
    delete_parser.add_argument("user", help="Numeric user ID or exact username")

    delete_all_parser = commands.add_parser("delete-all", help="Delete every user")
    delete_all_parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the confirmation prompt",
    )
    return parser


def print_users(base_url: str) -> None:
    users = list_users(base_url)
    if not users:
        print("No users found.")
        return

    id_width = max(2, max(len(str(user.id)) for user in users))
    username_width = max(8, max(len(user.username) for user in users))
    print(f"{'ID':>{id_width}}  {'USERNAME':<{username_width}}  CREATED AT")
    for user in users:
        print(f"{user.id:>{id_width}}  {user.username:<{username_width}}  {user.created_at}")


def resolve_user_id(base_url: str, value: str) -> int:
    if value.isdecimal():
        return int(value)

    normalized = value.strip().casefold()
    matches = [user for user in list_users(base_url) if user.username.casefold() == normalized]
    if not matches:
        raise AuthClientError(f"User not found: {value}", status_code=404)
    return matches[0].id


def main() -> int:
    args = build_parser().parse_args()

    try:
        if args.command == "add":
            username = args.username or random_text("player-")
            password = args.password or random_text("Battle!", 18)
            if not register(args.base_url, username, password):
                raise AuthClientError(f"Username already exists: {username}", status_code=409)
            print(f"Added user {username!r}")
            print(f"Password: {password}")
        elif args.command == "list":
            print_users(args.base_url)
        elif args.command == "delete":
            user_id = resolve_user_id(args.base_url, args.user)
            delete_user(args.base_url, user_id)
            print(f"Deleted user {args.user!r} (ID {user_id}).")
        elif args.command == "delete-all":
            if not args.yes:
                confirmation = input("Delete ALL users? Type 'delete all' to continue: ")
                if confirmation.strip().casefold() != "delete all":
                    print("Cancelled.")
                    return 0
            deleted = delete_all_users(args.base_url)
            print(f"Deleted {deleted} user(s).")
    except (AuthClientError, OSError) as error:
        print(f"Error: {error}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
