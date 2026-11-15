"""Verify that the deployed gateway serves HTTPS with its saved certificate."""
import json
import sys
from urllib.error import HTTPError
from urllib.request import urlopen
from common.tls import production_ssl_context

url = sys.argv[1].rstrip('/')
context = production_ssl_context()
with urlopen(url + '/config.json', context=context, timeout=20) as response:
    if response.status != 200 or json.load(response).get('environment') != 'prod':
        raise RuntimeError('Production config smoke test failed')
try:
    urlopen(url + '/api/backend/player/state', context=context, timeout=20)
except HTTPError as error:
    if error.code != 401:
        raise
else:
    raise RuntimeError('Production authentication smoke test failed')
print('Production HTTPS smoke test passed')
