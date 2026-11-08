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
import time
import urllib.error
import urllib.parse
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

    def set_images(self, type: str, id: str, img: str | None = None, token: str | None = None) -> dict:
        """Point an existing world Actor/Item (by id) at pictures already uploaded; nothing else changes."""
        return self.call("documents.images", type=type, id=id, **({"img": img} if img else {}),
                         **({"token": token} if token else {}))

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

    # --- at the table ---------------------------------------------------------
    def events(self, since: int = 0, wait: float = 0, boot: str | None = None) -> dict:
        """Events after `since`: {events, last, boot, connected}; `wait` s long-poll when there are none."""
        q = {"since": since, "wait": wait} | ({"boot": boot} if boot else {})
        return self._req("GET", "/events?" + urllib.parse.urlencode(q))

    def listen(self, since: int | None = None, wait: float = 25):
        """Events one by one as they come, forever; `since` None starts with what happens from now on."""
        boot = None
        if since is None:
            r = self.events()
            since, boot = r["last"], r["boot"]
        while True:
            try:
                r = self.events(since, wait, boot)
            except BridgeError as e:
                if e.status:                       # a real refusal (key), not a bridge being restarted
                    raise
                time.sleep(2)
                continue
            if boot and r["boot"] != boot:
                since = 0
            boot = r["boot"]
            for e in r["events"]:
                if e["seq"] > since:
                    yield e
            since = r["last"]

    def say(self, text: str, whisper: str | list[str] | None = "gm", speaker: str | None = None,
            flavor: str | None = None, share: bool = True) -> dict:
        """A message in the chat (plain text, **bold**, *italic*); by default whispered to the GM with a button
        to show it to everyone."""
        args = {"text": text, "whisper": whisper, "share": share} | ({"speaker": speaker} if speaker else {}) \
            | ({"flavor": flavor} if flavor else {})
        return self.call("chat.post", **args)

    def add_tokens(self, scene: str, tokens: list[dict]) -> list[dict]:
        """Tokens of actors (`actor`: id, bridge key or uuid, compendium too) at `x`, `y` (px, or grid cells with
        `grid: true`), optionally `hidden`, `disposition` (-1 hostile, 0 neutral, 1 friendly), `name`."""
        return self.call("tokens.create", scene=scene, tokens=tokens)

    def update_tokens(self, scene: str, tokens: list[dict]) -> list[str]:
        return self.call("tokens.update", scene=scene, tokens=tokens)

    def remove_tokens(self, scene: str, ids: list[str]) -> int:
        return self.call("tokens.delete", scene=scene, ids=ids)

    def import_pack(self, pack: str, ids: list[str], folder: str | None = None) -> list[dict]:
        """Compendium documents copied into the world: [{id, uuid, name, source}]."""
        return self.call("packs.import", pack=pack, ids=ids, **({"folder": folder} if folder else {}))

    def activate(self, scene: str) -> dict:
        return self.call("scenes.activate", scene=scene)

    def view(self, scene: str) -> dict:
        return self.call("scenes.view", scene=scene)

    def start_combat(self, scene: str, tokens: list[str] | None = None, roll: str | None = None) -> dict:
        """Combat on the scene with the given tokens (all when None); `roll`: "npc" or "all" initiative."""
        return self.call("combat.start", scene=scene, **({"tokens": tokens} if tokens else {}), **({"roll": roll} if roll else {}))

    def end_combat(self, scene: str | None = None) -> int:
        return self.call("combat.end", **({"scene": scene} if scene else {}))

    def show(self, img: str | None = None, journal: str | None = None, page: str | None = None,
             title: str | None = None, users: list[str] | None = None) -> dict:
        """A picture (path served by Foundry) or a journal (page) shown to the players."""
        args = {k: v for k, v in {"img": img, "journal": journal, "page": page, "title": title, "users": users}.items() if v}
        return self.call("show", **args)

    def open(self, type: str, id: str) -> dict:
        """Opens a document's sheet on the GM's screen (a scene: views it)."""
        return self.call("ui.open", type=type, id=id)

    def state(self) -> dict:
        """Active and viewed scene, combat, users with their characters, the GM's controlled and targeted tokens."""
        return self.call("world.state")

    def play(self, playlist: str, sound: str | None = None) -> dict:
        return self.call("playlists.play", playlist=playlist, **({"sound": sound} if sound else {}))

    def stop(self, playlist: str | None = None) -> int:
        return self.call("playlists.stop", **({"playlist": playlist} if playlist else {}))

    def update(self, type: str, id: str, data: dict) -> dict:
        """Changes fields of an existing world document by id, bridge key or uuid (not its embedded documents)."""
        return self.call("documents.update", type=type, id=id, data=data)

    def give(self, actor: str, items: list[dict | str]) -> list[dict]:
        """Items for an actor (id, bridge key, or a token's uuid for an unlinked one): item data or the uuid of an
        item in a compendium or in the world. The rest of the inventory stays."""
        return self.call("actors.items.add", actor=actor, items=items)

    def update_items(self, actor: str, items: list[dict]) -> list[str]:
        return self.call("actors.items.update", actor=actor, items=items)

    def take(self, actor: str, ids: list[str]) -> int:
        return self.call("actors.items.remove", actor=actor, ids=ids)

    # --- embedded documents of any allowed parent ---------------------------------
    def embedded_create(self, parent_type: str, parent: str, name: str, data: list[dict]) -> list[dict]:
        """E.g. ("Scene", key, "Wall", [...]), ("Actor", id, "ActiveEffect", [...]); the others stay."""
        return self.call("embedded.create", parent={"type": parent_type, "id": parent}, name=name, data=data)

    def embedded_update(self, parent_type: str, parent: str, name: str, data: list[dict]) -> list[str]:
        return self.call("embedded.update", parent={"type": parent_type, "id": parent}, name=name, data=data)

    def embedded_delete(self, parent_type: str, parent: str, name: str, ids: list[str]) -> int:
        return self.call("embedded.delete", parent={"type": parent_type, "id": parent}, name=name, ids=ids)

    def pan(self, x: float, y: float, grid: bool = False, scale: float | None = None, pull: bool = True) -> dict:
        """The GM's view to a point of the viewed scene; with `pull` the players' views follow."""
        return self.call("canvas.pan", x=x, y=y, grid=grid, pull=pull, **({"scale": scale} if scale else {}))
