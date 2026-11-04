"""Key and port: env first, then the key file (created on first `serve`)."""
from __future__ import annotations

import os
import secrets
from pathlib import Path

from . import DEFAULT_PORT

KEY_FILE = Path(os.environ.get("FOUNDRY_BRIDGE_KEY_FILE", "~/.config/foundry-bridge/key")).expanduser()


def port() -> int:
    return int(os.environ.get("FOUNDRY_BRIDGE_PORT", DEFAULT_PORT))


def read_key() -> str | None:
    if k := os.environ.get("FOUNDRY_BRIDGE_KEY"):
        return k.strip()
    if KEY_FILE.exists():
        return KEY_FILE.read_text().strip() or None
    return None


def ensure_key() -> str:
    if k := read_key():
        return k
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    k = secrets.token_urlsafe(32)
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(k + "\n")
    return k
