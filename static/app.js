import { $, toast, ask } from "./ui.js";
import { initDictionary, planAdd, commitAdd } from "./dictionary.js";

/* ================= Tabs ================= */

function selectTab(name) {
  const isMap = name === "map";
  $("tab-map").setAttribute("aria-selected", String(isMap));
  $("tab-dict").setAttribute("aria-selected", String(!isMap));
  $("tab-map").tabIndex = isMap ? 0 : -1;
  $("tab-dict").tabIndex = isMap ? -1 : 0;
  $("panel-map").hidden = !isMap;
  $("panel-dict").hidden = isMap;
}

for (const [name, button] of [["map", $("tab-map")], ["dict", $("tab-dict")]]) {
  button.addEventListener("click", () => selectTab(name));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = name === "map" ? "dict" : "map";
    selectTab(next);
    $(next === "map" ? "tab-map" : "tab-dict").focus();
  });
}

/* ================= SRT word mapper ================= */

const PAGE_SIZE = 1000;
const files = { native: null, roman: null };
let mapping = {};
let jsonText = "";
let visibleLimit = PAGE_SIZE;

function mapStatus(message, kind = "") {
  const el = $("map-status");
  el.textContent = message;
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function updateReady() {
  const ready = Boolean(files.native && files.roman);
  $("generate").disabled = !ready;
  mapStatus(ready ? "Ready. Select Generate mapping." : "Choose both .srt files to continue.");
}

function setFile(kind, file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".srt")) {
    mapStatus("Only .srt files are supported.", "error");
    return;
  }
  files[kind] = file;
  $(`hint-${kind}`).textContent = file.name;
  $(`drop-${kind}`).classList.add("ready");
  updateReady();
}

for (const kind of ["native", "roman"]) {
  const zone = $(`drop-${kind}`);
  const input = $(`file-${kind}`);

  input.addEventListener("change", () => setFile(kind, input.files[0]));
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragover");
    setFile(kind, event.dataTransfer.files[0]);
  });
}

function showResult(count) {
  $("result").hidden = false;
  $("result-title").textContent = `Mapping (${count.toLocaleString()} ${count === 1 ? "word" : "words"})`;
  $("map-json").textContent = jsonText;
  $("map-search").value = "";
  visibleLimit = PAGE_SIZE;
  renderRows("");
  selectResultTab("table");
}

function renderRows(query) {
  const needle = query.trim().toLowerCase();
  const body = $("map-rows");
  body.replaceChildren();

  let matches = 0;
  let shown = 0;
  const fragment = document.createDocumentFragment();

  for (const [native, roman] of Object.entries(mapping)) {
    if (needle && !native.toLowerCase().includes(needle) && !roman.toLowerCase().includes(needle)) continue;
    matches++;
    if (shown >= visibleLimit) continue;

    const row = document.createElement("tr");
    const nativeCell = document.createElement("td");
    const romanCell = document.createElement("td");
    nativeCell.textContent = native;
    romanCell.textContent = roman;
    row.append(nativeCell, romanCell);
    fragment.appendChild(row);
    shown++;
  }

  body.appendChild(fragment);

  const note = $("map-note");
  const more = $("map-more");

  if (matches > shown) {
    note.textContent = `Showing ${shown.toLocaleString()} of ${matches.toLocaleString()} words.`;
    more.hidden = false;
    more.textContent = `Show ${Math.min(PAGE_SIZE, matches - shown).toLocaleString()} more`;
  } else {
    note.textContent = matches === 0
      ? "No words match your search."
      : `${matches.toLocaleString()} word${matches === 1 ? "" : "s"}`;
    more.hidden = true;
  }
}

function selectResultTab(which) {
  const isTable = which === "table";
  $("tab-map-table").setAttribute("aria-selected", String(isTable));
  $("tab-map-json").setAttribute("aria-selected", String(!isTable));
  $("tab-map-table").tabIndex = isTable ? 0 : -1;
  $("tab-map-json").tabIndex = isTable ? -1 : 0;
  $("panel-map-table").hidden = !isTable;
  $("panel-map-json").hidden = isTable;
}

$("tab-map-table").addEventListener("click", () => selectResultTab("table"));
$("tab-map-json").addEventListener("click", () => selectResultTab("json"));
$("map-search").addEventListener("input", (event) => {
  visibleLimit = PAGE_SIZE;
  renderRows(event.target.value);
});
$("map-more").addEventListener("click", () => {
  visibleLimit += PAGE_SIZE;
  renderRows($("map-search").value);
});

$("generate").addEventListener("click", async () => {
  const body = new FormData();
  body.append("native_file", files.native);
  body.append("roman_file", files.roman);

  $("generate").disabled = true;
  mapStatus("Processing subtitles and mapping words…");

  try {
    const response = await fetch("/api/map", { method: "POST", body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Something went wrong. Try again.");

    mapping = data.mapping || {};
    jsonText = JSON.stringify(mapping, null, 2);
    const count = Number(data.count) || 0;
    showResult(count);
    mapStatus(`Mapped ${count.toLocaleString()} unique word${count === 1 ? "" : "s"}.`, "ok");
  } catch (error) {
    mapStatus(error.message, "error");
  } finally {
    $("generate").disabled = false;
  }
});

$("send-dict").addEventListener("click", async () => {
  const items = Object.entries(mapping).map(([key, value]) => ({ key, value }));
  if (!items.length) {
    toast("There is nothing to add.", "error");
    return;
  }

  const plan = planAdd(items);
  if (!plan.add.length) {
    const reason = plan.skip.length === 1 ? plan.skip[0].why : "every word is already in the dictionary";
    toast(`Nothing new to add — ${reason}.`, "error");
    return;
  }

  const blocks = [
    `${plan.add.length.toLocaleString()} new ${plan.add.length === 1 ? "word" : "words"} will be added to the dictionary.`,
  ];
  if (plan.skip.length) {
    blocks.push({
      heading: `Skipped (${plan.skip.length.toLocaleString()})`,
      items: plan.skip.map((entry) => `${entry.key} — ${entry.why}`),
    });
  }

  const ok = await ask("Add mapped words to the dictionary?", blocks, `Add ${plan.add.length.toLocaleString()}`);
  if (!ok) return;

  const added = commitAdd(plan);
  toast(`Added ${added.toLocaleString()} ${added === 1 ? "word" : "words"} to the dictionary.`, "ok");
  selectTab("dict");
});

$("map-download").addEventListener("click", () => {
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "punjabi_word_mapping.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

$("map-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(jsonText);
    toast("Mapping JSON copied to the clipboard.", "ok");
  } catch {
    toast("Copy failed — select the text in the Raw JSON tab instead.", "error");
  }
});

/* ================= Boot ================= */

selectTab("map");

// Load the saved dictionary before the mapper can send anything to it, so a
// freshly loaded list can never overwrite words added in this session.
await initDictionary();
