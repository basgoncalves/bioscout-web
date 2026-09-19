/**
 * mot.mjs -- read (and write) OpenSim storage files: .mot, .sto, and the CSV
 * an IK pipeline often spits out instead.
 *
 * The ground truth in this harness is whatever the lab produced: usually
 * inverse-kinematics output, one column per coordinate, one row per sample,
 * degrees. This reads that without OpenSim installed and without pandas.
 *
 * The header is free-form up to `endheader`; the only keys that change how the
 * numbers are read are `inDegrees` and `nColumns`. Anything else is kept in
 * `meta` so the report can say which file and which model produced it.
 */

import { readFileSync, writeFileSync } from "node:fs";

/**
 * @returns {{time:number[], cols:Object<string,number[]>, names:string[],
 *            inDegrees:boolean, meta:Object}}
 */
export function readStorage(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const meta = {};
  let i = 0, sawHeader = false;

  // .mot/.sto: free-form header, then `endheader`. A bare CSV has neither, so
  // the first line is already the column names -- detected by there being no
  // `endheader` anywhere rather than by guessing from the first line.
  const hasHeader = lines.some((l) => /^\s*endheader\s*$/i.test(l));
  if (hasHeader) {
    for (; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^endheader$/i.test(l)) { i++; sawHeader = true; break; }
      const m = /^([A-Za-z_][\w ]*)\s*=\s*(.*)$/.exec(l);
      if (m) meta[m[1].trim()] = m[2].trim();
      else if (l && !meta.title) meta.title = l;
    }
    if (!sawHeader) throw new Error(`${path}: header never ends (no 'endheader')`);
  }

  const split = (l) => l.trim().split(/[\t,]\s*|\s{2,}| +/).filter((s) => s !== "");
  while (i < lines.length && !lines[i].trim()) i++;
  const names = split(lines[i++]);
  if (!names.length) throw new Error(`${path}: no column names`);

  const cols = {};
  for (const n of names) cols[n] = [];
  const time = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const v = split(l).map(Number);
    if (v.length < names.length) continue;          // a ragged trailing line
    if (v.some((x) => !Number.isFinite(x))) continue;
    names.forEach((n, k) => cols[n].push(v[k]));
    time.push(v[0]);
  }
  if (!time.length) throw new Error(`${path}: no data rows`);

  // inDegrees defaults to yes for .mot coordinates, which is what every IK
  // setup this is pointed at writes. Radians are converted here, once, so
  // nothing downstream has to carry a unit flag around.
  const inDegrees = !/^no$/i.test(meta.inDegrees ?? "yes");
  if (!inDegrees) {
    for (const n of names) {
      if (n === names[0]) continue;
      if (/_t[xyz]$/.test(n) || /force|moment|_v[xyz]$/i.test(n)) continue;
      cols[n] = cols[n].map((v) => v * 180 / Math.PI);
    }
  }
  return { time, cols, names: names.slice(1), inDegrees: true, meta, path };
}

/** Linear resample of one channel onto arbitrary times; NaN outside the range. */
export function resample(time, values, at) {
  const out = new Array(at.length).fill(NaN);
  let k = 0;
  for (let j = 0; j < at.length; j++) {
    const t = at[j];
    if (t < time[0] || t > time[time.length - 1]) continue;
    while (k < time.length - 2 && time[k + 1] < t) k++;
    const t0 = time[k], t1 = time[k + 1];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    out[j] = values[k] + f * (values[k + 1] - values[k]);
  }
  return out;
}

/** Write a storage file -- used by the self-test to make fixtures. */
export function writeStorage(path, time, cols, { title = "gt", inDegrees = true } = {}) {
  const names = Object.keys(cols);
  const head = [
    title,
    `version=1`,
    `nRows=${time.length}`,
    `nColumns=${names.length + 1}`,
    `inDegrees=${inDegrees ? "yes" : "no"}`,
    `endheader`,
    ["time", ...names].join("\t"),
  ];
  const rows = time.map((t, i) =>
    [t.toFixed(6), ...names.map((n) => Number(cols[n][i]).toFixed(6))].join("\t"));
  writeFileSync(path, head.concat(rows).join("\n") + "\n");
}
