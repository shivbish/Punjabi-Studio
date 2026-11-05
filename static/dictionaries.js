import { $, toast, ask, promptText, api, isRetryable } from "./ui.js";

/* ================= Dictionary selection ================= */

const LIST_URL = "/api/dictionaries";
const STORAGE_KEY = "punjabi-studio.dictionary";
const LIST_RETRIES = 3;
const LIST_REFRESH_MS = 30_000;

let items = [];
let currentId = null;
let wired = false;
let lastListRefresh = Date.now();
let hooks = {
  flush: async () => {},
  open: async () => {},
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function currentDictionaryId() {
  return currentId;
}

export function currentDictionary() {
  return items.find((item) => item.id === currentId) || null;
}

export function dictionaryUrl(id = currentId) {
  return `${LIST_URL}/${encodeURIComponent(id)}`;
}

function label(item) {
  return item.count ? `${item.name} (${item.count.toLocaleString()})` : item.name;
}

export function noteActiveSave(count, revision, savedAt) {
  const item = currentDictionary();
  if (!item) return;
  item.count = count;
  item.revision = revision;
  if (savedAt) item.updatedAt = savedAt;
  for (const option of $("dict-select").options) {
    if (option.value === item.id) option.textContent = label(item);
  }
}

function renderSelect() {
  const select = $("dict-select");
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = label(item);
    select.appendChild(option);
  }
  select.disabled = items.length === 0;
  if (currentId) select.value = currentId;
}

function sortItems() {
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

function setCurrent(id) {
  currentId = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private browsing can block localStorage; the URL still carries the id.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("d", id);
  history.replaceState(null, "", url.toString());
  const select = $("dict-select");
  if (select) select.value = id;
  const name = currentDictionary()?.name;
  if (name) document.title = `${name} · Dictionary Studio`;
}

async function fetchList() {
  const data = await api(LIST_URL);
  items = Array.isArray(data.dictionaries) ? data.dictionaries : [];
  sortItems();
  renderSelect();
  return items;
}

/** Quietly pick up dictionaries other people created, renamed or saved. */
async function refreshList() {
  lastListRefresh = Date.now();
  try {
    const data = await api(LIST_URL);
    const fresh = Array.isArray(data.dictionaries) ? data.dictionaries : [];
    const active = currentDictionary();
    // Never drop the open dictionary from the picker, even if the list lags.
    if (active && !fresh.some((item) => item.id === active.id)) fresh.push(active);
    items = fresh;
    sortItems();
    renderSelect();
  } catch {
    // A failed background refresh is not worth interrupting the user.
  }
}

async function activate(id) {
  setCurrent(id);
  await hooks.open(id);
}

async function flushOrWarn() {
  const ok = await hooks.flush();
  if (ok === false) {
    toast("Could not save your changes — staying on this dictionary so nothing is lost.", "error");
    return false;
  }
  return true;
}

async function switchTo(id) {
  if (!id || id === currentId) return;
  if (!(await flushOrWarn())) {
    renderSelect();
    return;
  }
  await activate(id);
}

/* ---------- Wiring ---------- */

function wire() {
  if (wired) return;
  wired = true;

  $("dict-select").addEventListener("change", async (event) => {
    const select = event.target;
    const previous = currentId;
    try {
      await switchTo(select.value);
    } catch (error) {
      select.value = previous;
      toast(`Could not open that dictionary: ${error.message}`, "error");
    }
  });

  $("dict-new").addEventListener("click", async () => {
    const name = await promptText("New dictionary", "Dictionary name", "", "Create");
    if (!name) return;
    try {
      if (!(await flushOrWarn())) return;
      const doc = await api(LIST_URL, { method: "POST", json: { name } });
      items.push(doc);
      sortItems();
      renderSelect();
      await activate(doc.id);
      toast(`Created "${doc.name}".`, "ok");
    } catch (error) {
      toast(`Could not create the dictionary: ${error.message}`, "error");
    }
  });

  $("dict-rename").addEventListener("click", async () => {
    const current = currentDictionary();
    if (!current) return;
    const name = await promptText("Rename dictionary", "Dictionary name", current.name, "Save");
    if (!name || name === current.name) return;
    try {
      const updated = await api(dictionaryUrl(current.id), { method: "PATCH", json: { name } });
      Object.assign(current, updated);
      sortItems();
      renderSelect();
      setCurrent(current.id);
      toast(`Renamed to "${updated.name}".`, "ok");
    } catch (error) {
      toast(`Could not rename the dictionary: ${error.message}`, "error");
    }
  });

  $("dict-delete").addEventListener("click", async () => {
    const current = currentDictionary();
    if (!current) return;
    if (items.length <= 1) {
      toast("Create another dictionary before deleting this one.", "error");
      return;
    }
    const ok = await ask(
      "Delete this dictionary?",
      [
        `"${current.name}" and all ${Number(current.count || 0).toLocaleString()} of its words will be deleted.`,
        "A backup copy is kept on the server, but it is not shown in the app.",
      ],
      "Delete",
    );
    if (!ok) return;
    try {
      await api(dictionaryUrl(current.id), { method: "DELETE" });
      items = items.filter((item) => item.id !== current.id);
      renderSelect();
      toast(`Deleted "${current.name}".`, "ok");
      await activate(items[0].id);
    } catch (error) {
      toast(`Could not delete the dictionary: ${error.message}`, "error");
    }
  });

  $("dict-share").addEventListener("click", async () => {
    if (!currentId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("d", currentId);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast("Share link copied to the clipboard.", "ok");
    } catch {
      toast(`Copy failed — share this URL instead: ${url}`, "error");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastListRefresh >= LIST_REFRESH_MS) refreshList();
  });
}

function preferredId() {
  const fromUrl = new URL(window.location.href).searchParams.get("d");
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Ignore blocked storage.
  }
  return { fromUrl, stored };
}

/** Load the list, retrying brief outages. Returns false when it could not be loaded. */
async function loadListWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= LIST_RETRIES; attempt++) {
    try {
      await fetchList();
      return true;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === LIST_RETRIES) break;
      await sleep(700 * attempt);
    }
  }
  toast(`Could not load the dictionary list: ${lastError.message} Reload the page to try again.`, "error");
  return false;
}

export async function initDictionaries(callbacks) {
  hooks = { ...hooks, ...callbacks };
  wire();

  // If the list could not be read we must NOT assume there are no dictionaries:
  // creating a "Main Dictionary" then would shadow the real ones.
  if (!(await loadListWithRetry())) return;

  const { fromUrl, stored } = preferredId();
  let id = null;
  if (fromUrl && items.some((item) => item.id === fromUrl)) id = fromUrl;
  else if (stored && items.some((item) => item.id === stored)) id = stored;
  else if (items.length) id = items[0].id;

  if (!id) {
    try {
      const doc = await api(LIST_URL, { method: "POST", json: { name: "Main Dictionary" } });
      items.push(doc);
      renderSelect();
      id = doc.id;
    } catch (error) {
      toast(`Could not create the first dictionary: ${error.message}`, "error");
      return;
    }
  }

  await activate(id);
}
