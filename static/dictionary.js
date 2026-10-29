import { $, toast, ask, readFileText, triggerDownload } from "./ui.js";
import { buildFile, KNOWN_EXT } from "./export.js";

/* ================= Dictionary editor ================= */

const TYPES = new Set(["string", "number", "boolean", "null", "json"]);
const STORE_URL = "/api/dictionary";
const AUTOSAVE_MS = 900;
const PAGE_SIZE = 1000;

let entries = [];
let editing = -1;
let revision = 0;
let savedRevision = 0;
let saveTimer = null;
let saving = false;
let pendingFocus = null;
let visibleLimit = PAGE_SIZE;

/* ---------- Key/value helpers ---------- */

// nk = key as stored: Unicode NFC (so the same Gurmukhi letter is always the
// same code points) + trimmed.
// ck = key as compared: nk without invisible characters (zero-width space and
// joiners, BOM), so keys that look identical are treated as duplicates.
const nk = (value) => String(value).normalize("NFC").trim();
const ck = (value) => String(value).normalize("NFC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

function valueText(entry) {
  return entry.value !== null && typeof entry.value === "object"
    ? JSON.stringify(entry.value)
    : String(entry.value);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "object") return "json";
  return typeof value;
}

function codepoints(value) {
  return Array.from(String(value))
    .map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ");
}

function buildObject() {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function hasKey(key, skip = -1) {
  const signature = ck(key);
  return entries.some((entry, index) => index !== skip && ck(entry.key) === signature);
}

function keyWithValue(value, skip = -1) {
  const signature = JSON.stringify(value);
  const match = entries.find((entry, index) => index !== skip && JSON.stringify(entry.value) === signature);
  return match ? match.key : null;
}

function parseValue(type, raw) {
  if (type === "string") return raw;
  if (type === "number") {
    const number = Number(raw);
    if (raw.trim() === "" || Number.isNaN(number)) throw new Error("Value is not a valid number.");
    return number;
  }
  if (type === "boolean") {
    const text = raw.trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
    throw new Error("Boolean must be true or false.");
  }
  if (type === "null") return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

function isValidEntry(entry) {
  return Boolean(entry)
    && typeof entry.key === "string"
    && entry.key.trim() !== ""
    && TYPES.has(entry.type)
    && "value" in entry;
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

async function errorMessage(response) {
  try {
    const data = await response.json();
    return data.detail || `Server returned ${response.status}.`;
  } catch {
    return `Server returned ${response.status}.`;
  }
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

function renderPreview() {
  $("preview").textContent = JSON.stringify(buildObject(), null, 2);
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

  entries.forEach((entry, index) => {
    if (index !== editing && query) {
      const haystack = `${entry.key} ${valueText(entry)} ${entry.type}`.toLowerCase();
      if (!haystack.includes(query)) return;
    }
    matches++;
    if (shown >= visibleLimit) return;

    const row = document.createElement("tr");
    const number = document.createElement("td");
    number.className = "num";
    number.textContent = index + 1;
    const keyCell = document.createElement("td");
    const valueCell = document.createElement("td");
    const typeCell = document.createElement("td");
    typeCell.className = "type-col";
    const actionCell = document.createElement("td");
    actionCell.className = "act";

    if (index === editing) {
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
        if (hasKey(key, index)) {
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
        const clash = keyWithValue(value, index);
        if (clash !== null) {
          say(`That Roman word is already used by "${clash}".`, "error");
          valueInput.focus();
          return;
        }
        entries[index] = { key, type: typeSelect.value, value };
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
        editing = index;
        say("");
        render();
      });
      const remove = smallButton("Delete", () => {
        entries.splice(index, 1);
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

/* ---------- Saving ---------- */

function touch() {
  revision++;
  setSaveStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, AUTOSAVE_MS);
}

async function saveNow() {
  if (saving || revision === savedRevision) return;
  clearTimeout(saveTimer);
  saving = true;
  const target = revision;
  const body = JSON.stringify({ entries });
  try {
    const response = await fetch(STORE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const data = await response.json();
    savedRevision = target;
    if (revision === savedRevision) {
      const when = data.savedAt ? new Date(data.savedAt).toLocaleTimeString() : "now";
      setSaveStatus(`Saved ${Number(data.count).toLocaleString()} ${data.count === 1 ? "word" : "words"} at ${when}.`, "ok");
    } else {
      saveTimer = setTimeout(saveNow, AUTOSAVE_MS);
    }
  } catch (error) {
    setSaveStatus(`Could not save: ${error.message}. Your changes are still in this tab.`, "error");
  } finally {
    saving = false;
  }
}

async function load() {
  try {
    const response = await fetch(STORE_URL);
    if (!response.ok) throw new Error(await errorMessage(response));
    const data = await response.json();
    const list = Array.isArray(data.entries) ? data.entries : [];
    entries = list.filter(isValidEntry).map(({ key, type, value }) => ({ key, type, value }));
    visibleLimit = PAGE_SIZE;
    render();
    if (entries.length) {
      const when = data.savedAt ? ` (saved ${new Date(data.savedAt).toLocaleString()})` : "";
      setSaveStatus(`Loaded ${entries.length.toLocaleString()} saved ${entries.length === 1 ? "word" : "words"}${when}.`, "ok");
    } else {
      setSaveStatus("New dictionary — nothing saved yet.");
    }
  } catch {
    render();
    setSaveStatus("Could not load the saved dictionary. Changes stay in this tab.", "error");
  }
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

  entries.push({ key, type: $("type").value, value });
  $("key").value = "";
  $("value").value = "";
  say(`Added "${key}".`, "ok");
  render();
  touch();
  $("key").focus();
}

/* ---------- Merge planner (used by imports and the SRT mapper) ---------- */

function createPlanner() {
  const keys = new Set(entries.map((entry) => ck(entry.key)));
  const values = new Map(entries.map((entry) => [JSON.stringify(entry.value), entry.key]));
  const add = [];
  const skip = [];

  function consider(key, value) {
    const clean = nk(key);
    if (!clean) {
      skip.push({ key: String(key), why: "empty key" });
      return;
    }
    if (keys.has(ck(clean))) {
      skip.push({ key: clean, why: "key already in the dictionary" });
      return;
    }
    const signature = JSON.stringify(value);
    if (values.has(signature)) {
      skip.push({ key: clean, why: `Roman word already used by "${values.get(signature)}"` });
      return;
    }
    add.push({ key: clean, type: typeOf(value), value });
    keys.add(ck(clean));
    values.set(signature, clean);
  }

  return {
    add,
    skip,
    consider,
    considerObject(object) {
      for (const [key, value] of Object.entries(object)) consider(key, value);
    },
    considerItems(items) {
      for (const item of items) consider(item.key, item.value);
    },
  };
}

/** Work out which {key, value} pairs can be added without mutating the list. */
export function planAdd(items) {
  const planner = createPlanner();
  planner.considerItems(items);
  return { add: planner.add, skip: planner.skip };
}

/** Apply a plan produced by planAdd() or an import planner. Returns the count added. */
export function commitAdd(plan) {
  if (!plan.add.length) return 0;
  entries.push(...plan.add);
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

  const planner = createPlanner();
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
      items: planner.add.map((entry) => `${entry.key} = ${valueText(entry).slice(0, 60)}`),
    },
  ];
  if (planner.skip.length) {
    blocks.push({
      heading: `Skipped (${planner.skip.length.toLocaleString()})`,
      items: planner.skip.map((entry) => `${entry.key} — ${entry.why}`),
    });
  }

  const ok = await ask("Merge into the dictionary?", blocks, `Merge ${planner.add.length.toLocaleString()}`);
  if (!ok) {
    toast("Merge cancelled. Nothing changed.");
    return;
  }

  const added = commitAdd(planner);
  toast(`Merged ${added.toLocaleString()} new ${added === 1 ? "entry" : "entries"}${planner.skip.length ? `, skipped ${planner.skip.length.toLocaleString()} duplicate(s)` : ""}.`, "ok");
}

/* ---------- Duplicate keys ---------- */

function findDuplicates() {
  const groups = new Map();
  entries.forEach((entry, index) => {
    const signature = ck(entry.key);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push({ number: index + 1, entry });
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
  $("q").addEventListener("input", () => {
    visibleLimit = PAGE_SIZE;
    renderRows();
  });
  $("dict-more").addEventListener("click", () => {
    visibleLimit += PAGE_SIZE;
    renderRows();
  });
  $("dups").addEventListener("click", findDuplicates);

  $("clear").addEventListener("click", async () => {
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
      toast("Copy failed — select the text in the preview instead.", "error");
    }
  });

  $("format").addEventListener("change", (event) => {
    const current = $("filename").value.trim() || "dictionary";
    $("filename").value = current.replace(KNOWN_EXT, "") + "." + event.target.value;
  });

  $("dict-download").addEventListener("click", () => {
    const format = $("format").value;
    if (!entries.length && format !== "json") {
      toast("Nothing to download yet — the dictionary is empty.", "error");
      return;
    }
    try {
      const { blob, ext } = buildFile(format, entries);
      const base = ($("filename").value.trim() || "dictionary").replace(KNOWN_EXT, "") || "dictionary";
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
    if (files.length) importFiles(files);
  });

  // Best-effort save when the page is closed with unsaved changes. Browsers cap
  // keepalive bodies at ~64 KB, so only try it for small dictionaries.
  window.addEventListener("pagehide", () => {
    if (revision === savedRevision) return;
    const body = JSON.stringify({ entries });
    if (body.length > 60_000) return;
    try {
      fetch(STORE_URL, {
        method: "PUT",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      // Nothing useful to do while unloading.
    }
  });
}

export async function initDictionary() {
  wire();
  await load();
}
