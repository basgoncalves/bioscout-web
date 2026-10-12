/**
 * process.js -- the lab demo's Process page.
 *
 * Load any lab file (Vicon/Nexus CSV, C3D, OpenSim .mot/.sto, .trc, .xlsx,
 * plain CSV), look at it, and run the BD2II course analyses on it: filtering,
 * EMG envelopes, force-plate peaks and contacts, jump height, centre of
 * pressure, joint power and work, mean ± SD curves and paired comparisons.
 *
 * Everything is a COMMAND. A button only writes the command into the box and
 * runs it, so what a student did is a list of lines they can read, copy into
 * a report, and replay on every loaded file ("Run on all files") -- the
 * Project_analysis notebook's batch step without the notebook.
 *
 * The engine (makeProcessor) is pure state + commands, no DOM, and is what
 * tests/test_process.mjs drives. mountProcess() is the page around it.
 * Nothing leaves the device: files are read in the browser.
 */
import { readAny, toCsv } from "./proc_io.js";
import * as D from "./proc_dsp.js";

export const COLORS = ["#2f6fe4", "#e8871a", "#1d7a45", "#c0392b", "#7d5bbe", "#0f8f9c", "#b8860b", "#d6336c"];
const fin = Number.isFinite;
const r3 = (v) => (fin(v) ? +(+v).toPrecision(4) : v);

/** Split a command line into words; "double quotes" keep spaces. */
export function tokenize(line) {
  const out = []; const re = /\x22([^\x22]*)\x22|(\S+)/g; let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}
const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);

export const HELP = [
  ["use <n>", "make file n the current file"],
  ["plot <col> [col ...]", "plot columns (no column: clear the plot)"],
  ["xy <colX> <colY>", "plot one column against another (e.g. CoP)"],
  ["window <t0> <t1> | window all", "limit plots and analyses to a time window (s)"],
  ["crop <t0> <t1>", "cut the current file to a window"],
  ["offset <col>", "remove the mean"],
  ["lowpass <col> <fc> [order]", "zero-lag Butterworth low-pass (default 4th order)"],
  ["highpass <col> <fc> [order]", "zero-lag Butterworth high-pass"],
  ["bandpass <col> <lo> <hi> [order]", "zero-lag Butterworth band-pass"],
  ["smooth <col> <n>", "centred moving average over n samples"],
  ["rectify <col>", "absolute value"],
  ["envelope <col> [ms] [band]", "EMG: offset (or 20-450 Hz band-pass) -> rectify -> moving average"],
  ["normalise <col> <ref|max>", "divide by a reference (e.g. MVC) -> %"],
  ["deriv <col> | integrate <col>", "time derivative / cumulative integral"],
  ["scale <col> <k> | divide <col> <k|bw>", "multiply / divide (bw = this file's body weight)"],
  ["fz [plate]", "vertical ground force from the most loaded plate -> column 'Fz'"],
  ["bw [t0 t1]", "body weight = mean Fz over a quiet window (default first 1 s)"],
  ["stats <col>", "mean, SD, min, max, range, RMS in the window"],
  ["peaks <col> <threshold|1.3bw> [half]", "local maxima above a threshold (Excel template rule)"],
  ["contacts <col> [threshold] [min]", "stance/contact phases, two peaks each, time-normalised curves"],
  ["jump <col> [threshold] [quiet_s]", "jump height from flight time and from impulse"],
  ["cop [plate | colX colY]", "sway: path length, ranges, mean velocity, 95 % ellipse"],
  ["power <moment> <angle>", "joint power (W) and positive/negative work (J); 'n:col' takes a column from file n"],
  ["markererr", "IK marker error: mean RMS and max (cm)"],
  ["meansd <col> [contacts]", "mean ± SD curve across files (or across this file's contacts), 0-100 %"],
  ["compare <measure> <A> <B>", "paired comparison of a results measure between two conditions"],
  ["values <label> <v1> <v2> ...", "typed values (ultrasound, raters): mean, SD, range, CV"],
  ["change <label> <before> <after>", "% change between two typed values"],
  ["all <command>", "run a command on every loaded file"],
];

/**
 * The engine. `t` translates the few words it puts in the results table
 * (it is optional: tests run it without).
 */
export function makeProcessor() {
  const S = { ds: [], cur: -1, results: [], plot: { cols: [], xy: null, curves: null, marks: [] }, win: null, bw: {}, contacts: {}, log: [] };

  const cur = () => { if (S.cur < 0 || !S.ds[S.cur]) throw new Error("load a file first"); return S.ds[S.cur]; };
  const addResult = (ds, analysis, measure, value, unit = "") => {
    const p = D.parseName(ds.name);
    S.results.push({ file: ds.name, participant: p.participant, condition: p.condition, analysis, measure, value: r3(value), unit });
  };

  /** Find a column by exact name, then case-insensitive, then a unique substring. "@fz" is the vertical force. */
  function col(ds, name, { need = true } = {}) {
    if (name == null) { if (need) throw new Error("which column?"); return null; }
    const m = String(name).match(/^(\d+):(.+)$/);
    if (m) {                                           // a column of another file, resampled onto this file's time
      const other = S.ds[+m[1] - 1]; if (!other) throw new Error(`no file ${m[1]}`);
      const k = col(other, m[2]);
      return { key: `${m[1]}:${k.key}`, y: other === ds ? k.y : D.interp(ds.time, other.time, k.y) };
    }
    if (/^@?fz$/i.test(name) && !ds.cols[name]) {
      if (ds.cols.Fz) return { key: "Fz", y: ds.cols.Fz };
      const v = D.verticalForce(ds); return { key: v.col, y: v.y };
    }
    const keys = Object.keys(ds.cols);
    let k = keys.find((c) => c === name) || keys.find((c) => c.toLowerCase() === String(name).toLowerCase());
    if (!k) {
      const hits = keys.filter((c) => c.toLowerCase().includes(String(name).toLowerCase()));
      if (hits.length === 1) k = hits[0];
      else if (hits.length > 1) {
        const ends = hits.filter((c) => c.toLowerCase().endsWith(String(name).toLowerCase()));
        if (ends.length === 1) k = ends[0];
        else throw new Error(`"${name}" matches ${hits.length} columns: ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? ", ..." : ""}`);
      }
    }
    if (!k) throw new Error(`no column "${name}" in ${ds.name}`);
    return { key: k, y: ds.cols[k] };
  }
  const win = (ds) => {
    if (!S.win) return [0, ds.time.length];
    let a = 0; while (a < ds.time.length && ds.time[a] < S.win[0]) a++;
    let b = a; while (b < ds.time.length && ds.time[b] <= S.win[1]) b++;
    if (b - a < 2) throw new Error("the window holds no samples of this file");
    return [a, b];
  };
  const put = (ds, key, y, unit = "", from = null) => {
    ds.cols[key] = Float64Array.from(y); if (unit) ds.units[key] = unit;
    // the raw channel this column was made from (for the raw-vs-processed view)
    const parent = from ?? (S._src && !/^\d+:/.test(S._src) ? S._src : null);
    if (parent && parent !== key) { ds.src = ds.src || {}; ds.src[key] = (ds.src[parent] || parent); }
    if (!S.plot.cols.includes(key)) S.plot.cols.push(key);
    S.plot.xy = null; S.plot.curves = null;
    return key;
  };
  const numArg = (v, d) => (v == null || v === "" ? d : (() => { const x = Number(v); if (!fin(x)) throw new Error(`"${v}" is not a number`); return x; })());
  const bwOf = (ds) => {
    if (S.bw[ds.name]) return S.bw[ds.name];
    const v = D.verticalForce(ds); const n = Math.trunc(1.0 * ds.fs);
    const w = D.mean(Array.from(v.y).slice(0, n)); S.bw[ds.name] = w; return w;
  };

  const C = {
    use([n]) { const i = +n - 1; if (!S.ds[i]) throw new Error(`no file ${n}`); S.cur = i; S.plot = { cols: [], xy: null, curves: null, marks: [] }; return `using ${S.ds[i].name}`; },
    plot(args) { const ds = cur(); S.plot = { cols: args.map((a) => col(ds, a).key).filter((k) => ds.cols[k]), xy: null, curves: null, marks: [] }; return args.length ? `plotting ${S.plot.cols.length} column(s)` : "plot cleared"; },
    xy([a, b]) { const ds = cur(); S.plot = { cols: [], xy: [col(ds, a).key, col(ds, b).key], curves: null, marks: [] }; return "xy plot"; },
    window([a, b]) {
      if (!a || /^(all|off)$/i.test(a)) { S.win = null; return "whole trial"; }
      const t0 = numArg(a), t1 = numArg(b); if (!(t1 > t0)) throw new Error("window needs t0 < t1"); S.win = [t0, t1]; return `window ${t0}-${t1} s`;
    },
    crop([a, b]) {
      const ds = cur(); const t0 = numArg(a), t1 = numArg(b);
      const idx = []; ds.time.forEach((t, i) => { if (t >= t0 && t <= t1) idx.push(i); });
      if (idx.length < 2) throw new Error("nothing inside that window");
      ds.time = Float64Array.from(idx, (i) => ds.time[i]);
      for (const k of Object.keys(ds.cols)) ds.cols[k] = Float64Array.from(idx, (i) => ds.cols[k][i]);
      S.win = null; return `cropped to ${idx.length} samples`;
    },
    offset([c]) { const ds = cur(), k = col(ds, c), m = D.mean(k.y); return put(ds, `${k.key}·off`, k.y.map((v) => v - m), ds.units[k.key]); },
    lowpass([c, fc, ord]) { const ds = cur(), k = col(ds, c); fc = numArg(fc); if (!(fc > 0 && fc < ds.fs / 2)) throw new Error(`cut-off must be between 0 and ${ds.fs / 2} Hz`);
      return put(ds, `${k.key}·lp${fc}`, D.lowpass(D.nanToNum(k.y), ds.fs, fc, numArg(ord, 4)), ds.units[k.key]); },
    highpass([c, fc, ord]) { const ds = cur(), k = col(ds, c); fc = numArg(fc); return put(ds, `${k.key}·hp${fc}`, D.highpass(D.nanToNum(k.y), ds.fs, fc, numArg(ord, 4)), ds.units[k.key]); },
    bandpass([c, lo, hi, ord]) { const ds = cur(), k = col(ds, c); return put(ds, `${k.key}·bp${lo}-${hi}`, D.bandpass(D.nanToNum(k.y), ds.fs, numArg(lo), numArg(hi), numArg(ord, 4)), ds.units[k.key]); },
    smooth([c, n]) { const ds = cur(), k = col(ds, c); n = numArg(n, 5); return put(ds, `${k.key}·ma${n}`, D.movingAverage(k.y, n), ds.units[k.key]); },
    rectify([c]) { const ds = cur(), k = col(ds, c); return put(ds, `${k.key}·abs`, k.y.map(Math.abs), ds.units[k.key]); },
    envelope([c, ms, band]) {
      const ds = cur(), k = col(ds, c); const w = numArg(ms, 100);
      const e = D.emgEnvelope(k.y, ds.fs, w, band ? [20, 450] : null);
      return put(ds, `${k.key}·env${w}`, e.envelope, ds.units[k.key]);
    },
    normalise([c, ref]) {
      const ds = cur(), k = col(ds, c); const [a, b] = win(ds);
      const r = !ref || /^max$/i.test(ref) ? D.max(Array.from(k.y).slice(a, b)) : numArg(ref);
      if (!(r !== 0)) throw new Error("reference is zero");
      addResult(ds, "normalise", `${k.key} reference`, r, ds.units[k.key] || "");
      return put(ds, `${k.key}·%`, k.y.map((v) => (100 * v) / r), "%");
    },
    deriv([c]) { const ds = cur(), k = col(ds, c); return put(ds, `d(${k.key})/dt`, D.numGradient(k.y, ds.time)); },
    integrate([c]) { const ds = cur(), k = col(ds, c); return put(ds, `∫${k.key}`, D.cumtrapz(D.nanToNum(k.y), ds.time)); },
    scale([c, f]) { const ds = cur(), k = col(ds, c); f = numArg(f); return put(ds, `${k.key}×${f}`, k.y.map((v) => v * f)); },
    divide([c, f]) {
      const ds = cur(), k = col(ds, c);
      const d = /^bw$/i.test(f) ? bwOf(ds) : numArg(f);
      return put(ds, /^bw$/i.test(f) ? `${k.key} (xBW)` : `${k.key}/${f}`, k.y.map((v) => v / d), /^bw$/i.test(f) ? "xBW" : "");
    },
    fz([plate]) { const ds = cur(), v = D.verticalForce(ds, plate || null); put(ds, "Fz", v.y, "N", v.col); return `Fz from ${v.col}`; },
    bw([a, b]) {
      const ds = cur(), v = col(ds, "@fz"); const t0 = numArg(a, 0), t1 = numArg(b, 1);
      const y = []; ds.time.forEach((t, i) => { if (t >= t0 && t < t1) y.push(v.y[i]); });
      const w = D.mean(y); S.bw[ds.name] = w; addResult(ds, "body weight", "body weight", w, "N"); addResult(ds, "body weight", "body mass", w / D.G, "kg");
      return `body weight ${r3(w)} N (${r3(w / D.G)} kg)`;
    },
    stats([c]) {
      const ds = cur(), k = col(ds, c), [a, b] = win(ds);
      const s = D.stats(Array.from(k.y).slice(a, b), Array.from(ds.time).slice(a, b)); const u = ds.units[k.key] || "";
      for (const [m, v] of Object.entries(s)) if (m !== "n") addResult(ds, "stats", `${k.key} ${m}`, v, m.startsWith("t_") ? "s" : u);
      return `mean ${r3(s.mean)}, SD ${r3(s.sd)}, max ${r3(s.max)} at ${r3(s.t_max)} s`;
    },
    peaks([c, thr, half]) {
      const ds = cur(), k = col(ds, c), [a, b] = win(ds);
      const th = /bw$/i.test(String(thr)) ? parseFloat(thr) * bwOf(ds) : numArg(thr);
      const y = Array.from(k.y).slice(a, b);
      const pk = D.simplePeaks(y, th, numArg(half, 50)).map((i) => i + a);
      const vals = pk.map((i) => k.y[i]);
      S.plot = { cols: [k.key], xy: null, curves: null, marks: pk.map((i) => [ds.time[i], k.y[i]]) };
      const [m, s] = D.meanSd(vals); const u = ds.units[k.key] || "";
      addResult(ds, "peaks", `${k.key} n peaks`, pk.length); if (pk.length) { addResult(ds, "peaks", `${k.key} mean peak`, m, u); addResult(ds, "peaks", `${k.key} SD peak`, s, u); }
      return `${pk.length} peaks, mean ${r3(m)} ± ${r3(s)}`;
    },
    contacts([c, thr, mn]) {
      const ds = cur(), k = col(ds, c || "@fz"), [a, b] = win(ds);
      const y = Array.from(k.y).slice(a, b);
      const cs = D.contacts(y, numArg(thr, 20), numArg(mn, 20)).map(([s, e]) => [s + a, e + a]);
      S.contacts[ds.name] = { col: k.key, list: cs };
      const u = ds.units[k.key] || "";
      cs.forEach(([s, e], i) => {
        const st = Array.from(k.y).slice(s, e); const [p1, p2] = D.twoPeaks(st);
        addResult(ds, "contacts", `contact ${i + 1} duration`, (e - s) / ds.fs, "s");
        addResult(ds, "contacts", `contact ${i + 1} peak 1`, p1, u); addResult(ds, "contacts", `contact ${i + 1} peak 2`, p2, u);
      });
      S.plot = { cols: [k.key], xy: null, curves: null, marks: cs.flatMap(([s, e]) => [[ds.time[s], k.y[s]], [ds.time[e - 1], k.y[e - 1]]]) };
      return `${cs.length} contact(s)`;
    },
    jump([c, thr, quiet]) {
      const ds = cur(), k = col(ds, c || "@fz"), [a, b] = win(ds);
      const y = Float64Array.from(k.y).slice(a, b);
      const f = D.jumpHeightFlight(y, ds.fs, numArg(thr, 20)), im = D.jumpHeightImpulse(y, ds.fs, numArg(quiet, 1), numArg(thr, 20));
      addResult(ds, "jump", "height (flight time)", f.height * 100, "cm"); addResult(ds, "jump", "flight time", f.flight, "s");
      addResult(ds, "jump", "height (impulse)", im.height * 100, "cm"); addResult(ds, "jump", "take-off velocity", im.vTakeoff, "m/s");
      S.plot = { cols: [k.key], xy: null, curves: null, marks: [[ds.time[a + f.window[0]], 0], [ds.time[Math.min(a + f.window[1], ds.time.length - 1)], 0]] };
      return `flight ${r3(f.height * 100)} cm, impulse ${r3(im.height * 100)} cm`;
    },
    cop(args) {
      const ds = cur(); let x, y;
      if (args.length >= 2) { x = col(ds, args[0]); y = col(ds, args[1]); }
      else {
        const pairs = D.copPairs(ds); let p = args[0] ? pairs.find((q) => q.plate.startsWith(args[0])) : null;
        if (!p && pairs.length) { // the plate carrying the load
          let best = null; try { best = D.verticalForce(ds).col; } catch { /* no force */ }
          p = (best && pairs.find((q) => best.startsWith(q.plate))) || pairs[0];
        }
        if (!p) throw new Error("no CoP columns: give the two columns, cop <colX> <colY>");
        x = col(ds, p.x); y = col(ds, p.y);
      }
      const [a, b] = win(ds);
      const m = D.copMetrics(x.y.slice(a, b), y.y.slice(a, b), ds.fs);
      for (const [k, v] of Object.entries(m)) addResult(ds, "CoP", k.replace(/_(mm.*)$/, ""), v, k.match(/_(mm.*)$/)?.[1].replace("mm2", "mm²").replace("mm_s", "mm/s") || "");
      S.plot = { cols: [], xy: [x.key, y.key], curves: null, marks: [] };
      return `path ${r3(m.path_length_mm)} mm, ellipse ${r3(m.ellipse95_area_mm2)} mm²`;
    },
    power([mo, an]) {
      const ds = cur(), m = col(ds, mo), a = col(ds, an);
      const angDeg = S.ds.find((d) => d.cols[a.key])?.meta?.inDegrees === false ? a.y.map((v) => (v * 180) / Math.PI) : a.y;
      const p = D.jointPower(m.y, angDeg, ds.time); const [i0, i1] = win(ds);
      const w = D.workPhases(p.slice(i0, i1), ds.time.slice(i0, i1));
      const key = put(ds, `power ${a.key.replace(/^\d+:/, "")}`, p, "W");
      addResult(ds, "power", `${key} peak +`, D.max(p.slice(i0, i1)), "W"); addResult(ds, "power", `${key} peak -`, D.min(p.slice(i0, i1)), "W");
      addResult(ds, "power", `${key} positive work`, w.positive, "J"); addResult(ds, "power", `${key} negative work`, w.negative, "J");
      return `work +${r3(w.positive)} / ${r3(w.negative)} J`;
    },
    markererr() {
      const ds = cur(), rms = col(ds, "marker_error_RMS").y, mx = col(ds, "marker_error_max").y;
      const a = D.mean(rms) * 100, b = D.max(mx) * 100;
      addResult(ds, "IK", "marker error RMS (mean)", a, "cm"); addResult(ds, "IK", "marker error max", b, "cm");
      return `RMS ${r3(a)} cm, max ${r3(b)} cm${b > 4 || a > 2 ? " — above the usual 2 cm RMS / 4 cm max" : ""}`;
    },
    meansd([c, how]) {
      let curves = [], labels = [];
      if (how && /^contacts?$/i.test(how)) {
        const ds = cur(), k = col(ds, c), cs = S.contacts[ds.name];
        if (!cs || !cs.list.length) throw new Error("run contacts first");
        curves = cs.list.map(([s, e]) => D.timeNormalise(k.y.slice(s, e))); labels = cs.list.map((_, i) => `contact ${i + 1}`);
      } else {
        for (const ds of S.ds) {
          let k; try { k = col(ds, c); } catch { continue; }
          let [a, b] = [0, ds.time.length]; try { [a, b] = win(ds); } catch { continue; }
          curves.push(D.timeNormalise(k.y.slice(a, b))); labels.push(ds.name);
        }
      }
      if (!curves.length) throw new Error(`no file has "${c}"`);
      const ms = D.meanSdCurves(curves);
      S.plot = { cols: [], xy: null, curves: { name: c, all: curves, labels, mean: ms.mean, sd: ms.sd }, marks: [] };
      return `${curves.length} curve(s), mean ± SD`;
    },
    compare([measure, A, B]) {
      if (!measure || !A || !B) throw new Error("compare <measure> <A> <B>");
      const rows = S.results.filter((r) => r.measure.toLowerCase().includes(measure.toLowerCase()) && fin(r.value));
      if (!rows.length) throw new Error(`no results called "${measure}"`);
      // group like the project notebook: by condition if A/B are conditions, else by participant
      const byCond = rows.some((r) => r.condition === A) && rows.some((r) => r.condition === B);
      const key = byCond ? "condition" : "participant", other = byCond ? "participant" : "condition";
      const avg = {};
      for (const r of rows) { const g = `${r[other]}|${r[key]}`; (avg[g] = avg[g] || []).push(r.value); }
      const ids = [...new Set(rows.map((r) => r[other]))].filter((id) => avg[`${id}|${A}`] && avg[`${id}|${B}`]);
      if (!ids.length) throw new Error(`no ${other} has both ${A} and ${B} -- name files like P01_${A}_1.csv / P01_${B}_1.csv`);
      const a = ids.map((id) => D.mean(avg[`${id}|${A}`])), b = ids.map((id) => D.mean(avg[`${id}|${B}`]));
      const s = D.pairedSummary(a, b);
      const ds = { name: `compare ${A} vs ${B}` };
      for (const [k, v] of Object.entries(s)) if (k !== "t") addResult(ds, `compare ${measure}`, k, v);
      return `n=${s.n}, mean diff ${r3(s.mean_diff)} (dz ${r3(s.cohens_dz)}${fin(s.p_paired_t) ? `, p ${r3(s.p_paired_t)}` : ""})`;
    },
    values([label, ...vals]) {
      const v = vals.map((x) => numArg(x)); if (v.length < 2) throw new Error("give at least two values");
      const r = D.reliability(v), ds = { name: "typed values" };
      for (const [k, x] of Object.entries(r)) addResult(ds, `values ${label}`, `${label} ${k}`, x, k === "cv_pct" ? "%" : "");
      return `${label}: mean ${r3(r.mean)} ± ${r3(r.sd)}, CV ${r3(r.cv_pct)} %`;
    },
    change([label, a, b]) {
      const x = numArg(a), y = numArg(b), ds = { name: "typed values" };
      addResult(ds, "change", `${label} change`, (100 * (y - x)) / x, "%"); return `${label}: ${r3((100 * (y - x)) / x)} %`;
    },
  };

  function run(line) {
    const words = tokenize(String(line).trim());
    if (!words.length) return { ok: true, msg: "" };
    const [cmd, ...args] = words; const c = cmd.toLowerCase();
    try {
      let msg;
      if (c === "all") {
        if (!args.length) throw new Error("all <command>");
        const keep = S.cur, msgs = [];
        for (let i = 0; i < S.ds.length; i++) {
          S.cur = i;
          S._src = null;
          try { if (args[1]) S._src = col(S.ds[i], args[1]).key; } catch { /* not a column */ }
          try { msgs.push(`${S.ds[i].name}: ${C[args[0].toLowerCase()](args.slice(1))}`); }
          catch (e) { msgs.push(`${S.ds[i].name}: ${e.message}`); }
        }
        S.cur = keep; msg = msgs.join("\n");
      } else {
        if (!C[c]) throw new Error(`unknown command "${cmd}" -- see the command list`);
        S._src = null;
        try { if (args[0] && S.ds[S.cur]) S._src = col(S.ds[S.cur], args[0]).key; } catch { /* not a column */ }
        if (c === "power") S._src = null;
        msg = C[c](args);
      }
      S.log.push(String(line).trim());
      return { ok: true, msg: String(msg ?? "") };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  }

  return {
    S, run, col: (n) => col(cur(), n),
    add(list) { const first = S.ds.length; S.ds.push(...list); if (S.cur < 0 || list.length) S.cur = first; S.plot = { cols: [], xy: null, curves: null, marks: [] }; return list.length; },
    remove(i) { const d = S.ds.splice(i, 1)[0]; if (d) delete S.bw[d.name]; S.cur = Math.min(S.cur, S.ds.length - 1); if (S.cur >= 0 && S.cur === i) S.plot = { cols: [], xy: null, curves: null, marks: [] }; },
    current: () => S.ds[S.cur] || null,
    resultsCsv() {
      const h = ["file", "participant", "condition", "analysis", "measure", "value", "unit"];
      return [h.join(","), ...S.results.map((r) => h.map((k) => { const v = r[k] ?? ""; return /[\x22,\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v; }).join(","))].join("\n");
    },
  };
}

/** Raw channels and what was made from each: { raw: [...], derived: { raw: [keys] } }. */
export function channelTree(ds) {
  const src = ds.src || {}, derived = {};
  for (const [k, r] of Object.entries(src)) if (ds.cols[k] && ds.cols[r]) (derived[r] = derived[r] || []).push(k);
  const raw = Object.keys(ds.cols).filter((k) => !src[k]);
  return { raw, derived };
}

/** Marker triplets: "LASI X/Y/Z" (C3D, .trc) or "LASI - X" (Vicon CSV) -> [{ name, x, y, z }]. */
export function markerTriplets(ds) {
  const out = [];
  for (const k of Object.keys(ds.cols)) {
    const m = k.match(/^(.*?)(?: - | )X$/); if (!m) continue;
    const sep = k.slice(m[1].length, k.length - 1);
    const y = m[1] + sep + "Y", z = m[1] + sep + "Z";
    if (ds.cols[y] && ds.cols[z] && !(ds.src && ds.src[k])) out.push({ name: m[1], x: k, y, z });
  }
  return out;
}

/**
 * Draw one frame of markers on a 2-D canvas: orthographic view, rotated by
 * yaw about the vertical axis and pitched toward the viewer.
 * view: { yaw, pitch, zoom, up: "z"|"y", labels, frame }
 */
export function drawMarkers(ctx, W, H, ds, mk, view, box) {
  const up = view.up === "y" ? 1 : 2, h1 = up === 2 ? 1 : 2;     // horizontal axes: x and (y or z)
  const P = (p) => {
    const a = p[0] - box.c[0], b = p[h1] - box.c[h1], v = p[up] - box.c[up];
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const x1 = a * cy - b * sy, d1 = a * sy + b * cy;           // depth before pitch
    const yv = v * cp - d1 * sp, depth = v * sp + d1 * cp;
    const s = (Math.min(W, H) / box.r) * 0.45 * view.zoom;
    return [W / 2 + x1 * s, H / 2 - yv * s, depth];
  };
  ctx.clearRect(0, 0, W, H);
  // floor grid at the lowest marker height
  ctx.strokeStyle = "rgba(128,128,128,.25)"; ctx.lineWidth = 1;
  const g = box.r, step = niceStep(2 * g, 8);
  for (let i = -Math.ceil(g / step); i <= Math.ceil(g / step); i++) {
    for (const [p0, p1] of [[[i * step, -g], [i * step, g]], [[-g, i * step], [g, i * step]]]) {
      const A = [0, 0, 0], B = [0, 0, 0];
      A[0] = box.c[0] + p0[0]; A[h1] = box.c[h1] + p0[1]; A[up] = box.lo;
      B[0] = box.c[0] + p1[0]; B[h1] = box.c[h1] + p1[1]; B[up] = box.lo;
      const a = P(A), b = P(B); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }
  const f = view.frame, pts = [];
  for (const m of mk) {
    const p = [ds.cols[m.x][f], ds.cols[m.y][f], ds.cols[m.z][f]];
    if (!p.every(Number.isFinite)) continue;
    const q = P(p); pts.push([q, m.name]);
  }
  pts.sort((a, b) => a[0][2] - b[0][2]);
  ctx.font = "11px system-ui, sans-serif";
  for (const [q, name] of pts) {
    const side = /^(L|l_|left)/.test(name) ? "#2f6fe4" : /^(R|r_|right)/.test(name) ? "#e8871a" : "#1d7a45";
    ctx.fillStyle = side; ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, 2 * Math.PI); ctx.fill();
    if (view.labels) { ctx.fillStyle = "rgba(128,128,128,.95)"; ctx.fillText(name, q[0] + 6, q[1] - 4); }
  }
  return pts.length;
}
export function markerBox(ds, mk, up) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const n = ds.time.length, step = Math.max(1, Math.floor(n / 200));
  for (const m of mk) for (let i = 0; i < n; i += step) {
    const p = [ds.cols[m.x][i], ds.cols[m.y][i], ds.cols[m.z][i]];
    if (!p.every(Number.isFinite)) continue;
    for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  }
  if (!Number.isFinite(lo[0])) return null;
  const c = lo.map((v, k) => (v + hi[k]) / 2), r = Math.max(...hi.map((v, k) => v - lo[k])) || 1;
  return { c, r, lo: lo[up === "y" ? 1 : 2] };
}

// ============================================================== drawing
const escX = (s) => String(s).replace(/[&<>\x22]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function niceStep(span, target = 5) {
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || mag;
}
/** At most ~2 points per pixel column: min and max of each bucket, so spikes survive. */
function decimate(x, y, buckets) {
  if (x.length <= buckets * 2) return [Array.from(x), Array.from(y)];
  const X = [], Y = [], per = x.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per), e = Math.min(x.length, Math.floor((b + 1) * per));
    let lo = s, hi = s;
    for (let i = s; i < e; i++) { if (y[i] < y[lo] || !fin(y[lo])) lo = i; if (y[i] > y[hi] || !fin(y[hi])) hi = i; }
    for (const i of lo < hi ? [lo, hi] : [hi, lo]) { X.push(x[i]); Y.push(y[i]); }
  }
  return [X, Y];
}
/**
 * series: [{ x, y, color, label, dash, band:[lo,hi] }]. Returns { svg, map }
 * where map converts a pointer x (0..1 of width) to a data x for the readout.
 */
export function chartSVG({ series, xLabel = "s", yLabel = "", marks = [], equal = false, W = 720, H = 300 }) {
  const L = 64, R = 12, T = 14, B = 38;
  const xs = series.flatMap((s) => Array.from(s.x)).filter(fin);
  const ys = series.flatMap((s) => [...Array.from(s.y), ...(s.band ? [...s.band[0], ...s.band[1]] : [])]).filter(fin);
  if (!xs.length || !ys.length) return { svg: "", x0: 0, x1: 1 };
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 - x0 < 1e-12) { x0 -= 1; x1 += 1; } if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  if (equal) { const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, ax = (W - L - R) / (H - T - B); const sx = Math.max(x1 - x0, (y1 - y0) * ax), sy = sx / ax; x0 = cx - sx / 2; x1 = cx + sx / 2; y0 = cy - sy / 2; y1 = cy + sy / 2; }
  const ys0 = niceStep(y1 - y0); y0 = Math.floor(y0 / ys0) * ys0; y1 = Math.ceil(y1 / ys0) * ys0;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const dp = (st) => (st < 1 ? Math.min(4, Math.ceil(-Math.log10(st))) : 0);
  let g = "";
  for (let v = y0; v <= y1 + ys0 / 2; v += ys0) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--line)"${Math.abs(v) < ys0 / 1e6 ? "" : ' stroke-dasharray="2 3"'}/><text x="${L - 5}" y="${(Y(v) + 3).toFixed(1)}" font-size="13" text-anchor="end" fill="var(--muted)">${v.toFixed(dp(ys0))}</text>`;
  const xs0 = niceStep(x1 - x0, 6);
  for (let v = Math.ceil(x0 / xs0) * xs0; v <= x1 + 1e-9; v += xs0) g += `<line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${T}" y2="${H - B}" stroke="var(--line)" stroke-dasharray="2 3"/><text x="${X(v).toFixed(1)}" y="${H - B + 17}" font-size="13" text-anchor="middle" fill="var(--muted)">${v.toFixed(dp(xs0))}</text>`;
  const buckets = W - L - R;
  const paths = series.map((s) => {
    let band = "";
    if (s.band) {
      const up = Array.from(s.x, (x, i) => `${X(x).toFixed(1)},${Y(s.band[1][i]).toFixed(1)}`);
      const dn = Array.from(s.x, (x, i) => `${X(x).toFixed(1)},${Y(s.band[0][i]).toFixed(1)}`).reverse();
      band = `<polygon points="${up.concat(dn).join(" ")}" fill="${s.color}" fill-opacity=".2" stroke="none"/>`;
    }
    const [px, py] = decimate(s.x, s.y, buckets);
    let d = "", pen = false;
    for (let i = 0; i < px.length; i++) { if (!fin(py[i]) || !fin(px[i])) { pen = false; continue; } d += `${pen ? "L" : "M"}${X(px[i]).toFixed(1)} ${Y(py[i]).toFixed(1)}`; pen = true; }
    return `${band}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.thin ? 1 : 1.6}"${s.dash ? ' stroke-dasharray="5 3"' : ""}${s.thin ? ' stroke-opacity=".45"' : ""}><title>${escX(s.label || "")}</title></path>`;
  }).join("");
  const mk = marks.filter(([x, y]) => fin(x) && fin(y)).map(([x, y]) => `<circle cx="${X(x).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="3.5" fill="none" stroke="var(--warn)" stroke-width="1.6"/>`).join("");
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;touch-action:pan-y" role="img" data-l="${L}" data-r="${R}" data-w="${W}">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="var(--card)"/>${g}${paths}${mk}`
    + `<text x="${W - R}" y="${H - 6}" font-size="13" text-anchor="end" fill="var(--muted)">${escX(xLabel)}</text>`
    + (yLabel ? `<text x="${L + 4}" y="${T + 10}" font-size="13" fill="var(--muted)">${escX(yLabel)}</text>` : "")
    + `<line class="prCursor" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/></svg>`;
  return { svg, x0, x1, L, R, W };
}

// ============================================================== the page
/**
 * Tools: forms that write commands. `f` fields: c = column, n = number, s = text.
 * Labels are i18n keys; the command words stay English (they are the language).
 */
export const TOOLS = [
  { group: "pr_gSignal", items: [
    { k: "pr_tLowpass", f: [["c", "pr_fCol"], ["n", "pr_fCutoff", 10], ["n", "pr_fOrder", 4]], cmd: (v) => `lowpass ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tHighpass", f: [["c", "pr_fCol"], ["n", "pr_fCutoff", 20], ["n", "pr_fOrder", 4]], cmd: (v) => `highpass ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tBandpass", f: [["c", "pr_fCol"], ["n", "pr_fLow", 20], ["n", "pr_fHigh", 450]], cmd: (v) => `bandpass ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tSmooth", f: [["c", "pr_fCol"], ["n", "pr_fSamples", 25]], cmd: (v) => `smooth ${quote(v[0])} ${v[1]}` },
    { k: "pr_tOffset", f: [["c", "pr_fCol"]], cmd: (v) => `offset ${quote(v[0])}` },
    { k: "pr_tRectify", f: [["c", "pr_fCol"]], cmd: (v) => `rectify ${quote(v[0])}` },
    { k: "pr_tDeriv", f: [["c", "pr_fCol"]], cmd: (v) => `deriv ${quote(v[0])}` },
    { k: "pr_tIntegrate", f: [["c", "pr_fCol"]], cmd: (v) => `integrate ${quote(v[0])}` },
    { k: "pr_tScale", f: [["c", "pr_fCol"], ["n", "pr_fFactor", 1]], cmd: (v) => `scale ${quote(v[0])} ${v[1]}` },
    { k: "pr_tStats", f: [["c", "pr_fCol"]], cmd: (v) => `stats ${quote(v[0])}` },
    { k: "pr_tPeaks", f: [["c", "pr_fCol"], ["s", "pr_fThreshold", "1.3bw"], ["n", "pr_fHalf", 50]], cmd: (v) => `peaks ${quote(v[0])} ${v[1]} ${v[2]}` },
  ] },
  { group: "pr_gEmg", items: [
    { k: "pr_tEnvelope", f: [["c", "pr_fCol"], ["n", "pr_fWindowMs", 100]], cmd: (v) => `envelope ${quote(v[0])} ${v[1]}` },
    { k: "pr_tEnvelopeBand", f: [["c", "pr_fCol"], ["n", "pr_fWindowMs", 100]], cmd: (v) => `envelope ${quote(v[0])} ${v[1]} band` },
    { k: "pr_tNormalise", f: [["c", "pr_fCol"], ["s", "pr_fRef", "max"]], cmd: (v) => `normalise ${quote(v[0])} ${v[1]}` },
  ] },
  { group: "pr_gForce", items: [
    { k: "pr_tFz", f: [], cmd: () => "fz" },
    { k: "pr_tBw", f: [["n", "pr_fFrom", 0], ["n", "pr_fTo", 1]], cmd: (v) => `bw ${v[0]} ${v[1]}` },
    { k: "pr_tXbw", f: [["c", "pr_fCol"]], cmd: (v) => `divide ${quote(v[0])} bw` },
    { k: "pr_tContacts", f: [["c", "pr_fCol"], ["n", "pr_fThresholdN", 20], ["n", "pr_fMinSamples", 20]], cmd: (v) => `contacts ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tJump", f: [["c", "pr_fCol"], ["n", "pr_fThresholdN", 20], ["n", "pr_fQuiet", 1]], cmd: (v) => `jump ${quote(v[0])} ${v[1]} ${v[2]}` },
  ] },
  { group: "pr_gBalance", items: [
    { k: "pr_tCop", f: [], cmd: () => "cop" },
    { k: "pr_tCopCols", f: [["c", "pr_fColX"], ["c", "pr_fColY"]], cmd: (v) => `cop ${quote(v[0])} ${quote(v[1])}` },
  ] },
  { group: "pr_gJoints", items: [
    { k: "pr_tPower", f: [["c", "pr_fMoment"], ["c", "pr_fAngle"]], cmd: (v) => `power ${quote(v[0])} ${quote(v[1])}` },
    { k: "pr_tMarkerErr", f: [], cmd: () => "markererr" },
  ] },
  { group: "pr_gCompare", items: [
    { k: "pr_tMeanSd", f: [["c", "pr_fCol"]], cmd: (v) => `meansd ${quote(v[0])}` },
    { k: "pr_tMeanSdContacts", f: [["c", "pr_fCol"]], cmd: (v) => `meansd ${quote(v[0])} contacts` },
    { k: "pr_tCompare", f: [["s", "pr_fMeasure", "height (flight"], ["s", "pr_fCondA", "A"], ["s", "pr_fCondB", "B"]], cmd: (v) => `compare ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tValues", f: [["s", "pr_fLabel", "fascicle_mm"], ["s", "pr_fValues", "45.1 47.8 44.0"]], cmd: (v) => `values ${quote(v[0])} ${v[1]}` },
    { k: "pr_tChange", f: [["s", "pr_fLabel", "pennation"], ["n", "pr_fBefore", 18], ["n", "pr_fAfter", 45.9]], cmd: (v) => `change ${quote(v[0])} ${v[1]} ${v[2]}` },
  ] },
];

/** Mount the page into `root`. `t` translates, `esc` escapes, `download(name, text|blob)` saves a file. */
export function mountProcess(root, { t, download }) {
  const P = makeProcessor();
  const S = P.S;
  let colFilter = "", out = [];
  const vis = { tab: "pp", chans: new Set(), view: { yaw: 0.6, pitch: 0.35, zoom: 1, up: null, labels: false, frame: 0 }, playing: false, speed: 1, box: null, boxFor: null };

  const say = (r, line) => { out.unshift({ ok: r.ok, line, msg: r.msg }); out = out.slice(0, 30); };
  const exec = (line) => { const r = P.run(line); say(r, line); render(); return r; };

  function plotHTML() {
    const ds = P.current(); if (!ds) return "";
    const pl = S.plot; let ch, legend = [];
    if (pl.curves) {
      const x = Float64Array.from({ length: pl.curves.mean.length }, (_, i) => (100 * i) / (pl.curves.mean.length - 1));
      const lo = pl.curves.mean.map((m, i) => m - pl.curves.sd[i]), hi = pl.curves.mean.map((m, i) => m + pl.curves.sd[i]);
      const series = pl.curves.all.map((y, i) => ({ x, y, color: COLORS[(i + 1) % COLORS.length], thin: true, label: pl.curves.labels[i] }));
      series.push({ x, y: pl.curves.mean, band: [lo, hi], color: COLORS[0], label: t("pr_meanSd") });
      ch = chartSVG({ series, xLabel: "%", yLabel: pl.curves.name });
      legend = [{ color: COLORS[0], label: `${t("pr_meanSd")} (n = ${pl.curves.all.length})` }];
    } else if (pl.xy) {
      const [a, b] = pl.xy; let i0 = 0, i1 = ds.time.length;
      if (S.win) { i0 = ds.time.findIndex((v) => v >= S.win[0]); i1 = ds.time.findIndex((v) => v > S.win[1]); if (i1 < 0) i1 = ds.time.length; }
      const x = ds.cols[a].slice(i0, i1), y = ds.cols[b].slice(i0, i1);
      ch = chartSVG({ series: [{ x, y, color: COLORS[0], label: `${b} vs ${a}` }], xLabel: a, yLabel: b, equal: true });
      legend = [{ color: COLORS[0], label: `${b} vs ${a}` }];
    } else if (pl.cols.length) {
      let i0 = 0, i1 = ds.time.length;
      if (S.win) { i0 = Math.max(0, ds.time.findIndex((v) => v >= S.win[0])); i1 = ds.time.findIndex((v) => v > S.win[1]); if (i1 < 0) i1 = ds.time.length; }
      const x = ds.time.slice(i0, i1);
      const series = pl.cols.filter((k) => ds.cols[k]).map((k, i) => ({ x, y: ds.cols[k].slice(i0, i1), color: COLORS[i % COLORS.length], label: k }));
      const units = [...new Set(pl.cols.map((k) => ds.units[k]).filter(Boolean))];
      ch = chartSVG({ series, xLabel: t("pr_timeS"), yLabel: units.join(", "), marks: pl.marks.filter(([tm]) => !S.win || (tm >= S.win[0] && tm <= S.win[1])) });
      legend = series;
    } else return `<p class="note" style="margin:8px 0">${t("pr_tickToPlot")}</p>`;
    return `<div class="prPlot">${ch.svg}<div class="prReadout sub" style="font-size:12px;min-height:16px;margin:2px 0 0"></div></div>
      <div class="sub" style="font-size:12px;display:flex;flex-wrap:wrap;gap:4px 12px;margin:2px 0 0">${legend.map((s) => `<span><i class="dot" style="display:inline-block;width:10px;height:3px;background:${s.color};vertical-align:middle"></i> ${escX(s.label)}</span>`).join("")}</div>
      <div class="row" style="margin-top:8px;gap:8px"><button type="button" class="ghost" id="prSvg" style="margin:0">${t("pr_saveSvg")}</button><button type="button" class="ghost" id="prCsv" style="margin:0">${t("pr_saveCsv")}</button></div>`;
  }

  function visHTML(ds) {
    const mk = markerTriplets(ds), tree = channelTree(ds);
    const has3d = mk.length > 0;
    if (vis.tab === "3d" && !has3d) vis.tab = "pp";
    const tabs = `<div class="row" style="gap:6px;margin:8px 0">
      <button type="button" class="${vis.tab === "pp" ? "" : "ghost"}" data-vtab="pp" style="margin:0">${t("pr_vRawProc")}</button>
      ${has3d ? `<button type="button" class="${vis.tab === "3d" ? "" : "ghost"}" data-vtab="3d" style="margin:0">${t("pr_v3d")} (${mk.length})</button>` : ""}</div>`;
    let body = "";
    if (vis.tab === "pp") {
      const raws = tree.raw.filter((k) => !colFilter || k.toLowerCase().includes(colFilter.toLowerCase()));
      const sorted = [...raws.filter((k) => tree.derived[k]), ...raws.filter((k) => !tree.derived[k])];
      for (const k of [...vis.chans]) if (!ds.cols[k]) vis.chans.delete(k);
      if (!vis.chans.size) for (const k of Object.keys(tree.derived).slice(0, 2)) vis.chans.add(k);
      let i0 = 0, i1 = ds.time.length;
      if (S.win) { i0 = Math.max(0, ds.time.findIndex((v) => v >= S.win[0])); i1 = ds.time.findIndex((v) => v > S.win[1]); if (i1 < 0) i1 = ds.time.length; }
      const x = ds.time.slice(i0, i1);
      const panels = [...vis.chans].map((k) => {
        const kids = tree.derived[k] || [];
        const series = [{ x, y: ds.cols[k].slice(i0, i1), color: "#9aa1ae", label: `${k} (${t("pr_raw")})` },
          ...kids.map((d, i) => ({ x, y: ds.cols[d].slice(i0, i1), color: COLORS[i % COLORS.length], label: d }))];
        const ch = chartSVG({ series, xLabel: t("pr_timeS"), yLabel: ds.units[k] || "", H: 220 });
        return `<div style="margin-top:10px"><b style="font-size:13px">${escX(k)}</b>${ch.svg}
          <div class="sub" style="font-size:12px;display:flex;flex-wrap:wrap;gap:4px 12px;margin:2px 0 0">${series.map((q) => `<span><i style="display:inline-block;width:10px;height:3px;background:${q.color};vertical-align:middle"></i> ${escX(q.label)}</span>`).join("")}</div></div>`;
      }).join("");
      body = `<p class="note" style="margin:0 0 6px">${t("pr_vRawNote")}</p>
        <div class="prCols" style="max-height:160px">${sorted.map((k) => `<label class="prCol"><input type="checkbox" data-vchan="${escX(k)}"${vis.chans.has(k) ? " checked" : ""}> ${escX(k)}${tree.derived[k] ? ` <span class="sub" style="font-size:11px">→ ${tree.derived[k].length}</span>` : ""}</label>`).join("")}</div>
        ${panels || `<p class="note" style="margin:8px 0 0">${t("pr_vNone")}</p>`}`;
    } else {
      const n = ds.time.length;
      if (vis.view.up == null) vis.view.up = ds.kind === "trc" ? "y" : "z";
      vis.view.frame = Math.min(vis.view.frame, n - 1);
      body = `<canvas id="prCanvas" style="width:100%;aspect-ratio:4/3;display:block;border:1px solid var(--line);border-radius:10px;touch-action:none;cursor:grab"></canvas>
        <p class="note" style="margin:4px 0 6px">${t("pr_vDrag")}</p>
        <div class="row" style="gap:8px;align-items:center">
          <button type="button" id="prPlay" style="margin:0;width:auto;padding:6px 14px">${vis.playing ? t("pr_pause") : t("pr_play")}</button>
          <input id="prFrame" type="range" min="0" max="${n - 1}" value="${vis.view.frame}" style="flex:1">
          <span id="prFrameT" class="sub" style="font-size:12px;min-width:64px;text-align:right">${(+ds.time[vis.view.frame]).toFixed(2)} s</span></div>
        <div class="row" style="gap:12px;align-items:center;margin-top:6px;font-size:13px">
          <label>${t("pr_up")} <select id="prUp" style="width:auto;display:inline-block">${["z", "y"].map((a) => `<option${vis.view.up === a ? " selected" : ""}>${a}</option>`).join("")}</select></label>
          <label>${t("pr_speed")} <select id="prSpeed" style="width:auto;display:inline-block">${[0.25, 0.5, 1, 2].map((v) => `<option value="${v}"${vis.speed === v ? " selected" : ""}>${v}×</option>`).join("")}</select></label>
          <label><input type="checkbox" id="prLabels"${vis.view.labels ? " checked" : ""} style="width:auto;display:inline-block;min-height:0"> ${t("pr_labels")}</label></div>`;
    }
    return `<div class="card"><b>${t("pr_visualise")}</b>${tabs}${body}</div>`;
  }

  function wireVis(ds) {
    root.querySelectorAll("[data-vtab]").forEach((b) => { b.onclick = () => { vis.tab = b.dataset.vtab; vis.playing = false; render(); }; });
    root.querySelectorAll("[data-vchan]").forEach((c) => { c.onchange = () => { c.checked ? vis.chans.add(c.dataset.vchan) : vis.chans.delete(c.dataset.vchan); render(); }; });
    const cv = root.querySelector("#prCanvas"); if (!cv) { vis.playing = false; return; }
    const mk = markerTriplets(ds);
    const key = ds.name + vis.view.up;
    if (vis.boxFor !== key) { vis.box = markerBox(ds, mk, vis.view.up); vis.boxFor = key; }
    const draw = () => {
      const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (vis.box) drawMarkers(ctx, r.width, r.height, ds, mk, vis.view, vis.box);
      const fr = root.querySelector("#prFrame"), ft = root.querySelector("#prFrameT");
      if (fr) fr.value = vis.view.frame; if (ft) ft.textContent = `${(+ds.time[vis.view.frame]).toFixed(2)} s`;
    };
    draw();
    let drag = null;
    cv.onpointerdown = (e) => { drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = (e) => { if (!drag) return; vis.view.yaw += (e.clientX - drag[0]) * 0.01; vis.view.pitch = Math.max(-1.5, Math.min(1.5, vis.view.pitch + (e.clientY - drag[1]) * 0.01)); drag = [e.clientX, e.clientY]; draw(); };
    cv.onpointerup = () => { drag = null; };
    cv.onwheel = (e) => { e.preventDefault(); vis.view.zoom = Math.max(0.2, Math.min(8, vis.view.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); draw(); };
    root.querySelector("#prFrame").oninput = (e) => { vis.view.frame = +e.target.value; draw(); };
    root.querySelector("#prUp").onchange = (e) => { vis.view.up = e.target.value; render(); };
    root.querySelector("#prSpeed").onchange = (e) => { vis.speed = +e.target.value; };
    root.querySelector("#prLabels").onchange = (e) => { vis.view.labels = e.target.checked; draw(); };
    root.querySelector("#prPlay").onclick = (e) => {
      vis.playing = !vis.playing; e.target.textContent = vis.playing ? t("pr_pause") : t("pr_play");
      if (!vis.playing) return;
      let last = performance.now(), acc = 0;
      const tick = (now) => {
        if (!vis.playing || !cv.isConnected) { vis.playing = false; return; }
        acc += ((now - last) / 1000) * vis.speed * (ds.fs || 100); last = now;
        const step = Math.floor(acc); acc -= step;
        if (step) { vis.view.frame = (vis.view.frame + step) % ds.time.length; draw(); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
  }

  function toolsHTML(ds) {
    const keys = ds ? Object.keys(ds.cols) : [];
    const firstTicked = S.plot.cols[0] || "";
    const colSel = (id, pre) => `<select id="${id}" class="prColSel">${["@fz", ...keys].map((k) => `<option value="${escX(k)}"${k === pre ? " selected" : ""}>${escX(k === "@fz" ? t("pr_autoFz") : k)}</option>`).join("")}</select>`;
    return TOOLS.map((g, gi) => `<details class="prGroup"><summary><b>${t(g.group)}</b></summary>${g.items.map((it, ii) => {
      const id = `prT${gi}_${ii}`;
      const fields = it.f.map(([type, lbl, def], fi) => `<label style="font-size:12px;margin:6px 0 2px;display:block">${t(lbl)}</label>${
        type === "c" ? colSel(`${id}_${fi}`, fi === 0 ? firstTicked : S.plot.cols[fi] || "") : `<input id="${id}_${fi}" type="${type === "n" ? "number" : "text"}" step="any" value="${escX(def ?? "")}">`}`).join("");
      return `<div class="prTool"><div style="font-size:13.5px;font-weight:600">${t(it.k)}</div>${fields}<button type="button" data-tool="${gi}_${ii}" style="margin:8px 0 0">${t("pr_run")}</button></div>`;
    }).join("")}</details>`).join("");
  }

  function render() {
    const ds = P.current();
    const keys = ds ? Object.keys(ds.cols) : [];
    const shown = keys.filter((k) => !colFilter || k.toLowerCase().includes(colFilter.toLowerCase()));
    root.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b style="font-size:16px">${t("pr_title")}</b>
        <button type="button" class="ghost labHomeBtn" style="margin:0;width:auto;padding:6px 12px">${t("labHome")}</button>
      </div>
      <p class="note" style="margin:4px 0 10px">${t("pr_intro")}</p>
      <label class="prDrop" for="prFiles"><input id="prFiles" type="file" multiple style="display:none"
        accept=".csv,.txt,.tsv,.mot,.sto,.trc,.c3d,.xlsx,.xlsm">${t("pr_drop")}</label>
      ${S.ds.length ? `<div class="prFiles">${S.ds.map((d, i) => `<div class="prFile${i === S.cur ? " sel" : ""}">
        <button type="button" class="ghost" data-use="${i + 1}" style="margin:0;text-align:left">${i + 1} · ${escX(d.name)}
          <span class="sub" style="font-size:11.5px;display:block;margin:0">${d.fs ? `${+d.fs.toFixed(2)} Hz · ` : ""}${d.time.length} ${t("pr_samples")} · ${Object.keys(d.cols).length} ${t("pr_columns")}${d.meta?.noTime ? " · " + t("pr_noTime") : ""}</span></button>
        <button type="button" class="ghost" data-del="${i}" aria-label="${t("pr_remove")}" style="margin:0;width:auto;padding:6px 10px">×</button></div>`).join("")}</div>` : ""}
    </div>
    ${ds ? `<div class="card">
      <b>${escX(ds.name)}</b>
      <div class="row" style="margin-top:8px;align-items:flex-end;gap:8px">
        <div><label for="prT0">${t("pr_from")}</label><input id="prT0" type="number" step="any" value="${S.win ? S.win[0] : ""}" placeholder="${(+ds.time[0]).toFixed(2)}"></div>
        <div><label for="prT1">${t("pr_to")}</label><input id="prT1" type="number" step="any" value="${S.win ? S.win[1] : ""}" placeholder="${(+ds.time[ds.time.length - 1]).toFixed(2)}"></div>
        <div><button type="button" class="ghost" id="prWinAll" style="margin:0">${t("pr_whole")}</button></div>
      </div>
      ${plotHTML()}
      <input id="prColFilter" type="search" placeholder="${t("pr_filterCols")}" value="${escX(colFilter)}" style="margin-top:10px">
      <div class="prCols">${shown.map((k) => `<label class="prCol"><input type="checkbox" data-col="${escX(k)}"${S.plot.cols.includes(k) ? " checked" : ""}> ${escX(k)}${ds.units[k] ? ` <span class="sub" style="font-size:11px">(${escX(ds.units[k])})</span>` : ""}</label>`).join("") || `<p class="note">${t("pr_noCols")}</p>`}</div>
      ${ds.meta?.text ? `<p class="note" style="margin:6px 0 0">${t("pr_textCols")}: ${Object.keys(ds.meta.text).map(escX).join(", ")}</p>` : ""}
    </div>
    ${visHTML(ds)}
    <div class="card"><b>${t("pr_tools")}</b><p class="note" style="margin:4px 0 6px">${t("pr_toolsNote")}</p>${toolsHTML(ds)}</div>` : ""}
    <div class="card">
      <b>${t("pr_commands")}</b>
      <form id="prCmdForm" style="display:flex;gap:6px;margin-top:8px" autocomplete="off">
        <input id="prCmd" type="text" spellcheck="false" autocapitalize="off" placeholder="lowpass Fz 10" style="flex:1;font-family:ui-monospace,Consolas,monospace">
        <button type="submit" style="margin:0;width:auto;padding:0 16px">${t("pr_run")}</button>
      </form>
      ${out.length ? `<div class="osimLog" style="max-height:150px">${out.map((o) => `<div style="${o.ok ? "" : "color:var(--warn)"}">&gt; ${escX(o.line)}${o.msg ? `\n  ${escX(o.msg)}` : ""}</div>`).join("")}</div>` : ""}
      ${S.log.length ? `<details style="margin-top:8px"><summary>${t("pr_recipe")} (${S.log.length})</summary>
        <textarea id="prRecipe" rows="5" style="width:100%;font:12px ui-monospace,Consolas,monospace;margin-top:6px">${escX(S.log.join("\n"))}</textarea>
        <div class="row" style="gap:8px;margin-top:6px"><button type="button" class="ghost" id="prRunAll" style="margin:0">${t("pr_runAll")}</button>
        <button type="button" class="ghost" id="prRecipeSave" style="margin:0">${t("pr_saveRecipe")}</button></div></details>` : ""}
      <details style="margin-top:8px"><summary>${t("pr_cmdList")}</summary><table style="font-size:12px;margin-top:6px"><tbody>${HELP.map(([c, d], i) => `<tr><td style="font-family:ui-monospace,Consolas,monospace;white-space:nowrap;padding-right:8px">${escX(c)}</td><td>${escX(t(`pr_h${i}`) === `pr_h${i}` ? d : t(`pr_h${i}`))}</td></tr>`).join("")}</tbody></table>
        <p class="note">${t("pr_cmdNote")}</p></details>
    </div>
    ${S.results.length ? `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b>${t("pr_results")}</b>
      <span><button type="button" class="ghost" id="prResCsv" style="margin:0;width:auto;padding:6px 10px">${t("pr_saveCsv")}</button>
      <button type="button" class="ghost" id="prResClear" style="margin:0;width:auto;padding:6px 10px">${t("pr_clear")}</button></span></div>
      <div style="overflow-x:auto;max-height:340px;margin-top:8px"><table style="font-size:12px"><thead><tr><th>${t("pr_file")}</th><th>${t("pr_measure")}</th><th>${t("pr_value")}</th><th></th></tr></thead><tbody>${
        S.results.slice().reverse().map((r) => `<tr><td>${escX(r.file.replace(/ · .*/, ""))}</td><td>${escX(r.measure)}</td><td style="text-align:right">${escX(r.value)}</td><td>${escX(r.unit)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <p class="note" style="margin:6px 4px 0">${t("pr_honest")}</p>`;
    wire(ds);
  }

  async function load(files) {
    for (const f of files) {
      try { const list = await readAny(f); P.add(list); say({ ok: true, msg: list.map((d) => `${d.name}: ${Object.keys(d.cols).length} ${t("pr_columns")}`).join("\n") }, `load ${f.name}`); }
      catch (e) { say({ ok: false, msg: e.message }, `load ${f.name}`); }
    }
    render();
  }

  function wire(ds) {
    const q = (s) => root.querySelector(s);
    q("#prFiles").onchange = (e) => load([...e.target.files]);
    const drop = q(".prDrop");
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); load([...e.dataTransfer.files]); };
    root.querySelectorAll("[data-use]").forEach((b) => { b.onclick = () => exec(`use ${b.dataset.use}`); });
    root.querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => { P.remove(+b.dataset.del); render(); }; });
    q("#prCmdForm").onsubmit = (e) => { e.preventDefault(); const v = q("#prCmd").value; if (v.trim()) { exec(v); root.querySelector("#prCmd")?.focus(); } };
    if (q("#prRunAll")) q("#prRunAll").onclick = () => {
      const lines = q("#prRecipe").value.split("\n").map((l) => l.trim()).filter((l) => l && !/^(use|all)\b/i.test(l));
      const keep = S.cur;
      for (let i = 0; i < S.ds.length; i++) { S.cur = i; for (const l of lines) { const r = P.run(l); if (!r.ok) say(r, `${S.ds[i].name}: ${l}`); } }
      S.cur = keep; say({ ok: true, msg: `${lines.length} × ${S.ds.length}` }, t("pr_runAll")); render();
    };
    if (q("#prRecipeSave")) q("#prRecipeSave").onclick = () => download("process_recipe.txt", q("#prRecipe").value);
    if (q("#prResCsv")) q("#prResCsv").onclick = () => download("process_results.csv", P.resultsCsv());
    if (q("#prResClear")) q("#prResClear").onclick = () => { S.results.length = 0; render(); };
    if (!ds) return;
    wireVis(ds);
    const setWin = () => { const a = q("#prT0").value, b = q("#prT1").value; if (a !== "" && b !== "") exec(`window ${a} ${b}`); };
    q("#prT0").onchange = setWin; q("#prT1").onchange = setWin;
    q("#prWinAll").onclick = () => exec("window all");
    const f = q("#prColFilter");
    f.oninput = () => { colFilter = f.value; const pos = f.selectionStart; render(); const g = root.querySelector("#prColFilter"); g.focus(); g.setSelectionRange(pos, pos); };
    root.querySelectorAll("[data-col]").forEach((c) => {
      c.onchange = () => {
        const k = c.dataset.col, cols = S.plot.curves || S.plot.xy ? [] : S.plot.cols.slice();
        const next = c.checked ? [...cols.filter((x) => x !== k), k] : cols.filter((x) => x !== k);
        exec(`plot ${next.map(quote).join(" ")}`.trim());
      };
    });
    root.querySelectorAll("[data-tool]").forEach((b) => {
      b.onclick = () => {
        const [gi, ii] = b.dataset.tool.split("_").map(Number), it = TOOLS[gi].items[ii];
        const v = it.f.map((_, fi) => root.querySelector(`#prT${gi}_${ii}_${fi}`).value);
        const line = it.cmd(v); q("#prCmd").value = line; exec(line);
        const d = root.querySelectorAll(".prGroup")[gi]; if (d) d.open = true;
      };
    });
    const svg = q(".prPlot svg");
    if (svg) {
      const ro = q(".prReadout"), cursor = svg.querySelector(".prCursor");
      svg.onpointermove = (e) => {
        const rc = svg.getBoundingClientRect(), W = +svg.dataset.w, L = +svg.dataset.l, R = +svg.dataset.r;
        const px = ((e.clientX - rc.left) / rc.width) * W; if (px < L || px > W - R) return;
        const pl = S.plot;
        if (pl.xy) return;
        let xs, val;
        if (pl.curves) { const n = pl.curves.mean.length, i = Math.round(((px - L) / (W - L - R)) * (n - 1)); xs = `${Math.round((100 * i) / (n - 1))} %`; val = `${r3(pl.curves.mean[i])} ± ${r3(pl.curves.sd[i])}`; }
        else {
          let i0 = 0, i1 = ds.time.length;
          if (S.win) { i0 = Math.max(0, ds.time.findIndex((v) => v >= S.win[0])); i1 = ds.time.findIndex((v) => v > S.win[1]); if (i1 < 0) i1 = ds.time.length; }
          const i = Math.min(i1 - 1, i0 + Math.round(((px - L) / (W - L - R)) * (i1 - 1 - i0)));
          xs = `${r3(ds.time[i])} s`; val = pl.cols.map((k) => `${k}: ${r3(ds.cols[k][i])}`).join(" · ");
        }
        ro.textContent = `${xs} — ${val}`;
        cursor.setAttribute("x1", px); cursor.setAttribute("x2", px); cursor.setAttribute("visibility", "visible");
      };
      q("#prSvg").onclick = () => download("process_plot.svg", new Blob([svg.outerHTML.replace(/var\(--card\)/g, "#fff").replace(/var\(--line\)/g, "#ddd").replace(/var\(--muted\)/g, "#666").replace(/var\(--warn\)/g, "#b4540f").replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')], { type: "image/svg+xml" }));
      q("#prCsv").onclick = () => {
        const keys = S.plot.cols.length ? S.plot.cols : S.plot.xy || Object.keys(ds.cols);
        if (S.plot.curves) {
          const c = S.plot.curves, lines = [["percent", "mean", "sd", ...c.labels.map((l) => `"${l}"`)].join(",")];
          c.mean.forEach((m, i) => lines.push([(100 * i) / (c.mean.length - 1), m, c.sd[i], ...c.all.map((y) => y[i])].join(",")));
          download("process_curves.csv", lines.join("\n"));
        } else download(`${ds.name.replace(/[^\w.-]+/g, "_")}.csv`, toCsv(ds, keys));
      };
    }
  }

  render();
  return { P, render, load };
}
