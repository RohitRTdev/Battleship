"""Continuously match and play with pre-provisioned Battleship bot accounts."""
from __future__ import annotations

import argparse
import asyncio
import math
import os
import random
import signal
import sys
import time
from pathlib import Path
from typing import Any

import aiohttp

from common.auth_client import AuthClientError, configure_production, login
from common.bot_names import DEFAULT_NAME_FILE, bot_password
from common.game_bot import aggressive_target, bot_player, random_fleet

ROOT = Path(__file__).resolve().parent.parent


class RequestError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class Readiness:
    """Announce once when at least 75% of bots are in active games."""
    def __init__(self, total: int):
        self.total = total
        self.active: set[str] = set()
        self.announced = False

    def update(self, name: str, active: bool) -> None:
        if active:
            self.active.add(name)
        else:
            self.active.discard(name)
        if not self.announced and len(self.active) >= math.ceil(self.total * 0.75):
            self.announced = True
            print(f'Environment ready: {len(self.active)}/{self.total} bots are playing.', flush=True)


class Player:
    def __init__(self, name: str, password: str, base_url: str, session: aiohttp.ClientSession,
                 rng: random.Random, auth_limit: asyncio.Semaphore, readiness: Readiness | None = None):
        self.name, self.password, self.base_url = name, password, base_url.rstrip('/')
        self.session, self.rng, self.auth_limit = session, rng, auth_limit
        self.token = ''
        self.expires_at = 0.0
        self.game_code: str | None = None
        self.aggressive = False
        self.fleet: list[dict[str, Any]] = []
        self.readiness = readiness

    async def authenticate(self, force: bool = False) -> None:
        if not force and self.token and time.monotonic() < self.expires_at - 60:
            return
        async with self.auth_limit:
            result = await asyncio.to_thread(login, self.base_url, self.name, self.password)
        self.token = result.access_token
        self.expires_at = time.monotonic() + result.expires_in

    async def request(self, method: str, path: str, body: dict | None = None) -> dict:
        for attempt in range(2):
            await self.authenticate(force=attempt == 1)
            async with self.session.request(method, self.base_url + '/api/backend' + path,
                                            json=body, headers={'Authorization': 'Bearer ' + self.token,
                                                               'Cache-Control': 'no-store'}) as response:
                try:
                    data = await response.json(content_type=None)
                except (ValueError, aiohttp.ContentTypeError):
                    data = {}
                if response.status == 401 and attempt == 0:
                    continue
                if response.status >= 400:
                    error = data.get('error', {}) if isinstance(data, dict) else {}
                    code = error.get('code') if isinstance(error, dict) else None
                    raise RequestError(response.status, str(error), code)
                if not isinstance(data, dict):
                    raise ValueError(f'{path}: expected an object')
                return data
        raise RequestError(401, 'Authentication failed')

    def begin_game(self, code: str) -> None:
        if self.game_code != code:
            self.game_code = code
            self.aggressive = bool(self.rng.randrange(2))
            self.fleet = random_fleet(self.rng)

    async def play_step(self, code: str, stop: asyncio.Event) -> None:
        self.begin_game(code)
        game = (await self.request('GET', f'/games/{code}'))['game']
        status = game['status']
        if self.readiness:
            self.readiness.update(self.name, status == 'ACTIVE')
        if stop.is_set():
            return
        if status == 'FINISHED':
            self.game_code = None
            return
        if status == 'PLACEMENT' and not bot_player(game).get('fleetSubmitted'):
            await self.request('PUT', f'/games/{code}/fleet', {'ships': self.fleet})
            return
        if status == 'ACTIVE' and game.get('isYourTurn'):
            if self.aggressive:
                target = await asyncio.to_thread(aggressive_target, game, self.rng)
            else:
                attacked = {(a['coordinate']['row'], a['coordinate']['column']) for a in game.get('yourAttacks', [])}
                available = [(r, c) for r in range(10) for c in range(10) if (r, c) not in attacked]
                if not available:
                    raise ValueError('No legal target squares remain')
                row, column = self.rng.choice(available)
                target = {'row': row, 'column': column}
            if not stop.is_set():
                await self.request('POST', f'/games/{code}/fire', {'coordinate': target})
            return
        if status not in {'WAITING', 'PLACEMENT', 'ACTIVE'}:
            raise ValueError(f'Unexpected game status: {status}')
        await self.request('GET', f'/games/{code}/updates?afterVersion={game["version"]}')

    async def run(self, stop: asyncio.Event) -> None:
        failures = 0
        while not stop.is_set():
            try:
                state = await self.request('GET', '/player/state')
                if stop.is_set():
                    break
                if state['state'] == 'NOT_PLAYING':
                    if self.readiness:
                        self.readiness.update(self.name, False)
                    self.game_code = None
                    await self.request('POST', '/matchmaking', {})
                elif state['state'] == 'SEARCHING':
                    if self.readiness:
                        self.readiness.update(self.name, False)
                    await self.request('GET', '/matchmaking/updates')
                elif state['state'] == 'PLAYING':
                    await self.play_step(state['gameCode'], stop)
                else:
                    raise ValueError(f'Unexpected player state: {state}')
                failures = 0
            except (RequestError, AuthClientError, aiohttp.ClientError, asyncio.TimeoutError,
                    OSError, ValueError, KeyError, TypeError) as error:
                if self.readiness:
                    self.readiness.update(self.name, False)
                failures += 1
                delay = min(30, 2 ** min(failures - 1, 5))
                print(f'[{self.name}] {error}; retrying in {delay}s', file=sys.stderr, flush=True)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass

    async def cleanup(self) -> None:
        # DELETE atomically removes a search or returns the game created in a race.
        state = await self.request('DELETE', '/matchmaking')
        if state.get('state') != 'PLAYING':
            if state.get('state') != 'NOT_PLAYING':
                raise ValueError(f'Unexpected cleanup state: {state}')
            return
        code = state['gameCode']
        for _ in range(3):
            game = (await self.request('GET', f'/games/{code}'))['game']
            status = game['status']
            if status == 'FINISHED':
                return
            if status not in {'WAITING', 'PLACEMENT', 'ACTIVE'}:
                raise ValueError(f'Unexpected cleanup game status: {status}')
            action = 'surrender' if status == 'ACTIVE' else 'cancel'
            try:
                await self.request('POST', f'/games/{code}/{action}', {})
                return
            except RequestError as error:
                if error.status != 409:
                    raise
        game = (await self.request('GET', f'/games/{code}'))['game']
        if game['status'] != 'FINISHED':
            raise RuntimeError(f'Could not end game {code}')


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prod', action='store_true', help='Use the deployed environment')
    parser.add_argument('--base-url', default=os.environ.get('BATTLESHIP_BASE_URL', 'http://localhost:8000'))
    parser.add_argument('--count', type=int, help='Number of bot accounts (default: all names)')
    parser.add_argument('--names-file', type=Path, default=DEFAULT_NAME_FILE)
    parser.add_argument('--password-seed', default=os.environ.get('BATTLESHIP_BOT_PASSWORD_SEED', 'battleship-local-bot-seed'))
    parser.add_argument('--seed', type=int, help='Seed for reproducible bot randomness')
    return parser.parse_args()


def read_names(path: Path, count: int | None) -> list[str]:
    names = [line.strip() for line in path.read_text(encoding='utf-8').splitlines()
             if line.strip() and not line.lstrip().startswith('#')]
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError('Bot name file contains duplicate names')
    if count is None:
        count = len(names)
    if count < 1 or count > len(names):
        raise ValueError(f'--count must be between 1 and {len(names)}')
    return names[:count]


async def simulate(args: argparse.Namespace, names: list[str]) -> int:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    try:
        loop.add_signal_handler(signal.SIGTERM, stop.set)
    except (NotImplementedError, RuntimeError):
        pass
    connector = aiohttp.TCPConnector(limit=max(100, len(names) * 2), limit_per_host=max(100, len(names) * 2))
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        auth_limit = asyncio.Semaphore(16)
        readiness = Readiness(len(names))
        source = random.Random(args.seed) if args.seed is not None else random.SystemRandom()
        players = [Player(name, bot_password(name, args.password_seed), args.base_url, session,
                          random.Random(source.getrandbits(128)), auth_limit, readiness) for name in names]
        tasks = [asyncio.create_task(player.run(stop)) for player in players]
        print(f'Started {len(players)} bots; press Ctrl-C to stop.', flush=True)
        try:
            await stop.wait()
        except asyncio.CancelledError:
            # asyncio.run delivers Ctrl-C as cancellation; finish in-flight operations first.
            stop.set()
        print('Stopping bots and cleaning up...', flush=True)
        await asyncio.gather(*tasks, return_exceptions=True)
        cleanup_limit = asyncio.Semaphore(50)
        async def cleanup(player: Player) -> str | None:
            async with cleanup_limit:
                # An account that never logged in cannot have joined during this run.
                # Still attempt login: it may have activity from an earlier run.
                try:
                    await player.cleanup()
                    return None
                except Exception as error:
                    return f'{player.name}: {error}'
        results = await asyncio.gather(*(cleanup(player) for player in players))
        failures = [result for result in results if result]
        for failure in failures:
            print(f'Cleanup failed for {failure}', file=sys.stderr, flush=True)
        print(f'Cleanup complete: {len(players) - len(failures)}/{len(players)} accounts.', flush=True)
        return 1 if failures else 0


def main() -> int:
    args = arguments()
    try:
        names = read_names(args.names_file, args.count)
        if args.prod:
            args.base_url = configure_production(ROOT / '.deployment' / 'prod.json')
        return asyncio.run(simulate(args, names))
    except (AuthClientError, OSError, ValueError) as error:
        print(f'Simulator stopped: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
