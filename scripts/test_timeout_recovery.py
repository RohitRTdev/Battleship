"""Exercise timer recovery against the local Docker Compose stack.

Requires DISABLE_TIMEOUT=false and ENABLE_TEST_ROUTES=true. Pauses the shared
Postgres container; run only when interrupting the local stack is acceptable.
"""
from __future__ import annotations

import secrets
import argparse
import json
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from common.auth_client import delete_user, list_users, login, register
from test_replay import BASE, ROOT, database, execute, metadata


def request(token, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = Request(BASE + path, data=data, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        response = urlopen(req, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            payload = {'body': raw.decode(errors='replace')}
        return response.status, payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pause-seconds', type=int, default=40)
    parser.add_argument('--verify-timeout', action='store_true', help='Also wait for a normal 30-second timeout')
    args = parser.parse_args()
    if args.pause_seconds <= 5:
        parser.error('--pause-seconds must be greater than the five-second detection threshold')
    names, codes = [], []
    password = 'RecoveryTest!' + secrets.token_hex(12) + 'aA1'
    paused = False
    try:
        tokens = []
        for label in ('a', 'b', 'c', 'd'):
            name = 'recovery-test-' + secrets.token_hex(8) + '-' + label
            assert register(BASE, name, password)
            names.append(name)
            tokens.append(login(BASE, name, password).access_token)
        a, b, c, d = tokens
        game = execute(a, 'POST', ROOT, {}, 201)['game']
        code = game['gameCode']; codes.append(code); path = f'{ROOT}/{code}'
        execute(b, 'POST', path + '/join', metadata(1))
        ships = [{'start': {'row': i * 2, 'column': 0}, 'end': {'row': i * 2, 'column': length - 1}} for i, length in enumerate((5, 4, 3, 3, 2))]
        execute(a, 'PUT', path + '/fleet', {**metadata(2), 'ships': ships})
        execute(b, 'PUT', path + '/fleet', {**metadata(3), 'ships': ships})
        execute(a, 'POST', path + '/fire', {**metadata(4), 'coordinate': {'row': 0, 'column': 0}})
        placement = execute(c, 'POST', ROOT, {}, 201)['game']
        placement_code = placement['gameCode']; codes.append(placement_code); placement_path = f'{ROOT}/{placement_code}'
        execute(d, 'POST', placement_path + '/join', metadata(1))
        time.sleep(2)
        subprocess.run(['docker', 'pause', 'battleship-postgres'], check=True, capture_output=True)
        paused = True
        print(f'PostgreSQL paused for {args.pause_seconds} seconds; attempting a move during the outage.', flush=True)
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as executor:
            attempt = executor.submit(request, b, 'POST', path + '/fire', {**metadata(5), 'coordinate': {'row': 1, 'column': 0}})
            time.sleep(max(0, args.pause_seconds - (time.monotonic() - started)))
            assert attempt.result()[0] >= 500
        subprocess.run(['docker', 'unpause', 'battleship-postgres'], check=True, capture_output=True)
        paused = False
        shot = {**metadata(5), 'coordinate': {'row': 1, 'column': 0}}
        # Allow transient connection failures on recovery, preserving the same command ID.
        response = None
        for _ in range(20):
            try:
                response = request(b, 'POST', path + '/fire', shot)
                if response[0] < 500:
                    break
            except OSError:
                pass
            time.sleep(.25)
        assert response is not None and response[0] == 200, response
        assert response[1]['game']['status'] == 'ACTIVE', response
        stale = request(b, 'POST', path + '/fire', {**metadata(5), 'coordinate': {'row': 2, 'column': 0}})
        assert stale[0] == 409 and stale[1]['error']['code'] == 'STALE_VERSION', stale
        fleet = execute(c, 'PUT', placement_path + '/fleet', {**metadata(2), 'ships': ships})
        assert fleet['game']['status'] == 'PLACEMENT', fleet
        assert database(f"SELECT count(*) FROM game_events WHERE game_id = (SELECT id FROM games WHERE code = '{code}') AND event_type = 'TURN_TIMEOUT'") == '0'
        assert database(f"SELECT count(*) FROM game_events WHERE game_id = (SELECT id FROM games WHERE code = '{code}') AND event_type = 'DEADLINE_RESET'") == '1'
        assert database(f"SELECT count(*) FROM game_events WHERE game_id = (SELECT id FROM games WHERE code = '{code}') AND event_type = 'DEADLINE_RESET' AND actor_player_id IS NULL") == '1'
        assert database(f"SELECT count(*) FROM game_events WHERE game_id = (SELECT id FROM games WHERE code = '{placement_code}') AND event_type = 'DEADLINE_RESET'") == '1'
        for _ in range(30):
            if database('SELECT count(*) FROM database_recoveries') == '0':
                break
            time.sleep(.2)
        else:
            raise AssertionError('Processed recovery record was not cleaned up')
        if args.verify_timeout:
            time.sleep(33)
            timed_out = request(a, 'GET', path)
            assert timed_out[0] == 200 and timed_out[1]['game']['status'] == 'FINISHED', timed_out
            assert database(f"SELECT completion_reason FROM games WHERE code = '{code}'") == 'TIMEOUT'
            print('PASS: a later genuine turn timeout finishes the game.')
        print(f'PASS: {args.pause_seconds}-second outage preserves active turn and placement; old versions accepted.')
    finally:
        if paused:
            subprocess.run(['docker', 'unpause', 'battleship-postgres'], check=False)
        if codes:
            assert all(len(code) == 8 and code.isalnum() for code in codes)
            database('DELETE FROM games WHERE code IN (' + ','.join("'" + code + "'" for code in codes) + ')')
        users = {user.username: user.id for user in list_users(BASE)}
        for name in names:
            if name in users:
                delete_user(BASE, int(users[name]))


if __name__ == '__main__':
    main()
