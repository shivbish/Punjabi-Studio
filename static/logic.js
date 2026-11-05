/* Pure dictionary-editor logic: no DOM, no network, so it can be unit-tested in Node. */

export const TYPES = new Set(["string", "number", "boolean", "null", "json"]);

// nk = key as stored: Unicode NFC (so the same Gurmukhi letter is always the
// same code points) + trimmed.
// ck = key as compared: nk without invisible characters (zero-width space and
// joiners, BOM), so keys that look identical are treated as duplicates.
export const nk = (value) => String(value).normalize("NFC").trim();
export const ck = (value) => String(value).normalize("NFC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

export function valueText(entry) {
  return entry.value !== null && typeof entry.value === "object"
    ? JSON.stringify(entry.value)
    : String(entry.value);
}

export function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "object") return "json";
  return typeof value;
}

export function parseValue(type, raw) {
  if (type === "string") return raw;
  if (type === "number") {
    const number = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(number)) throw new Error("Value is not a valid number.");
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

export function isValidEntry(entry) {
  return Boolean(entry)
    && typeof entry.key === "string"
    && entry.key.trim() !== ""
    && TYPES.has(entry.type)
    && "value" in entry;
}

export function entrySignature(entry) {
  return `${entry.type}:${JSON.stringify(entry.value)}`;
}

export function signaturesOf(list) {
  return new Map(list.map((entry) => [entry.key, entrySignature(entry)]));
}

export function copyEntries(list) {
  return list
    .filter(isValidEntry)
    .map(({ key, type, value }) => ({ key, type, value }));
}

/* ---------- Duplicate lookup in O(1) ---------- */

/**
 * Maps comparable keys and values to entry positions, so checking a word while
 * typing does not rescan (and re-normalise) the whole dictionary per keystroke.
 *
 * Call invalidate() after any change other than appending. Lookups take the
 * current entries and rebuild the index first when it is out of date, so a
 * stale answer is impossible.
 */
export class EntryIndex {
  constructor() {
    this.clear();
  }

  clear() {
    this.keys = new Map();
    this.values = new Map();
    this.size = 0;
    this.valid = true;
  }

  invalidate() {
    this.valid = false;
  }

  rebuild(entries) {
    this.clear();
    entries.forEach((entry, position) => this._add(entry, position));
    this.size = entries.length;
  }

  sync(entries) {
    if (!this.valid || this.size !== entries.length) this.rebuild(entries);
  }

  /** Register an entry that is about to be appended at `position`. */
  add(entry, position) {
    if (!this.valid || position !== this.size) {
      this.valid = false;
      return;
    }
    this._add(entry, position);
    this.size = position + 1;
  }

  _add(entry, position) {
    push(this.keys, ck(entry.key), position);
    push(this.values, JSON.stringify(entry.value), position);
  }

  hasKey(entries, key, skip = -1) {
    this.sync(entries);
    const positions = this.keys.get(ck(key));
    return Boolean(positions) && positions.some((position) => position !== skip);
  }

  /** The key that already uses this value, or null. */
  keyWithValue(entries, value, skip = -1) {
    this.sync(entries);
    const positions = this.values.get(JSON.stringify(value));
    if (!positions) return null;
    const position = positions.find((candidate) => candidate !== skip);
    return position === undefined ? null : entries[position].key;
  }
}

function push(map, signature, position) {
  const list = map.get(signature);
  if (list) list.push(position);
  else map.set(signature, [position]);
}

/* ---------- Merge planner (imports and the SRT mapper) ---------- */

/** Decide which {key, value} pairs can be added without changing `entries`. */
export function createPlanner(entries, index) {
  const plannedKeys = new Set();
  const plannedValues = new Map();
  const add = [];
  const skip = [];

  function consider(key, value) {
    const clean = nk(key);
    if (!clean) {
      skip.push({ key: String(key), why: "empty key" });
      return;
    }
    const signature = ck(clean);
    if (index.hasKey(entries, clean) || plannedKeys.has(signature)) {
      skip.push({ key: clean, why: "key already in the dictionary" });
      return;
    }
    const valueSignature = JSON.stringify(value);
    let clash = index.keyWithValue(entries, value);
    if (clash === null && plannedValues.has(valueSignature)) clash = plannedValues.get(valueSignature);
    if (clash !== null) {
      skip.push({ key: clean, why: `Roman word already used by "${clash}"` });
      return;
    }
    add.push({ key: clean, type: typeOf(value), value });
    plannedKeys.add(signature);
    plannedValues.set(valueSignature, clean);
  }

  return {
    add,
    skip,
    considerObject(object) {
      for (const [key, value] of Object.entries(object)) consider(key, value);
    },
    considerItems(items) {
      for (const item of items) consider(item.key, item.value);
    },
  };
}

/* ---------- Three-way merge with the server's copy ---------- */

/**
 * Fold the server's latest entries into the local edit. The server wins true
 * conflicts. `baseSignatures` describes the entries as last loaded/saved.
 *
 * @returns {{ entries: object[], notes: string[], base: Map<string, string> }}
 */
export function mergeEntries(localEntries, baseSignatures, remoteList) {
  const remoteEntries = copyEntries(Array.isArray(remoteList) ? remoteList : []);
  const remoteMap = new Map(remoteEntries.map((entry) => [entry.key, entry]));
  const merged = new Map(remoteMap);
  const localKeys = new Set(localEntries.map((entry) => entry.key));
  const notes = [];

  // Local deletions only apply when the server still has the version we loaded.
  for (const [key, baseSig] of baseSignatures) {
    if (localKeys.has(key)) continue;
    const remoteEntry = remoteMap.get(key);
    if (!remoteEntry) continue;
    if (entrySignature(remoteEntry) === baseSig) {
      merged.delete(key);
    } else {
      notes.push(`"${key}" was changed by someone else, so it was kept.`);
    }
  }

  for (const entry of localEntries) {
    const localSig = entrySignature(entry);
    const baseSig = baseSignatures.get(entry.key);

    if (baseSig === undefined) {
      // Added locally while someone else was editing.
      if (!remoteMap.has(entry.key)) merged.set(entry.key, entry);
      else notes.push(`"${entry.key}" already exists on the server, so the saved word was kept.`);
      continue;
    }
    if (localSig === baseSig) continue;   // unchanged locally, take the remote copy

    const remoteEntry = remoteMap.get(entry.key);
    if (!remoteEntry) {
      // Edited locally, but someone else deleted it: keep the local edit.
      merged.set(entry.key, entry);
      notes.push(`"${entry.key}" was deleted by someone else but has been restored.`);
    } else if (entrySignature(remoteEntry) === baseSig) {
      merged.set(entry.key, entry);       // only the local side changed
    } else {
      notes.push(`"${entry.key}" was changed by someone else, so the saved word was kept.`);
    }
  }

  return { entries: [...merged.values()], notes, base: signaturesOf(remoteEntries) };
}
