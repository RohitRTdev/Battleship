"""Test retry-safe commands through the local gateway"""
from __future__ import annotations
import json
import secrets
import socket
import subprocess
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from common.auth_client import delete_user, list_users, login, register

BASE = 'http://127.0.0.1:8000'
ROOT = '/api/backend/games'

def request(token, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = Request(BASE + path, data=data, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        res = urlopen(req, timeout=15)
    except HTTPError as error:
        res = error
    with res:
        return res.status, json.load(res)

def metadata(version):
    return {'commandId': str(uuid.uuid4()), 'expectedVersion': version}

def execute(token, method, path, body, status=200):
    result = request(token, method, path, body)
    assert result[0] == status, (path, result)
    return result[1]

def drop_response(token, path, body):
    payload = json.dumps(body).encode()
    headers = (f'POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n'
               f'Content-Type: application/json\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n').encode()
    with socket.create_connection(('127.0.0.1', 8000), timeout=5) as connection:
        connection.sendall(headers + payload)
        time.sleep(.05)  # Allow the gateway to forward the request, without reading the response.
        connection.shutdown(socket.SHUT_RDWR)

def database(sql):
    result = subprocess.run(['docker', 'exec', 'battleship-postgres', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -c "$1"', 'sh', sql], check=True, capture_output=True, text=True)
    return result.stdout.strip()

def main():
    names, codes = [], []
    password = 'CommandTest!' + secrets.token_hex(12) + 'aA1'
    try:
        tokens = []
        for label in ('a', 'b', 'c'):
            name = 'command-test-' + secrets.token_hex(8) + '-' + label
            assert register(BASE, name, password)
            names.append(name)
            tokens.append(login(BASE, name, password).access_token)
        a, b, outsider = tokens
        game = execute(a, 'POST', ROOT, {}, 201)['game']
        code = game['gameCode']; codes.append(code); path = f'{ROOT}/{code}'
        join = metadata(1)
        first_join = execute(b, 'POST', path + '/join', join)
        assert execute(b, 'POST', path + '/join', join) == first_join
        ships = [{'start': {'row': i * 2, 'column': 0}, 'end': {'row': i * 2, 'column': length - 1}} for i, length in enumerate((5, 4, 3, 3, 2))]
        fleet_a = {**metadata(2), 'ships': ships}
        fleet_response = execute(a, 'PUT', path + '/fleet', fleet_a)
        assert execute(a, 'PUT', path + '/fleet', fleet_a) == fleet_response
        execute(b, 'PUT', path + '/fleet', {**metadata(3), 'ships': ships})
        shot = {**metadata(4), 'coordinate': {'row': 0, 'column': 0}}
        drop_response(a, path + '/fire', shot)
        for _ in range(50):
            game = request(a, 'GET', path)[1]['game']
            if game['version'] == 5:
                break
            time.sleep(.1)
        assert game['version'] == 5, 'Shot was not committed after dropping the response'
        recovered = execute(a, 'POST', path + '/fire', shot)
        assert recovered['game']['version'] == 5 and recovered['outcome']['result'] == 'HIT'
        with ThreadPoolExecutor(max_workers=2) as executor:
            pair = list(executor.map(lambda _: execute(b, 'POST', path + '/fire', racing), range(2)))
        assert pair[0] == pair[1]
        assert execute(a, 'POST', path + '/fire', shot) == recovered
        assert request(a, 'POST', path + '/fire', {**shot, 'coordinate': {'row': 1, 'column': 0}})[1]['error']['code'] == 'COMMAND_ID_CONFLICT'
        assert request(a, 'POST', path + '/fire', {**metadata(4), 'coordinate': {'row': 1, 'column': 0}})[1]['error']['code'] == 'STALE_VERSION'
        assert request(outsider, 'POST', path + '/fire', shot)[0] == 403
        assert request(a, 'POST', path + '/fire', {**shot, 'commandId': 'bad'})[0] == 400
        surrender = metadata(6)
        response = execute(a, 'POST', path + '/surrender', surrender)
        assert execute(a, 'POST', path + '/surrender', surrender) == response
        game2 = execute(outsider, 'POST', ROOT, {}, 201)['game']; codes.append(game2['gameCode'])
        cancel_path = f"{ROOT}/{game2['gameCode']}/cancel"; cancel = metadata(1)
        cancelled = execute(outsider, 'POST', cancel_path, cancel)
        assert execute(outsider, 'POST', cancel_path, cancel) == cancelled
        assert database(f"SELECT count(*) FROM game_events WHERE game_id = (SELECT id FROM games WHERE code = '{code}') AND event_type = 'FIRE'") == '2'
        assert int(database(f"SELECT count(*) FROM game_command_results WHERE game_id = (SELECT id FROM games WHERE code = '{code}')")) == 6
        print('PASS: dropped response, concurrent duplicates, replay after later move, conflicts, isolation, invalid ID and all five commands')
    finally:
        if codes:
            assert all(len(code) == 8 and code.isalnum() for code in codes)
            query = "DELETE FROM games WHERE code IN (" + ','.join("'" + code + "'" for code in codes) + ")"
            ids = database("SELECT id FROM games WHERE code IN (" + ','.join("'" + code + "'" for code in codes) + ")").splitlines()
            database(query)
            if ids:
                remaining = database("SELECT count(*) FROM game_command_results WHERE game_id IN (" + ','.join("'" + game_id + "'" for game_id in ids) + ")")
                assert remaining == '0', 'Command records were not removed with their games'
        users = {user.username: user.id for user in list_users(BASE)}
        for name in names:
            if name in users:
                delete_user(BASE, int(users[name]))

if __name__ == '__main__':
    racing = {**metadata(5), 'coordinate': {'row': 0, 'column': 0}}
    main()
