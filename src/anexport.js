/**
 * anexport.js -- what Analysis hands over: a zip that opens everywhere.
 *
 *   results.xlsx        every results table, one sheet each (Excel, JASP, SPSS)
 *   tables/*.csv        the same tables as CSV
 *   figures/*.svg|.png  every figure, print colours
 *   data/data_wide.csv  the analysed data, one row per case, ready for JASP
 *   data/data_spss.csv  same, SPSS-safe names + numeric codes for nominal variables
 *   analysis.sps        SPSS syntax that loads data_spss.csv and repeats the analysis
 *   analysis.py         Python (pandas + pingouin / spm1d) that repeats it
 *   README.txt          what is where, the variable-name map, how to open it in JASP
 *
 * The xlsx is written by hand (store-only zip, inline strings): no library, and
 * Excel, LibreOffice, JASP and SPSS all read it.
 */
import { makeZip } from "./zip.js";
import { lightSvg, svgStringToPng } from "./anfigs.js";

const xesc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

function colName(i) { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/** sheets: [{ name, rows: [[cell...]] }] -> Blob (.xlsx). First row of each sheet is bold. */
export function makeXlsx(sheets) {
  const used = new Set();
  const safe = sheets.map((s, i) => {
    let n = String(s.name || "Sheet" + (i + 1)).replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || "Sheet" + (i + 1);
    let k = 2; const base = n.slice(0, 28);
    while (used.has(n.toLowerCase())) n = `${base} ${k++}`;
    used.add(n.toLowerCase()); return { ...s, name: n };
  });
  const sheetXml = (rows) => {
    const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : "";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
      if (v == null || v === "" || (typeof v === "number")) return `<c r="${ref}"${st}/>`;
      return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
    }).join("")}</row>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>` },
    ...safe.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];
  return makeZip(files);
}

export function csvOf(rows) {
  return rows.map((r) => r.map((v) => {
    if (v == null) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(+v.toPrecision(10)) : "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n") + "\r\n";
}

/** SPSS / Python safe variable name. */
export function safeName(name, used = new Set()) {
  let s = String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!/^[A-Za-z]/.test(s)) s = "v_" + s;
  s = s.slice(0, 60) || "v";
  const reserved = /^(ALL|AND|BY|EQ|GE|GT|LE|LT|NE|NOT|OR|TO|WITH)$/i;
  if (reserved.test(s)) s += "_";
  let out = s, k = 2;
  while (used.has(out.toLowerCase())) out = `${s}_${k++}`;
  used.add(out.toLowerCase());
  return out;
}

/**
 * The analysed table, both ways.
 * vars: [{ name, type: "scale" | "nominal", values: [] }]
 * Returns { wide, spss, map: [{ orig, safe, code?: [[label, code]] }] }.
 */
export function dataFiles(vars) {
  const used = new Set(), map = [];
  const n = Math.max(0, ...vars.map((v) => v.values.length));
  const wide = [vars.map((v) => v.name)], spss = [[]];
  for (const v of vars) {
    const s = safeName(v.name, used), m = { orig: v.name, safe: s, type: v.type };
    spss[0].push(s);
    if (v.type === "nominal") {
      const lv = [...new Set(v.values.filter((x) => x != null && x !== ""))].sort((a, b) => (isFinite(a) && isFinite(b) ? a - b : String(a).localeCompare(String(b))));
      m.levels = lv; m.codeName = safeName(s + "_code", used); spss[0].push(m.codeName);
    }
    map.push(m);
  }
  for (let i = 0; i < n; i++) {
    const w = [], s = [];
    vars.forEach((v, j) => {
      const x = v.values[i];
      w.push(x); s.push(x);
      if (map[j].levels) s.push(x == null || x === "" ? "" : map[j].levels.indexOf(x) + 1);
    });
    wide.push(w); spss.push(s);
  }
  return { wide, spss, map };
}

export function spssLoad(map, file = "data_spss.csv") {
  const fmt = [];
  for (const m of map) {
    fmt.push(`  ${m.safe} ${m.type === "nominal" ? "A64" : "F12.6"}`);
    if (m.codeName) fmt.push(`  ${m.codeName} F4.0`);
  }
  const labels = map.filter((m) => m.levels).map((m) => `VALUE LABELS ${m.codeName} ${m.levels.map((l, i) => `${i + 1} '${String(l).replace(/'/g, "''")}'`).join(" ")}.`);
  const varlabels = map.filter((m) => m.safe !== m.orig).map((m) => `VARIABLE LABELS ${m.safe} '${String(m.orig).replace(/'/g, "''")}'.`);
  return [
    "* BioScout Web -- Analysis. Generated " + new Date().toISOString().slice(0, 16).replace("T", " ") + ".",
    "* Run from the export folder, or write the full path of data_spss.csv below.",
    `GET DATA /TYPE=TXT /FILE='${file}' /ENCODING='UTF8' /DELCASE=LINE /DELIMITERS="," /QUALIFIER='"' /ARRANGEMENT=DELIMITED /FIRSTCASE=2`,
    " /VARIABLES=",
    ...fmt.map((l, i) => l + (i === fmt.length - 1 ? "." : "")),
    ...varlabels, ...labels,
    ...map.filter((m) => m.type === "scale").length ? [`VARIABLE LEVEL ${map.filter((m) => m.type === "scale").map((m) => m.safe).join(" ")} (SCALE).`] : [],
    ...map.filter((m) => m.codeName).length ? [`VARIABLE LEVEL ${map.filter((m) => m.codeName).map((m) => m.codeName).join(" ")} (NOMINAL).`] : [],
    "DATASET NAME bioscout WINDOW=FRONT.",
    "",
  ].join("\n");
}

export const pyHeader = (extra = "") => `"""BioScout Web -- Analysis. Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}.

Repeats the analysis done in the browser. Run from this folder:
    pip install pandas numpy pingouin statsmodels matplotlib${extra}
    python analysis.py
"""
import numpy as np
import pandas as pd
`;

/**
 * Build and download the zip.
 *   bundle: { base, tables: [{ name, rows }], figures: [{ name, svg }], files: [{ name, data }], readme }
 */
export async function exportBundle(bundle, download) {
  const files = [];
  const xlsx = makeXlsx(bundle.tables);
  files.push({ name: "results.xlsx", data: new Uint8Array(await xlsx.arrayBuffer()) });
  for (const t of bundle.tables) files.push({ name: `tables/${safeName(t.name)}.csv`, data: "﻿" + csvOf(t.rows) });
  for (const f of bundle.figures) {
    const svg = lightSvg(f.svg), nm = safeName(f.name);
    files.push({ name: `figures/${nm}.svg`, data: svg });
    const png = await svgStringToPng(svg);
    if (png) files.push({ name: `figures/${nm}.png`, data: new Uint8Array(await png.arrayBuffer()) });
  }
  for (const f of bundle.files || []) files.push(f);
  files.push({ name: "README.txt", data: bundle.readme });
  download(`${bundle.base}_${new Date().toISOString().slice(0, 10)}.zip`, makeZip(files));
}
