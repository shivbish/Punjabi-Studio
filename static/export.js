/* Dictionary export builders: JSON, Excel, Word, CSV, TSV, text, Markdown, HTML, XML.
 * The ZIP writer is dependency-free, so .xlsx and .docx are built in the browser. */

export const KNOWN_EXT = /\.(json|xlsx|docx|csv|tsv|txt|md|html|xml)$/i;

const HEADS = ["Native word", "Roman word"];
const EXT = {
  json: "json",
  xlsx: "xlsx",
  docx: "docx",
  csv: "csv",
  tsv: "tsv",
  txt: "txt",
  md: "md",
  html: "html",
  xml: "xml",
};

function valueText(entry) {
  return entry.value !== null && typeof entry.value === "object"
    ? JSON.stringify(entry.value)
    : String(entry.value);
}

function tableRows(entries) {
  return entries.map((entry, index) => [String(index + 1), entry.key, valueText(entry)]);
}

function esc(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------- Minimal ZIP writer (no compression) ---------------- */
const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files, mime) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.data);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  });

  let centralSize = 0;
  central.forEach((chunk) => { centralSize += chunk.length; });

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]), { type: mime });
}

/* ---------------- Excel ---------------- */
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OD_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function buildXlsx(entries) {
  function cell(ref, text, style) {
    return `<c r="${ref}" t="inlineStr"${style ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(String(text).slice(0, 32000))}</t></is></c>`;
  }

  let sheet = `<row r="1">${cell("A1", "No.", 1)}${cell("B1", HEADS[0], 1)}${cell("C1", HEADS[1], 1)}</row>`;
  entries.forEach((entry, index) => {
    const row = index + 2;
    const value = entry.type === "number" && isFinite(entry.value)
      ? `<c r="C${row}"><v>${entry.value}</v></c>`
      : cell(`C${row}`, valueText(entry));
    sheet += `<row r="${row}"><c r="A${row}"><v>${index + 1}</v></c>${cell(`B${row}`, entry.key)}${value}</row>`;
  });

  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  return zip([
    { name: "[Content_Types].xml", data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `${XML_HEAD}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OD_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${OD_REL}"><sheets><sheet name="Dictionary" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${XML_HEAD}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OD_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OD_REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `${XML_HEAD}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: `${XML_HEAD}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="3" width="34" customWidth="1"/></cols><sheetData>${sheet}</sheetData></worksheet>` },
  ], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

/* ---------------- Word ---------------- */
function buildDocx(entries) {
  const widths = [900, 4369, 4369];

  function cell(text, width, head) {
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : ""}</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Nirmala UI"/>${head ? "<w:b/><w:bCs/>" : ""}<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
  }

  const borders = '<w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>';
  let rows = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("No.", widths[0], 1)}${cell(HEADS[0], widths[1], 1)}${cell(HEADS[1], widths[2], 1)}</w:tr>`;
  tableRows(entries).forEach((row) => {
    rows += `<w:tr>${cell(row[0], widths[0])}${cell(row[1], widths[1])}${cell(row[2], widths[2])}</w:tr>`;
  });

  const doc = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Nirmala UI"/><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t>Dictionary</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:color w:val="666666"/></w:rPr><w:t>${entries.length} entries</w:t></w:r></w:p>` +
    `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="${widths[0]}"/><w:gridCol w:w="${widths[1]}"/><w:gridCol w:w="${widths[2]}"/></w:tblGrid>${rows}</w:tbl><w:p/>` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  return zip([
    { name: "[Content_Types].xml", data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", data: `${XML_HEAD}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OD_REL}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: doc },
  ], "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

/* ---------------- Text formats ---------------- */
function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function oneLine(value) {
  return String(value).replace(/[\t\r\n]+/g, " ");
}

function buildText(format, entries) {
  const rows = tableRows(entries);

  if (format === "csv") {
    return "\uFEFF" + [["No.", HEADS[0], HEADS[1]]]
      .concat(rows)
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n") + "\r\n";
  }
  if (format === "tsv") {
    return "\uFEFF" + [["No.", HEADS[0], HEADS[1]]]
      .concat(rows)
      .map((row) => row.map(oneLine).join("\t"))
      .join("\r\n") + "\r\n";
  }
  if (format === "txt") {
    return entries.map((entry) => `${oneLine(entry.key)} = ${oneLine(valueText(entry))}`).join("\n") + "\n";
  }
  if (format === "md") {
    const md = (value) => oneLine(value).replace(/\|/g, "\\|");
    const head = "| No. | " + md(HEADS[0]) + " | " + md(HEADS[1]) + " |\n| --- | --- | --- |\n";
    return head + rows.map((row) => `| ${row[0]} | ${md(row[1])} | ${md(row[2])} |`).join("\n") + "\n";
  }
  if (format === "html") {
    return '<!DOCTYPE html>\n<html lang="pa"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dictionary</title><style>body{font-family:system-ui,"Nirmala UI",sans-serif;margin:24px}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px 12px;text-align:left}th{background:#eee}</style></head><body><h1>Dictionary</h1><p>' +
      entries.length + " entries</p><table><thead><tr><th>No.</th><th>" + esc(HEADS[0]) + "</th><th>" + esc(HEADS[1]) + "</th></tr></thead><tbody>\n" +
      rows.map((row) => `<tr><td>${row[0]}</td><td>${esc(row[1])}</td><td>${esc(row[2])}</td></tr>`).join("\n") +
      "\n</tbody></table></body></html>\n";
  }
  return `${XML_HEAD}\n<dictionary count="${entries.length}">\n` +
    rows.map((row) => `  <entry no="${row[0]}"><key>${esc(row[1])}</key><value>${esc(row[2])}</value></entry>`).join("\n") +
    "\n</dictionary>\n";
}

/**
 * Build a downloadable file for the chosen format.
 * @returns {{ ext: string, blob: Blob }}
 */
export function buildFile(format, entries) {
  const ext = EXT[format] || "json";
  switch (format) {
    case "json": {
      const object = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
      return { ext, blob: new Blob([JSON.stringify(object, null, 2)], { type: "application/json" }) };
    }
    case "xlsx":
      return { ext, blob: buildXlsx(entries) };
    case "docx":
      return { ext, blob: buildDocx(entries) };
    case "csv":
      return { ext, blob: new Blob([buildText("csv", entries)], { type: "text/csv;charset=utf-8" }) };
    case "tsv":
      return { ext, blob: new Blob([buildText("tsv", entries)], { type: "text/tab-separated-values;charset=utf-8" }) };
    case "txt":
      return { ext, blob: new Blob([buildText("txt", entries)], { type: "text/plain;charset=utf-8" }) };
    case "md":
      return { ext, blob: new Blob([buildText("md", entries)], { type: "text/markdown;charset=utf-8" }) };
    case "html":
      return { ext, blob: new Blob([buildText("html", entries)], { type: "text/html;charset=utf-8" }) };
    case "xml":
      return { ext, blob: new Blob([buildText("xml", entries)], { type: "application/xml;charset=utf-8" }) };
    default:
      throw new Error(`Unknown format "${format}".`);
  }
}
