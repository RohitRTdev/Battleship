"""Manage local development users or administrator-provisioned Cognito users."""

from __future__ import annotations

import argparse
import os
import secrets
import string
from pathlib import Path

from common.auth_client import (
    AuthClientError,
    delete_all_users,
    delete_production_user,
    delete_user,
    configure_production,
    is_production,
    list_users,
    register,
    provision_user,
    provision_users,
)
from common.bot_names import DEFAULT_NAME_FILE, bot_password


def random_text(prefix: str, length: int = 10) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return prefix + "".join(secrets.choice(alphabet) for _ in range(length))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python scripts/auth_users.py add
  python scripts/auth_users.py add --username admiral --password secret
  python scripts/auth_users.py list
  python scripts/auth_users.py delete admiral
  python scripts/auth_users.py delete 3
  python scripts/auth_users.py delete-all
  python scripts/auth_users.py delete-all --yes

Local list and delete commands require ENABLE_TEST_ROUTES=true on the auth service.
Production commands use the AWS profile configured in .env.
""",
    )
    parser.add_argument(
        "--prod",
        action="store_true",
        help="Manage users in the deployed Cognito user pool",
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
    bots_parser = commands.add_parser("provision-bots", help="Create deterministic Cognito benchmark users")
    bots_parser.add_argument("--count", type=int, help="Number to create (default: every name in the file)")
    bots_parser.add_argument("--workers", type=int, default=8, help="Concurrent Cognito requests (default: 8)")
    bots_parser.add_argument("--names-file", type=Path, default=DEFAULT_NAME_FILE)
    bots_parser.add_argument("--password-seed", default=os.environ.get("BATTLESHIP_BOT_PASSWORD_SEED", "battleship-local-bot-seed"))
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
    if args.prod:
        args.base_url = configure_production()

    try:
        if args.command == "add":
            username = args.username or random_text("player-")
            password = args.password or random_text("Battle!", 18)
            if is_production():
                provision_user(username, password)
            elif not register(args.base_url, username, password):
                raise AuthClientError(f"Username already exists: {username}", status_code=409)
            print(f"Added user {username!r}")
            print(f"Password: {password}")
        elif args.command == "list":
            print_users(args.base_url)
        elif args.command == "delete":
            if is_production():
                delete_production_user(args.user)
                print(f"Deleted Cognito user {args.user!r}.")
            else:
                user_id = resolve_user_id(args.base_url, args.user)
                delete_user(args.base_url, user_id)
                print(f"Deleted user {args.user!r} (ID {user_id}).")
        elif args.command == "delete-all":
            if not args.yes:
                confirmation = input("Delete ALL users? Type 'delete all' to continue: ")
                if confirmation.strip().casefold() != "delete all":
                    print("Cancelled.")
                    return 0
            if is_production():
                users = list_users(args.base_url)
                for user in users:
                    delete_production_user(user.username)
                deleted = len(users)
            else:
                deleted = delete_all_users(args.base_url)
            print(f"Deleted {deleted} user(s).")
        elif args.command == "provision-bots":
            if not is_production():
                raise AuthClientError("provision-bots requires --prod")
            names = [line.strip() for line in args.names_file.read_text(encoding="utf-8").splitlines() if line.strip() and not line.lstrip().startswith("#")]
            count = len(names) if args.count is None else args.count
            if count < 1 or count > len(names):
                raise AuthClientError(f"--count must be between 1 and {len(names)}")
            users = [(username, bot_password(username, args.password_seed)) for username in names[:count]]
            for completed, username in enumerate(provision_users(users, args.workers), start=1):
                print(f"[{completed}/{count}] Provisioned {username}")
    except (AuthClientError, OSError) as error:
        print(f"Error: {error}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
