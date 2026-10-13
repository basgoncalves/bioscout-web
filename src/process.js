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
  ["gait <Fz> <Fy> [mass_kg] [threshold]", "L02 A: stance time, peak 1, valley, peak 2, braking and propulsion (xBW); curves of all files"],
  ["impulse <Fz> [quiet_s] [threshold]", "L02 B: positive, negative and net impulse, take-off velocity, heights"],
  ["filters <col> 5 10 20 50 ma25 [quiet ab | quiet t0 t1]", "L02 C: several filters at once; peak, time of peak and quiet-window mean each"],
  ["overlay <col> [norm]", "the same column from every file on one plot (norm: 0-100 %)"],  ["step <op> [numbers] | step undo | step clear", "add to the processing applied to every channel: lowpass fc [order], highpass, bandpass lo hi, smooth n, offset, rectify, envelope ms, scale k, divbw, normmax, deriv, integrate"],
];

/**
 * The processing chain: steps applied, in order, to EVERY channel of a file.
 * f(y, ds, args) -> new array. Filters refuse a cut-off at or above fs/2.
 */
export const STEPS = {
  offset: { n: 0, label: () => "offset removed", f: (y) => { const m = D.mean(y); return y.map((v) => v - m); } },
  rectify: { n: 0, label: () => "rectified", f: (y) => y.map(Math.abs) },
  scale: { n: 1, label: ([k]) => `× ${k}`, f: (y, ds, [k]) => y.map((v) => v * k) },
  divbw: { n: 0, label: () => "÷ body weight", f: (y, ds, a, S) => { const b = S.bw[ds.name]; if (!b) throw new Error("no body weight yet (bw)"); return y.map((v) => v / b); } },
  normmax: { n: 0, label: () => "% of max", f: (y) => { const m = D.max(Array.from(y, Math.abs)); return y.map((v) => (100 * v) / m); } },
  smooth: { n: 1, label: ([n]) => `moving average ${n}`, f: (y, ds, [n]) => D.movingAverage(y, n) },
  deriv: { n: 0, label: () => "d/dt", f: (y, ds) => D.numGradient(y, ds.time) },
  integrate: { n: 0, label: () => "∫ dt", f: (y, ds) => D.cumtrapz(D.nanToNum(y), ds.time) },
  lowpass: { n: 1, label: ([fc, o = 4]) => `low-pass ${fc} Hz (${o})`, f: (y, ds, [fc, o = 4]) => { if (!(fc < ds.fs / 2)) throw new Error(`${fc} Hz is above fs/2 (${ds.fs / 2} Hz)`); return D.lowpass(D.nanToNum(y), ds.fs, fc, o); } },
  highpass: { n: 1, label: ([fc, o = 4]) => `high-pass ${fc} Hz (${o})`, f: (y, ds, [fc, o = 4]) => { if (!(fc < ds.fs / 2)) throw new Error(`${fc} Hz is above fs/2 (${ds.fs / 2} Hz)`); return D.highpass(D.nanToNum(y), ds.fs, fc, o); } },
  bandpass: { n: 2, label: ([lo, hi, o = 4]) => `band-pass ${lo}-${hi} Hz (${o})`, f: (y, ds, [lo, hi, o = 4]) => { if (!(lo < ds.fs / 2)) throw new Error(`${lo} Hz is above fs/2`); return D.bandpass(D.nanToNum(y), ds.fs, lo, hi, o); } },
  envelope: { n: 0, label: ([ms = 100]) => `EMG envelope ${ms} ms`, f: (y, ds, [ms = 100]) => D.emgEnvelope(y, ds.fs, ms).envelope },
};
export const stepLabel = (st) => STEPS[st.op].label(st.args);

/**
 * The engine. `t` translates the few words it puts in the results table
 * (it is optional: tests run it without).
 */
export function makeProcessor() {
  const S = { pipe: [], gait: {}, cursors: {}, ds: [], cur: -1, results: [], plot: { cols: [], xy: null, curves: null, marks: [] }, win: null, bw: {}, contacts: {}, log: [] };

  const rootOf = (ds, k) => (ds.src && ds.src[k]) || k;
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
      const v = D.verticalForce(ds);
      // A plate that reports Fz pointing down (Vicon) gets a positive copy, "Fz", made from it,
      // so filtered curves and peaks are compared with a signal of the same sign.
      if (D.mean(ds.cols[v.col]) < 0) { put(ds, "Fz", v.y, "N", v.col); return { key: "Fz", y: ds.cols.Fz }; }
      return { key: v.col, y: ds.cols[v.col] };
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
    if (parent && parent !== key) { ds.src = ds.src || {}; ds.src[key] = (ds.src[parent] || parent); ds.par = ds.par || {}; ds.par[key] = parent; }
    const r = rootOf(ds, key); if (!S.plot.cols.includes(r)) S.plot.cols.push(r);
    S.plot.xy = null; S.plot.curves = null;
    return key;
  };
  const numArg = (v, d) => (v == null || v === "" ? d : (() => { const x = Number(v); if (!fin(x)) throw new Error(`"${v}" is not a number`); return x; })());
  const bwOf = (ds) => {
    if (S.bw[ds.name]) return S.bw[ds.name];
    const v = D.verticalForce(ds); const n = Math.trunc(1.0 * ds.fs);
    const w = D.mean(Array.from(v.y).slice(0, n)); S.bw[ds.name] = w; return w;
  };

  /** A channel after the processing chain (cached per file, channel and chain). */
  function processed(ds, key) {
    const sig = JSON.stringify(S.pipe) + "|" + (S.bw[ds.name] || "");
    if (!ds._pc || ds._pc.sig !== sig) ds._pc = { sig, map: {} };
    if (ds._pc.map[key]) return ds._pc.map[key];
    let y = Float64Array.from(ds.cols[key]);
    for (const st of S.pipe) y = Float64Array.from(STEPS[st.op].f(y, ds, st.args, S));
    return (ds._pc.map[key] = y);
  }
  const C = {
    /* the chain: "step lowpass 10 4", "step undo", "step clear", "step remove 2" */
    step([op, ...args]) {
      if (!op) throw new Error("step <operation> [numbers]");
      const o = op.toLowerCase();
      if (o === "clear") { S.pipe.length = 0; return "no processing"; }
      if (o === "undo") { S.pipe.pop(); return `${S.pipe.length} step(s)`; }
      if (o === "remove") { S.pipe.splice(numArg(args[0]) - 1, 1); return `${S.pipe.length} step(s)`; }
      if (!STEPS[o]) throw new Error(`unknown step "${op}" -- ${Object.keys(STEPS).join(", ")}`);
      const a = args.map((x) => numArg(x));
      if (a.length < STEPS[o].n) throw new Error(`${o} needs ${STEPS[o].n} number(s)`);
      const st = { op: o, args: a };
      if (S.cur >= 0 && S.ds[S.cur]) { const ds = S.ds[S.cur], k = Object.keys(ds.cols)[0]; if (k) STEPS[o].f(Float64Array.from(ds.cols[k]).slice(0, 400), ds, a, S); }
      S.pipe.push(st);
      return `${S.pipe.length}. ${stepLabel(st)} -- applied to every channel`;
    },
    use([n]) { const i = +n - 1; if (!S.ds[i]) throw new Error(`no file ${n}`); S.cur = i; S.plot = { cols: [], xy: null, curves: null, marks: [] }; return `using ${S.ds[i].name}`; },
    plot(args) { const ds = cur(); S.plot = { cols: [...new Set(args.map((a) => rootOf(ds, col(ds, a).key)))].filter((k) => ds.cols[k]), xy: null, curves: null, marks: [] }; return args.length ? `plotting ${S.plot.cols.length} column(s)` : "plot cleared"; },
    xy([a, b]) { const ds = cur(); S.plot = { cols: S.plot.cols, xy: [col(ds, a).key, col(ds, b).key], curves: null, marks: [] }; return "xy plot"; },
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
    bw([a, b, c]) {
      const ds = cur();
      let t0, t1, v;
      if (/^ab$/i.test(a || "")) { const cc = (S.cursors || {})[ds.name]; if (!cc) throw new Error("no cursors yet"); [t0, t1] = cc.slice().sort((x, y) => x - y); v = col(ds, b || "@fz"); }
      else { t0 = numArg(a, 0); t1 = numArg(b, 1); v = col(ds, c || "@fz"); }
      const y = []; ds.time.forEach((t, i) => { if (t >= t0 && t < t1) y.push(v.y[i]); });
      const w = D.mean(y); S.bw[ds.name] = w; addResult(ds, "body weight", "body weight", w, "N"); addResult(ds, "body weight", "body mass", w / D.G, "kg");
      return `body weight ${r3(w)} N (${r3(w / D.G)} kg)`;
    },
    /* L02 Station A (L02_DataAnalysis notebook): one stance, vertical + AP force in xBW. */
    gait([cz, cy, mass, thr]) {
      const ds = cur(), z = col(ds, cz || "@fz"), y = col(ds, cy);
      const bw = mass ? numArg(mass) * D.G : (S.bw[ds.name] || null);
      if (!bw) throw new Error("give the body mass (kg), or run bw first");
      const cs = D.contacts(z.y, numArg(thr, 20));
      if (!cs.length) throw new Error("no stance above the threshold");
      const [s0, e0] = cs[0], st = Array.from(z.y.slice(s0, e0), (v) => v / bw), n = st.length;
      let ap = Array.from(y.y.slice(s0, e0), (v) => v / bw);
      // sign so that braking (first half) is negative, whatever the walking direction (AP_SIGN in the notebook)
      const h = n >> 1, lo = D.min(ap.slice(0, h)), hi = D.max(ap.slice(0, h));
      if (Math.abs(hi) > Math.abs(lo)) ap = ap.map((v) => -v);
      const r = { stance_s: n / ds.fs, peak1_xBW: D.max(st.slice(0, h)), valley_xBW: D.min(st.slice(Math.trunc(0.25 * n), Math.trunc(0.75 * n))),
        peak2_xBW: D.max(st.slice(h)), braking_xBW: D.min(ap.slice(0, h)), propulsion_xBW: D.max(ap.slice(h)) };
      for (const [k, v] of Object.entries(r)) addResult(ds, "walking stance", k.replace(/_(xBW|s)$/, ""), v, k.endsWith("_s") ? "s" : "xBW");
      S.gait[ds.name] = { fz: D.timeNormalise(st), ap: D.timeNormalise(ap) };
      const names = Object.keys(S.gait).filter((k) => S.ds.some((d) => d.name === k));
      const x = Float64Array.from({ length: 101 }, (_, i) => i);
      S.plot = { ...S.plot, curves: null, xy: null, panels: [
        { title: "Vertical GRF (xBW)", xLabel: "stance (%)", series: names.map((k) => ({ label: k, x, y: S.gait[k].fz })) },
        { title: "AP GRF (xBW): braking < 0 < propulsion", xLabel: "stance (%)", series: names.map((k) => ({ label: k, x, y: S.gait[k].ap })) }] };
      return `stance ${r3(r.stance_s)} s, peaks ${r3(r.peak1_xBW)} / ${r3(r.peak2_xBW)} xBW, braking ${r3(r.braking_xBW)}, propulsion ${r3(r.propulsion_xBW)}`;
    },
    /* L02 Station B: positive, negative and net impulse before take-off. */
    impulse([c, quiet, thr]) {
      const ds = cur(), k = col(ds, c || "@fz"), fz = Float64Array.from(k.y, Math.abs), fs = ds.fs;
      const q = numArg(quiet, 0.5), bw = D.mean(Array.from(fz.slice(0, Math.trunc(q * fs)))), m = bw / D.G;
      const f = D.jumpHeightFlight(fz, fs, numArg(thr, 20)), to = f.window[0];
      let pos = 0, neg = 0;
      for (let i = 0; i < to; i++) { const F = fz[i] - bw; if (F > 0) pos += F / fs; else neg += F / fs; }
      const v = (pos + neg) / m;
      const r = { body_weight: [bw, "N"], positive_impulse: [pos, "N·s"], negative_impulse: [neg, "N·s"], net_impulse: [pos + neg, "N·s"],
        takeoff_velocity: [v, "m/s"], height_impulse: [(100 * v * v) / (2 * D.G), "cm"], height_flight: [100 * f.height, "cm"],
        height_positive_only: [(100 * (pos / m) ** 2) / (2 * D.G), "cm"] };
      for (const [n, [val, u]] of Object.entries(r)) addResult(ds, "jump impulse", n, val, u);
      S.bw[ds.name] = bw;
      const y = Array.from(fz, (v2) => v2 / bw), one = y.map(() => 1);
      const pre = (arr) => arr.map((v2, i) => (i < to ? v2 : 1));
      S.plot = { ...S.plot, curves: null, xy: null, panels: [{ title: `${k.key} (xBW): positive / negative impulse before take-off`, xLabel: "s", series: [
        { label: "positive impulse", x: ds.time, y: one, color: "#2f6fe4", band: [one, pre(y.map((v2) => Math.max(v2, 1)))], thin: true },
        { label: "negative impulse", x: ds.time, y: one, color: "#e8871a", band: [pre(y.map((v2) => Math.min(v2, 1))), one], thin: true },
        { label: `${k.key} / BW`, x: ds.time, y, color: "#888" }] }] };
      return `BW ${r3(bw)} N; impulse +${r3(pos)} / ${r3(neg)} N·s; v ${r3(v)} m/s; h ${r3(r.height_impulse[0])} cm (flight ${r3(r.height_flight[0])} cm)`;
    },
    /* L02 Station C: several filters at once, each with peak, time of peak and the quiet-window mean. */
    filters(args) {
      const ds = cur(), k = col(ds, args[0] || "@fz");
      let qa = null, qb = null; const specs = [];
      for (let i = 1; i < args.length; i++) {
        const a = String(args[i]);
        if (/^quiet$/i.test(a)) {
          if (/^ab$/i.test(args[i + 1] || "")) { const c = (S.cursors || {})[ds.name]; if (!c) throw new Error("no cursors yet"); [qa, qb] = c.slice().sort((x, y) => x - y); i += 1; }
          else { qa = numArg(args[i + 1]); qb = numArg(args[i + 2]); i += 2; }
        } else specs.push(a);
      }
      if (qa == null) { qa = ds.time[0]; qb = qa + 0.5; }
      const inQ = (t) => t >= qa && t <= qb;
      const row = (label, y) => {
        const i = D.argmax(y), q = []; ds.time.forEach((t, j) => { if (inQ(t)) q.push(y[j]); });
        const bw = S.bw[ds.name];
        addResult(ds, "filters", `${label} peak`, y[i], ds.units[k.key] || "");
        if (bw) addResult(ds, "filters", `${label} peak (xBW)`, y[i] / bw, "xBW");
        addResult(ds, "filters", `${label} time of peak`, ds.time[i], "s");
        addResult(ds, "filters", `${label} quiet mean`, D.mean(q), ds.units[k.key] || "");
      };
      row("raw", k.y);
      const made = [];
      for (const sp of specs) {
        let key, y;
        const ma = sp.match(/^ma(\d+)$/i);
        if (ma) { y = D.movingAverage(k.y, +ma[1]); key = `${k.key}·ma${ma[1]}`; }
        else { const fc = numArg(sp); if (!(fc > 0 && fc < ds.fs / 2)) { made.push(`${fc} Hz skipped (fs/2 = ${ds.fs / 2})`); continue; } y = D.lowpass(D.nanToNum(k.y), ds.fs, fc); key = `${k.key}·lp${fc}`; }
        put(ds, key, y, ds.units[k.key], k.key); row(key.slice(k.key.length + 1), y); made.push(key);
      }
      S.cursors = S.cursors || {}; S.cursors[ds.name] = [qa, qb];
      return `${made.length} filter(s); quiet window ${r3(qa)}-${r3(qb)} s`;
    },
    /* The same column from every loaded file on one plot (e.g. three walking speeds). */
    overlay([c, mode]) {
      const norm = /^norm/i.test(mode || ""), series = [];
      for (const ds of S.ds) {
        let k; try { k = col(ds, c); } catch { continue; }
        let [a, b] = [0, ds.time.length]; try { [a, b] = win(ds); } catch { continue; }
        const y = k.y.slice(a, b);
        series.push({ label: ds.name, x: norm ? Float64Array.from({ length: 101 }, (_, i) => i) : ds.time.slice(a, b), y: norm ? D.timeNormalise(y) : y });
      }
      if (!series.length) throw new Error(`no file has "${c}"`);
      S.plot = { ...S.plot, curves: null, xy: null, panels: [{ title: `${c} — ${series.length} file(s)`, xLabel: norm ? "%" : "s", series }] };
      return `${series.length} file(s) overlaid`;
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
      S.plot = { cols: [rootOf(ds, k.key)], markCol: k.key, xy: null, curves: null, marks: pk.map((i) => [ds.time[i], k.y[i]]) };
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
      S.plot = { cols: [rootOf(ds, k.key)], markCol: k.key, xy: null, curves: null, marks: cs.flatMap(([s, e]) => [[ds.time[s], k.y[s]], [ds.time[e - 1], k.y[e - 1]]]) };
      return `${cs.length} contact(s)`;
    },
    jump([c, thr, quiet]) {
      const ds = cur(), k = col(ds, c || "@fz"), [a, b] = win(ds);
      const y = Float64Array.from(k.y).slice(a, b);
      const f = D.jumpHeightFlight(y, ds.fs, numArg(thr, 20)), im = D.jumpHeightImpulse(y, ds.fs, numArg(quiet, 1), numArg(thr, 20));
      addResult(ds, "jump", "height (flight time)", f.height * 100, "cm"); addResult(ds, "jump", "flight time", f.flight, "s");
      addResult(ds, "jump", "height (impulse)", im.height * 100, "cm"); addResult(ds, "jump", "take-off velocity", im.vTakeoff, "m/s");
      S.plot = { cols: [rootOf(ds, k.key)], markCol: k.key, xy: null, curves: null, marks: [[ds.time[a + f.window[0]], 0], [ds.time[Math.min(a + f.window[1], ds.time.length - 1)], 0]] };
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
      S.plot = { ...S.plot, xy: [x.key, y.key], curves: null, marks: [] };
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
      S.plot = { ...S.plot, xy: null, curves: { name: c, all: curves, labels, mean: ms.mean, sd: ms.sd }, marks: [] };
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
    S, run, col: (n) => col(cur(), n), processed,
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
export function chartSVG({ series, xLabel = "s", yLabel = "", marks = [], equal = false, W = 640, H = 300, cursors = null, xRange = null }) {
  const L = 78, R = 12, T = 18, B = 46;
  const xs = series.flatMap((s) => Array.from(s.x)).filter(fin);
  const ys = series.flatMap((s) => [...Array.from(s.y), ...(s.band ? [...s.band[0], ...s.band[1]] : [])]).filter(fin);
  if (!xs.length || !ys.length) return { svg: "", x0: 0, x1: 1 };
  let x0 = xRange ? xRange[0] : Math.min(...xs), x1 = xRange ? xRange[1] : Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 - x0 < 1e-12) { x0 -= 1; x1 += 1; } if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  if (equal) { const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, ax = (W - L - R) / (H - T - B); const sx = Math.max(x1 - x0, (y1 - y0) * ax), sy = sx / ax; x0 = cx - sx / 2; x1 = cx + sx / 2; y0 = cy - sy / 2; y1 = cy + sy / 2; }
  const ys0 = niceStep(y1 - y0); y0 = Math.floor(y0 / ys0) * ys0; y1 = Math.ceil(y1 / ys0) * ys0;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const dp = (st) => (st < 1 ? Math.min(4, Math.ceil(-Math.log10(st))) : 0);
  let g = "";
  for (let v = y0; v <= y1 + ys0 / 2; v += ys0) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--line)"${Math.abs(v) < ys0 / 1e6 ? "" : ' stroke-dasharray="2 3"'}/><text x="${L - 5}" y="${(Y(v) + 4).toFixed(1)}" font-size="18" text-anchor="end" fill="var(--muted)">${v.toFixed(dp(ys0))}</text>`;
  const xs0 = niceStep(x1 - x0, 6);
  for (let v = Math.ceil(x0 / xs0) * xs0; v <= x1 + 1e-9; v += xs0) g += `<line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${T}" y2="${H - B}" stroke="var(--line)" stroke-dasharray="2 3"/><text x="${X(v).toFixed(1)}" y="${H - B + 22}" font-size="18" text-anchor="middle" fill="var(--muted)">${v.toFixed(dp(xs0))}</text>`;
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
    return `${band}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.thin ? 1 : 1.6}"${s.dash ? ` stroke-dasharray="${typeof s.dash === "string" ? s.dash : "5 3"}"` : ""}${s.thin ? ' stroke-opacity=".45"' : ""}><title>${escX(s.label || "")}</title></path>`;
  }).join("");
  const mk = marks.filter(([x, y]) => fin(x) && fin(y)).map(([x, y]) => `<circle cx="${X(x).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="4" fill="none" stroke="var(--warn)" stroke-width="1.8"/>`).join("");
  const cur = (cursors || []).map((c, i) => fin(c) ? `<g class="prCur" data-cur="${i}" transform="translate(${X(c).toFixed(1)},0)"><line x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--accent)" stroke-width="1.5"/><rect x="-9" y="${T - 2}" width="18" height="16" rx="3" fill="var(--accent)"/><text x="0" y="${T + 10}" font-size="13" fill="#fff" text-anchor="middle">${"AB"[i]}</text></g>` : "").join("");
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;touch-action:pan-y" role="img" data-l="${L}" data-r="${R}" data-w="${W}" data-x0="${x0}" data-x1="${x1}">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="var(--card)"/>${g}${paths}${mk}${cur}`
    + `<text x="${W - R}" y="${H - 4}" font-size="17" text-anchor="end" fill="var(--muted)">${escX(xLabel)}</text>`
    + (yLabel ? `<text x="${L + 4}" y="${T + 12}" font-size="17" fill="var(--muted)">${escX(yLabel)}</text>` : "")
    + `<line class="prCursor" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/></svg>`;
  return { svg, x0, x1, L, R, W };
}

// ============================================================== the page
/**
 * Tools: forms that write commands. `f` fields: c = column, n = number, s = text.
 * Labels are i18n keys; the command words stay English (they are the language).
 */
export const TOOLS = [
  { group: "pr_gBasic", items: [
    { k: "pr_tMinMax", f: [], ui: "minmax" },
    { k: "pr_tBwAB", f: [["c", "pr_fCol", null, "fz"]], cmd: (v) => `bw ab ${quote(v[0])}` },
    { k: "pr_tOffset", f: [], cmd: () => "step offset" },
    { k: "pr_tRectify", f: [], cmd: () => "step rectify" },
    { k: "pr_tScale", f: [["n", "pr_fFactor", 1]], cmd: (v) => `step scale ${v[0]}` },
    { k: "pr_tXbw", f: [], cmd: () => "step divbw" },
    { k: "pr_tNormMax", f: [], cmd: () => "step normmax" },
    { k: "pr_tSmooth", f: [["n", "pr_fSamples", 25]], cmd: (v) => `step smooth ${v[0]}` },
    { k: "pr_tDeriv", f: [], cmd: () => "step deriv" },
    { k: "pr_tIntegrate", f: [], cmd: () => "step integrate" },
  ] },
  { group: "pr_gFilter", items: [
    { k: "pr_tLowpass", f: [["n", "pr_fCutoff", 10], ["n", "pr_fOrder", 4]], cmd: (v) => `step lowpass ${v[0]} ${v[1]}` },
    { k: "pr_tHighpass", f: [["n", "pr_fCutoff", 20], ["n", "pr_fOrder", 4]], cmd: (v) => `step highpass ${v[0]} ${v[1]}` },
    { k: "pr_tBandpass", f: [["n", "pr_fLow", 20], ["n", "pr_fHigh", 450], ["n", "pr_fOrder", 4]], cmd: (v) => `step bandpass ${v[0]} ${v[1]} ${v[2]}` },
    { k: "pr_tFilters", f: [["c", "pr_fCol", null, "fz"], ["s", "pr_fCutoffs", "5 10 20 50"], ["n", "pr_fSamples", 25], ["s", "pr_fQuietWin", "ab"]],
      cmd: (v) => `filters ${quote(v[0])} ${v[1]} ma${v[2]} quiet ${v[3]}` },
  ] },
  { group: "pr_gEmg", items: [
    { k: "pr_tEnvelope", f: [["n", "pr_fWindowMs", 100]], cmd: (v) => `step envelope ${v[0]}` },
    { k: "pr_tEnvelopeBand", f: [["n", "pr_fWindowMs", 100]], cmd: (v) => [`step bandpass 20 450 4`, `step envelope ${v[0]}`] },
    { k: "pr_tNormalise", f: [], cmd: () => "step normmax" },
  ] },
  { group: "pr_gForce", items: [
    { k: "pr_tFz", f: [], cmd: () => "fz" },
    { k: "pr_tBw", f: [["n", "pr_fFrom", 0], ["n", "pr_fTo", 1]], cmd: (v) => `bw ${v[0]} ${v[1]}` },
    { k: "pr_tPeaks", f: [["c", "pr_fCol", null, "fz"], ["s", "pr_fThreshold", "1.3bw"], ["n", "pr_fHalf", 50]], cmd: (v) => `peaks ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tContacts", f: [["c", "pr_fCol", null, "fz"], ["n", "pr_fThresholdN", 20], ["n", "pr_fMinSamples", 20]], cmd: (v) => `contacts ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tJump", f: [["c", "pr_fCol", null, "fz"], ["n", "pr_fThresholdN", 20], ["n", "pr_fQuiet", 1]], cmd: (v) => `jump ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tImpulse", f: [["c", "pr_fCol", null, "fz"], ["n", "pr_fQuiet", 0.5], ["n", "pr_fThresholdN", 20]], cmd: (v) => `impulse ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tGait", f: [["c", "pr_fVert", null, "fz"], ["c", "pr_fAp", null, "fy"], ["n", "pr_fMass", ""], ["n", "pr_fThresholdN", 20]],
      cmd: (v) => `gait ${quote(v[0])} ${quote(v[1])} ${v[2] || ""} ${v[3]}`.replace(/\s+/g, " ").trim() },
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
    { k: "pr_tOverlay", f: [["c", "pr_fCol"], ["s", "pr_fMode", "time"]], cmd: (v) => `overlay ${quote(v[0])} ${v[1]}` },
    { k: "pr_tMeanSd", f: [["c", "pr_fCol"]], cmd: (v) => `meansd ${quote(v[0])}` },
    { k: "pr_tMeanSdContacts", f: [["c", "pr_fCol"]], cmd: (v) => `meansd ${quote(v[0])} contacts` },
    { k: "pr_tCompare", f: [["s", "pr_fMeasure", "height (flight"], ["s", "pr_fCondA", "A"], ["s", "pr_fCondB", "B"]], cmd: (v) => `compare ${quote(v[0])} ${v[1]} ${v[2]}` },
    { k: "pr_tValues", f: [["s", "pr_fLabel", "fascicle_mm"], ["s", "pr_fValues", "45.1 47.8 44.0"]], cmd: (v) => `values ${quote(v[0])} ${v[1]}` },
    { k: "pr_tChange", f: [["s", "pr_fLabel", "pennation"], ["n", "pr_fBefore", 18], ["n", "pr_fAfter", 45.9]], cmd: (v) => `change ${quote(v[0])} ${v[1]} ${v[2]}` },
  ] },
];

/** Mount the page into `root`. `t` translates, `download(name, text|blob)` saves a file. */
export function mountProcess(root, { t, download }) {
  const P = makeProcessor();
  const S = P.S;
  let colFilter = "", out = [];
  const vis = { toolTab: 0, minmax: false, show3d: false, view: { yaw: 0.6, pitch: 0.35, zoom: 1, up: null, labels: false, frame: 0 }, playing: false, speed: 1, box: null, boxFor: null };
  const cursors = S.cursors;   // dataset name -> [tA, tB]; the engine reads them for "bw ab" / "quiet ab"

  const say = (r, line) => { out.unshift({ ok: r.ok, line, msg: r.msg }); out = out.slice(0, 30); };
  const exec = (line) => { const r = P.run(line); say(r, line); render(); return r; };

  // ---- what is plotted ---------------------------------------------------------
  const rootOf = (ds, k) => (ds.src && ds.src[k]) || k;
  function span(ds) {
    let i0 = 0, i1 = ds.time.length;
    if (S.win) { i0 = Math.max(0, ds.time.findIndex((v) => v >= S.win[0])); i1 = ds.time.findIndex((v) => v > S.win[1]); if (i1 < 0) i1 = ds.time.length; }
    return [i0, Math.max(i0 + 2, i1)];
  }
  function curOf(ds) {
    const [i0, i1] = span(ds), a = ds.time[i0], b = ds.time[i1 - 1];
    let c = cursors[ds.name];
    if (!c || !(c[0] >= a && c[0] <= b) || !(c[1] >= a && c[1] <= b)) c = cursors[ds.name] = [a + 0.1 * (b - a), a + 0.9 * (b - a)];
    return c;
  }
  /* raw = ticked channels (solid); proc = each one through the chain, dashed in the
     same colour, plus any column a command made from it. y arrays are full length. */
  let pipeErr = null;
  function plotted(ds) {
    const tree = channelTree(ds);
    const ticked = [...new Set(S.plot.cols.map((k) => rootOf(ds, k)))].filter((k) => ds.cols[k]);
    const raw = ticked.map((k, i) => ({ key: k, color: COLORS[i % COLORS.length], y: ds.cols[k] }));
    const proc = []; pipeErr = null;
    raw.forEach((r) => {
      if (S.pipe.length) {
        try { proc.push({ key: `${r.key} · ${t("pr_procShort")}`, parent: r.key, color: r.color, dash: "6 4", y: P.processed(ds, r.key) }); }
        catch (e) { pipeErr = e.message; }
      }
      (tree.derived[r.key] || []).forEach((d) => proc.push({ key: d, parent: r.key, base: ds.par && ds.par[d], color: r.color, dash: "2 3", y: ds.cols[d] }));
    });
    return { tree, raw, proc };
  }
  /** Min/max/mean between the cursors, and the processed-vs-raw differences. */
  function compareRows(ds, pl) {
    const [ta, tb] = curOf(ds).slice().sort((x, y) => x - y);
    let a = ds.time.findIndex((v) => v >= ta), b = ds.time.findIndex((v) => v > tb); if (b < 0) b = ds.time.length;
    const iA = Math.max(0, a), iB = Math.max(iA + 1, b);
    const st = (k) => {
      const y = typeof k === "string" ? ds.cols[k] : k; let mn = Infinity, mx = -Infinity, imn = iA, imx = iA, s = 0, n = 0;
      for (let i = iA; i < iB; i++) { const v = y[i]; if (!fin(v)) continue; if (v < mn) { mn = v; imn = i; } if (v > mx) { mx = v; imx = i; } s += v; n++; }
      return { min: mn, tmin: ds.time[imn], max: mx, tmax: ds.time[imx], mean: n ? s / n : NaN, range: mx - mn, atA: y[iA], atB: y[iB - 1] };
    };
    const rows = [];
    for (const r of pl.raw) {
      const s0r = st(r.y); rows.push({ name: r.key, kind: "raw", color: r.color, ...s0r });
      for (const p of pl.proc.filter((q) => q.parent === r.key)) {
        const s1 = st(p.y);
        // compared with what it was made from (e.g. Fz·lp10 with Fz, not with the downward plate signal)
        const s0 = p.base && ds.cols[p.base] && p.base !== r.key ? st(p.base) : s0r;
        rows.push({ name: p.key, kind: "proc", color: p.color, ...s1,
          dPeak: s0.max ? (100 * (s1.max - s0.max)) / Math.abs(s0.max) : NaN, dT: s1.tmax - s0.tmax });
      }
    }
    return { rows, ta, tb };
  }

  // ---- the plot card -------------------------------------------------------------
  function plotCardHTML(ds) {
    if (!S.plot.cols.length && !S.plot.curves && !S.plot.xy) {
      let k = Object.keys(ds.cols)[0];
      try { if (D.verticalForceCandidates(ds).length) k = D.verticalForce(ds).col; } catch { /* no force */ }
      if (k) S.plot.cols = [k];
    }
    const pl = plotted(ds), [i0, i1] = span(ds);
    const x = ds.time.slice(i0, i1), xr = [ds.time[i0], ds.time[i1 - 1]];
    const cur = curOf(ds);
    const marksFor = (keys) => (keys.includes(S.plot.markCol) ? S.plot.marks.filter(([tm]) => tm >= xr[0] && tm <= xr[1]) : []);
    const legend = (series) => `<div class="sub" style="font-size:16px;display:flex;flex-wrap:wrap;gap:4px 12px;margin:2px 0 0">${series.map((s) => `<span><i style="display:inline-block;width:12px;height:0;border-top:2px ${s.dash ? (s.dash === "2 3" ? "dotted" : "dashed") : "solid"} ${s.color};vertical-align:middle"></i> ${escX(s.label)}</span>`).join("")}</div>`;
    const plotBox = (id, title, series, unit, marks, extra = "") => `<div class="prPlotTitle">${title}${extra}</div>${series.length
      ? `<div class="prPlot" id="${id}">${chartSVG({ series, xLabel: t("pr_timeS"), yLabel: unit, marks, cursors: cur, xRange: xr, H: 250 }).svg}<div class="prReadout sub" style="font-size:16px;min-height:16px;margin:2px 0 0"></div></div>${legend(series)}`
      : `<p class="note prEmpty">${id === "prRaw" ? t("pr_tickToPlot") : t("pr_vNone")}</p>`}`;
    const rawSeries = pl.raw.map((r) => ({ x, y: r.y.slice(i0, i1), color: r.color, label: r.key }));
    // min / max of every curve between the cursors, marked on the plot (Basic tab)
    const mmMarks = (list) => {
      if (!vis.minmax) return [];
      const [ta, tb] = cur.slice().sort((p1, p2) => p1 - p2), out2 = [];
      for (const q2 of list) {
        let lo = -1, hi = -1;
        for (let i = 0; i < ds.time.length; i++) { const tt = ds.time[i]; if (tt < ta || tt > tb || !fin(q2.y[i])) continue; if (lo < 0 || q2.y[i] < q2.y[lo]) lo = i; if (hi < 0 || q2.y[i] > q2.y[hi]) hi = i; }
        if (lo >= 0) out2.push([ds.time[lo], q2.y[lo]], [ds.time[hi], q2.y[hi]]);
      }
      return out2;
    };
    const units = (list) => [...new Set(list.map((s) => ds.units[s.key]).filter(Boolean))].join(", ");
    let bottom;
    if (S.plot.panels && S.plot.panels.length) {
      const clear = ` <button type="button" class="ghost" id="prResultClose" style="margin:0 0 0 6px;width:auto;padding:2px 10px;font-size:16px">${t("pr_backProc")}</button>`;
      bottom = S.plot.panels.map((pn, pi) => {
        const series = pn.series.map((q, i) => ({ ...q, color: q.color || COLORS[i % COLORS.length] }));
        return `<div class="prPlotTitle">${escX(pn.title)}${pi === 0 ? clear : ""}</div><div class="prPlot">${chartSVG({ series, xLabel: pn.xLabel || "", H: 260 }).svg}</div>${legend(series.filter((q) => !q.band || q.label))}`;
      }).join("");
    } else if (S.plot.curves || S.plot.xy) {
      const clear = ` <button type="button" class="ghost" id="prResultClose" style="margin:0 0 0 6px;width:auto;padding:2px 8px;font-size:16px">${t("pr_backProc")}</button>`;
      let ch;
      if (S.plot.curves) {
        const c = S.plot.curves, xx = Float64Array.from({ length: c.mean.length }, (_, i) => (100 * i) / (c.mean.length - 1));
        const series = c.all.map((y, i) => ({ x: xx, y, color: COLORS[(i + 1) % COLORS.length], thin: true, label: c.labels[i] }));
        series.push({ x: xx, y: c.mean, band: [c.mean.map((m, i) => m - c.sd[i]), c.mean.map((m, i) => m + c.sd[i])], color: COLORS[0], label: `${t("pr_meanSd")} (n = ${c.all.length})` });
        ch = chartSVG({ series, xLabel: "%", yLabel: c.name, H: 250 }).svg + legend([series[series.length - 1]]);
      } else {
        const [a, b] = S.plot.xy;
        ch = chartSVG({ series: [{ x: ds.cols[a].slice(i0, i1), y: ds.cols[b].slice(i0, i1), color: COLORS[0], label: `${b} vs ${a}` }], xLabel: a, yLabel: b, equal: true, H: 300 }).svg;
      }
      bottom = `<div class="prPlotTitle">${t("pr_result")}${clear}</div><div class="prPlot">${ch}</div>`;
    } else {
      const procSeries = pl.proc.length ? [
        ...pl.raw.map((r) => ({ x, y: r.y.slice(i0, i1), color: r.color, label: `${r.key} (${t("pr_raw").toLowerCase()})`, thin: true })),
        ...pl.proc.map((p) => ({ x, y: p.y.slice(i0, i1), color: p.color, dash: p.dash, label: p.key }))] : [];
      bottom = plotBox("prProc", t("pr_processed"), procSeries, units(pl.raw), [...marksFor(pl.proc.map((p) => p.key)), ...mmMarks(pl.proc)],
        pipeErr ? ` <span style="color:var(--warn);font-weight:400">${escX(pipeErr)}</span>` : "");
    }
    const cmp = pl.raw.length ? compareRows(ds, pl) : null;
    const f = (v) => (fin(v) ? r3(v) : "–");
    const cmpHTML = cmp ? `<div class="prCmp"><div class="prPlotTitle" style="margin-top:0">${t("pr_cmpTitle", { a: f(cmp.ta), b: f(cmp.tb) })}</div>
      <div style="overflow-x:auto"><table><thead><tr><th></th><th>${t("pr_min")}</th><th>${t("pr_atT")}</th><th>${t("pr_max")}</th><th>${t("pr_atT")}</th><th>${t("pr_mean")}</th><th>${t("pr_range")}</th><th>A</th><th>B</th><th>${t("pr_peakChange")}</th><th>${t("pr_peakShift")}</th></tr></thead><tbody>${
      cmp.rows.map((r) => `<tr${r.kind === "raw" ? ' class="prCmpRaw"' : ""}><td><i style="display:inline-block;width:10px;height:0;border-top:2px solid ${r.color};vertical-align:middle"></i> ${escX(r.name)}</td><td>${f(r.min)}</td><td>${f(r.tmin)}</td><td>${f(r.max)}</td><td>${f(r.tmax)}</td><td>${f(r.mean)}</td><td>${f(r.range)}</td><td>${f(r.atA)}</td><td>${f(r.atB)}</td><td>${r.kind === "proc" ? `${f(r.dPeak)} %` : ""}</td><td>${r.kind === "proc" ? `${f(r.dT)} s` : ""}</td></tr>`).join("")}</tbody></table></div>
      <button type="button" class="ghost" id="prZoomCur" style="margin:6px 0 0;width:auto;padding:4px 10px;font-size:16px">${t("pr_zoomCur")}</button></div>` : "";
    const mk = markerTriplets(ds);
    const chans = pl.tree.raw.filter((k) => !colFilter || k.toLowerCase().includes(colFilter.toLowerCase()));
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b>${escX(ds.name)}</b>
        ${mk.length ? `<button type="button" class="${vis.show3d ? "" : "ghost"}" id="prShow3d" style="margin:0;width:auto;padding:4px 10px;font-size:16px">${t("pr_v3d")} (${mk.length})</button>` : ""}</div>
      <div class="row" style="margin-top:8px;align-items:flex-end;gap:8px">
        <div><label for="prT0">${t("pr_from")}</label><input id="prT0" type="number" step="any" value="${S.win ? S.win[0] : ""}" placeholder="${(+ds.time[0]).toFixed(2)}"></div>
        <div><label for="prT1">${t("pr_to")}</label><input id="prT1" type="number" step="any" value="${S.win ? S.win[1] : ""}" placeholder="${(+ds.time[ds.time.length - 1]).toFixed(2)}"></div>
        <div><button type="button" class="ghost" id="prWinAll" style="margin:0">${t("pr_whole")}</button></div>
      </div>
      <div class="prVis">
        <div class="prChanCol">
          <input id="prColFilter" type="search" placeholder="${t("pr_filterCols")}" value="${escX(colFilter)}">
          <div class="prChanList">${chans.map((k) => `<label class="prCol"><input type="checkbox" data-col="${escX(k)}"${S.plot.cols.some((c) => rootOf(ds, c) === k) ? " checked" : ""}> ${escX(k)}${pl.tree.derived[k] ? ` <span class="sub" style="font-size:15px">→ ${pl.tree.derived[k].length}</span>` : ""}${ds.units[k] ? ` <span class="sub" style="font-size:15px">(${escX(ds.units[k])})</span>` : ""}</label>`).join("") || `<p class="note">${t("pr_noCols")}</p>`}</div>
          ${ds.meta?.text ? `<p class="note" style="margin:6px 0 0">${t("pr_textCols")}: ${Object.keys(ds.meta.text).map(escX).join(", ")}</p>` : ""}
        </div>
        <div class="prPlots">
          ${plotBox("prRaw", t("pr_raw"), rawSeries, units(pl.raw), [...marksFor(pl.raw.map((r) => r.key)), ...mmMarks(pl.raw)])}
          ${bottom}
          <div class="row" style="margin-top:8px;gap:8px"><button type="button" class="ghost" id="prCsv" style="margin:0">${t("pr_saveCsv")}</button><button type="button" class="ghost" id="prPng" style="margin:0">${t("pr_savePng")}</button></div>
          ${cmpHTML}
        </div>
      </div>
    </div>
    ${vis.show3d && mk.length ? markers3dHTML(ds, mk) : ""}`;
  }

  function markers3dHTML(ds, mk) {
    const n = ds.time.length;
    if (vis.view.up == null) vis.view.up = ds.kind === "trc" ? "y" : "z";
    vis.view.frame = Math.min(vis.view.frame, n - 1);
    return `<div class="card"><b>${t("pr_v3d")} (${mk.length})</b>
      <canvas id="prCanvas" style="width:100%;aspect-ratio:4/3;display:block;border:1px solid var(--line);border-radius:10px;touch-action:none;cursor:grab;margin-top:8px"></canvas>
      <p class="note" style="margin:4px 0 6px">${t("pr_vDrag")}</p>
      <div class="row" style="gap:8px;align-items:center">
        <button type="button" id="prPlay" style="margin:0;width:auto;padding:6px 14px">${vis.playing ? t("pr_pause") : t("pr_play")}</button>
        <input id="prFrame" type="range" min="0" max="${n - 1}" value="${vis.view.frame}" style="flex:1">
        <span id="prFrameT" class="sub" style="font-size:16px;min-width:64px;text-align:right">${(+ds.time[vis.view.frame]).toFixed(2)} s</span></div>
      <div class="row" style="gap:12px;align-items:center;margin-top:6px;font-size:15px">
        <label>${t("pr_up")} <select id="prUp" style="width:auto;display:inline-block">${["z", "y"].map((a) => `<option${vis.view.up === a ? " selected" : ""}>${a}</option>`).join("")}</select></label>
        <label>${t("pr_speed")} <select id="prSpeed" style="width:auto;display:inline-block">${[0.25, 0.5, 1, 2].map((v) => `<option value="${v}"${vis.speed === v ? " selected" : ""}>${v}×</option>`).join("")}</select></label>
        <label><input type="checkbox" id="prLabels"${vis.view.labels ? " checked" : ""} style="width:auto;display:inline-block;min-height:0"> ${t("pr_labels")}</label></div></div>`;
  }

  // ---- tools: one row each, the button first --------------------------------------
  function toolsHTML(ds) {
    const keys = ds ? Object.keys(ds.cols) : [];
    const pl = ds ? plotted(ds) : { raw: [], proc: [] };
    const pre = [...pl.proc.map((p) => p.key), ...pl.raw.map((r) => r.key)];
    const colSel = (id, pick) => `<select id="${id}">${["@fz", ...keys].map((k) => `<option value="${escX(k)}"${k === pick ? " selected" : ""}>${escX(k === "@fz" ? t("pr_autoFz") : k)}</option>`).join("")}</select>`;
    const tabs = `<div class="prTabs">${TOOLS.map((g, gi) => `<button type="button" class="${gi === vis.toolTab ? "" : "ghost"}" data-ttab="${gi}">${t(g.group)}</button>`).join("")}</div>`;
    const chain = `<div class="prChain"><b>${t("pr_steps")}</b> ${S.pipe.length ? S.pipe.map((st, i) => `<span class="prChip">${i + 1}. ${escX(stepLabel(st))} <button type="button" data-unstep="${i + 1}" aria-label="${t("pr_remove")}">×</button></span>`).join("")
      + ` <button type="button" class="ghost" id="prStepsClear" style="margin:0;width:auto;padding:4px 12px">${t("pr_clearSteps")}</button>` : `<span class="sub">${t("pr_noSteps")}</span>`}</div>`;
    return chain + tabs + [TOOLS[vis.toolTab]].map((g) => { const gi = vis.toolTab; return `<div class="prGroup">${g.items.map((it, ii) => {
      const id = `prT${gi}_${ii}`; let ci = 0;
      const fields = it.f.map(([type, lbl, def, pick], fi) => `<label>${t(lbl)} ${type === "c"
        ? colSel(`${id}_${fi}`, pick === "fz" ? (keys.find((k) => /^(Fz|Fz_N|Fz \(N\))$/i.test(k)) || "@fz")
          : pick === "fy" ? (keys.find((k) => /(^|[ ._-])Fy(_N)?$/.test(k) && !/·/.test(k)) || "")
          : pl.raw[ci] ? (ci++ === 0 ? pl.raw[0].key : pre[ci - 1]) : "")
        : `<input id="${id}_${fi}" type="${type === "n" ? "number" : "text"}" step="any" value="${escX(def ?? "")}"${type === "n" ? ' class="prNum"' : ""}>`}</label>`).join("");
      const on = it.ui === "minmax" && vis.minmax;
      return `<div class="prToolRow"><button type="button" data-tool="${gi}_${ii}"${it.ui && !on ? ' class="ghost"' : ""}>${t(it.k)}${it.ui ? (on ? " ✓" : "") : ""}</button>${fields}</div>`;
    }).join("")}</div>`; }).join("");
  }

  function render() {
    const open = [];
    const ds = P.current();
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
          <span class="sub" style="font-size:15.5px;display:block;margin:0">${d.fs ? `${+d.fs.toFixed(2)} Hz · ` : ""}${d.time.length} ${t("pr_samples")} · ${Object.keys(d.cols).length} ${t("pr_columns")}${d.meta?.noTime ? " · " + t("pr_noTime") : ""}</span></button>
        <button type="button" class="ghost" data-del="${i}" aria-label="${t("pr_remove")}" style="margin:0;width:auto;padding:6px 10px">×</button></div>`).join("")}</div>` : ""}
    </div>
    ${ds ? plotCardHTML(ds) : ""}
    ${ds ? `<div class="card"><b>${t("pr_tools")}</b><p class="note" style="margin:4px 0 6px">${t("pr_toolsNote")}</p>${toolsHTML(ds)}</div>` : ""}
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
      <details style="margin-top:8px"><summary>${t("pr_cmdList")}</summary><table style="font-size:16px;margin-top:6px"><tbody>${HELP.map(([c, d], i) => `<tr><td style="font-family:ui-monospace,Consolas,monospace;white-space:nowrap;padding-right:8px">${escX(c)}</td><td>${escX(t(`pr_h${i}`) === `pr_h${i}` ? d : t(`pr_h${i}`))}</td></tr>`).join("")}</tbody></table>
        <p class="note">${t("pr_cmdNote")}</p></details>
    </div>
    ${S.results.length ? `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b>${t("pr_results")}</b>
      <span><button type="button" class="ghost" id="prResCsv" style="margin:0;width:auto;padding:6px 10px">${t("pr_saveCsv")}</button>
      <button type="button" class="ghost" id="prResClear" style="margin:0;width:auto;padding:6px 10px">${t("pr_clear")}</button></span></div>
      <div style="overflow-x:auto;max-height:340px;margin-top:8px"><table style="font-size:16px"><thead><tr><th>${t("pr_file")}</th><th>${t("pr_measure")}</th><th>${t("pr_value")}</th><th></th></tr></thead><tbody>${
        S.results.slice().reverse().map((r) => `<tr><td>${escX(r.file.replace(/ · .*/, ""))}</td><td>${escX(r.measure)}</td><td style="text-align:right">${escX(r.value)}</td><td>${escX(r.unit)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <p class="note" style="margin:6px 4px 0">${t("pr_honest")}</p>`;
    root.querySelectorAll(".prGroup").forEach((d, i) => { if (open[i] !== undefined) d.open = open[i]; });
    wire(ds);
  }

  async function load(files) {
    for (const f of files) {
      try {
        const list = await readAny(f); P.add(list);
        // open on something: the first few channels of the new file
        /* the plot card picks the first channel (the loaded force plate if any) */
        say({ ok: true, msg: list.map((d) => `${d.name}: ${Object.keys(d.cols).length} ${t("pr_columns")}`).join("\n") }, `load ${f.name}`);
      } catch (e) { say({ ok: false, msg: e.message }, `load ${f.name}`); }
    }
    render();
  }

  function svgForExport(svgs, titles) {
    const W = 720; let y = 0, body = "";
    svgs.forEach((s, i) => {
      const vb = s.getAttribute("viewBox").split(" ").map(Number), h = vb[3];
      body += `<text x="8" y="${y + 18}" font-size="17" font-weight="600" fill="#222">${escX(titles[i])}</text>`;
      body += s.outerHTML.replace("<svg ", `<svg x="0" y="${y + 24}" width="${W}" height="${h}" `);
      y += h + 30;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}"><rect width="${W}" height="${y}" fill="#fff"/>${body}</svg>`
      .replace(/var\(--card\)/g, "#fff").replace(/var\(--line\)/g, "#ddd").replace(/var\(--muted\)/g, "#666").replace(/var\(--warn\)/g, "#b4540f").replace(/var\(--accent\)/g, "#2d706c")
      .replace(/<line class="prCursor"[^>]*\/>/g, "");
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
    const setWin = () => { const a = q("#prT0").value, b = q("#prT1").value; if (a !== "" && b !== "") exec(`window ${a} ${b}`); };
    q("#prT0").onchange = setWin; q("#prT1").onchange = setWin;
    q("#prWinAll").onclick = () => exec("window all");
    if (q("#prZoomCur")) q("#prZoomCur").onclick = () => { const c = curOf(ds).slice().sort((x, y) => x - y); exec(`window ${r3(c[0])} ${r3(c[1])}`); };
    if (q("#prResultClose")) q("#prResultClose").onclick = () => { S.plot.curves = null; S.plot.xy = null; S.plot.panels = null; render(); };
    if (q("#prShow3d")) q("#prShow3d").onclick = () => { vis.show3d = !vis.show3d; vis.playing = false; render(); };
    const f = q("#prColFilter");
    f.oninput = () => { colFilter = f.value; const pos = f.selectionStart; render(); const g = root.querySelector("#prColFilter"); g.focus(); g.setSelectionRange(pos, pos); };
    root.querySelectorAll("[data-col]").forEach((c) => {
      c.onchange = () => {
        const k = c.dataset.col, now = [...new Set(S.plot.cols.map((x) => rootOf(ds, x)))];
        const next = c.checked ? [...now.filter((x) => x !== k), k] : now.filter((x) => x !== k);
        const keepRes = { curves: S.plot.curves, xy: S.plot.xy, panels: S.plot.panels };
        exec(`plot ${next.map(quote).join(" ")}`.trim());
        Object.assign(S.plot, keepRes); render();
      };
    });
    root.querySelectorAll("[data-ttab]").forEach((b) => { b.onclick = () => { vis.toolTab = +b.dataset.ttab; render(); }; });
    root.querySelectorAll("[data-unstep]").forEach((b) => { b.onclick = () => exec(`step remove ${b.dataset.unstep}`); });
    if (q("#prStepsClear")) q("#prStepsClear").onclick = () => exec("step clear");
    root.querySelectorAll("[data-tool]").forEach((b) => {
      b.onclick = () => {
        const [gi, ii] = b.dataset.tool.split("_").map(Number), it = TOOLS[gi].items[ii];
        if (it.ui === "minmax") { vis.minmax = !vis.minmax; render(); return; }
        const v = it.f.map((_, fi) => root.querySelector(`#prT${gi}_${ii}_${fi}`).value);
        const lines = [].concat(it.cmd(v));
        for (const line of lines.slice(0, -1)) say(P.run(line), line);
        q("#prCmd").value = lines[lines.length - 1]; exec(lines[lines.length - 1]);
      };
    });
    if (q("#prCsv")) q("#prCsv").onclick = () => {
      // every channel of the file, through the processing chain, over the current window
      const [i0, i1] = span(ds), keys = channelTree(ds).raw, cols = {};
      try { for (const k of keys) cols[k] = (S.pipe.length ? P.processed(ds, k) : ds.cols[k]).slice(i0, i1); }
      catch (e) { say({ ok: false, msg: e.message }, t("pr_saveCsv")); render(); return; }
      download(`${ds.name.replace(/[^\w.-]+/g, "_")}_${S.pipe.length ? "processed" : "raw"}.csv`, toCsv({ time: ds.time.slice(i0, i1), cols }, keys));
    };
    if (q("#prPng")) q("#prPng").onclick = () => {
      const svgs = [...root.querySelectorAll(".prPlots .prPlot svg")];
      const titles = [...root.querySelectorAll(".prPlots .prPlotTitle")].map((e) => e.firstChild.textContent);
      if (!svgs.length) return;
      const text = svgForExport(svgs, titles);
      const img = new Image(), url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
      img.onload = () => {
        const c = document.createElement("canvas"); c.width = img.width * 2; c.height = img.height * 2;
        const g = c.getContext("2d"); g.scale(2, 2); g.drawImage(img, 0, 0); URL.revokeObjectURL(url);
        c.toBlob((b) => download(`${ds.name.replace(/[^\w.-]+/g, "_")}_plot.png`, b), "image/png");
      };
      img.src = url;
    };
    // hover readout + draggable cursors, on both plots
    for (const svg of root.querySelectorAll(".prPlots .prPlot svg")) {
      const box = svg.closest(".prPlot"), ro = box.querySelector(".prReadout"), line = svg.querySelector(".prCursor");
      const W = +svg.dataset.w, L = +svg.dataset.l, R = +svg.dataset.r, x0 = +svg.dataset.x0, x1 = +svg.dataset.x1;
      const toT = (e) => { const rc = svg.getBoundingClientRect(); const px = ((e.clientX - rc.left) / rc.width) * W; return [px, x0 + ((px - L) / (W - L - R)) * (x1 - x0)]; };
      const isTime = !!svg.querySelector(".prCur");
      let drag = null;
      svg.onpointerdown = (e) => {
        if (!isTime) return;
        // press anywhere: the nearer cursor jumps there and follows the pointer
        const [px, tm] = toT(e), c = curOf(ds);
        if (px < L || px > W - R) return;
        const k = Math.abs(c[0] - tm) <= Math.abs(c[1] - tm) ? 0 : 1;
        drag = k; e.preventDefault();
        try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
        svg.onpointermove(e);
      };
      svg.onpointermove = (e) => {
        const [px, tm] = toT(e); if (px < L || px > W - R) return;
        if (drag != null) {
          const c = curOf(ds); c[drag] = Math.max(x0, Math.min(x1, tm));
          const tx = L + ((c[drag] - x0) / (x1 - x0)) * (W - L - R);
          root.querySelectorAll(`.prPlots .prCur[data-cur="${drag}"]`).forEach((g) => g.setAttribute("transform", `translate(${tx.toFixed(1)},0)`));
        }
        if (!ro || !isTime) return;
        const i = Math.max(0, Math.min(ds.time.length - 1, ds.time.findIndex((v) => v >= tm)));
        const keys = box.id === "prRaw" ? plotted(ds).raw.map((r) => r.key) : plotted(ds).proc.map((p) => p.key);
        ro.textContent = `${r3(ds.time[i])} s — ${keys.map((k) => `${k}: ${r3(ds.cols[k][i])}`).join(" · ")}`;
        line.setAttribute("x1", px); line.setAttribute("x2", px); line.setAttribute("visibility", "visible");
      };
      svg.onpointerup = () => { if (drag != null) { drag = null; render(); } };
    }
    wire3d(ds);
  }

  function wire3d(ds) {
    const cv = root.querySelector("#prCanvas"); if (!cv) { vis.playing = false; return; }
    const mk = markerTriplets(ds), key = ds.name + vis.view.up;
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

  render();
  return { P, render, load };
}
