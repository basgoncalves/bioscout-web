/**
 * proc_io.js -- reading lab files for the Process page.
 *
 * Every reader returns one or more DATASETS:
 *   { name, kind, fs, time: Float64Array, cols: { name: Float64Array }, units: {}, meta: {} }
 * A file with two sampling rates (a Vicon CSV's Devices and Trajectories, a
 * C3D's analog and marker data) becomes two datasets, never one resampled one:
 * resampling silently is how a 1000 Hz force trace ends up at 100 Hz.
 *
 * The readers follow the course's bd2ii_tools.py (BD2II 2026W) so that the
 * numbers on this page and in the students' Colab notebooks agree:
 * read_vicon_csv, read_opensim, read_nexus_export.
 */

const num = (s) => {
  if (s == null) return NaN;
  const t = String(s).trim();
  if (t === "") return NaN;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
};

function medianStep(t) {
  const d = [];
  for (let i = 1; i < t.length && d.length < 2000; i++) { const x = t[i] - t[i - 1]; if (x > 0) d.push(x); }
  d.sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : NaN;
}

/** Build a dataset from a header + numeric rows; a column named like time becomes the time base. */
export function fromTable(name, header, rows, { fs = null, units = {}, kind = "table", meta = {} } = {}) {
  const n = rows.length;
  const cols = {};
  const seen = new Map();
  const names = header.map((h, j) => {
    let k = String(h ?? "").trim() || `col${j + 1}`;
    if (seen.has(k)) { const c = seen.get(k) + 1; seen.set(k, c); k = `${k} (${c})`; } else seen.set(k, 1);
    return k;
  });
  names.forEach((k, j) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = num(rows[i][j]);
    cols[k] = a;
  });
  // a column with no numbers is kept as text (participant labels, sides, ...) in meta.text
  const text = {};
  names.forEach((k, j) => {
    if (cols[k].some(Number.isFinite)) return;
    const v = rows.map((r) => String(r[j] ?? "").trim());
    if (v.some(Boolean)) text[k] = v;
    delete cols[k];
  });
  if (Object.keys(text).length) meta.text = text;
  const tKey = Object.keys(cols).find((k) => /^(time|time_s|time \(s\)|t|zeit|frame time)$/i.test(k.trim()));
  let time;
  if (tKey) {
    time = cols[tKey]; delete cols[tKey];
    const dt = medianStep(time);
    if (!fs && dt > 0) fs = 1 / dt;
  } else {
    fs = fs || 1;
    time = Float64Array.from({ length: n }, (_, i) => i / fs);
    meta.noTime = !fs || fs === 1;
  }
  return { name, kind, fs, time, cols, units, meta };
}

function splitLine(line, sep) {
  if (sep !== ",") return line.split(sep);
  if (!line.includes('"')) return line.split(",");
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const blank = (l) => !l || !l.trim().replace(/[,;\t]/g, "");

/** One section ('Devices' or 'Trajectories' ...) of a Vicon Nexus CSV export. */
export function readViconSection(lines, start, fileName) {
  const section = lines[start].trim().replace(/,+$/, "");
  const fs = num(lines[start + 1].split(",")[0]);
  const groups = splitLine(lines[start + 2], ",");
  const names = splitLine(lines[start + 3], ",");
  const unitsRow = splitLine(lines[start + 4] || "", ",");
  let end = lines.length;
  for (let i = start + 5; i < lines.length; i++) if (blank(lines[i])) { end = i; break; }
  let cur = "";
  const header = names.map((n, j) => {
    const g = (groups[j] || "").trim();
    cur = g || cur;
    const nm = n.trim();
    return cur ? `${cur} - ${nm}` : nm;
  });
  const rows = [];
  for (let i = start + 5; i < end; i++) rows.push(splitLine(lines[i], ","));
  const units = {};
  header.forEach((h, j) => { if (unitsRow[j]) units[h] = unitsRow[j].trim(); });
  const ds = fromTable(`${fileName} · ${section}`, header, rows, { fs, units, kind: "vicon" });
  // Frame / Sub Frame are counters, not signals
  delete ds.cols["Frame"]; delete ds.cols["Sub Frame"];
  ds.time = Float64Array.from({ length: rows.length }, (_, i) => i / fs);
  ds.meta = { section, source: fileName };
  return { ds, end };
}

function mostlyNum(cells) {
  const vals = cells.filter((c) => String(c).trim() !== "");
  return vals.length > 0 && vals.filter((c) => Number.isFinite(Number(c))).length * 2 >= vals.length;
}

function isNumRow(cells) {
  const vals = cells.filter((c) => c.trim() !== "");
  return vals.length > 0 && vals.every((c) => Number.isFinite(Number(c)));
}

/** Any delimited text file: Vicon sections, Nexus ASCII export, or a plain table. */
export function readDelimited(text, fileName) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  // Vicon Nexus CSV: a line that is just "Devices" / "Trajectories" / "Model Outputs" ..., then the rate.
  const secs = [];
  for (let i = 0; i < lines.length - 4; i++) {
    const l = lines[i].trim().replace(/,+$/, "");
    if (/^(Devices|Trajectories|Model Outputs|Segments|Joints)$/i.test(l) && Number.isFinite(num(lines[i + 1].split(",")[0]))) secs.push(i);
  }
  if (secs.length) return secs.map((s) => readViconSection(lines, s, fileName).ds);
  const sep = (lines.slice(0, 30).join("\n").match(/\t/g) || []).length > (lines.slice(0, 30).join("\n").match(/,/g) || []).length ? "\t"
    : (lines.slice(0, 30).join("\n").match(/;/g) || []).length > (lines.slice(0, 30).join("\n").match(/,/g) || []).length ? ";" : ",";
  const cells = lines.map((l) => splitLine(l, sep));
  // Nexus "Export data to ASCII": metadata rows, then a row starting with "Time", a units row, data.
  const tRow = cells.findIndex((c) => (c[0] || "").trim() === "Time");
  if (tRow >= 0 && tRow + 2 < cells.length && !isNumRow(cells[tRow + 1])) {
    const header = cells[tRow].map((c) => String(c).replace("EMG Channels.", "").trim());
    header[0] = "time";
    const rows = cells.slice(tRow + 2).filter((c) => isNumRow(c));
    return [fromTable(fileName, header, rows, { kind: "nexus" })];
  }
  // Plain table: the last non-numeric line before the first numeric one is the header.
  let first = cells.findIndex((c) => isNumRow(c));
  if (first < 0) first = cells.findIndex((c, i) => i > 0 && mostlyNum(c));
  if (first < 0) throw new Error("no numeric rows found");
  const header = first > 0 ? cells[first - 1] : cells[first].map((_, j) => `col${j + 1}`);
  const rows = [];
  for (let i = first; i < cells.length; i++) if (!blank(lines[i])) rows.push(cells[i]);
  return [fromTable(fileName, header, rows, { kind: "table" })];
}

/** OpenSim .mot / .sto (any version): header up to `endheader`, then a whitespace table. */
export function readOpenSim(text, fileName) {
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => l.trim().toLowerCase() === "endheader");
  if (h < 0) throw new Error("not an OpenSim file (no endheader)");
  const meta = {};
  for (const l of lines.slice(0, h)) { const m = l.match(/^\s*(\w+)\s*=\s*(.*)$/); if (m) meta[m[1]] = m[2].trim(); }
  const header = lines[h + 1].trim().split(/\s+/);
  const rows = [];
  for (let i = h + 2; i < lines.length; i++) { const l = lines[i].trim(); if (l) rows.push(l.split(/\s+/)); }
  const ds = fromTable(fileName, header, rows, { kind: "opensim", meta });
  ds.meta = { ...meta, inDegrees: !/^no$/i.test(meta.inDegrees || "yes"), title: lines[0].trim() };
  return [ds];
}

/** OpenSim/Vicon .trc marker file: X/Y/Z per marker. */
export function readTrc(text, fileName) {
  const lines = text.split(/\r?\n/);
  const keys = lines[1].split("\t"), vals = lines[2].split("\t");
  const info = {}; keys.forEach((k, i) => { info[k.trim()] = (vals[i] || "").trim(); });
  const markers = lines[3].split("\t");
  const header = [];
  let cur = "";
  for (let j = 0; j < markers.length; j++) {
    if (j === 0) { header.push("Frame#"); continue; }
    if (j === 1) { header.push("time"); continue; }
    if (markers[j].trim()) cur = markers[j].trim();
    header.push(`${cur} ${["X", "Y", "Z"][(j - 2) % 3]}`);
  }
  const rows = [];
  for (let i = 5; i < lines.length; i++) if (lines[i].trim()) rows.push(lines[i].split("\t"));
  const ds = fromTable(fileName, header, rows, { kind: "trc", fs: num(info.DataRate) || null });
  delete ds.cols["Frame#"];
  ds.meta = { units: info.Units || "", markers: markers.slice(2).map((m) => m.trim()).filter(Boolean) };
  for (const k of Object.keys(ds.cols)) ds.units[k] = info.Units || "";
  return [ds];
}

// ---- XLSX (first sheet with data) ----------------------------------------------
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

/** Minimal unzip: { path: Uint8Array } from a zip archive. */
export async function unzip(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
    const data = b.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    files[name] = { method, data };
    p += 46 + nl + xl + cl;
  }
  return {
    names: Object.keys(files),
    async text(name) {
      const f = files[name]; if (!f) return null;
      const raw = f.method === 0 ? f.data : await inflateRaw(f.data);
      return dec.decode(raw);
    },
  };
}

const xmlUnesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function colIndex(ref) {
  const m = ref.match(/^([A-Z]+)/); let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

/** Cells of the first worksheet as a 2-D array of strings. */
export async function readXlsxCells(buf) {
  const z = await unzip(buf);
  const ss = [];
  const sst = await z.text("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) ss.push(xmlUnesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
  const sheets = z.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  for (const sh of sheets) {
    const xml = await z.text(sh);
    const rows = [];
    for (const r of xml.matchAll(/<row[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const ri = +r[1] - 1, row = [];
      for (const c of r[2].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = (c[1].match(/r="([A-Z]+\d+)"/) || [])[1]; if (!ref) continue;
        const type = (c[1].match(/t="(\w+)"/) || [])[1];
        const body = c[2] || "";
        let v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (type === "s") v = ss[+v];
        else if (type === "inlineStr") v = xmlUnesc((body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || "");
        else if (v != null) v = xmlUnesc(v);
        row[colIndex(ref)] = v ?? "";
      }
      rows[ri] = row;
    }
    const out = Array.from(rows, (r) => Array.from(r || [], (x) => x ?? ""));
    if (out.some((r) => r.length)) return out;
  }
  return [];
}

export async function readXlsx(buf, fileName) {
  const cells = await readXlsxCells(buf);
  const text = cells.map((r) => r.map((c) => (/[\x22,]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  return readDelimited(text, fileName);
}

// ---- C3D ---------------------------------------------------------------------------
/**
 * C3D: markers and analog channels, Intel / DEC / MIPS, integer or float.
 * Force plates of type 2 and 4 are also given as named channels
 * ("FP1 Fx" ... "FP1 Mz", in N and N·mm, plate axes, CAL_MATRIX applied for type 4)
 * plus their centre of pressure ("FP1 CoPx/CoPy", mm, plate axes).
 */
export function readC3d(buf, fileName) {
  const b = new Uint8Array(buf);
  if (b[1] !== 0x50) throw new Error("not a C3D file");
  const pBlock = b[0];
  const pStart = (pBlock - 1) * 512;
  const proc = b[pStart + 3];               // 84 Intel, 85 DEC, 86 MIPS
  const le = proc !== 86;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const i16 = (o) => dv.getInt16(o, le), u16 = (o) => dv.getUint16(o, le);
  const f32 = (o) => {
    if (proc !== 85) return dv.getFloat32(o, le);
    // DEC float: swap 16-bit halves, read as IEEE, divide by 4
    const t = new DataView(new ArrayBuffer(4));
    t.setUint8(0, b[o + 2]); t.setUint8(1, b[o + 3]); t.setUint8(2, b[o]); t.setUint8(3, b[o + 1]);
    return t.getFloat32(0, true) / 4;
  };
  // parameters
  const P = {};
  let o = pStart + 4;
  const groups = {};
  const dec = new TextDecoder("latin1");
  for (let guard = 0; guard < 10000; guard++) {
    const nl = dv.getInt8(o), id = dv.getInt8(o + 1);
    if (nl === 0) break;
    const name = dec.decode(b.subarray(o + 2, o + 2 + Math.abs(nl))).toUpperCase();
    const nextRel = i16(o + 2 + Math.abs(nl));
    const body = o + 4 + Math.abs(nl);
    if (id < 0) groups[-id] = name;
    else {
      const type = dv.getInt8(body), nd = b[body + 1];
      const dims = []; for (let d = 0; d < nd; d++) dims.push(b[body + 2 + d]);
      let q = body + 2 + nd;
      const count = dims.reduce((a, c) => a * c, 1);
      let val;
      if (type === -1) {
        const w = dims[0] || 1, nstr = count / w || 1, arr = [];
        for (let s = 0; s < nstr; s++) arr.push(dec.decode(b.subarray(q + s * w, q + (s + 1) * w)).trim());
        val = nd <= 1 ? arr[0] : arr;
      } else {
        const arr = [];
        for (let k = 0; k < count; k++) arr.push(type === 1 ? dv.getInt8(q + k) : type === 2 ? i16(q + 2 * k) : f32(q + 4 * k));
        val = { v: arr, dims };
      }
      (P[id] = P[id] || {})[name] = val;
    }
    if (nextRel === 0) break;
    o = o + 2 + Math.abs(nl) + nextRel;
  }
  const par = {};
  for (const [id, ps] of Object.entries(P)) par[groups[id] || "G" + id] = ps;
  const g = (grp, nm) => (par[grp] || {})[nm];
  const numv = (grp, nm, d) => { const x = g(grp, nm); return x && x.v ? x.v : d; };
  const strs = (grp, nm) => { const x = g(grp, nm); return x == null ? [] : Array.isArray(x) ? x : [x]; };
  // header
  const nPts = u16(2), nAnPerFrame = u16(4), first = u16(6), last = u16(8);
  const scale = f32(12), dataBlock = u16(16), anPerFrame = u16(18), rate = f32(20);
  const nFrames = last - first + 1;
  const isFloat = scale < 0;
  const nAn = anPerFrame ? nAnPerFrame / anPerFrame : 0;
  const ptRate = numv("POINT", "RATE", [rate])[0] || rate;
  const labels = strs("POINT", "LABELS").concat(strs("POINT", "LABELS2"));
  const anLabels = strs("ANALOG", "LABELS").concat(strs("ANALOG", "LABELS2"));
  const anScale = numv("ANALOG", "SCALE", []), anOff = numv("ANALOG", "OFFSET", []);
  const gen = numv("ANALOG", "GEN_SCALE", [1])[0];
  const anUnits = strs("ANALOG", "UNITS");
  const ptUnits = strs("POINT", "UNITS")[0] || "mm";
  const pts = Array.from({ length: nPts * 3 }, () => new Float64Array(nFrames));
  const an = Array.from({ length: nAn }, () => new Float64Array(nFrames * anPerFrame));
  let q = (dataBlock - 1) * 512;
  const w = isFloat ? 4 : 2;
  const rd = isFloat ? f32 : i16;
  const unsignedAn = /UNSIGNED/i.test(strs("ANALOG", "FORMAT")[0] || "");
  for (let f = 0; f < nFrames; f++) {
    for (let p = 0; p < nPts; p++) {
      const x = rd(q), y = rd(q + w), z = rd(q + 2 * w), r = rd(q + 3 * w);
      const s = isFloat ? 1 : Math.abs(scale);
      const missing = r < 0 || (x === 0 && y === 0 && z === 0);
      pts[3 * p][f] = missing ? NaN : x * s; pts[3 * p + 1][f] = missing ? NaN : y * s; pts[3 * p + 2][f] = missing ? NaN : z * s;
      q += 4 * w;
    }
    for (let s = 0; s < anPerFrame; s++) for (let c = 0; c < nAn; c++) {
      const raw = isFloat ? f32(q) : unsignedAn ? u16(q) : i16(q);
      an[c][f * anPerFrame + s] = (raw - (anOff[c] || 0)) * (anScale[c] ?? 1) * gen;
      q += w;
    }
  }
  const out = [];
  if (nPts) {
    const cols = {}, units = {};
    labels.slice(0, nPts).forEach((lb, p) => ["X", "Y", "Z"].forEach((ax, k) => {
      const key = `${lb || "P" + (p + 1)} ${ax}`; cols[key] = pts[3 * p + k]; units[key] = ptUnits;
    }));
    out.push({ name: `${fileName} · markers`, kind: "c3d", fs: ptRate, units, meta: { markers: labels.slice(0, nPts) },
      time: Float64Array.from({ length: nFrames }, (_, i) => i / ptRate), cols });
  }
  if (nAn) {
    const fsA = numv("ANALOG", "RATE", [ptRate * anPerFrame])[0] || ptRate * anPerFrame;
    const cols = {}, units = {};
    anLabels.slice(0, nAn).forEach((lb, c) => { const k = lb || `A${c + 1}`; cols[cols[k] ? `${k} (${c + 1})` : k] = an[c]; units[k] = anUnits[c] || ""; });
    // force plates
    const used = numv("FORCE_PLATFORM", "USED", [0])[0];
    const types = numv("FORCE_PLATFORM", "TYPE", []);
    const ch = g("FORCE_PLATFORM", "CHANNEL");
    const origin = numv("FORCE_PLATFORM", "ORIGIN", []);
    const cal = g("FORCE_PLATFORM", "CAL_MATRIX");
    for (let k = 0; k < used && ch; k++) {
      const per = ch.dims[0] || 6;
      const idx = ch.v.slice(k * per, k * per + 6).map((i) => i - 1);
      if (idx.some((i) => i < 0 || i >= nAn) || ![2, 4].includes(types[k])) continue;
      let F = idx.map((i) => an[i]);
      if (types[k] === 4 && cal) {
        const m = cal.v.slice(k * 36, k * 36 + 36);
        F = [0, 1, 2, 3, 4, 5].map((r) => { const a = new Float64Array(F[0].length);
          for (let i = 0; i < a.length; i++) { let s = 0; for (let c = 0; c < 6; c++) s += m[c * 6 + r] * F[c][i]; a[i] = s; } return a; });
      }
      const [fx, fy, fz, mx, my, mz] = F;
      const name = `FP${k + 1}`;
      ["Fx", "Fy", "Fz", "Mx", "My", "Mz"].forEach((nm, j) => { cols[`${name} ${nm}`] = F[j]; units[`${name} ${nm}`] = j < 3 ? "N" : "N·mm"; });
      const oz = origin.length >= 3 * (k + 1) ? origin[3 * k + 2] : 0;
      const cx = new Float64Array(fz.length), cy = new Float64Array(fz.length);
      for (let i = 0; i < fz.length; i++) {
        const ok = Math.abs(fz[i]) > 10;
        cx[i] = ok ? (-my[i] + oz * fx[i] * (oz > 0 ? -1 : 1)) / fz[i] : NaN;
        cy[i] = ok ? (mx[i] + oz * fy[i] * (oz > 0 ? -1 : 1)) / fz[i] : NaN;
      }
      cols[`${name} CoPx`] = cx; cols[`${name} CoPy`] = cy; units[`${name} CoPx`] = units[`${name} CoPy`] = "mm";
      void mz;
    }
    out.push({ name: `${fileName} · analog`, kind: "c3d", fs: fsA, units, meta: { plates: used || 0 },
      time: Float64Array.from({ length: nFrames * anPerFrame }, (_, i) => i / fsA), cols });
  }
  if (!out.length) throw new Error("the C3D file holds no data");
  return out;
}

/** Read any supported file. `file` is a File/Blob with a name. */
export async function readAny(file) {
  const name = file.name || "file";
  const ext = name.toLowerCase().split(".").pop();
  const buf = await file.arrayBuffer();
  if (ext === "c3d") return readC3d(buf, name);
  if (ext === "xlsx" || ext === "xlsm") return readXlsx(buf, name);
  const text = new TextDecoder().decode(buf);
  if (ext === "trc" || /^PathFileType/i.test(text.slice(0, 40))) return readTrc(text, name);
  if (ext === "mot" || ext === "sto" || /^\s*endheader\s*$/im.test(text.slice(0, 6000))) return readOpenSim(text, name);
  return readDelimited(text, name);
}

/** A dataset as CSV text (time first). */
export function toCsv(ds, keys = Object.keys(ds.cols)) {
  const head = ["time", ...keys].map((k) => (/[\x22,]/.test(k) ? `"${k.replace(/"/g, '""')}"` : k)).join(",");
  const lines = [head];
  for (let i = 0; i < ds.time.length; i++) {
    lines.push([ds.time[i], ...keys.map((k) => ds.cols[k][i])].map((v) => (Number.isFinite(v) ? +v.toPrecision(8) : "")).join(","));
  }
  return lines.join("\n");
}
