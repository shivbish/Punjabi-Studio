import { $, toast, ask, api, ApiError, isRetryable, debounce, readFileText, triggerDownload } from "./ui.js";
import { buildFile, KNOWN_EXT } from "./export.js";
import { currentDictionary, currentDictionaryId, dictionaryUrl, noteActiveSave } from "./dictionaries.js";
import {
  TYPES, nk, ck, valueText, parseValue, copyEntries, signaturesOf,
  EntryIndex, createPlanner, mergeEntries,
} from "./logic.js";

/* ================= Dictionary editor ================= */

const AUTOSAVE_MS = 900;
const PAGE_SIZE = 1000;
const POLL_MS = 10_000;
const PREVIEW_LIMIT = 200;      // entries shown in the Export preview
const RETRY_START_MS = 2000;
const RETRY_MAX_MS = 30_000;

let entries = [];
let editing = -1;
let revision = 0;          // local edit counter, bumped by touch()
let savedRevision = 0;     // local edit counter at the last successful save
let serverRevision = 0;    // revision reported by the server
let baseSignatures = new Map();  // entry signatures as last loaded/saved
let saveTimer = null;
let saving = false;
let loading = false;       // a dictionary is being fetched
let polling = false;
let generation = 0;        // bumped whenever another dictionary is opened
let retryDelay = 0;        // current save-retry backoff (0 = none)
let filenameTouched = false;
let pendingFocus = null;
let visibleLimit = PAGE_SIZE;

const index = new EntryIndex();

/* ---------- Key/value helpers ---------- */

function hasKey(key, skip = -1) {
  return index.hasKey(entries, key, skip);
}

function keyWithValue(value, skip = -1) {
  return index.keyWithValue(entries, value, skip);
}

function buildObject(list = entries) {
  return Object.fromEntries(list.map((entry) => [entry.key, entry.value]));
}

function codepoints(value) {
  return Array.from(String(value))
    .map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ");
}

function fileSafe(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "dictionary";
}

/** Block edits while a dictionary is still loading, so they cannot be overwritten. */
function ready() {
  if (!loading) return true;
  toast("The dictionary is still loading — try again in a moment.", "error");
  return false;
}

export function isDictionaryLoading() {
  return loading;
}

/* ---------- Messages ---------- */

function say(message, kind = "") {
  const el = $("form-msg");
  el.textContent = message;
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function setSaveStatus(message, kind = "") {
  const el = $("save-status");
  el.textContent = message;
  el.className = "save-status" + (kind ? ` ${kind}` : "");
}

/* ---------- Rendering ---------- */

function render() {
  renderRows();
  renderPreview();
  updateCounts();
}

function updateCounts() {
  const text = entries.length.toLocaleString();
  $("count").textContent = text;
  $("dict-badge").textContent = text;
}

// Stringifying a 100k-entry dictionary on every keystroke froze the page, so
// the preview shows the first entries only. Copy and Download use everything.
function renderPreview() {
  const shown = entries.length > PREVIEW_LIMIT ? entries.slice(0, PREVIEW_LIMIT) : entries;
  $("preview").textContent = JSON.stringify(buildObject(shown), null, 2);

  const note = $("preview-note");
  if (entries.length > PREVIEW_LIMIT) {
    note.hidden = false;
    note.textContent =
      `Preview shows the first ${PREVIEW_LIMIT.toLocaleString()} of ${entries.length.toLocaleString()} entries. ` +
      "Copy and Download include all of them.";
  } else {
    note.hidden = true;
  }
}

function smallButton(label, onClick, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn" + (primary ? " primary" : "");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderRows() {
  const table = $("dict-rows");
  const query = $("q").value.trim().toLowerCase();
  table.replaceChildren();
  $("q").disabled = editing !== -1;

  let matches = 0;
  let shown = 0;
  const fragment = document.createDocumentFragment();

  entries.forEach((entry, position) => {
    if (position !== editing && query) {
      const haystack = `${entry.key} ${valueText(entry)} ${entry.type}`.toLowerCase();
      if (!haystack.includes(query)) return;
    }
    matches++;
    if (shown >= visibleLimit) return;

    const row = document.createElement("tr");
    const number = document.createElement("td");
    number.className = "num";
    number.textContent = position + 1;
    const keyCell = document.createElement("td");
    const valueCell = document.createElement("td");
    const typeCell = document.createElement("td");
    typeCell.className = "type-col";
    const actionCell = document.createElement("td");
    actionCell.className = "act";

    if (position === editing) {
      const keyInput = document.createElement("input");
      keyInput.value = entry.key;
      keyInput.setAttribute("aria-label", "Key");

      const valueInput = document.createElement("input");
      valueInput.value = entry.type === "null" ? "" : entry.type === "json" ? JSON.stringify(entry.value) : String(entry.value);
      valueInput.setAttribute("aria-label", "Value");

      const typeSelect = document.createElement("select");
      typeSelect.setAttribute("aria-label", "Type");
      for (const type of TYPES) {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = type;
        option.selected = type === entry.type;
        typeSelect.appendChild(option);
      }

      const save = () => {
        const key = nk(keyInput.value);
        if (!key) {
          say("Key cannot be empty.", "error");
          keyInput.focus();
          return;
        }
        if (hasKey(key, position)) {
          say(`"${key}" is already in the dictionary.`, "error");
          keyInput.focus();
          return;
        }
        let value;
        try {
          value = parseValue(typeSelect.value, valueInput.value);
        } catch (error) {
          say(error.message, "error");
          valueInput.focus();
          return;
        }
        const clash = keyWithValue(value, position);
        if (clash !== null) {
          say(`That Roman word is already used by "${clash}".`, "error");
          valueInput.focus();
          return;
        }
        entries[position] = { key, type: typeSelect.value, value };
        index.invalidate();
        editing = -1;
        say(`Updated "${key}".`, "ok");
        render();
        touch();
      };

      const cancel = () => {
        editing = -1;
        say("");
        render();
      };

      for (const input of [keyInput, valueInput]) {
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") save();
          else if (event.key === "Escape") cancel();
        });
      }

      keyCell.appendChild(keyInput);
      valueCell.appendChild(valueInput);
      typeCell.appendChild(typeSelect);
      actionCell.append(smallButton("Save", save, true), smallButton("Cancel", cancel));
      pendingFocus = keyInput;
    } else {
      keyCell.textContent = entry.key;
      valueCell.textContent = valueText(entry);
      typeCell.textContent = entry.type;
      const edit = smallButton("Edit", () => {
        if (!ready()) return;
        editing = position;
        say("");
        render();
      });
      const remove = smallButton("Delete", () => {
        if (!ready()) return;
        entries.splice(position, 1);
        index.invalidate();
        editing = -1;
        say(`Deleted "${entry.key}".`, "ok");
        render();
        touch();
      });
      actionCell.append(edit, remove);
    }

    row.append(number, keyCell, valueCell, typeCell, actionCell);
    fragment.appendChild(row);
    shown++;
  });

  table.appendChild(fragment);

  const empty = $("empty");
  empty.hidden = matches > 0;
  empty.textContent = entries.length ? "No entries match your search." : "No entries yet.";

  const note = $("dict-note");
  const more = $("dict-more");

  if (matches > shown) {
    note.hidden = false;
    note.textContent = `Showing ${shown.toLocaleString()} of ${matches.toLocaleString()} entries.`;
    more.hidden = false;
    more.textContent = `Show ${Math.min(PAGE_SIZE, matches - shown).toLocaleString()} more`;
  } else if (query && matches !== entries.length) {
    note.hidden = false;
    note.textContent = `${matches.toLocaleString()} of ${entries.length.toLocaleString()} entries match.`;
    more.hidden = true;
  } else {
    note.hidden = true;
    more.hidden = true;
  }

  if (pendingFocus) {
    pendingFocus.focus();
    pendingFocus.select?.();
    pendingFocus = null;
  }
}

/* ---------- Saving, syncing and conflicts ---------- */

// Every save uploads the whole dictionary, so wait longer to batch edits in
// big ones.
function autosaveDelay() {
  if (entries.length > 20_000) return 3000;
  if (entries.length > 5000) return 1800;
  return AUTOSAVE_MS;
}

function scheduleSave(ms) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, ms);
}

function touch() {
  revision++;
  retryDelay = 0;  // a fresh edit starts over with the normal delay
  setSaveStatus("Saving…");
  scheduleSave(autosaveDelay());
}

/** Fold the server's copy into the local edit and show the result. Returns the conflict notes. */
function mergeRemote(remote) {
  // The row being edited is tracked by key, because merging can move rows around.
  const editingKey = editing !== -1 ? entries[editing]?.key : null;

  const merged = mergeEntries(entries, baseSignatures, remote.entries);
  entries = merged.entries;
  baseSignatures = merged.base;
  serverRevision = Number(remote.revision) || 0;
  index.invalidate();

  editing = editingKey === null ? -1 : entries.findIndex((entry) => entry.key === editingKey);
  render();
  return merged.notes;
}

/** Replace the editor with a clean, unchanged copy from the server. */
function applyRemote(remote) {
  entries = copyEntries(Array.isArray(remote.entries) ? remote.entries : []);
  serverRevision = Number(remote.revision) || 0;
  revision = 0;
  savedRevision = 0;
  baseSignatures = signaturesOf(entries);
  index.invalidate();
  visibleLimit = PAGE_SIZE;
  render();
}

async function refreshFromServer() {
  if (document.hidden || saving || loading || editing !== -1 || !currentDictionaryId()) return;
  const gen = generation;
  const url = dictionaryUrl();
  const stale = () => gen !== generation || saving || loading || editing !== -1;

  try {
    // A few bytes tell us whether anything changed; only then download it all.
    const head = await api(`${url}/revision`);
    if (stale() || (Number(head.revision) || 0) === serverRevision) return;

    const data = await api(url);
    // The user may have switched dictionary, started a save or begun editing
    // while we were waiting: applying this copy now could clobber their work.
    if (stale() || (Number(data.revision) || 0) === serverRevision) return;

    if (revision !== savedRevision) {
      const notes = mergeRemote(data);
      const suffix = notes.length ? ` (${notes.length} conflict${notes.length === 1 ? "" : "s"} kept the saved word)` : "";
      toast(`Merged another user's edits${suffix}.`, "ok");
      touch();
    } else {
      applyRemote(data);
      toast("Dictionary updated by another user.", "ok");
    }
  } catch {
    // A transient polling failure is not worth interrupting the editor.
  }
}

async function pollOnce() {
  if (polling) return;   // never stack requests when the server is slow
  polling = true;
  try {
    await refreshFromServer();
  } finally {
    polling = false;
  }
}

async function saveNow() {
  if (saving || revision === savedRevision) return;
  clearTimeout(saveTimer);
  saving = true;
  const gen = generation;
  const url = dictionaryUrl();

  try {
    for (let attempt = 0; ; attempt++) {
      // Snapshot exactly what is sent. Edits made while the request is in
      // flight are NOT on the server yet and must stay "unsaved".
      const target = revision;
      const sent = entries.slice();
      let data;
      try {
        data = await api(url, { method: "PUT", json: { entries: sent, revision: serverRevision } });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409 && attempt === 0)) throw error;
        // Someone else saved first. Pull the latest copy, fold in our edits,
        // then retry once with the new revision.
        const latest = await api(url);
        if (gen !== generation) return;
        const notes = mergeRemote(latest);
        if (notes.length) {
          toast(
            `Merged your changes with another user's edits (${notes.length} conflict${notes.length === 1 ? "" : "s"} kept the saved word).`,
            "",
          );
        }
        continue;
      }

      if (gen !== generation) return;
      savedRevision = target;
      serverRevision = Number(data.revision) || serverRevision;
      baseSignatures = signaturesOf(sent);
      retryDelay = 0;
      noteActiveSave(Number(data.count) || sent.length, serverRevision, data.savedAt);

      if (revision === savedRevision) {
        const when = data.savedAt ? new Date(data.savedAt).toLocaleTimeString() : "now";
        setSaveStatus(`Saved ${Number(data.count).toLocaleString()} ${data.count === 1 ? "word" : "words"} at ${when}.`, "ok");
      } else {
        scheduleSave(autosaveDelay());
      }
      return;
    }
  } catch (error) {
    if (gen === generation) {
      if (isRetryable(error)) {
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : RETRY_START_MS, RETRY_MAX_MS);
        setSaveStatus(`Could not save: ${error.message} Retrying in ${Math.round(retryDelay / 1000)}s — your changes are still in this tab.`, "error");
        scheduleSave(retryDelay);
      } else {
        setSaveStatus(`Could not save: ${error.message} Your changes are still in this tab.`, "error");
      }
    }
  } finally {
    saving = false;
  }
}

/** Save before switching dictionaries. Returns false when the save failed. */
export async function flushDictionary() {
  clearTimeout(saveTimer);
  if (revision === savedRevision) return true;
  const started = Date.now();
  while (saving && Date.now() - started < 15_000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (saving) return false;
  await saveNow();
  return revision === savedRevision;
}

async function load() {
  const gen = generation;
  loading = true;
  try {
    const data = await api(dictionaryUrl());
    if (gen !== generation) return;

    entries = copyEntries(Array.isArray(data.entries) ? data.entries : []);
    serverRevision = Number(data.revision) || 0;
    revision = 0;
    savedRevision = 0;
    baseSignatures = signaturesOf(entries);
    index.invalidate();
    visibleLimit = PAGE_SIZE;
    render();

    if (entries.length) {
      const when = data.savedAt ? ` (saved ${new Date(data.savedAt).toLocaleString()})` : "";
      setSaveStatus(`Loaded ${entries.length.toLocaleString()} saved ${entries.length === 1 ? "word" : "words"}${when}.`, "ok");
    } else {
      setSaveStatus("New dictionary — nothing saved yet.");
    }
  } catch (error) {
    if (gen !== generation) return;
    render();
    setSaveStatus(`Could not load the saved dictionary: ${error.message} Changes stay in this tab.`, "error");
  } finally {
    if (gen === generation) loading = false;
  }
}

/** Clear the editor and load a different dictionary. */
export async function openDictionary(id) {
  clearTimeout(saveTimer);
  saveTimer = null;
  generation++;            // invalidates every request still in flight
  loading = Boolean(id);
  retryDelay = 0;
  editing = -1;
  entries = [];
  index.invalidate();
  revision = 0;
  savedRevision = 0;
  serverRevision = 0;
  baseSignatures = new Map();
  visibleLimit = PAGE_SIZE;

  $("q").value = "";
  $("key").value = "";
  $("value").value = "";
  clearFormErrors();
  say("");
  render();
  setSaveStatus("Loading the dictionary…");
  if (!filenameTouched) {
    $("filename").value = `${fileSafe(currentDictionary()?.name || "dictionary")}.json`;
  }

  if (id) await load();
}

/* ---------- Adding entries ---------- */

function clearFormErrors() {
  $("key").classList.remove("bad");
  $("value").classList.remove("bad");
}

function checkLive() {
  const key = nk($("key").value);
  const type = $("type").value;
  clearFormErrors();
  let error = "";

  if (key && hasKey(key)) {
    $("key").classList.add("bad");
    error = `"${key}" is already in the dictionary.`;
  }
  if (!error && (type === "null" || $("value").value !== "")) {
    try {
      const clash = keyWithValue(parseValue(type, $("value").value));
      if (clash !== null) {
        $("value").classList.add("bad");
        error = `That Roman word is already used by "${clash}".`;
      }
    } catch {
      // Incomplete input while typing is fine; Add pair reports the real error.
    }
  }

  if (error) say(error, "error");
  else if ($("form-msg").classList.contains("error")) say("");
}

function addPair() {
  if (!ready()) return;
  const key = nk($("key").value);
  clearFormErrors();

  if (!key) {
    say("Key cannot be empty.", "error");
    $("key").focus();
    return;
  }
  if (hasKey(key)) {
    $("key").classList.add("bad");
    say(`"${key}" is already in the dictionary.`, "error");
    $("key").focus();
    return;
  }

  let value;
  try {
    value = parseValue($("type").value, $("value").value);
  } catch (error) {
    $("value").classList.add("bad");
    say(error.message, "error");
    $("value").focus();
    return;
  }

  const clash = keyWithValue(value);
  if (clash !== null) {
    $("value").classList.add("bad");
    say(`That Roman word is already used by "${clash}".`, "error");
    $("value").focus();
    return;
  }

  const entry = { key, type: $("type").value, value };
  index.sync(entries);
  index.add(entry, entries.length);
  entries.push(entry);
  $("key").value = "";
  $("value").value = "";
  say(`Added "${key}".`, "ok");
  render();
  touch();
  $("key").focus();
}

/* ---------- Merge planner (used by imports and the SRT mapper) ---------- */

/** Work out which {key, value} pairs can be added without mutating the list. */
export function planAdd(items) {
  const planner = createPlanner(entries, index);
  planner.considerItems(items);
  return { add: planner.add, skip: planner.skip };
}

/** Apply a plan produced by planAdd() or an import planner. Returns the count added. */
export function commitAdd(plan) {
  if (!plan.add.length || !ready()) return 0;
  index.sync(entries);
  for (const entry of plan.add) {   // a loop: push(...big) overflows the call stack
    index.add(entry, entries.length);
    entries.push(entry);
  }
  visibleLimit += plan.add.length;   // keep the newly added words visible
  render();
  touch();
  return plan.add.length;
}

/* ---------- Import JSON files ---------- */

async function importFiles(fileList) {
  const good = [];
  const bad = [];

  for (const file of fileList) {
    try {
      const text = await readFileText(file);
      const object = JSON.parse(text);
      if (object === null || typeof object !== "object" || Array.isArray(object)) {
        throw new Error("top level must be a JSON object");
      }
      good.push({ name: file.name, object });
    } catch (error) {
      bad.push(`${file.name} (${error.message})`);
    }
  }

  const badNote = bad.length ? ` Could not read: ${bad.join("; ")}.` : "";
  if (!good.length) {
    toast(`No valid JSON file chosen.${badNote}`, "error");
    return;
  }

  const planner = createPlanner(entries, index);
  for (const file of good) planner.considerObject(file.object);

  const total = planner.add.length + planner.skip.length;
  if (!total) {
    toast(`The chosen file is empty. Nothing to merge.${badNote}`, "error");
    return;
  }
  if (!planner.add.length) {
    toast(`Nothing to merge: all ${total.toLocaleString()} entries are duplicates.${badNote}`, "error");
    return;
  }

  const blocks = [
    `Reading ${good.length} file${good.length === 1 ? "" : "s"} (${total.toLocaleString()} entries): ` +
    `${planner.add.length.toLocaleString()} new, ${planner.skip.length.toLocaleString()} will be skipped as duplicates.${badNote}`,
    {
      heading: `Will be added (${planner.add.length.toLocaleString()})`,
      items: planner.add.slice(0, 40).map((entry) => `${entry.key} = ${valueText(entry).slice(0, 60)}`),
    },
  ];
  if (planner.skip.length) {
    blocks.push({
      heading: `Skipped (${planner.skip.length.toLocaleString()})`,
      items: planner.skip.slice(0, 40).map((entry) => `${entry.key} — ${entry.why}`),
    });
  }

  const ok = await ask("Merge into the dictionary?", blocks, `Merge ${planner.add.length.toLocaleString()}`);
  if (!ok) {
    toast("Merge cancelled. Nothing changed.");
    return;
  }

  // The dictionary may have been edited while the dialog was open: plan again.
  const fresh = createPlanner(entries, index);
  for (const file of good) fresh.considerObject(file.object);
  const added = commitAdd(fresh);
  if (!added) {
    toast("Nothing left to merge — those entries are already in the dictionary.", "error");
    return;
  }
  toast(`Merged ${added.toLocaleString()} new ${added === 1 ? "entry" : "entries"}${fresh.skip.length ? `, skipped ${fresh.skip.length.toLocaleString()} duplicate(s)` : ""}.`, "ok");
}

/* ---------- Duplicate keys ---------- */

function findDuplicates() {
  const groups = new Map();
  entries.forEach((entry, position) => {
    const signature = ck(entry.key);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push({ number: position + 1, entry });
  });

  const duplicates = [...groups.values()].filter((group) => group.length > 1);
  if (!duplicates.length) {
    toast("No duplicate keys found.", "ok");
    return;
  }

  const blocks = [
    `${duplicates.length.toLocaleString()} key${duplicates.length === 1 ? "" : "s"} appear more than once. ` +
    "They look identical but are stored with different characters (or hidden spaces). " +
    "Search for the key and delete the row you do not want.",
  ];
  duplicates.slice(0, 30).forEach((group) => {
    blocks.push({
      heading: group[0].entry.key,
      items: group.map((item) => `#${item.number}  ${item.entry.key} = ${valueText(item.entry).slice(0, 40)}   [${codepoints(item.entry.key)}]`),
    });
  });
  if (duplicates.length > 30) blocks.push(`…and ${(duplicates.length - 30).toLocaleString()} more.`);

  ask("Duplicate keys", blocks, "Close");
}

/* ---------- Wiring ---------- */

function wire() {
  $("key").addEventListener("input", checkLive);
  $("value").addEventListener("input", checkLive);
  $("type").addEventListener("change", checkLive);

  for (const input of [$("key"), $("value")]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") addPair();
    });
  }

  $("add").addEventListener("click", addPair);

  // Searching scans every entry, so wait for a pause in typing.
  const search = debounce(() => {
    visibleLimit = PAGE_SIZE;
    renderRows();
  }, 150);
  $("q").addEventListener("input", search);

  $("dict-more").addEventListener("click", () => {
    visibleLimit += PAGE_SIZE;
    renderRows();
  });
  $("dups").addEventListener("click", findDuplicates);

  $("clear").addEventListener("click", async () => {
    if (!ready()) return;
    if (!entries.length) {
      toast("The dictionary is already empty.");
      return;
    }
    const ok = await ask(
      "Clear the dictionary?",
      [`All ${entries.length.toLocaleString()} entries will be deleted. This cannot be undone.`],
      "Clear all",
    );
    if (!ok) return;
    entries = [];
    index.invalidate();
    editing = -1;
    visibleLimit = PAGE_SIZE;
    say("");
    render();
    touch();
    toast("Dictionary cleared.", "ok");
  });

  $("copy-json").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildObject(), null, 2));
      toast("JSON copied to the clipboard.", "ok");
    } catch {
      toast("Copy failed — use Download instead.", "error");
    }
  });

  $("format").addEventListener("change", (event) => {
    const current = $("filename").value.trim() || "dictionary";
    $("filename").value = current.replace(KNOWN_EXT, "") + "." + event.target.value;
  });

  $("filename").addEventListener("input", () => {
    filenameTouched = true;
  });

  $("dict-download").addEventListener("click", () => {
    const format = $("format").value;
    if (!entries.length && format !== "json") {
      toast("Nothing to download yet — the dictionary is empty.", "error");
      return;
    }
    try {
      const { blob, ext } = buildFile(format, entries);
      const fallback = fileSafe(currentDictionary()?.name || "dictionary");
      const base = ($("filename").value.trim() || fallback).replace(KNOWN_EXT, "") || fallback;
      const name = `${base}.${ext}`;
      triggerDownload(blob, name);
      toast(`Downloaded ${name}.`, "ok");
    } catch (error) {
      toast(`Could not build the file: ${error.message}`, "error");
    }
  });

  $("load").addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length && ready()) importFiles(files);
  });

  // Warn before leaving with edits that are not on the server yet. (Closing
  // also attempts a last-moment save below, but that only fits small ones.)
  window.addEventListener("beforeunload", (event) => {
    if (revision === savedRevision) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // Best-effort save when the page is closed with unsaved changes. Browsers cap
  // keepalive bodies at ~64 KB, so only try it for small dictionaries.
  window.addEventListener("pagehide", () => {
    if (revision === savedRevision || !currentDictionaryId() || loading) return;
    const body = JSON.stringify({ entries, revision: serverRevision });
    if (body.length > 60_000) return;
    try {
      fetch(dictionaryUrl(), {
        method: "PUT",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      // Nothing useful to do while unloading.
    }
  });

  // Pick up edits made by other users. Merging only happens while this tab is
  // visible; switching tabs pauses the poll.
  setInterval(pollOnce, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollOnce();
  });
}

export function initDictionary() {
  wire();
}
