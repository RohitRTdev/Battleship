"""Registration and login helpers for Battleship test bots."""

from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Iterable, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class AuthClientError(RuntimeError):
    """Raised when the auth service rejects a request or cannot be reached."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class LoginResult:
    access_token: str
    token_type: str
    expires_in: int


@dataclass(frozen=True)
class UserSummary:
    id: int | str
    username: str
    created_at: str


_production: dict[str, str] | None = None


def configure_production(path: Path = Path(".deployment/prod.json")) -> str:
    """Use the deployed Cognito pool and return its public application URL."""
    global _production
    env_path = Path(".env")
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key in {"AWS_PROFILE", "AWS_REGION"} and value:
                os.environ.setdefault(key, value)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AuthClientError(
            f"Could not read {path}; run ./setup.sh up prod first"
        ) from error
    required = ("url", "region", "userPoolId", "userPoolClientId")
    if not isinstance(payload, dict) or any(not isinstance(payload.get(key), str) for key in required):
        raise AuthClientError(f"{path} does not contain valid production outputs")
    _production = {key: payload[key] for key in required}
    return _production["url"]


def is_production() -> bool:
    return _production is not None


def _cognito_client(admin: bool = False):
    try:
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config
    except ImportError as error:
        raise AuthClientError("Production scripts require: pip install -r scripts/requirements.txt") from error
    assert _production is not None
    return boto3.client(
        "cognito-idp",
        region_name=_production["region"],
        config=Config(
            **({} if admin else {"signature_version": UNSIGNED}),
            retries={"mode": "standard", "max_attempts": 10},
        ),
    )


def _parse_response_body(
    raw_body: bytes,
    status_code: int | None = None,
) -> Any:
    if not raw_body:
        raise AuthClientError(
            "Auth service returned an empty response instead of JSON",
            status_code=status_code,
        )

    try:
        return json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise AuthClientError(
            "Auth service returned a response that was not valid JSON",
            status_code=status_code,
        ) from error


def _post_json(url: str, payload: dict[str, str]) -> tuple[int, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=10) as response:
            raw_body = response.read()
            parsed_body = _parse_response_body(raw_body, response.status)
            return response.status, parsed_body
    except HTTPError as error:
        raw_body = error.read()
        parsed_body = _parse_response_body(raw_body, error.code)
        details = json.dumps(parsed_body, separators=(",", ":"))
        raise AuthClientError(
            f"Auth request failed with HTTP {error.code}: {details}",
            status_code=error.code,
        ) from error
    except URLError as error:
        raise AuthClientError(f"Could not reach auth service: {error.reason}") from error


def _request_json(
    url: str,
    method: str,
    access_token: str | None = None,
) -> tuple[int, Any]:
    headers = {}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"

    request = Request(
        url,
        headers=headers,
        method=method,
    )

    try:
        with urlopen(request, timeout=10) as response:
            raw_body = response.read()
            parsed_body = _parse_response_body(raw_body, response.status)
            return response.status, parsed_body
    except HTTPError as error:
        raw_body = error.read()
        parsed_body = _parse_response_body(raw_body, error.code)
        details = json.dumps(parsed_body, separators=(",", ":"))
        raise AuthClientError(
            f"Auth request failed with HTTP {error.code}: {details}",
            status_code=error.code,
        ) from error
    except URLError as error:
        raise AuthClientError(f"Could not reach auth service: {error.reason}") from error


def register(base_url: str, username: str, password: str) -> bool:
    """Register a user, returning False when the username already exists."""

    if _production is not None:
        return False
    try:
        status, payload = _post_json(
            f"{base_url.rstrip('/')}/api/auth/register",
            {"username": username, "password": password},
        )
    except AuthClientError as error:
        if error.status_code == 409:
            return False
        raise

    if (
        status != 201
        or not isinstance(payload, dict)
        or payload.get("created") is not True
    ):
        raise AuthClientError(f"Registration returned unexpected HTTP {status}")
    return True


def login(base_url: str, username: str, password: str) -> LoginResult:
    if _production is not None:
        try:
            response = _cognito_client().initiate_auth(
                AuthFlow="USER_PASSWORD_AUTH",
                ClientId=_production["userPoolClientId"],
                AuthParameters={"USERNAME": username, "PASSWORD": password},
            )
            result = response.get("AuthenticationResult", {})
            return LoginResult(result["AccessToken"], result.get("TokenType", "Bearer"), result["ExpiresIn"])
        except Exception as error:
            raise AuthClientError(f"Cognito login failed for {username}: {error}") from error
    status, payload = _post_json(
        f"{base_url.rstrip('/')}/api/auth/login",
        {"username": username, "password": password},
    )
    if status != 200 or not isinstance(payload, dict):
        raise AuthClientError(f"Login returned unexpected HTTP {status}")

    access_token = payload.get("access_token")
    token_type = payload.get("token_type")
    expires_in = payload.get("expires_in")
    if (
        not isinstance(access_token, str)
        or not isinstance(token_type, str)
        or not isinstance(expires_in, int)
    ):
        raise AuthClientError("Login response did not contain the expected token fields")

    return LoginResult(
        access_token=access_token,
        token_type=token_type,
        expires_in=expires_in,
    )


def list_users(base_url: str, access_token: str | None = None) -> list[UserSummary]:
    if _production is not None:
        client = _cognito_client(admin=True)
        users: list[UserSummary] = []
        paginator = client.get_paginator("list_users")
        for page in paginator.paginate(UserPoolId=_production["userPoolId"]):
            for raw in page.get("Users", []):
                attributes = {item["Name"]: item["Value"] for item in raw.get("Attributes", [])}
                users.append(UserSummary(attributes.get("sub", raw["Username"]), raw["Username"], raw["UserCreateDate"].isoformat()))
        return users
    status, payload = _request_json(
        f"{base_url.rstrip('/')}/api/auth/_test/users",
        "GET",
        access_token,
    )
    if status != 200 or not isinstance(payload, dict):
        raise AuthClientError(f"User listing returned unexpected HTTP {status}")

    raw_users = payload.get("users")
    if not isinstance(raw_users, list):
        raise AuthClientError("User listing did not contain a users array")

    users: list[UserSummary] = []
    for raw_user in raw_users:
        if not isinstance(raw_user, dict):
            raise AuthClientError("User listing contained an invalid user")
        user_id = raw_user.get("id")
        username = raw_user.get("username")
        created_at = raw_user.get("created_at")
        if (
            not isinstance(user_id, int)
            or not isinstance(username, str)
            or not isinstance(created_at, str)
        ):
            raise AuthClientError("User listing contained invalid user fields")
        users.append(UserSummary(user_id, username, created_at))

    return users


def delete_user(base_url: str, user_id: int) -> None:
    status, _ = _request_json(
        f"{base_url.rstrip('/')}/api/auth/_test/users/{user_id}",
        "DELETE",
    )
    if status != 200:
        raise AuthClientError(f"User deletion returned unexpected HTTP {status}")


def _provision_user(client: Any, username: str, password: str) -> None:
    assert _production is not None
    try:
        client.admin_create_user(UserPoolId=_production["userPoolId"], Username=username, MessageAction="SUPPRESS")
    except client.exceptions.UsernameExistsException:
        pass
    client.admin_set_user_password(UserPoolId=_production["userPoolId"], Username=username, Password=password, Permanent=True)


def provision_user(username: str, password: str) -> None:
    if _production is None:
        raise AuthClientError("Production authentication is not configured")
    _provision_user(_cognito_client(admin=True), username, password)


def provision_users(users: Iterable[tuple[str, str]], max_workers: int = 8) -> Iterator[str]:
    """Provision Cognito users concurrently and yield usernames as they finish."""

    if _production is None:
        raise AuthClientError("Production authentication is not configured")
    if max_workers < 1:
        raise AuthClientError("Provisioning worker count must be at least one")

    client = _cognito_client(admin=True)

    def provision(entry: tuple[str, str]) -> str:
        username, password = entry
        try:
            _provision_user(client, username, password)
            return username
        except Exception as error:
            raise AuthClientError(f"Could not provision {username}: {error}") from error

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(provision, entry) for entry in users]
        for future in as_completed(futures):
            yield future.result()


def delete_production_user(username: str) -> None:
    if _production is None:
        raise AuthClientError("Production authentication is not configured")
    _cognito_client(admin=True).admin_delete_user(UserPoolId=_production["userPoolId"], Username=username)


def delete_all_users(base_url: str) -> int:
    status, payload = _request_json(
        f"{base_url.rstrip('/')}/api/auth/_test/users",
        "DELETE",
    )
    if status != 200 or not isinstance(payload, dict):
        raise AuthClientError(f"Bulk user deletion returned unexpected HTTP {status}")

    deleted = payload.get("deleted")
    if not isinstance(deleted, int):
        raise AuthClientError("Bulk user deletion did not return a deleted count")
    return deleted
