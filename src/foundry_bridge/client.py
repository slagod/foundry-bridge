"""Client for scripts — standard library only.

    from foundry_bridge.client import Bridge
    fb = Bridge()                                   # key and port from env or ~/.config/foundry-bridge/key
    fb.upload("rpg-maps/inn/map.webp", Path("map.webp"))
    j = fb.upsert("JournalEntry", "rpgmaps:inn", {"name": "Inn", "pages": [...]}, folder="rpg-maps")
    fb.upsert("Scene", "rpgmaps:inn", {..., "journal": j["id"]}, folder="rpg-maps")

`key` identifies a document across pushes (stored in flags["foundry-bridge"].key): the same key
updates the existing document instead of creating a copy. Embedded collections sent in `data`
(a scene's walls, an actor's items, a journal's pages) replace the existing ones; collections
not sent are left alone, so tokens placed by the GM survive a scene re-push.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import urllib.error
import urllib.request
from pathlib import Path

from . import config


class BridgeError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"[{status}] {message}")
        self.status = status


class Bridge:
    def __init__(self, url: str | None = None, key: str | None = None, timeout: float = 180.0):
        self.url = (url or f"http://127.0.0.1:{config.port()}").rstrip("/")
        self.key = key or config.read_key()
        if not self.key:
            raise BridgeError(0, "no bridge key — run `foundry-bridge serve` once, or set FOUNDRY_BRIDGE_KEY")
        self.timeout = timeout

    def _req(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", e.reason)
            except ValueError:
                msg = e.reason
            raise BridgeError(e.code, msg) from None
        except urllib.error.URLError as e:
            raise BridgeError(0, f"bridge not running at {self.url} ({e.reason}) — `foundry-bridge serve`") from None

    # --- generic --------------------------------------------------------------
    def status(self) -> dict:
        return self._req("GET", "/status")

    def call(self, op: str, **args) -> object:
        return self._req("POST", "/rpc", {"op": op, "args": args})["result"]

    def batch(self, ops: list[dict]) -> list:
        return self._req("POST", "/batch", {"ops": ops})["results"]

    # --- helpers --------------------------------------------------------------
    def upload(self, path: str, data: bytes | Path, mime: str | None = None) -> str:
        """Upload into Foundry's Data/<path>; returns the path Foundry stored. Overwrites."""
        if isinstance(data, Path):
            mime = mime or mimetypes.guess_type(data.name)[0]
            data = data.read_bytes()
        return self.call("files.upload", path=path, b64=base64.b64encode(data).decode(),
                         mime=mime or mimetypes.guess_type(path)[0] or "application/octet-stream")

    def upsert(self, type: str, key: str, data: dict, folder: str | None = None) -> dict:
        """Create or update a document by key; returns {uuid, id, created}."""
        args = {"type": type, "key": key, "data": data}
        if folder:
            args["folder"] = folder
        return self.call("documents.upsert", **args)

    def find(self, type: str, key: str | None = None) -> list[dict]:
        args = {"type": type} | ({"key": key} if key else {})
        return self.call("documents.find", **args)

    def delete(self, type: str, key: str) -> int:
        return self.call("documents.delete", type=type, key=key)

    # --- read -----------------------------------------------------------------
    def get(self, type: str, ids: list[str] | None = None, folder: str | None = None) -> list[dict]:
        """Full data of world documents (any, not only bridge-created), optionally by ids or top folder name."""
        args = {"type": type} | ({"ids": ids} if ids else {}) | ({"folder": folder} if folder else {})
        return self.call("documents.get", **args)

    def packs(self) -> list[dict]:
        """Compendiums of allowed document types: {id, label, type, package, size}."""
        return self.call("packs.list")

    def export_pack(self, pack: str, ids: list[str] | None = None) -> list[dict]:
        """Full data of a compendium's documents (each with its uuid)."""
        return self.call("packs.export", pack=pack, **({"ids": ids} if ids else {}))

    def fetch_file(self, path: str) -> tuple[bytes, str | None]:
        """A file served by Foundry (e.g. an actor's img), as (bytes, mime)."""
        r = self.call("files.fetch", path=path)
        return base64.b64decode(r["b64"]), r.get("mime")
