// Foundry Bridge — the GM's browser connects to a local bridge and runs the operations it sends.
// The module only connects for a GM who enabled it in their own client settings.
const MOD = "foundry-bridge";

// Document types scripts may create/update. No Macro: a macro is arbitrary code.
const TYPES = ["Scene", "JournalEntry", "Actor", "Item", "RollTable", "Playlist", "Cards"];

const FP = () => foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;

// --- operations ----------------------------------------------------------------------------

function cleanPath(path) {
  const parts = String(path ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some(p => p === "." || p === "..")) throw new Error(`bad path: ${path}`);
  const roots = game.settings.get(MOD, "roots").split(",").map(s => s.trim()).filter(Boolean);
  if (!roots.includes(parts[0])) throw new Error(`path outside allowed folders (${roots.join(", ")}): ${path}`);
  return parts;
}

async function ensureDir(parts) {
  let parent = "";
  for (const p of parts) {
    const dir = parent ? `${parent}/${p}` : p;
    const listing = await FP().browse("data", parent);
    if (!listing.dirs.includes(dir)) await FP().createDirectory("data", dir, {});
    parent = dir;
  }
  return parent;
}

function collectionFor(type) {
  if (!TYPES.includes(type)) throw new Error(`type not allowed: ${type} (allowed: ${TYPES.join(", ")})`);
  return game.collections.get(type);
}

function packFor(id) {
  const pack = game.packs.get(id);
  if (!pack) throw new Error(`no compendium: ${id}`);
  if (!TYPES.includes(pack.documentName)) throw new Error(`compendium type not allowed: ${pack.documentName}`);
  return pack;
}

// Files the GM's browser can already load from this Foundry server; relative paths only.
function servedPath(path) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.split("/").some(s => s === "..")) throw new Error(`bad path: ${path}`);
  return p;
}

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const byKey = (type, key) => collectionFor(type).filter(d => d.getFlag(MOD, "key") === key);

async function folderId(type, name) {
  const f = game.folders.find(f => f.type === type && f.name === name && !f.folder)
    ?? await Folder.create({ name, type });
  return f.id;
}

const OPS = {
  async status() {
    return info();
  },

  async "files.upload"({ path, b64, mime }) {
    const parts = cleanPath(path);
    const name = parts.pop();
    const dir = await ensureDir(parts);
    const blob = await (await fetch(`data:${mime || "application/octet-stream"};base64,${b64}`)).blob();
    const res = await FP().upload("data", dir, new File([blob], name, { type: blob.type }), {}, { notify: false });
    if (!res || res.status === "error") throw new Error(res?.message || `upload failed: ${path}`);
    return res.path ?? `${dir}/${name}`;
  },

  async "documents.upsert"({ type, key, data, folder }) {
    if (!key) throw new Error("key is required");
    const cls = CONFIG[type]?.documentClass;
    data = foundry.utils.deepClone(data ?? {});
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [MOD]: { key } });
    if (folder) data.folder = await folderId(type, folder);

    const [existing, ...dupes] = byKey(type, key);
    for (const d of dupes) await d.delete();
    let doc, created = false;
    if (!existing) {
      doc = await cls.create(data);
      created = true;
    } else {
      // Embedded collections that were sent replace the old ones; the rest stay (e.g. GM's tokens).
      const later = [];
      for (const [name, field] of Object.entries(cls.metadata.embedded ?? {})) {
        if (!(field in data)) continue;
        const ids = existing.getEmbeddedCollection(name).map(e => e.id);
        if (ids.length) await existing.deleteEmbeddedDocuments(name, ids);
        later.push([name, data[field]]);
        delete data[field];
      }
      await existing.update(data);
      for (const [name, items] of later) if (items?.length) await existing.createEmbeddedDocuments(name, items);
      doc = existing;
    }
    if (type === "Scene") {
      try { const t = await doc.createThumbnail(); await doc.update({ thumb: t.thumb }); }
      catch (e) { console.warn(`${MOD} | thumbnail`, e); }
    }
    return { uuid: doc.uuid, id: doc.id, created };
  },

  // Only the pictures of an existing world document (e.g. an actor pulled from the world): img and, for actors,
  // the prototype token's texture. Paths must be files this server serves. Nothing else can be changed this way.
  async "documents.images"({ type, id, img, token }) {
    if (!["Actor", "Item"].includes(type)) throw new Error(`documents.images: Actor or Item, not ${type}`);
    const doc = collectionFor(type).find(d => d.id === id);
    if (!doc) throw new Error(`${type} ${id} not in the world`);
    const data = {};
    if (img) data.img = servedPath(img);
    if (token && type === "Actor") data.prototypeToken = { texture: { src: servedPath(token) } };
    if (!Object.keys(data).length) throw new Error("documents.images: nothing to set");
    await doc.update(data);
    return { uuid: doc.uuid, id: doc.id, img: doc.img, token: doc.prototypeToken?.texture?.src ?? null };
  },

  async "documents.find"({ type, key }) {
    const docs = key ? byKey(type, key) : collectionFor(type).filter(d => d.getFlag(MOD, "key"));
    return docs.map(d => ({ uuid: d.uuid, id: d.id, name: d.name, key: d.getFlag(MOD, "key") }));
  },

  // Read-only: full data of world documents, e.g. actors with their items (statblocks).
  async "documents.get"({ type, ids, folder }) {
    let docs = collectionFor(type).contents ?? [...collectionFor(type)];
    if (ids?.length) docs = docs.filter(d => ids.includes(d.id));
    if (folder) docs = docs.filter(d => d.folder?.name === folder);
    return docs.map(d => d.toObject());
  },

  async "packs.list"() {
    return game.packs.filter(p => TYPES.includes(p.documentName)).map(p => ({
      id: p.collection, label: p.metadata.label, type: p.documentName,
      package: p.metadata.packageName, size: p.index.size,
    }));
  },

  async "packs.export"({ pack, ids }) {
    const docs = await packFor(pack).getDocuments(ids?.length ? { _id__in: ids } : {});
    return docs.map(d => ({ ...d.toObject(), uuid: d.uuid }));
  },

  async "files.fetch"({ path }) {
    const p = servedPath(path);
    const res = await fetch(foundry.utils.getRoute ? foundry.utils.getRoute(p) : `/${p}`);
    if (!res.ok) throw new Error(`fetch ${p}: HTTP ${res.status}`);
    return { path: p, mime: res.headers.get("content-type"), b64: toB64(await res.arrayBuffer()) };
  },

  async "documents.delete"({ type, key }) {
    if (!key) throw new Error("key is required");
    const docs = byKey(type, key);
    for (const d of docs) await d.delete();
    return docs.length;
  },
};

// --- connection ----------------------------------------------------------------------------

function info() {
  return {
    world: game.world.id, title: game.world.title,
    system: game.system.id, systemVersion: game.system.version,
    foundry: game.version, user: game.user.name, isGM: game.user.isGM,
  };
}

const Bridge = {
  ws: null, retry: 2000, timer: null, announced: false,

  start() {
    this.stop();
    if (!game.user.isGM || !game.settings.get(MOD, "enabled")) return;
    const url = game.settings.get(MOD, "url"), key = game.settings.get(MOD, "key");
    if (!key) return ui.notifications.warn(`${MOD}: no key set — run \`foundry-bridge key --copy\` and paste it in the module settings`);
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return this.later(); }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", key, info: info() }));
    ws.onmessage = ev => this.handle(ws, ev.data);
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4401) return ui.notifications.error(`${MOD}: the bridge rejected the key`);
      if (ev.code === 4000) return;  // another tab took over
      if (this.announced) ui.notifications.warn(`${MOD}: disconnected from the bridge, retrying`);
      this.announced = false;
      this.later();
    };
  },

  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), this.retry);
    this.retry = Math.min(this.retry * 2, 30000);
  },

  stop() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  },

  async handle(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "welcome") {
      this.retry = 2000;
      this.announced = true;
      return ui.notifications.info(`${MOD}: connected to the bridge`);
    }
    if (msg.id === undefined) return;
    const fn = OPS[msg.op];
    let reply;
    try {
      if (!fn) throw new Error(`unknown op: ${msg.op}`);
      reply = { id: msg.id, ok: true, result: await fn(msg.args ?? {}) };
    } catch (e) {
      console.error(`${MOD} | ${msg.op}`, e);
      reply = { id: msg.id, ok: false, error: e?.message ?? String(e) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  },
};

Hooks.once("init", () => {
  const restart = () => game.ready && Bridge.start();
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
  game.settings.register(MOD, "roots", {
    name: "Folders scripts may upload into", hint: "Comma-separated top-level folders of Data/.",
    scope: "world", config: true, type: String, default: "rpg-maps, bridge",
  });
});

Hooks.once("ready", () => Bridge.start());
