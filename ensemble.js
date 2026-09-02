/**
 * ensemble.js -- the mean rep.
 *
 * Reps are never the same length, so averaging them frame by frame would
 * compare the bottom of a slow rep against the top of a fast one. The standard
 * fix in gait and strength biomechanics is time normalisation: express every
 * rep as 0-100% of itself, resample onto a common grid, then average across
 * reps at each percent. That is what this does.
 *
 * What comes back is a rep-shaped object, so every panel that draws a single
 * rep -- the angle chart, the joint moments, the muscle forces -- draws the
 * mean with no changes. Its `times` array is PERCENT, not seconds, which is
 * why it carries `timeUnit` for the axis label.
 *
 * The spread is carried alongside as `sd`: the between-rep standard deviation
 * at each percent. A wide band means the reps did not repeat, which is often
 * the more interesting finding than the mean itself.
 */
export const GRID = 101;                 // 0, 1, ... 100 percent

/** Linear resample of `y` (sampled at `x`) onto `n` points spanning x's range. */
export function resample(x, y, n = GRID) {
  const out = new Array(n);
  const x0 = x[0], x1 = x[x.length - 1], span = x1 - x0 || 1;
  let j = 0;
  for (let k = 0; k < n; k++) {
    const xt = x0 + (span * k) / (n - 1);
    while (j < x.length - 2 && x[j + 1] < xt) j++;
    const xa = x[j], xb = x[j + 1] ?? xa, ya = y[j], yb = y[j + 1] ?? ya;
    const f = xb === xa ? 0 : (xt - xa) / (xb - xa);
    const v = ya + (yb - ya) * f;
    out[k] = Number.isFinite(v) ? v : (Number.isFinite(ya) ? ya : 0);
  }
  return out;
}

// Float64Array counts. forces.js hands back typed arrays, and an
// Array.isArray test silently dropped every muscle force from the mean.
const isNumArray = (v) => v != null && (Array.isArray(v) || ArrayBuffer.isView(v)) &&
  v.length > 0 && typeof v[0] === "number";

function meanAndSd(curves) {
  const n = curves[0].length, m = new Array(n), s = new Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (const c of curves) sum += c[k];
    m[k] = sum / curves.length;
    let v = 0;
    for (const c of curves) v += (c[k] - m[k]) ** 2;
    // Sample SD: with two reps the population form understates the spread by
    // 30%, and two or three reps is the normal case here.
    s[k] = curves.length > 1 ? Math.sqrt(v / (curves.length - 1)) : 0;
  }
  return [m, s];
}

/** Average a dict of per-frame arrays across reps. Keys missing from any rep
 *  are dropped rather than averaged over a subset, which would silently mix
 *  different numbers of reps into different curves of the same plot. */
function meanDict(reps, get) {
  const first = get(reps[0]);
  if (!first) return [null, null];
  const out = {}, sd = {};
  for (const key of Object.keys(first)) {
    if (!isNumArray(first[key])) {
      // Scalars (body_weight_n and friends) are averaged as scalars.
      const vals = reps.map((r) => get(r)?.[key]).filter((v) => typeof v === "number");
      if (vals.length === reps.length) out[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
      continue;
    }
    const curves = [];
    for (const r of reps) {
      const d = get(r), a = d && d[key];
      if (!isNumArray(a) || a.length !== r.times.length) { curves.length = 0; break; }
      curves.push(resample(r.times, a));
    }
    if (!curves.length) continue;
    const [m, s] = meanAndSd(curves);
    out[key] = m; sd[key] = s;
  }
  return [out, sd];
}

/** Average the frames x muscles force matrix. */
function meanMatrix(reps, key) {
  const first = reps[0][key];
  if (!Array.isArray(first) || !first.length || !isNumArray(first[0])) return null;
  const width = first[0].length;
  const perRep = [];
  for (const r of reps) {
    const mat = r[key];
    if (!Array.isArray(mat) || mat.length !== r.times.length) return null;
    // Resample each muscle column, then re-assemble rows.
    const cols = [];
    for (let i = 0; i < width; i++) {
      cols.push(resample(r.times, mat.map((row) => row[i] ?? 0)));
    }
    perRep.push(cols);
  }
  const rows = [];
  for (let k = 0; k < GRID; k++) {
    const row = new Array(width);
    for (let i = 0; i < width; i++) {
      let s = 0;
      for (const cols of perRep) s += cols[i][k];
      row[i] = s / perRep.length;
    }
    rows.push(row);
  }
  return rows;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Mean of a scalar field across reps, with its SD, or null if any rep lacks it. */
export function scalarStats(reps, key) {
  const v = reps.map((r) => num(r[key])).filter((x) => x != null);
  if (v.length < 1) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1
    ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : 0;
  return { mean: m, sd, n: v.length, min: Math.min(...v), max: Math.max(...v) };
}

/**
 * Build the mean rep. Returns null for fewer than two reps -- an "average" of
 * one rep is that rep, and offering it as a separate tab would just be a
 * duplicate that quietly implies more data than exists.
 */
export function ensembleRep(reps) {
  if (!Array.isArray(reps) || reps.length < 2) return null;
  const usable = reps.filter((r) => Array.isArray(r.times) && r.times.length > 1);
  if (usable.length < 2) return null;

  const pct = Array.from({ length: GRID }, (_, k) => k);
  const [coords, coordSd] = meanDict(usable, (r) => r.coords);
  const [dyn, dynSd] = meanDict(usable, (r) => r.dyn);

  const out = {
    rep: "mean", isMean: true, nReps: usable.length,
    times: pct, timeUnit: "%",
    coords, sd: { coords: coordSd },
    bounds: usable[0].bounds,
    // Where the turnaround falls, averaged as a FRACTION of each rep rather
    // than in seconds: on the normalised axis that is the only position that
    // means the same thing for a slow rep and a fast one.
    topPct: 100 * usable.reduce((a, r) => {
      const [b0, top, b1] = r.bounds || [];
      return a + (b1 > b0 ? (top - b0) / (b1 - b0) : 0.5);
    }, 0) / usable.length,
  };
  if (dyn && Object.keys(dyn).length) { out.dyn = dyn; out.sd.dyn = dynSd; }

  const forces = meanMatrix(usable, "forces");
  if (forces) {
    out.forces = forces;
    out.forceNames = usable[0].forceNames;
    out.forceModel = usable[0].forceModel;
    out.forceMissing = usable[0].forceMissing;
    out.forceImplausible = Math.max(...usable.map((r) => r.forceImplausible || 0));
  }
  const jrf = meanMatrix(usable, "jrf");
  if (jrf) { out.jrf = jrf; out.jrfNames = usable[0].jrfNames; }

  // Scalar per-rep measures: mean, and the spread that says whether the mean
  // means anything.
  out.stats = {};
  const scalarKeys = new Set();
  for (const r of usable) {
    for (const [k, v] of Object.entries(r)) if (typeof v === "number") scalarKeys.add(k);
  }
  for (const k of scalarKeys) {
    const s = scalarStats(usable, k);
    if (s) { out.stats[k] = s; out[k] = s.mean; }
  }
  out.rep = "mean";        // scalarKeys must not overwrite the label
  return out;
}
