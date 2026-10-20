#!/usr/bin/env python3

"""Creative identity allocation shared by Battleship test bots."""

from __future__ import annotations

import hashlib
import random
import threading
from pathlib import Path


DEFAULT_NAME_FILE = Path(__file__).resolve().parent.parent / "bot_names.txt"

_claim_lock = threading.Lock()
_claimed_names: set[str] = set()


def claim_bot_names(count: int, name_file: Path = DEFAULT_NAME_FILE) -> list[str]:
    """Claim distinct names for bots running in this Python process."""

    if count < 1:
        raise ValueError("Bot count must be at least one")

    names = [
        line.strip()
        for line in name_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    random.SystemRandom().shuffle(names)

    claimed: list[str] = []
    with _claim_lock:
        for name in names:
            identity = name.casefold()
            if identity in _claimed_names:
                continue
            _claimed_names.add(identity)
            claimed.append(name)
            if len(claimed) == count:
                return claimed

    raise ValueError(
        f"Requested {count} bot names, but the shared pool has only "
        f"{len(claimed)} unclaimed names"
    )


def bot_password(username: str, seed: str) -> str:
    """Create a stable development-only password for a bot identity."""

    digest = hashlib.sha256(f"{seed}:{username.casefold()}".encode("utf-8")).hexdigest()
    return f"Bot!{digest[:28]}"
