"""The bridge: HTTP API for scripts, WebSocket for the Foundry module.

    script ──HTTP, Bearer key──▶ bridge (127.0.0.1) ◀──WebSocket, key── module in the GM's browser

The module connects out to the bridge (a Foundry module can't listen on anything), sends
`hello` with the key, then executes the operations it receives. One module connection at a
time: a new one replaces the old (e.g. the GM reloaded the page).

When the GM turns events on in the module, it also sends what happens at the table (chat
messages with rolls, combat turns, scene changes, targets, actor changes) as `{type: "event"}`.
The bridge keeps the latest ones numbered; scripts read them with `GET /events?since=N`
(long-poll). The bridge passes them on as they are: what a roll means is the game system's
business, not the bridge's.
"""
from __future__ import annotations

import asyncio
import hmac
import itertools
import json
import logging
import secrets
import time
from collections import deque
from pathlib import Path

from aiohttp import WSMsgType, web

from . import OPS, __version__

log = logging.getLogger("foundry-bridge")

MAX_MSG = 256 * 1024 * 1024  # base64 maps and portraits travel over the socket
# The operations code the module's loader may ask for ("Load operations from the bridge"): this checkout's.
MODULE_JS = Path(__file__).resolve().parents[2] / "module" / "scripts" / "bridge.js"
KEEP_EVENTS = 5000
MAX_WAIT = 60.0


class NotConnected(Exception):
    pass


class ModuleError(Exception):
    pass


class Bridge:
    def __init__(self, key: str, timeout: float = 120.0):
        self.key = key
        self.timeout = timeout
        self.ws: web.WebSocketResponse | None = None
        self.info: dict | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.ids = itertools.count(1)
        self.events: deque[dict] = deque(maxlen=KEEP_EVENTS)
        self.seq = 0
        self.boot = secrets.token_hex(4)          # numbering starts over when the bridge restarts
        self.new_event = asyncio.Event()

    def add_event(self, ev: dict) -> dict:
        self.seq += 1
        e = {**ev, "seq": self.seq, "received": time.time()}
        self.events.append(e)
        self.new_event.set()
        self.new_event = asyncio.Event()
        return e

    # --- auth -----------------------------------------------------------------
    def _authorized(self, request: web.Request) -> bool:
        return hmac.compare_digest(request.headers.get("Authorization", ""), f"Bearer {self.key}")

    # --- module side ----------------------------------------------------------
    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=MAX_MSG, heartbeat=30)
        await ws.prepare(request)
        try:
            msg = await ws.receive(timeout=10)
            hello = json.loads(msg.data) if msg.type == WSMsgType.TEXT else {}
        except (asyncio.TimeoutError, ValueError):
            hello = {}
        if hello.get("type") != "hello" or not hmac.compare_digest(str(hello.get("key", "")), self.key):
            await ws.close(code=4401, message=b"bad key")
            return ws
        if hello.get("want") == "code":                 # the loader's short visit, not the module's connection
            if not MODULE_JS.is_file():
                await ws.close(code=4404, message=b"no module code next to this bridge")
                return ws
            await ws.send_json({"type": "code", "version": __version__, "source": MODULE_JS.read_text(encoding="utf-8")})
            await ws.close()
            log.info("sent the module code (%s)", __version__)
            return ws

        if self.ws is not None and not self.ws.closed:
            await self.ws.close(code=4000, message=b"replaced by a new connection")
        self.ws, self.info = ws, hello.get("info") or {}
        log.info("module connected: %s", self.info)
        await ws.send_json({"type": "welcome", "bridge": __version__})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if data.get("type") == "event" and isinstance(data.get("event"), dict):
                    self.add_event(data["event"])
                    continue
                fut = self.pending.pop(data.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(data)
        finally:
            if self.ws is ws:
                self.ws, self.info = None, None
                log.info("module disconnected")
                for fut in self.pending.values():
                    if not fut.done():
                        fut.set_exception(NotConnected("module disconnected"))
                self.pending.clear()
        return ws

    async def call(self, op: str, args: dict) -> object:
        if self.ws is None or self.ws.closed:
            raise NotConnected("no Foundry world connected — open the world as GM with the module enabled")
        i = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[i] = fut
        await self.ws.send_json({"id": i, "op": op, "args": args})
        try:
            res = await asyncio.wait_for(fut, self.timeout)
        finally:
            self.pending.pop(i, None)
        if not res.get("ok"):
            raise ModuleError(res.get("error") or "unknown error")
        return res.get("result")

    # --- script side ----------------------------------------------------------
    async def _run(self, op, args) -> tuple[int, dict]:
        if op not in OPS:
            return 400, {"error": f"unknown op: {op}"}
        if not isinstance(args, dict):
            return 400, {"error": "args must be an object"}
        try:
            return 200, {"result": await self.call(op, args)}
        except NotConnected as e:
            return 503, {"error": str(e)}
        except ModuleError as e:
            return 502, {"error": str(e)}
        except asyncio.TimeoutError:
            return 504, {"error": f"{op}: no answer from the module in {self.timeout:.0f}s"}

    async def status(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response({"bridge": __version__, "connected": self.ws is not None, "foundry": self.info})

    async def events_handler(self, request: web.Request) -> web.Response:
        """Events after `since`; with `wait` (s), waits for the first one when there are none yet."""
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            since = int(request.query.get("since", 0))
            wait = min(MAX_WAIT, max(0.0, float(request.query.get("wait", 0))))
        except ValueError:
            return web.json_response({"error": "since and wait must be numbers"}, status=400)
        if request.query.get("boot") not in (None, "", self.boot):
            since = 0                                   # the client numbered events of an earlier bridge
        if wait and not any(e["seq"] > since for e in self.events):
            try:
                await asyncio.wait_for(self.new_event.wait(), wait)
            except asyncio.TimeoutError:
                pass
        out = [e for e in self.events if e["seq"] > since]
        return web.json_response({"events": out, "last": self.seq, "boot": self.boot,
                                  "connected": self.ws is not None})

    async def rpc(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "body must be JSON"}, status=400)
        code, res = await self._run(body.get("op"), body.get("args", {}))
        return web.json_response(res, status=code)

    async def batch(self, request: web.Request) -> web.Response:
        """Operations one after another; stops at the first failure."""
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            ops = (await request.json()).get("ops", [])
        except (ValueError, AttributeError):
            return web.json_response({"error": "body must be {\"ops\": [...]}"}, status=400)
        results = []
        for n, item in enumerate(ops):
            code, res = await self._run(item.get("op"), item.get("args", {}))
            if code != 200:
                return web.json_response({"results": results, "failed": n, **res}, status=code)
            results.append(res["result"])
        return web.json_response({"results": results})


def make_app(key: str, timeout: float = 120.0) -> web.Application:
    bridge = Bridge(key, timeout)
    app = web.Application(client_max_size=MAX_MSG)
    app.add_routes([
        web.get("/ws", bridge.ws_handler),
        web.get("/status", bridge.status),
        web.get("/events", bridge.events_handler),
        web.post("/rpc", bridge.rpc),
        web.post("/batch", bridge.batch),
    ])
    return app


def serve(key: str, port: int) -> None:
    # loopback only: the key is the second line of defence, not the first
    web.run_app(make_app(key), host="127.0.0.1", port=port, print=None)
