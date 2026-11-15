"""Check error responses on the local Battleship deployment.

Start the stack first with ./setup.sh up, then run from the repository root:

    python scripts/test_error_handling.py             # oversized/malformed JSON
    python scripts/test_error_handling.py --database  # pause and retest PostgreSQL

The database test briefly interrupts all games on the local stack. It creates a
local test account and deletes that account afterwards. Docker must be available.
"""

from __future__ import annotations

import argparse
import json
import secrets
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def request(base: str, path: str, method: str = 'GET', body: bytes | None = None,
            token: str | None = None) -> tuple[int, dict]:
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = Request(base + path, data=body, method=method, headers=headers)
    try:
        response = urlopen(req, timeout=12)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RuntimeError(f'{method} {path}: HTTP {response.status} returned non-JSON: {raw[:200]!r}') from error
        return response.status, data


def check(label: str, actual: tuple[int, dict], status: int, code: str | None = None) -> None:
    received, body = actual
    print(f'{label}: HTTP {received} {json.dumps(body)}', flush=True)
    if received != status:
        raise AssertionError(f'{label}: expected HTTP {status}')
    if code is not None and (not isinstance(body.get('error'), dict) or body['error'].get('code') != code):
        raise AssertionError(f'{label}: expected error code {code}')


def body_tests(base: str) -> None:
    fire = '/api/backend/games/00000000/fire'
    fleet = '/api/backend/games/00000000/fleet'
    auth = '/api/auth/register'
    oversized = json.dumps({'padding': 'x' * 110_000}).encode()
    ships = json.dumps({'ships': [{'start': {'row': 0, 'column': 0},
                                   'end': {'row': 0, 'column': 1}}] * 1500}).encode()
    for label, path, method, payload, status, code in (
        ('Backend oversized fire', fire, 'POST', oversized, 413, 'INVALID_REQUEST'),
        ('Backend oversized fleet', fleet, 'PUT', ships, 413, 'INVALID_REQUEST'),
        ('Backend malformed JSON', fire, 'POST', b'{', 400, 'INVALID_REQUEST'),
        ('Local auth oversized JSON', auth, 'POST', oversized, 413, None),
        ('Local auth malformed JSON', auth, 'POST', b'{', 400, None),
    ):
        check(label, request(base, path, method, payload), status, code)


def docker(*args: str) -> str:
    result = subprocess.run(['docker', *args], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def database_test(base: str) -> None:
    name = 'battleship-postgres'
    inspect = json.loads(docker('inspect', name))[0]
    labels = inspect.get('Config', {}).get('Labels') or {}
    state = inspect.get('State', {})
    if labels.get('com.docker.compose.service') != 'postgres' or not state.get('Running') or state.get('Paused'):
        raise RuntimeError('Expected a running, unpaused local Compose postgres container')

    status, _ = request(base, '/api/auth/_test/users')
    if status != 200:
        raise RuntimeError('Local auth test routes are unavailable; restart with ./setup.sh up')
    username = 'error-test-' + secrets.token_hex(8)
    credentials = json.dumps({'username': username, 'password': secrets.token_urlsafe(24)}).encode()
    user_id = None
    try:
        status, body = request(base, '/api/auth/register', 'POST', credentials)
        if status != 201:
            raise RuntimeError(f'Could not register local test account: HTTP {status} {body}')
        status, body = request(base, '/api/auth/_test/users')
        if status != 200:
            raise RuntimeError('Local auth test routes are unavailable; restart with ./setup.sh up')
        user_id = next((user['id'] for user in body.get('users', []) if user.get('username') == username), None)
        if user_id is None:
            raise RuntimeError('Could not locate local test account for cleanup')
        status, body = request(base, '/api/auth/login', 'POST', credentials)
        if status != 200 or not isinstance(body.get('access_token'), str):
            raise RuntimeError(f'Could not log in local test account: HTTP {status}')
        token = body['access_token']
        path = '/api/backend/time'
        check('Before database pause', request(base, path, token=token), 200)
        paused = False
        try:
            docker('pause', name)
            paused = True
            check('While database paused', request(base, path, token=token), 503, 'DATABASE_UNAVAILABLE')
        finally:
            if paused:
                docker('unpause', name)
                print('PostgreSQL container unpaused.', flush=True)
        for attempt in range(20):
            try:
                result = request(base, path, token=token)
                if result[0] == 200:
                    check('After database recovery', result, 200)
                    break
            except (URLError, TimeoutError, RuntimeError):
                pass
            time.sleep(1)
        else:
            raise RuntimeError('Backend did not recover after unpausing PostgreSQL')
    finally:
        if user_id is not None:
            status, _ = request(base, f'/api/auth/_test/users/{user_id}', 'DELETE')
            if status != 200:
                print(f'Could not delete test account {username}; HTTP {status}', file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--database', action='store_true', help='run the database interruption check instead of body checks')
    parser.add_argument('--base-url', default='http://127.0.0.1:8000', help='local gateway URL (default: http://127.0.0.1:8000)')
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if url.scheme != 'http' or url.hostname not in ('localhost', '127.0.0.1', '::1') or url.path not in ('', '/') or url.query or url.fragment or url.username:
        parser.error('--base-url must be a local HTTP gateway URL')
    base = args.base_url.rstrip('/')
    try:
        if args.database:
            database_test(base)
        else:
            body_tests(base)
    except (AssertionError, RuntimeError, URLError, OSError, subprocess.CalledProcessError) as error:
        print(f'Test failed: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.strip(), file=sys.stderr)
        return 1
    print('All checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
