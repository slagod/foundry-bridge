// Foundry Bridge — settings, then the operations: the code of this release (scripts/bridge.js) or, with
// "Load operations from the bridge" on, the bridge.js the local bridge sends over the same keyed socket — so a
// change in the operations needs a bridge restart, not a module release. The loader itself rarely changes.
const MOD = "foundry-bridge";
let api = null;

Hooks.once("init", () => {
  const restart = () => api?.restart();
  game.settings.register(MOD, "enabled", {
    name: "Connect to the bridge", hint: "Only this browser, only for a GM. Leave off on machines without the bridge.",
    scope: "client", config: true, type: Boolean, default: false, onChange: restart,
  });
  game.settings.register(MOD, "url", {
    name: "Bridge URL", scope: "client", config: true, type: String,
    default: "ws://127.0.0.1:8765/ws", onChange: restart,
  });
  game.settings.register(MOD, "key", {
    name: "Bridge key", hint: "From `foundry-bridge key --copy`. Stored in this browser only.",
    scope: "client", config: true, type: String, default: "", onChange: restart,
  });
  game.settings.register(MOD, "events", {
    name: "Send table events to the bridge",
    hint: "Chat messages with rolls, combat turns, scene changes, targets and actor changes go to local scripts (e.g. descriptions of hits). This browser only.",
    scope: "client", config: true, type: Boolean, default: false,
  });
  game.settings.register(MOD, "devLoad", {
    name: "Load operations from the bridge (development)",
    hint: "Runs the operations code the local bridge sends instead of this module's own, so changes need only a bridge restart and a reload. Whoever controls the bridge's files on this machine controls that code. This browser only.",
    scope: "client", config: true, type: Boolean, default: false, requiresReload: true,
  });
  game.settings.register(MOD, "roots", {
    name: "Folders scripts may upload into", hint: "Comma-separated top-level folders of Data/.",
    scope: "world", config: true, type: String, default: "rpg-maps, bridge",
  });
});

// One short connection with the key: the bridge answers {type: "code", version, source} and closes.
function fromBridge() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(game.settings.get(MOD, "url"));
    const fail = e => { clearTimeout(t); reject(e); };
    const t = setTimeout(() => { ws.close(); reject(new Error("no answer")); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", key: game.settings.get(MOD, "key"), want: "code" }));
    ws.onmessage = ev => {
      clearTimeout(t);
      try { const m = JSON.parse(ev.data); m.type === "code" ? resolve(m) : reject(new Error(`unexpected ${m.type}`)); }
      catch (e) { reject(e); }
      ws.close();
    };
    ws.onerror = () => fail(new Error("bridge not running"));
    ws.onclose = ev => { if (ev.code >= 4000) fail(new Error(ev.reason || `closed ${ev.code}`)); };
  });
}

Hooks.once("ready", async () => {
  let mod = null, source = "module";
  if (game.user.isGM && game.settings.get(MOD, "enabled") && game.settings.get(MOD, "devLoad")) {
    try {
      const c = await fromBridge();
      mod = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(c.source));
      source = `bridge ${c.version}`;
    } catch (e) {
      console.warn(`${MOD} | loading the operations from the bridge`, e);
      ui.notifications.warn(`${MOD}: couldn't load the operations from the bridge (${e.message}) — using the module's own`);
    }
  }
  mod ??= await import("./bridge.js");
  api = mod;
  mod.start(source);
});
