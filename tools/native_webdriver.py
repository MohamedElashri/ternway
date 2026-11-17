"""Bounded transport recovery, restricted to operations safe to repeat."""
import http.client
import json
import time
import urllib.error
import urllib.request


def request(base, method, path, body=None, *, idempotent=False, alive=None):
    safe = idempotent or method == 'GET' or (
        method == 'POST' and path.rsplit('/', 1)[-1] in {'element', 'elements', 'window'}
    ) or (method == 'POST' and path.endswith('/window/rect'))
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    for attempt in range(3):
        if alive is not None and not alive():
            raise RuntimeError('Owned test driver exited; refusing to contact another process')
        try:
            with urllib.request.urlopen(req, timeout=35) as response:
                value = json.load(response).get('value')
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read()).get('value', {})
            raise RuntimeError(str(detail)) from error
        except (http.client.RemoteDisconnected, ConnectionError, urllib.error.URLError):
            if not safe or attempt == 2:
                raise
            time.sleep(.1)
            continue
        if isinstance(value, dict) and value.get('error'):
            raise RuntimeError(str(value))
        return value
