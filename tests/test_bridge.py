"""Bridge + client against a fake module (the real one runs only inside Foundry)."""
import asyncio
import base64
import unittest

import aiohttp
from aiohttp import web

from foundry_bridge.client import Bridge as Client, BridgeError
from foundry_bridge.server import make_app

KEY = "test-key"


class BridgeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runner = web.AppRunner(make_app(KEY, timeout=2))
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]
        self.client = Client(url=f"http://127.0.0.1:{self.port}", key=KEY)
        self.session = aiohttp.ClientSession()
        self.calls = []

    async def asyncTearDown(self):
        await self.session.close()
        await self.runner.cleanup()

    async def fake_module(self, key=KEY, answer=None):
        ws = await self.session.ws_connect(f"http://127.0.0.1:{self.port}/ws")
        await ws.send_json({"type": "hello", "key": key, "info": {"world": "test", "system": "wfrp4e"}})
        welcome = await ws.receive()
        if welcome.type != aiohttp.WSMsgType.TEXT:
            return ws, None

        async def loop():
            async for msg in ws:
                m = msg.json()
                self.calls.append(m)
                if answer is not False:
                    res = answer(m) if answer else {"ok": True, "result": {"echo": m["op"], "args": m["args"]}}
                    await ws.send_json({"id": m["id"], **res})
        return ws, asyncio.create_task(loop())

    def run_client(self, fn, *a, **kw):
        return asyncio.to_thread(fn, *a, **kw)

    async def test_status_without_module(self):
        st = await self.run_client(self.client.status)
        self.assertFalse(st["connected"])

    async def test_no_module_is_503(self):
        with self.assertRaises(BridgeError) as e:
            await self.run_client(self.client.call, "status")
        self.assertEqual(e.exception.status, 503)

    async def test_bad_client_key_is_401(self):
        bad = Client(url=f"http://127.0.0.1:{self.port}", key="nope")
        with self.assertRaises(BridgeError) as e:
            await self.run_client(bad.status)
        self.assertEqual(e.exception.status, 401)

    async def test_bad_module_key_is_rejected(self):
        ws, _ = await self.fake_module(key="nope")
        self.assertEqual(ws.close_code, 4401)
        st = await self.run_client(self.client.status)
        self.assertFalse(st["connected"])

    async def test_upsert_and_upload_roundtrip(self):
        await self.fake_module()
        st = await self.run_client(self.client.status)
        self.assertEqual(st["foundry"]["system"], "wfrp4e")
        r = await self.run_client(self.client.upsert, "Scene", "rpgmaps:x", {"name": "X"}, folder="rpg-maps")
        self.assertEqual(r["echo"], "documents.upsert")
        self.assertEqual(r["args"], {"type": "Scene", "key": "rpgmaps:x", "data": {"name": "X"}, "folder": "rpg-maps"})
        r = await self.run_client(self.client.upload, "rpg-maps/x/map.webp", b"\x00\x01")
        self.assertEqual(base64.b64decode(r["args"]["b64"]), b"\x00\x01")
        self.assertEqual(r["args"]["mime"], "image/webp")

    async def test_unknown_op_never_reaches_module(self):
        await self.fake_module()
        with self.assertRaises(BridgeError) as e:
            await self.run_client(self.client.call, "eval", code="alert(1)")
        self.assertEqual(e.exception.status, 400)
        self.assertEqual(self.calls, [])

    async def test_module_error_is_502(self):
        await self.fake_module(answer=lambda m: {"ok": False, "error": "type not allowed: Macro"})
        with self.assertRaises(BridgeError) as e:
            await self.run_client(self.client.upsert, "Macro", "k", {})
        self.assertEqual(e.exception.status, 502)
        self.assertIn("Macro", str(e.exception))

    async def test_timeout_is_504(self):
        await self.fake_module(answer=False)
        with self.assertRaises(BridgeError) as e:
            await self.run_client(self.client.call, "status")
        self.assertEqual(e.exception.status, 504)

    async def test_batch_stops_at_first_failure(self):
        await self.fake_module(answer=lambda m: {"ok": m["args"].get("n") != 1, "result": m["args"].get("n"),
                                                 "error": "boom"})
        with self.assertRaises(BridgeError) as e:
            await self.run_client(self.client.batch, [{"op": "status", "args": {"n": n}} for n in range(3)])
        self.assertEqual(e.exception.status, 502)
        self.assertEqual(len(self.calls), 2)

    async def test_new_connection_replaces_old(self):
        old, _ = await self.fake_module()
        await self.fake_module()
        await asyncio.sleep(0.1)
        self.assertEqual(old.close_code, 4000)
        st = await self.run_client(self.client.status)
        self.assertTrue(st["connected"])


if __name__ == "__main__":
    unittest.main()
