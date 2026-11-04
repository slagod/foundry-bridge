// Runs the real module/scripts/bridge.js against a minimal fake of the Foundry client API.
//   FOUNDRY_BRIDGE_KEY=… node tests/fake-foundry.mjs [ws://127.0.0.1:8765/ws]
// Prints the fake world's state on SIGINT/SIGTERM. Only what bridge.js touches is faked.
const URL_ = process.argv[2] ?? "ws://127.0.0.1:8765/ws";
const hooks = {};
const settings = new Map([
  ["foundry-bridge.enabled", true], ["foundry-bridge.url", URL_],
  ["foundry-bridge.key", process.env.FOUNDRY_BRIDGE_KEY], ["foundry-bridge.roots", "rpg-maps, bridge"],
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

const EMBEDDED = {
  Scene: { Wall: "walls", AmbientLight: "lights", Token: "tokens" },
  JournalEntry: { JournalEntryPage: "pages" }, Actor: { Item: "items", ActiveEffect: "effects" },
  Item: { ActiveEffect: "effects" }, RollTable: { TableResult: "results" }, Playlist: { PlaylistSound: "sounds" },
  Cards: { Card: "cards" },
};
const collections = new Map();

function docClass(type) {
  return class Doc {
    static metadata = { embedded: EMBEDDED[type] ?? {} };
    static async create(data) {
      const d = new Doc(structuredClone(data));
      collections.get(type).push(d);
      return d;
    }
    constructor(data) {
      Object.assign(this, data);
      this._id = id();
      for (const f of Object.values(Doc.metadata.embedded)) this[f] = (this[f] ?? []).map(e => ({ ...e, id: id() }));
    }
    get id() { return this._id; }
    get uuid() { return `${type}.${this._id}`; }
    getFlag(scope, k) { return this.flags?.[scope]?.[k]; }
    async update(data) { merge(this, structuredClone(data)); return this; }
    async delete() { const c = collections.get(type); c.splice(c.indexOf(this), 1); }
    getEmbeddedCollection(name) { return this[Doc.metadata.embedded[name]]; }
    async deleteEmbeddedDocuments(name, ids) { const f = Doc.metadata.embedded[name]; this[f] = this[f].filter(e => !ids.includes(e.id)); }
    async createEmbeddedDocuments(name, items) { const f = Doc.metadata.embedded[name]; this[f].push(...items.map(e => ({ ...e, id: id() }))); }
    async createThumbnail() { return { thumb: "data:image/webp;base64,AA==" }; }
  };
}

globalThis.CONFIG = {};
for (const t of [...Object.keys(EMBEDDED), "Folder", "Macro"]) {
  CONFIG[t] = { documentClass: docClass(t) };
  collections.set(t, []);
}
const coll = t => Object.assign(collections.get(t), {});
globalThis.Folder = CONFIG.Folder.documentClass;
globalThis.game = {
  ready: true, version: "13.351", world: { id: "fake", title: "Fake World" }, system: { id: "wfrp4e", version: "9.0.0" },
  user: { name: "Gamemaster", isGM: true },
  settings: { register() {}, get: (m, k) => settings.get(`${m}.${k}`) },
  collections: { get: t => coll(t) },
  get folders() { return coll("Folder"); },
};
globalThis.foundry = { utils: { deepClone: structuredClone, mergeObject: (a, b) => merge(a, b) } };
globalThis.ui = { notifications: Object.fromEntries(["info", "warn", "error"].map(l => [l, m => console.log(`[ui.${l}] ${m}`)])) };
globalThis.Hooks = { once: (h, fn) => (hooks[h] = fn) };
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
