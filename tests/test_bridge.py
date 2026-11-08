"""Bridge + client against a fake module (the real one runs only inside Foundry)."""
import asyncio
import base64
import os
import shutil
import unittest
from pathlib import Path

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

    async def test_events_from_the_module(self):
        ws, _ = await self.fake_module()
        first = await self.run_client(self.client.events)
        self.assertEqual((first["events"], first["last"]), ([], 0))
        waiting = asyncio.create_task(self.run_client(self.client.events, 0, 5))
        await asyncio.sleep(0.2)
        await ws.send_json({"type": "event", "event": {"kind": "chat", "content": "hit"}})
        got = await waiting
        self.assertEqual([(e["seq"], e["kind"]) for e in got["events"]], [(1, "chat")])
        self.assertEqual(self.calls, [])                                       # an event is not a reply
        await ws.send_json({"type": "event", "event": {"kind": "combat"}})
        await asyncio.sleep(0.1)
        later = await self.run_client(self.client.events, 1)
        self.assertEqual([e["kind"] for e in later["events"]], ["combat"])
        again = await self.run_client(self.client.events, 2, 0, "other-boot")  # numbers of an earlier bridge
        self.assertEqual(len(again["events"]), 2)

    async def test_new_connection_replaces_old(self):
        old, _ = await self.fake_module()
        await self.fake_module()
        await asyncio.sleep(0.1)
        self.assertEqual(old.close_code, 4000)
        st = await self.run_client(self.client.status)
        self.assertTrue(st["connected"])


@unittest.skipUnless(shutil.which("node"), "node not installed")
class ModuleE2ETest(unittest.IsolatedAsyncioTestCase):
    """The real module/scripts/bridge.js on the fake Foundry API (tests/fake-foundry.mjs)."""

    async def asyncSetUp(self):
        self.runner = web.AppRunner(make_app(KEY, timeout=5))
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.client = Client(url=f"http://127.0.0.1:{port}", key=KEY)
        fake = Path(__file__).with_name("fake-foundry.mjs")
        self.node = await asyncio.create_subprocess_exec(
            "node", str(fake), f"ws://127.0.0.1:{port}/ws", env={**os.environ, "FOUNDRY_BRIDGE_KEY": KEY},
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        for _ in range(50):
            if (await asyncio.to_thread(self.client.status))["connected"]:
                break
            await asyncio.sleep(0.1)
        else:
            self.fail("fake module did not connect")

    async def asyncTearDown(self):
        self.node.kill()
        await self.node.wait()
        await self.runner.cleanup()

    def run_client(self, fn, *a, **kw):
        return asyncio.to_thread(fn, *a, **kw)

    async def test_get_returns_all_world_documents_with_items(self):
        await self.run_client(self.client.upsert, "Actor", "t:a", {"name": "Etelka", "items": [{"name": "Dagger"}]})
        actors = await self.run_client(self.client.get, "Actor")
        self.assertEqual([a["name"] for a in actors], ["Etelka"])
        self.assertEqual(actors[0]["items"][0]["name"], "Dagger")
        only = await self.run_client(self.client.get, "Actor", ids=["nope"])
        self.assertEqual(only, [])

    async def test_packs_list_and_export(self):
        packs = await self.run_client(self.client.packs)
        self.assertEqual([p["id"] for p in packs], ["wfrp4e-core.items", "wfrp4e-core.bestiary"])  # Macro pack hidden
        self.assertEqual(packs[0]["size"], 2)
        items = await self.run_client(self.client.export_pack, "wfrp4e-core.items")
        self.assertEqual({i["name"] for i in items}, {"Dagger", "Sword"})
        self.assertTrue(items[0]["uuid"].startswith("Compendium.wfrp4e-core.items."))
        with self.assertRaises(BridgeError) as e:
            await self.run_client(self.client.export_pack, "macros.m")
        self.assertIn("not allowed", str(e.exception))

    async def test_images_of_an_existing_actor_only(self):
        a = await self.run_client(self.client.upsert, "Actor", "t:b", {"name": "Albert", "img": "old.webp", "system": {"x": 1}})
        r = await self.run_client(self.client.set_images, "Actor", a["id"], "studio/a.webp", "studio/a-token.png")
        self.assertEqual((r["img"], r["token"]), ("studio/a.webp", "studio/a-token.png"))
        got = (await self.run_client(self.client.get, "Actor", ids=[a["id"]]))[0]
        self.assertEqual((got["img"], got["system"]), ("studio/a.webp", {"x": 1}))
        for bad in (("Scene", a["id"], "x.webp"), ("Actor", "nope", "x.webp"), ("Actor", a["id"], "https://evil/x.png")):
            with self.assertRaises(BridgeError):
                await self.run_client(self.client.set_images, *bad)

    async def test_chat_is_text_whispered_to_the_gm_and_heard_as_an_event(self):
        r = await self.run_client(self.client.say, "Cios w **głowę**\n<img src=x onerror=alert(1)>")
        ev = (await self.run_client(self.client.events))["events"]
        chat = [e for e in ev if e["kind"] == "chat"]
        self.assertEqual(chat[-1]["id"], r["id"])
        self.assertEqual(chat[-1]["whisper"], ["gm1"])
        self.assertTrue(chat[-1]["bridge"] and chat[-1]["flags"]["foundry-bridge"]["share"])
        self.assertIn("<strong>głowę</strong>", chat[-1]["content"])
        self.assertNotIn("<img", chat[-1]["content"])
        await self.run_client(self.client.say, "Wszyscy", whisper=None, speaker="Narrator")
        last = [e for e in (await self.run_client(self.client.events))["events"] if e["kind"] == "chat"][-1]
        self.assertEqual((last["whisper"], last["speaker"]), ([], {"alias": "Narrator"}))

    async def test_tokens_combat_and_state(self):
        sc = await self.run_client(self.client.upsert, "Scene", "t:s", {"name": "Obóz"})
        await self.run_client(self.client.upsert, "Actor", "t:hero", {"name": "Etelka"})
        gob = "Compendium.wfrp4e-core.bestiary.Actor.Goblin"
        made = await self.run_client(self.client.add_tokens, "t:s", [
            {"actor": "t:hero", "x": 2, "y": 3, "grid": True},
            {"actor": gob, "x": 10, "y": 0, "hidden": True, "disposition": -1},
            {"actor": gob, "x": 11, "y": 0, "hidden": True, "disposition": -1}])
        self.assertEqual([m["name"] for m in made], ["Etelka", "Goblin", "Goblin"])
        actors = await self.run_client(self.client.get, "Actor")
        self.assertEqual(sorted(a["name"] for a in actors), ["Etelka", "Goblin"])      # imported once
        toks = (await self.run_client(self.client.get, "Scene", ids=[sc["id"]]))[0]["tokens"]
        self.assertEqual([(t["x"], t["y"]) for t in toks], [(300, 350), (110, 50), (111, 50)])
        await self.run_client(self.client.update_tokens, "t:s", [{"_id": made[1]["id"], "hidden": False}])
        self.assertEqual(await self.run_client(self.client.remove_tokens, "t:s", [made[2]["id"], "nope"]), 1)
        await self.run_client(self.client.activate, "t:s")
        c = await self.run_client(self.client.start_combat, "t:s", None, "npc")
        self.assertEqual((c["round"], len(c["order"])), (1, 2))
        st = await self.run_client(self.client.state)
        self.assertEqual((st["active"]["name"], st["combat"]["id"]), ("Obóz", c["id"]))
        self.assertEqual([u["name"] for u in st["users"]], ["Gamemaster", "Ania"])
        self.assertIn("combat", [e["kind"] for e in (await self.run_client(self.client.events))["events"]])
        self.assertEqual(await self.run_client(self.client.end_combat, "t:s"), 1)

    async def test_items_of_an_actor(self):
        a = await self.run_client(self.client.upsert, "Actor", "t:c", {"name": "Hans", "items": [{"name": "Dagger"}]})
        got = await self.run_client(self.client.give, "t:c", ["Compendium.wfrp4e-core.items.Item.Sword", {"name": "Rope"}])
        self.assertEqual([g["name"] for g in got], ["Sword", "Rope"])
        items = (await self.run_client(self.client.get, "Actor", ids=[a["id"]]))[0]["items"]
        self.assertEqual([i["name"] for i in items], ["Dagger", "Sword", "Rope"])
        await self.run_client(self.client.update_items, a["id"], [{"_id": got[1]["id"], "system": {"quantity": 2}}])
        self.assertEqual(await self.run_client(self.client.take, a["id"], [got[0]["id"]]), 1)
        await self.run_client(self.client.update, "Actor", a["id"], {"system": {"wounds": 3}})
        hans = (await self.run_client(self.client.get, "Actor", ids=[a["id"]]))[0]
        self.assertEqual([i["name"] for i in hans["items"]], ["Dagger", "Rope"])
        self.assertEqual((hans["items"][1]["system"], hans["system"]), ({"quantity": 2}, {"wounds": 3}))
        for bad in (("Actor", a["id"], {"items": []}), ("Scene", a["id"], {"name": "x"}), ("Actor", "nope", {"name": "x"})):
            with self.assertRaises(BridgeError):
                await self.run_client(self.client.update, *bad)

    async def test_import_show_open_and_music(self):
        gob = (await self.run_client(self.client.export_pack, "wfrp4e-core.bestiary"))[0]
        r = await self.run_client(self.client.import_pack, "wfrp4e-core.bestiary", [gob["_id"]], "Wrogowie")
        self.assertEqual((r[0]["name"], r[0]["source"]), ("Goblin", f"Compendium.wfrp4e-core.bestiary.Actor.{gob['_id']}"))
        self.assertEqual((await self.run_client(self.client.show, img="bridge/studio/x.webp"))["shown"], "image")
        with self.assertRaises(BridgeError):
            await self.run_client(self.client.show, img="https://evil.example/x.png")
        await self.run_client(self.client.upsert, "JournalEntry", "t:j", {"name": "List", "pages": [{"name": "Strona"}]})
        self.assertEqual((await self.run_client(self.client.show, journal="t:j", page="Strona"))["name"], "Strona")
        self.assertEqual((await self.run_client(self.client.open, "Actor", r[0]["id"]))["name"], "Goblin")
        await self.run_client(self.client.upsert, "Playlist", "t:p", {"name": "Las", "sounds": [{"name": "Deszcz"}]})
        await self.run_client(self.client.play, "t:p", "Deszcz")
        self.assertEqual([p["name"] for p in (await self.run_client(self.client.state))["playing"]], ["Las"])
        self.assertEqual(await self.run_client(self.client.stop), 1)

    async def test_fetch_file_only_relative_paths(self):
        data, mime = await self.run_client(self.client.fetch_file, "worlds/fake/portrait.webp")
        self.assertEqual(data, b"\x01\x02\x03")
        self.assertEqual(mime, "image/webp")
        for bad in ("https://evil.example/x.png", "worlds/../../etc/passwd", "data:text/plain,hi"):
            with self.assertRaises(BridgeError):
                await self.run_client(self.client.fetch_file, bad)


if __name__ == "__main__":
    unittest.main()
