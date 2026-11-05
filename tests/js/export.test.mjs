import test from "node:test";
import assert from "node:assert/strict";
import { buildFile, KNOWN_EXT } from "../../static/export.js";

const entries = [
  { key: "ਘਰ", type: "string", value: "ghar" },
  { key: "ਗਿਣਤੀ", type: "number", value: 7 },
  { key: "a,b", type: "string", value: 'say "hi" <&>' },
];

async function bytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function zipFileCount(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(view.getUint32(data.length - 22, true), 0x06054b50, "end-of-central-directory record");
  return view.getUint16(data.length - 22 + 10, true);
}

test("xlsx and docx are well-formed ZIP containers", async () => {
  const xlsx = await bytes(buildFile("xlsx", entries).blob);
  const docx = await bytes(buildFile("docx", entries).blob);
  assert.deepEqual([...xlsx.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(zipFileCount(xlsx), 6);
  assert.equal(zipFileCount(docx), 3);
});

test("csv has a BOM, a header row and quotes awkward cells", async () => {
  const { blob } = buildFile("csv", entries);
  assert.deepEqual([...(await bytes(blob)).slice(0, 3)], [0xef, 0xbb, 0xbf]);   // UTF-8 BOM, for Excel
  const text = await blob.text();
  assert.match(text, /No\.,Native word,Roman word/);
  assert.match(text, /"a,b","say ""hi"" <&>"/);
});

test("json export is a plain key/value object; xml and html escape markup", async () => {
  const json = JSON.parse(await buildFile("json", entries).blob.text());
  assert.deepEqual(json, { "ਘਰ": "ghar", "ਗਿਣਤੀ": 7, "a,b": 'say "hi" <&>' });
  const xml = await buildFile("xml", entries).blob.text();
  assert.match(xml, /say &quot;hi&quot; &lt;&amp;&gt;/);
  const html = await buildFile("html", entries).blob.text();
  assert.match(html, /&lt;&amp;&gt;/);
});

test("unknown formats throw and extensions are recognised", () => {
  assert.throws(() => buildFile("pdf", entries), /Unknown format/);
  assert.ok(KNOWN_EXT.test("words.XLSX"));
});
