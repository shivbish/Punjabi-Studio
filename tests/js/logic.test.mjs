import test from "node:test";
import assert from "node:assert/strict";
import {
  EntryIndex, createPlanner, mergeEntries, nk, ck, parseValue, signaturesOf, copyEntries, typeOf,
} from "../../static/logic.js";

const e = (key, value, type = "string") => ({ key, type, value });
const keys = (list) => list.map((entry) => entry.key);

test("nk normalises to NFC and ck also ignores invisible characters", () => {
  assert.equal(nk("  ਸ  "), "ਸ");
  assert.equal(ck("ਸ\u200B"), ck("ਸ"));
  assert.equal(ck("\uFEFFghar"), "ghar");
  assert.equal(nk("e\u0301"), "\u00e9");
});

test("parseValue accepts valid input and rejects bad input", () => {
  assert.equal(parseValue("number", "42"), 42);
  assert.throws(() => parseValue("number", ""), /valid number/);
  assert.throws(() => parseValue("number", "Infinity"), /valid number/);
  assert.equal(parseValue("boolean", " TRUE "), true);
  assert.throws(() => parseValue("boolean", "yes"), /true or false/);
  assert.equal(parseValue("null", "ignored"), null);
  assert.deepEqual(parseValue("json", '{"a":1}'), { a: 1 });
  assert.throws(() => parseValue("json", "{"), /^Error: Invalid JSON/);
  assert.equal(parseValue("string", " keep "), " keep ");
});

test("typeOf maps JS values to dictionary types", () => {
  assert.deepEqual(
    [null, [1], {}, "a", 1, true].map(typeOf),
    ["null", "json", "json", "string", "number", "boolean"],
  );
});

test("EntryIndex finds duplicate keys and values, honouring skip", () => {
  const entries = [e("ਘਰ", "ghar"), e("ਦਿਲ", "dil")];
  const index = new EntryIndex();
  index.sync(entries);

  assert.equal(index.hasKey(entries, "ਘਰ"), true);
  assert.equal(index.hasKey(entries, "ਘਰ\u200B"), true);          // invisible character
  assert.equal(index.hasKey(entries, "ਘਰ", 0), false);            // editing that very row
  assert.equal(index.hasKey(entries, "ਹੋਰ"), false);
  assert.equal(index.keyWithValue(entries, "dil"), "ਦਿਲ");
  assert.equal(index.keyWithValue(entries, "dil", 1), null);
  assert.equal(index.keyWithValue(entries, "nope"), null);
});

test("EntryIndex stays correct when entries are appended, removed or replaced", () => {
  const entries = [e("a", "1")];
  const index = new EntryIndex();
  index.sync(entries);

  const added = e("b", "2");
  index.add(added, entries.length);
  entries.push(added);
  assert.equal(index.hasKey(entries, "b"), true);
  assert.equal(index.keyWithValue(entries, "2"), "b");

  entries.splice(0, 1);
  index.invalidate();
  assert.equal(index.hasKey(entries, "a"), false);
  assert.equal(index.keyWithValue(entries, "2"), "b");

  entries.push(e("c", "3"));            // appended without telling the index
  assert.equal(index.hasKey(entries, "c"), true);
});

test("planner adds new words and explains every skip", () => {
  const entries = [e("ਘਰ", "ghar")];
  const planner = createPlanner(entries, new EntryIndex());
  planner.considerItems([
    { key: "ਘਰ", value: "other" },        // key exists
    { key: "ਦਿਲ", value: "ghar" },        // value used by ਘਰ
    { key: "ਨਵਾਂ", value: "nava" },       // new
    { key: "ਨਵਾਂ", value: "nava2" },      // repeated inside the batch
    { key: "ਹੋਰ", value: "nava" },        // value repeated inside the batch
    { key: "   ", value: "x" },            // empty
  ]);

  assert.deepEqual(planner.add, [{ key: "ਨਵਾਂ", type: "string", value: "nava" }]);
  assert.deepEqual(planner.skip.map((item) => item.why), [
    "key already in the dictionary",
    'Roman word already used by "ਘਰ"',
    "key already in the dictionary",
    'Roman word already used by "ਨਵਾਂ"',
    "empty key",
  ]);
});

test("planner infers types for imported JSON", () => {
  const planner = createPlanner([], new EntryIndex());
  planner.considerObject({ a: 1, b: null, c: [1], d: "x" });
  assert.deepEqual(planner.add.map((entry) => entry.type), ["number", "null", "json", "string"]);
});

test("merge: remote additions and local additions are both kept", () => {
  const base = signaturesOf([e("a", "1")]);
  const result = mergeEntries([e("a", "1"), e("c", "3")], base, [e("a", "1"), e("b", "2")]);
  assert.deepEqual(keys(result.entries).sort(), ["a", "b", "c"]);
  assert.deepEqual(result.notes, []);
});

test("merge: a local delete wins unless someone changed that word", () => {
  const base = signaturesOf([e("a", "1")]);
  const clean = mergeEntries([], base, [e("a", "1"), e("b", "2")]);
  assert.deepEqual(keys(clean.entries), ["b"]);

  const conflict = mergeEntries([], base, [e("a", "CHANGED")]);
  assert.deepEqual(keys(conflict.entries), ["a"]);
  assert.match(conflict.notes[0], /changed by someone else/);
});

test("merge: local edit wins when only we changed it, remote wins when both did", () => {
  const base = signaturesOf([e("a", "x")]);

  const mine = mergeEntries([e("a", "y")], base, [e("a", "x")]);
  assert.equal(mine.entries[0].value, "y");

  const both = mergeEntries([e("a", "y")], base, [e("a", "z")]);
  assert.equal(both.entries[0].value, "z");
  assert.equal(both.notes.length, 1);
});

test("merge: a locally edited word that someone deleted is restored", () => {
  const base = signaturesOf([e("a", "x")]);
  const result = mergeEntries([e("a", "y")], base, []);
  assert.deepEqual(result.entries, [e("a", "y")]);
  assert.match(result.notes[0], /restored/);
});

test("merge: a word added on both sides keeps the saved one", () => {
  const result = mergeEntries([e("a", "mine")], new Map(), [e("a", "theirs")]);
  assert.equal(result.entries[0].value, "theirs");
  assert.match(result.notes[0], /already exists/);
});

test("merge returns the new base and ignores malformed remote entries", () => {
  const remote = [e("a", "1"), { key: "", type: "string", value: "x" }, { key: "z", type: "bogus", value: 1 }];
  const result = mergeEntries([], new Map(), remote);
  assert.deepEqual(result.base, signaturesOf(copyEntries(remote)));
  assert.deepEqual(keys(result.entries), ["a"]);
  assert.deepEqual(mergeEntries([], new Map(), null).entries, []);
});
