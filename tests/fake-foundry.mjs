// Runs the real module/scripts/bridge.js against a minimal fake of the Foundry client API.
//   FOUNDRY_BRIDGE_KEY=… node tests/fake-foundry.mjs [ws://127.0.0.1:8765/ws]
// Prints the fake world's state on SIGINT/SIGTERM. Only what bridge.js touches is faked.
const URL_ = process.argv[2] ?? "ws://127.0.0.1:8765/ws";
const hooks = {};
const settings = new Map([
  ["foundry-bridge.enabled", true], ["foundry-bridge.url", URL_],
  ["foundry-bridge.key", process.env.FOUNDRY_BRIDGE_KEY], ["foundry-bridge.roots", "rpg-maps, bridge"],
  ["foundry-bridge.events", true],
]);
const files = new Map();                 // path -> bytes
const dirs = new Set([""]);
let nextId = 1;
const id = () => `id${nextId++}`;
const merge = (a, b) => {
  for (const [k, v] of Object.entries(b)) {
    a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
  }
  return a;
};

// Arrays standing in for Foundry's collections (get by id, getName).
const withGet = arr => Object.defineProperties(arr, {          // not enumerable: toObject() clones these arrays
  get: { value: k => arr.find(d => d.id === k) }, getName: { value: n => arr.find(d => d.name === n) },
  size: { get: () => arr.length }, importFromCompendium: { writable: true, value: undefined },
  active: { writable: true, value: undefined }, viewed: { writable: true, value: undefined },
});
const callAll = (h, ...a) => (hookOn[h] ?? []).forEach(fn => fn(...a));
const hookOn = {};

const EMBEDDED = {
  Scene: { Wall: "walls", AmbientLight: "lights", Token: "tokens" },
  JournalEntry: { JournalEntryPage: "pages" }, Actor: { Item: "items", ActiveEffect: "effects" },
  Item: { ActiveEffect: "effects" }, RollTable: { TableResult: "results" }, Playlist: { PlaylistSound: "sounds" },
  Cards: { Card: "cards" }, Combat: { Combatant: "combatants" },
};
const collections = new Map();

function docClass(type) {
  return class Doc {
    static metadata = { embedded: EMBEDDED[type] ?? {} };
    static async create(data) {
      const d = new Doc(structuredClone(data));
      collections.get(type).push(d);
      callAll(`create${type}`, d);
      return d;
    }
    constructor(data) {
      Object.assign(this, data);
      this._id = id();
      this.documentName = type;
      for (const f of Object.values(Doc.metadata.embedded)) this[f] = withGet((this[f] ?? []).map(e => this._embed(f, e)));
    }
    _embed(f, e) {
      const parent = this, sub = { ...e, id: id() };
      Object.defineProperty(sub, "uuid", { get: () => `${parent.uuid}.${f}.${sub.id}`, enumerable: false });
      Object.defineProperty(sub, "parent", { value: parent, enumerable: false });
      if (f === "tokens") Object.defineProperty(sub, "actor", { get: () => coll("Actor").get(sub.actorId), enumerable: false });
      return sub;
    }
    get sheet() { return { render: () => (this._rendered = true) }; }
    get items() { return this._items; }
    set items(v) { this._items = v; }
    get id() { return this._id; }
    get uuid() { return `${type}.${this._id}`; }
    getFlag(scope, k) { return this.flags?.[scope]?.[k]; }
    toObject() {
      const o = structuredClone({ ...this, _items: undefined, _rendered: undefined, documentName: undefined });
      delete o._items; delete o._rendered; delete o.documentName;
      if (this._items) o.items = structuredClone([...this._items]);
      o._id = this._id;
      return o;
    }
    async update(data) { merge(this, structuredClone(data)); return this; }
    async delete() { const c = collections.get(type); c.splice(c.indexOf(this), 1); }
    getEmbeddedCollection(name) { return this[Doc.metadata.embedded[name]]; }
    async deleteEmbeddedDocuments(name, ids) { const f = Doc.metadata.embedded[name]; this[f] = withGet(this[f].filter(e => !ids.includes(e.id))); }
    async createEmbeddedDocuments(name, items) {
      const f = Doc.metadata.embedded[name], made = items.map(e => this._embed(f, e));
      this[f].push(...made);
      return made;
    }
    async updateEmbeddedDocuments(name, items) {
      const f = Doc.metadata.embedded[name];
      return items.map(u => merge(this[f].get(u._id), (({ _id, ...r }) => r)(structuredClone(u))));
    }
    // Actor
    async getTokenDocument(data) { const o = { actorId: this.id, name: this.name, ...data }; return { toObject: () => o }; }
    // Scene
    get dimensions() { return { sceneX: 100, sceneY: 50, size: 100 }; }
    get grid() { return { size: 100 }; }
    async activate() { game.scenes.active = this; }
    async view() { game.scenes.viewed = this; }
    // Combat
    get started() { return (this.round ?? 0) > 0; }
    get scene() { return coll("Scene").get(this._scene ?? this.scene_); }
    async rollNPC() { this.combatants.forEach(c => (c.initiative ??= 10)); }
    async rollAll() { this.combatants.forEach(c => (c.initiative ??= 7)); }
    async startCombat() { this.round = 1; this.turn = 0; callAll("combatStart", this); }
    get turns() { return this.combatants; }
    get combatant() { return this.combatants[this.turn ?? 0]; }
    // Playlist
    async playSound(s) { s.playing = true; this.playing = true; }
    async playAll() { this.playing = true; }
    async stopAll() { this.playing = false; }
    async createThumbnail() { return { thumb: "data:image/webp;base64,AA==" }; }
  };
}

globalThis.CONFIG = {};
for (const t of [...Object.keys(EMBEDDED), "Folder", "Macro", "ChatMessage"]) {
  CONFIG[t] = { documentClass: docClass(t) };
  collections.set(t, withGet([]));
}
const coll = t => {
  const c = collections.get(t);
  c.importFromCompendium ??= async (pack, id_, update = {}) => {
    const src = (await pack.getDocuments()).find(d => d.id === id_);
    return CONFIG[t].documentClass.create({ ...src.toObject(), ...update, _stats: { compendiumSource: src.uuid } });
  };
  return c;
};
// Combat.create({scene}) — keep the scene id where the getter can't shadow it
const RealCombat = CONFIG.Combat.documentClass;
CONFIG.Combat.documentClass = class extends RealCombat {
  static async create(data) { const { scene, ...rest } = data; return RealCombat.create({ ...rest, scene_: scene }); }
};
globalThis.ChatMessage = CONFIG.ChatMessage.documentClass;
ChatMessage.getSpeaker = ({ actor }) => ({ actor: actor.id, alias: actor.name });
ChatMessage.prototype.setFlag = async function (scope, k, v) { merge(this, { flags: { [scope]: { [k]: v } } }); };
const users = withGet([{ id: "gm1", name: "Gamemaster", isGM: true, active: true },
  { id: "u2", name: "Ania", isGM: false, active: true, character: null }]);
const shared = [];
globalThis.Journal = { show: async (doc, opts) => shared.push({ journal: doc.id, opts }) };
globalThis.fromUuid = async uuid => {
  const p = uuid.split(".");
  if (p[0] === "Compendium") {
    const pk = packs.find(x => x.collection === `${p[1]}.${p[2]}`);
    const d = pk && (await pk.getDocuments()).find(x => x.uuid === uuid || x.id === p[4]);
    return d ? Object.assign(d, { pack: pk.collection }) : null;
  }
  const d = coll(p[0])?.get(p[1]);
  if (p.length === 4) return d?.[p[2] === "Token" ? "tokens" : p[2].toLowerCase() + "s"]?.get(p[3]) ?? null;
  return d ?? null;
};
globalThis.Folder = CONFIG.Folder.documentClass;
globalThis.game = {
  ready: true, version: "13.351", world: { id: "fake", title: "Fake World" }, system: { id: "wfrp4e", version: "9.0.0" },
  user: { id: "gm1", name: "Gamemaster", isGM: true, targets: new Set() },
  users,
  socket: { emit: (name, data) => shared.push({ socket: name, ...data }) },
  get actors() { return coll("Actor"); },
  get scenes() { return Object.assign(coll("Scene"), { active: coll("Scene").active, viewed: coll("Scene").viewed }); },
  get combats() { return coll("Combat"); },
  get combat() { return coll("Combat").find(c => c.started) ?? null; },
  get playlists() { return Object.assign(coll("Playlist"), { playing: coll("Playlist").filter(p => p.playing) }); },
  settings: { register() {}, get: (m, k) => settings.get(`${m}.${k}`) },
  collections: { get: t => coll(t) },
  get folders() { return coll("Folder"); },
  get packs() { return Object.assign(packs, { get: id => packs.find(p => p.collection === id) }); },
};
// Files served by the fake server: fetch("/worlds/fake/portrait.webp").
const served = new Map([["/worlds/fake/portrait.webp", new Uint8Array([1, 2, 3])]]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (typeof url === "string" && url.startsWith("/")) {
    const b = served.get(url);
    return new Response(b ?? "", { status: b ? 200 : 404, headers: { "content-type": "image/webp" } });
  }
  return realFetch(url, ...rest);
};
globalThis.foundry = { utils: { deepClone: structuredClone, mergeObject: (a, b) => merge(a, b), getRoute: p => `/${p}` } };

// Two compendiums: an allowed Item pack and a Macro pack the bridge must refuse.
const pack = (collection, documentName, docs) => {
  const Doc = docClass(documentName === "Macro" ? "Macro" : documentName);
  const made = docs.map(d => Object.defineProperty(new Doc(d), "uuid", { value: `Compendium.${collection}.${documentName}.${d.name}` }));
  return {
    collection, documentName, metadata: { label: collection, packageName: collection.split(".")[0] },
    index: { size: made.length },
    async getDocuments(q = {}) { return q._id__in ? made.filter(d => q._id__in.includes(d.id)) : made; },
  };
};
const packs = [
  pack("wfrp4e-core.items", "Item", [{ name: "Dagger", type: "weapon" }, { name: "Sword", type: "weapon" }]),
  pack("macros.m", "Macro", [{ name: "evil" }]),
  pack("wfrp4e-core.bestiary", "Actor", [{ name: "Goblin", type: "npc" }]),
];

globalThis.ui = { notifications: Object.fromEntries(["info", "warn", "error"].map(l => [l, m => console.log(`[ui.${l}] ${m}`)])) };
globalThis.Hooks = { once: (h, fn) => (hooks[h] = fn), on: (h, fn) => (hookOn[h] ??= []).push(fn) };
globalThis.FilePicker = {
  async browse(_src, dir) { return { dirs: [...dirs].filter(d => d && d.split("/").slice(0, -1).join("/") === dir), files: [] }; },
  async createDirectory(_src, dir) { if (dirs.has(dir)) throw new Error("EEXIST"); dirs.add(dir); },
  async upload(_src, dir, file) {
    if (!dirs.has(dir)) return { status: "error", message: `no dir ${dir}` };
    const path = `${dir}/${file.name}`;
    files.set(path, new Uint8Array(await file.arrayBuffer()));
    return { status: "success", path };
  },
};

await import(new URL("../module/scripts/bridge.js", import.meta.url));
hooks.init();
hooks.ready();

const dump = () => {
  const out = { files: Object.fromEntries([...files].map(([p, b]) => [p, b.length])), folders: coll("Folder").map(f => f.name) };
  for (const t of ["Scene", "JournalEntry"]) {
    out[t] = coll(t).map(d => ({ name: d.name, key: d.getFlag("foundry-bridge", "key"), folder: d.folder,
      embedded: Object.fromEntries(Object.values(EMBEDDED[t]).map(f => [f, d[f].length])), journal: d.journal, thumb: !!d.thumb }));
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
};
process.on("SIGINT", dump);
process.on("SIGTERM", dump);
