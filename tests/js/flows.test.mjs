// Editor flows (load, autosave, conflicts, polling, retries, dictionary switching) driven through the real
// static/*.js modules with a fake DOM, fake timers and an in-memory API server that mirrors the real contract.
import assert from "node:assert/strict";

/* ---------- fake DOM ---------- */
class El {
  constructor() {
    this.children = []; this.listeners = {}; this.value = ""; this.textContent = "";
    this.hidden = false; this.disabled = false; this.className = ""; this.attrs = {};
    const set = new Set(); this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  }
  get options() { return this.children; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  appendChild(c) { if (c.isFragment) { this.children.push(...c.children); c.children = []; } else this.children.push(c); return c; }
  append(...cs) { this.children.push(...cs); }
  replaceChildren(...cs) { this.children = [...cs]; }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {} select() {} click() {}
}
const els = new Map();
globalThis.document = {
  title: "", hidden: false,
  getElementById(id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); },
  createElement() { return new El(); }, createDocumentFragment() { const f = new El(); f.isFragment = true; return f; },
  addEventListener() {},
};
const $ = (id) => document.getElementById(id);
$("type").value = "string";
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
globalThis.history = { replaceState() {} };
globalThis.window = { addEventListener() {}, location: { href: "http://localhost/" } };

/* ---------- fake timers (manual) ---------- */
let timers = [], intervals = [], nextId = 1;
globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
globalThis.setInterval = (fn) => { intervals.push(fn); return nextId++; };
const fireTimers = async () => { const due = timers; timers = []; for (const t of due) await t.fn(); };
const fireNoWait = () => { const due = timers; timers = []; due.forEach((t) => t.fn()); };
const tick = () => new Promise((r) => setImmediate(r));
const poll = () => intervals[0]();

/* ---------- fake server (mirrors the real API contract) ---------- */
const server = { docs: {}, log: [], intercept: null };
const clone = (x) => JSON.parse(JSON.stringify(x));
const reply = (status, body) => ({ ok: status < 400, status, json: async () => clone(body) });
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  server.log.push(`${method} ${url}`);
  if (server.intercept) { const r = await server.intercept(method, url, body); if (r) return reply(r.status, r.body); }
  let m;
  if (method === "GET" && url === "/api/dictionaries")
    return reply(200, { dictionaries: Object.values(server.docs).map((d) => ({ id: d.id, name: d.name, count: d.entries.length, revision: d.revision })) });
  if ((m = url.match(/^\/api\/dictionaries\/([^/]+)\/revision$/)) && server.docs[m[1]]) return reply(200, { revision: server.docs[m[1]].revision });
  if ((m = url.match(/^\/api\/dictionaries\/([^/]+)$/)) && server.docs[m[1]]) {
    const d = server.docs[m[1]];
    if (method === "GET") return reply(200, d);
    if (method === "PUT") {
      if (body.revision !== d.revision) return reply(409, { detail: { message: "The dictionary changed since it was loaded.", current: { revision: d.revision } } });
      d.entries = body.entries; d.revision += 1; d.savedAt = "2026-11-05T10:00:00+00:00";
      return reply(200, { count: d.entries.length, savedAt: d.savedAt, revision: d.revision });
    }
  }
  return reply(404, { detail: "Dictionary not found." });
};
const E = (key, value) => ({ key, type: "string", value });
const otherUserSaves = (id, entries) => { const d = server.docs[id]; d.entries = entries; d.revision += 1; };
const keysOf = (id) => server.docs[id].entries.map((e) => e.key);
const count = () => $("count").textContent;
const addWord = (key, value) => { $("key").value = key; $("value").value = value; $("add").listeners.click[0](); };
const release = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };

/* ---------- boot ---------- */
server.docs.a = { id: "a", name: "Alpha", revision: 1, entries: [E("ਘਰ", "ghar"), E("ਦਿਲ", "dil")] };
server.docs.b = { id: "b", name: "Beta", revision: 1, entries: [E("ਬੀ", "bee")] };

const { initDictionary, openDictionary, flushDictionary } = await import(new URL("../../static/dictionary.js", import.meta.url).href);
const { initDictionaries } = await import(new URL("../../static/dictionaries.js", import.meta.url).href);
initDictionary();
await initDictionaries({ flush: flushDictionary, open: openDictionary });
assert.equal(count(), "2"); assert.equal($("dict-rows").children.length, 2);
assert.match($("save-status").textContent, /Loaded 2 saved words/);
console.log("ok 1  boot loads the first dictionary");

/* ---------- add, duplicate checks, autosave ---------- */
addWord("ਨਵਾਂ", "nava");
assert.equal(count(), "3");
addWord("ਨਵਾਂ", "other");
assert.match($("form-msg").textContent, /already in the dictionary/);
addWord("ਹੋਰ", "nava");
assert.match($("form-msg").textContent, /already used by/);
assert.equal(count(), "3");
await fireTimers(); await tick();
assert.deepEqual(keysOf("a"), ["ਘਰ", "ਦਿਲ", "ਨਵਾਂ"]);
assert.match($("save-status").textContent, /Saved 3 words/);
console.log("ok 2  add + duplicate key/value blocked + autosave");

/* ---------- background sync: cheap when idle, merges when changed ---------- */
server.log.length = 0;
await poll(); await tick();
assert.deepEqual(server.log, ["GET /api/dictionaries/a/revision"], "idle poll must only ask for the revision");
otherUserSaves("a", [...server.docs.a.entries, E("ਚਾਰ", "char")]);
server.log.length = 0;
await poll(); await tick();
assert.deepEqual(server.log, ["GET /api/dictionaries/a/revision", "GET /api/dictionaries/a"]);
assert.equal(count(), "4");
console.log("ok 3  idle poll = 1 tiny request; a change downloads once");

/* ---------- conflict: someone saved while we had unsaved edits ---------- */
addWord("ਪੰਜ", "panj");
otherUserSaves("a", [...server.docs.a.entries, E("ਛੇ", "chhe")]);
await fireTimers(); await tick();
for (const k of ["ਪੰਜ", "ਛੇ", "ਘਰ"]) assert.ok(keysOf("a").includes(k), `${k} survives the merge`);
assert.equal(count(), String(server.docs.a.entries.length));
assert.match($("save-status").textContent, /Saved/);
console.log("ok 4  409 conflict: both users' words end up saved");

/* ---------- edits made while a save is in flight are not lost ---------- */
const hold = release();
server.intercept = async (m) => (m === "PUT" ? (await hold.p, undefined) : undefined);
addWord("ਸੱਤ", "satt");
fireNoWait(); await tick();                  // PUT now in flight (parked)
addWord("ਅੱਠ", "atth");                      // edited during the save
hold.go(); await tick(); await tick();
server.intercept = null;
assert.ok(keysOf("a").includes("ਸੱਤ") && !keysOf("a").includes("ਅੱਠ"), "first PUT carries only what was sent");
await fireTimers(); await tick();
assert.ok(keysOf("a").includes("ਅੱਠ"), "the in-flight edit is saved by the follow-up save");
console.log("ok 5  edit during an in-flight save is saved afterwards");

/* ---------- transient save failure retries by itself ---------- */
let failures = 1;
server.intercept = async (m) => (m === "PUT" && failures-- > 0 ? { status: 503, body: { detail: "Storage is temporarily unavailable. Please try again." } } : undefined);
addWord("ਨੌਂ", "nau");
await fireTimers(); await tick();
assert.match($("save-status").textContent, /Could not save: Storage is temporarily unavailable.*Retrying/);
assert.ok(!keysOf("a").includes("ਨੌਂ"));
await fireTimers(); await tick();            // the scheduled retry
assert.ok(keysOf("a").includes("ਨੌਂ")); assert.match($("save-status").textContent, /Saved/);
server.intercept = null;
console.log("ok 6  503 -> automatic retry -> saved");

/* ---------- a non-retryable error does not loop ---------- */
server.intercept = async (m) => (m === "PUT" ? { status: 422, body: { detail: [{ msg: "Value error, bad entry" }] } } : undefined);
addWord("ਦਸ", "das");
await fireTimers(); await tick();
assert.match($("save-status").textContent, /Could not save: Value error, bad entry.*still in this tab/);
assert.equal(timers.length, 0, "no retry timer for a 422");
server.intercept = null;
await flushDictionary();                      // user-triggered flush saves it once the server is happy
assert.ok(keysOf("a").includes("ਦਸ"));
console.log("ok 7  422 shown readably, no retry loop; flush still saves");

/* ---------- RACE: a slow poll for dictionary A must not overwrite dictionary B ---------- */
otherUserSaves("a", [...server.docs.a.entries, E("ਗਿਆਰਾਂ", "gyaran")]);
const slow = release();
server.intercept = async (m, u) => (m === "GET" && u === "/api/dictionaries/a" ? (await slow.p, undefined) : undefined);
const pending = poll(); await tick(); await tick();    // revision seen, full GET of A is parked
const select = $("dict-select"); select.value = "b";
await select.listeners.change[0]({ target: select });  // user switches to B
assert.equal(count(), "1"); assert.equal($("dict-rows").children.length, 1);
slow.go(); await pending; await tick();                // A's response finally arrives
server.intercept = null;
assert.equal(count(), "1", "B must still show B's entries");
assert.equal($("dict-rows").children.length, 1);
await fireTimers(); await tick();
assert.deepEqual(keysOf("b"), ["ਬੀ"], "B must not have been overwritten by A's data");
console.log("ok 8  stale poll for the old dictionary is ignored after switching");

/* ---------- switching away saves pending edits first ---------- */
addWord("ਬੀਜ", "beej");
select.value = "a";
await select.listeners.change[0]({ target: select });
assert.ok(keysOf("b").includes("ਬੀਜ"), "edit to B was flushed before switching");
assert.equal($("dict-select").value, "a");
console.log("ok 9  switching dictionaries flushes unsaved edits");

console.log("\nALL FRONT-END FLOW CHECKS PASSED");
