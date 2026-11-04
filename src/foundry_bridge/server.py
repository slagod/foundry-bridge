"""The bridge: HTTP API for scripts, WebSocket for the Foundry module.

    script ──HTTP, Bearer key──▶ bridge (127.0.0.1) ◀──WebSocket, key── module in the GM's browser

The module connects out to the bridge (a Foundry module can't listen on anything), sends
`hello` with the key, then executes the operations it receives. One module connection at a
time: a new one replaces the old (e.g. the GM reloaded the page).
"""
from __future__ import annotations

import asyncio
import hmac
import itertools
import json
import logging

from aiohttp import WSMsgType, web

from . import OPS, __version__

log = logging.getLogger("foundry-bridge")

MAX_MSG = 256 * 1024 * 1024  # base64 maps and portraits travel over the socket


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
        web.post("/rpc", bridge.rpc),
        web.post("/batch", bridge.batch),
    ])
    return app


def serve(key: str, port: int) -> None:
    # loopback only: the key is the second line of defence, not the first
    web.run_app(make_app(key), host="127.0.0.1", port=port, print=None)
