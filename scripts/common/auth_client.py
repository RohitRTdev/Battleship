#!/usr/bin/env python3

"""Registration and login helpers for Battleship test bots."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
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
    id: int
    username: str
    created_at: str


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
