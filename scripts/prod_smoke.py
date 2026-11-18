"""Verify that the deployed gateway serves HTTPS with its saved certificate."""
import json
import re
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from common.tls import production_ssl_context

url = sys.argv[1].rstrip('/')
context = production_ssl_context()
with urlopen(url + '/config.json', context=context, timeout=20) as response:
    if response.status != 200 or json.load(response).get('environment') != 'prod':
        raise RuntimeError('Production config smoke test failed')


def read_shell(path):
    with urlopen(url + path, context=context, timeout=20) as response:
        if response.status != 200 or response.headers.get_content_type() != 'text/html':
            raise RuntimeError(f'Expected HTML at {path}')
        return response.read()


shell = read_shell('/')
for path in ('/lobby', '/games/ABCD1234', '/profile/matches/550e8400-e29b-41d4-a716-446655440000'):
    if read_shell(path) != shell:
        raise RuntimeError(f'Expected the application shell at {path}')

asset = re.search(rb'<script\b[^>]*\bsrc="(/assets/[^"]+\.js)"', shell)
if asset is None:
    raise RuntimeError('Application shell has no bundled JavaScript entry point')
with urlopen(url + asset[1].decode(), context=context, timeout=20) as response:
    if response.headers.get_content_type() not in ('application/javascript', 'text/javascript') or not response.read(1):
        raise RuntimeError('Expected a nonempty JavaScript bundle')

for method, path, expected in (
    ('GET', '/api/backend/player/state', 401),
    ('GET', '/assets/smoke-test-missing.js', 404),
    ('POST', '/lobby', 404),
):
    try:
        with urlopen(Request(url + path, method=method), context=context, timeout=20) as response:
            raise RuntimeError(f'{method} {path} returned {response.status}, expected {expected}')
    except HTTPError as error:
        if error.code != expected:
            raise
print('Production HTTPS smoke test passed')
