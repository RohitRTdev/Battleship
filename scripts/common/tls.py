"""TLS trust for the deployed Battleship gateway."""
from __future__ import annotations

import ssl
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@lru_cache(maxsize=1)
def production_ssl_context() -> ssl.SSLContext:
    certificate = ROOT / ".deployment" / "server.crt"
    if not certificate.is_file():
        raise FileNotFoundError(f"Production certificate missing: {certificate}; run ./setup.sh up prod")
    # Application requests trust only this deployment certificate. AWS SDK
    # clients keep their own default public CA trust store.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(certificate))
    return context
