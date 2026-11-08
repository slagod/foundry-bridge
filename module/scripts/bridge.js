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

// A document of an allowed type by world id, bridge key, or uuid (world only: compendium documents are read-only).
async function docFor(type, ref) {
  if (!ref) throw new Error(`${type}: no id`);
  const coll = collectionFor(type);
  let d = coll.get?.(ref) ?? coll.find(x => x.id === ref) ?? byKey(type, ref)[0];
  if (!d && String(ref).includes(".")) {
    const u = await fromUuid(ref);
    if (u?.pack) throw new Error(`${ref} is in a compendium — packs.import it first`);
    if (u?.documentName === type) d = u;
  }
  if (!d) throw new Error(`${type} not found: ${ref}`);
  return d;
}

async function sceneFor(ref) {
  if (ref === "active") return game.scenes.active ?? (() => { throw new Error("no active scene"); })();
  if (ref === "viewed" || !ref) return game.scenes.viewed ?? (() => { throw new Error("no viewed scene"); })();
  return docFor("Scene", ref);
}

// An actor by id / key / uuid; a token's uuid gives that token's actor (unlinked enemies have their own).
async function actorFor(ref) {
  if (String(ref ?? "").includes(".")) {
    const u = await fromUuid(ref);
    if (u?.pack) throw new Error(`${ref} is in a compendium — packs.import it first`);
    if (u?.documentName === "Token") { if (!u.actor) throw new Error(`token without an actor: ${ref}`); return u.actor; }
    if (u?.documentName === "Actor") return u;
  }
  return docFor("Actor", ref);
}

// A world actor for a token: world refs as they are; a compendium actor is imported once (and reused after).
async function tokenActor(ref) {
  if (String(ref ?? "").startsWith("Compendium.")) {
    const have = game.actors.find(a => (a._stats?.compendiumSource ?? a.flags?.core?.sourceId) === ref);
    if (have) return have;
    const src = await fromUuid(ref);
    if (src?.documentName !== "Actor") throw new Error(`not an actor: ${ref}`);
    return game.actors.importFromCompendium(game.packs.get(src.pack), src.id, { folder: await folderId("Actor", "bridge") });
  }
  return actorFor(ref);
}

// x, y: px from the map's top-left corner, or grid cells with grid: true. Foundry counts from the padded canvas.
function place(sc, t) {
  const out = { ...t };
  delete out.grid; delete out.actor;
  if (t.x === undefined && t.y === undefined) return out;
  const d = sc.dimensions, g = t.grid ? (sc.grid?.size ?? d.size) : 1;
  if (t.x !== undefined) out.x = d.sceneX + t.x * g;
  if (t.y !== undefined) out.y = d.sceneY + t.y * g;
  return out;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Chat text from scripts is text, never HTML: Foundry renders message HTML in every player's browser.
function textHtml(t) {
  return String(t).trim().split(/\n\s*\n/).map(par => "<p>" + esc(par)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>") + "</p>").join("");
}

function userIds(who) {
  if (who === "gm") return game.users.filter(u => u.isGM).map(u => u.id);
  return [].concat(who).map(w => (game.users.get(w) ?? game.users.getName?.(w) ?? game.users.find(u => u.name === w)
    ?? (() => { throw new Error(`no user: ${w}`); })()).id);
}

const brief = d => ({ id: d.id, uuid: d.uuid, name: d.name });

function combatData(c) {
  return {
    id: c.id, scene: c.scene?.id ?? null, round: c.round, turn: c.turn, started: !!c.started,
    current: c.combatant ? { id: c.combatant.id, name: c.combatant.name, tokenId: c.combatant.tokenId, actorId: c.combatant.actorId } : null,
    order: (c.turns ?? []).map(t => ({ id: t.id, name: t.name, tokenId: t.tokenId, actorId: t.actorId,
      initiative: t.initiative ?? null, defeated: !!t.isDefeated, hidden: !!t.hidden })),
  };
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

  // Fields of an existing world Actor or Item (also ones the bridge did not create). Embedded documents
  // (an actor's items, effects) go through actors.items.*: sending them here would replace the whole list.
  async "documents.update"({ type, id, data }) {
    if (!["Actor", "Item"].includes(type)) throw new Error(`documents.update: Actor or Item, not ${type}`);
    const doc = await docFor(type, id);
    const embedded = Object.values(doc.constructor.metadata?.embedded ?? {});
    const bad = Object.keys(data ?? {}).filter(k => embedded.includes(k) || k === "_id");
    if (bad.length) throw new Error(`documents.update: ${bad.join(", ")} can't be set here (items: actors.items.*)`);
    if (!Object.keys(data ?? {}).length) throw new Error("documents.update: nothing to set");
    await doc.update(data);
    return brief(doc);
  },

  // Items for an actor: item data, or the uuid of an item in a compendium or the world (copied).
  async "actors.items.add"({ actor, items }) {
    const a = await actorFor(actor);
    const datas = [];
    for (const it of items ?? []) {
      if (typeof it !== "string") { datas.push(it); continue; }
      const src = await fromUuid(it);
      if (src?.documentName !== "Item") throw new Error(`not an item: ${it}`);
      const o = src.toObject();
      delete o._id;
      if (src.pack) o._stats = { ...(o._stats ?? {}), compendiumSource: src.uuid };
      datas.push(o);
    }
    if (!datas.length) throw new Error("actors.items.add: no items");
    return (await a.createEmbeddedDocuments("Item", datas)).map(brief);
  },

  async "actors.items.update"({ actor, items }) {
    const a = await actorFor(actor);
    if (!items?.length || items.some(i => !i._id)) throw new Error("actors.items.update: items with _id");
    return (await a.updateEmbeddedDocuments("Item", items)).map(i => i.id);
  },

  async "actors.items.remove"({ actor, ids }) {
    const a = await actorFor(actor);
    const have = (ids ?? []).filter(id => a.items.get(id));
    if (have.length) await a.deleteEmbeddedDocuments("Item", have);
    return have.length;
  },

  async "packs.import"({ pack, ids, folder }) {
    const p = packFor(pack);
    const coll = collectionFor(p.documentName);
    const update = folder ? { folder: await folderId(p.documentName, folder) } : {};
    const out = [];
    for (const id of ids ?? []) {
      const d = await coll.importFromCompendium(p, id, update);
      out.push({ ...brief(d), source: `Compendium.${p.collection}.${p.documentName}.${id}` });
    }
    return out;
  },

  // Whispered to the GM by default, with a button that shows the message to everyone.
  async "chat.post"({ text, whisper = "gm", speaker, flavor, share = true }) {
    if (!String(text ?? "").trim()) throw new Error("chat.post: no text");
    const data = { content: textHtml(text), flags: { [MOD]: { share: !!(share && whisper) } } };
    if (flavor) data.flavor = esc(flavor);
    if (whisper) data.whisper = userIds(whisper);
    if (speaker) {
      const a = await actorFor(speaker).catch(() => null);
      data.speaker = a ? ChatMessage.getSpeaker({ actor: a }) : { alias: String(speaker) };
    }
    const m = await ChatMessage.create(data);
    return { id: m.id };
  },

  async "tokens.create"({ scene, tokens }) {
    const sc = await sceneFor(scene);
    const datas = [];
    for (const t of tokens ?? []) {
      const actor = await tokenActor(t.actor);
      const td = await actor.getTokenDocument(place(sc, t));
      datas.push(td.toObject());
    }
    if (!datas.length) throw new Error("tokens.create: no tokens");
    return (await sc.createEmbeddedDocuments("Token", datas)).map(t => ({ ...brief(t), actorId: t.actorId }));
  },

  async "tokens.update"({ scene, tokens }) {
    const sc = await sceneFor(scene);
    if (!tokens?.length || tokens.some(t => !t._id)) throw new Error("tokens.update: tokens with _id");
    return (await sc.updateEmbeddedDocuments("Token", tokens.map(t => place(sc, t)))).map(t => t.id);
  },

  async "tokens.delete"({ scene, ids }) {
    const sc = await sceneFor(scene);
    const have = (ids ?? []).filter(id => sc.tokens.get(id));
    if (have.length) await sc.deleteEmbeddedDocuments("Token", have);
    return have.length;
  },

  async "scenes.activate"({ scene }) {
    const sc = await sceneFor(scene);
    await sc.activate();
    return brief(sc);
  },

  async "scenes.view"({ scene }) {
    const sc = await sceneFor(scene);
    await sc.view();
    return brief(sc);
  },

  async "combat.start"({ scene, tokens, roll }) {
    const sc = await sceneFor(scene);
    const toks = tokens?.length ? tokens.map(id => sc.tokens.get(id) ?? (() => { throw new Error(`no token ${id} on ${sc.name}`); })())
      : [...sc.tokens];
    let c = game.combats.find(x => x.scene?.id === sc.id);
    if (!c) c = await CONFIG.Combat.documentClass.create({ scene: sc.id, active: true });
    const have = new Set(c.combatants.map(x => x.tokenId));
    const add = toks.filter(t => !have.has(t.id)).map(t => ({ tokenId: t.id, sceneId: sc.id, actorId: t.actorId, hidden: t.hidden }));
    if (add.length) await c.createEmbeddedDocuments("Combatant", add);
    if (roll === "npc") await c.rollNPC();
    else if (roll === "all") await c.rollAll();
    if (!c.started) await c.startCombat();
    return combatData(c);
  },

  // Ends without Foundry's confirmation dialog: the script asked for it.
  async "combat.end"({ scene }) {
    const sc = scene ? await sceneFor(scene) : null;
    const cs = game.combats.filter(c => sc ? c.scene?.id === sc.id : c.active);
    for (const c of cs) await c.delete();
    return cs.length;
  },

  async show({ img, journal, page, title, users }) {
    // Foundry sends "show players" to the other clients only; the GM gets the same popout here.
    if (img) {
      const image = servedPath(img), V13 = foundry.applications?.apps?.ImagePopout;
      const pop = V13 ? new V13({ src: image, window: { title: title ?? "" } }) : new ImagePopout(image, { title: title ?? "" });
      pop.render(true);
      await pop.shareImage();
      return { shown: "image", image };
    }
    if (!journal) throw new Error("show: img or journal");
    const j = await docFor("JournalEntry", journal);
    const target = page ? (j.pages.get(page) ?? j.pages.getName?.(page) ?? j.pages.find(p => p.name === page)
      ?? (() => { throw new Error(`no page ${page} in ${j.name}`); })()) : j;
    const J = foundry.documents?.collections?.Journal ?? globalThis.Journal;
    await J.show(target, { force: true, ...(users?.length ? { users: userIds(users) } : {}) });
    (target.parent ?? target).sheet?.render(true);
    return { shown: "journal", ...brief(target) };
  },

  async "ui.open"({ type, id }) {
    if (type === "Scene") { const sc = await sceneFor(id); await sc.view(); return brief(sc); }
    const d = await docFor(type, id);
    d.sheet.render(true);
    return brief(d);
  },

  async "world.state"() {
    const sc = game.scenes.active, vw = game.scenes.viewed, tok = t => ({ id: t.id, name: t.name, actorId: t.document?.actorId ?? t.actorId });
    return {
      active: sc ? brief(sc) : null, viewed: vw ? brief(vw) : null,
      combat: game.combat ? combatData(game.combat) : null,
      users: game.users.map(u => ({ id: u.id, name: u.name, active: u.active, isGM: u.isGM, character: u.character?.id ?? null })),
      controlled: (globalThis.canvas?.tokens?.controlled ?? []).map(tok),
      targets: [...(game.user.targets ?? [])].map(tok),
      playing: (game.playlists?.playing ?? []).map(brief),
    };
  },

  async "playlists.play"({ playlist, sound }) {
    const pl = await docFor("Playlist", playlist);
    if (sound) {
      const s = pl.sounds.get(sound) ?? pl.sounds.getName?.(sound) ?? pl.sounds.find(x => x.name === sound);
      if (!s) throw new Error(`no sound ${sound} in ${pl.name}`);
      await pl.playSound(s);
    } else await pl.playAll();
    return brief(pl);
  },

  async "playlists.stop"({ playlist }) {
    const pls = playlist ? [await docFor("Playlist", playlist)] : [...(game.playlists?.playing ?? [])];
    for (const pl of pls) await pl.stopAll();
    return pls.length;
  },
};

// --- events: what happens at the table, to the bridge (opt-in, GM's client only) ------------

function chatData(m) {
  const o = m.toObject();
  return {
    id: m.id, author: o.author ?? o.user ?? null, speaker: o.speaker, content: o.content, flavor: o.flavor ?? "",
    type: o.type ?? null, system: o.system ?? {},          // typed messages (wfrp4e 9: tests, opposed results) keep their data here
    whisper: o.whisper ?? [], blind: !!o.blind, flags: o.flags ?? {}, bridge: !!o.flags?.[MOD],
    rolls: (m.rolls ?? []).map(r => ({ formula: r.formula, total: r.total,
      dice: (r.dice ?? []).map(d => ({ faces: d.faces, results: d.results.map(x => x.result) })) })),
  };
}

const Events = {
  send(kind, data) {
    const ws = Bridge.ws;
    if (!Bridge.ready || ws?.readyState !== WebSocket.OPEN || !game.settings.get(MOD, "events")) return;
    try {
      ws.send(JSON.stringify({ type: "event", event: { kind, at: Date.now(), scene: game.scenes?.viewed?.id ?? null, ...data } }));
    } catch (e) { console.warn(`${MOD} | event ${kind}`, e); }
  },
  hook() {
    const ev = (name, fn) => Hooks.on(name, (...a) => { try { fn(...a); } catch (e) { console.warn(`${MOD} | ${name}`, e); } });
    ev("createChatMessage", m => this.send("chat", chatData(m)));
    ev("updateChatMessage", m => this.send("chat.update", chatData(m)));          // opposed tests finish later
    ev("combatStart", c => this.send("combat", combatData(c)));
    ev("updateCombat", (c, ch) => { if ("turn" in ch || "round" in ch) this.send("combat", combatData(c)); });
    ev("deleteCombat", c => this.send("combat.end", { id: c.id }));
    ev("canvasReady", cv => cv.scene && this.send("scene", brief(cv.scene)));
    ev("targetToken", (u, t, on) => this.send("target", { user: u.id, token: t.id, actor: t.document.actorId, name: t.name, targeted: on }));
    ev("controlToken", (t, on) => this.send("control", { token: t.id, actor: t.document.actorId, name: t.name, controlled: on }));
    ev("updateActor", (a, ch) => this.send("actor", { id: a.id, name: a.name, token: a.token?.id ?? null, changes: ch }));
    ev("updateToken", (t, ch) => {                                                 // unlinked actors change through their token
      if ("delta" in ch || "actorData" in ch || "hidden" in ch) this.send("token", { id: t.id, name: t.name, actor: t.actorId, changes: ch });
    });
    ev("createItem", i => i.parent?.documentName === "Actor" && this.send("item.create", { actor: i.parent.id, ...brief(i), type: i.type }));
    ev("deleteItem", i => i.parent?.documentName === "Actor" && this.send("item.delete", { actor: i.parent.id, ...brief(i), type: i.type }));
  },
};

// "Show everyone" on a message a script whispered to the GM.
function shareButton(message, html) {
  if (!game.user.isGM || !message.getFlag(MOD, "share") || !message.whisper?.length) return;
  const el = html instanceof HTMLElement ? html : html?.[0];
  if (!el || el.querySelector(".foundry-bridge-share")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "foundry-bridge-share";
  b.textContent = game.i18n?.lang === "pl" ? "Pokaż wszystkim" : "Show everyone";
  b.addEventListener("click", async () => {
    await ChatMessage.create({ content: message.content, flavor: message.flavor, speaker: message.speaker, flags: { [MOD]: { shared: message.id } } });
    await message.setFlag(MOD, "share", false);
  });
  (el.querySelector(".message-content") ?? el).append(b);
}

// --- connection ----------------------------------------------------------------------------

function info() {
  return {
    world: game.world.id, title: game.world.title,
    system: game.system.id, systemVersion: game.system.version,
    foundry: game.version, user: game.user.name, isGM: game.user.isGM,
  };
}

const Bridge = {
  ws: null, retry: 2000, timer: null, announced: false, ready: false,

  start() {
    this.stop();
    if (!game.user.isGM || !game.settings.get(MOD, "enabled")) return;
    const url = game.settings.get(MOD, "url"), key = game.settings.get(MOD, "key");
    if (!key) return ui.notifications.warn(`${MOD}: no key set — run \`foundry-bridge key --copy\` and paste it in the module settings`);
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return this.later(); }
    this.ws = ws;
    this.ready = false;
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
      this.ready = true;
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
  game.settings.register(MOD, "events", {
    name: "Send table events to the bridge",
    hint: "Chat messages with rolls, combat turns, scene changes, targets and actor changes go to local scripts (e.g. descriptions of hits). This browser only.",
    scope: "client", config: true, type: Boolean, default: false,
  });
  game.settings.register(MOD, "roots", {
    name: "Folders scripts may upload into", hint: "Comma-separated top-level folders of Data/.",
    scope: "world", config: true, type: String, default: "rpg-maps, bridge",
  });
});

Hooks.once("ready", () => { Events.hook(); Bridge.start(); });
Hooks.on("renderChatMessageHTML", shareButton);                                  // v13
Hooks.on("renderChatMessage", (m, html) => { if ((game.release?.generation ?? 12) < 13) shareButton(m, html); });   // v12
