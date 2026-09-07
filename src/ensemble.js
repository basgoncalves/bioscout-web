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

/* Event alignment.
 *
 * Stretching each rep from its first frame to its last lines up the ENDS of
 * the window and nothing else. For a squat that is nearly enough, because the
 * window is the rep. For a jump it is not: the window is a bit of pre-roll,
 * a push, a flight and a landing, and their proportions differ from jump to
 * jump. Two jumps with 0.09 s and 0.62 s of flight had take-off at completely
 * different points on the normalised axis, so the "mean" was averaging the
 * push of one against the flight of the other -- an average of nothing.
 *
 * The fix is the standard one from gait, where stance and swing are normalised
 * separately so heel-strike and toe-off always land on the same percent. Each
 * rep declares the events it knows -- start, turnaround (bottom of a squat,
 * take-off of a jump), touch-down where there is one, end -- and each interval
 * between events is resampled on its own. The events on the mean curve sit at
 * the MEAN of where they fell in the individual reps, so the mean keeps the
 * timing of a real rep rather than being forced onto arbitrary round numbers.
 */
function eventFracs(rep) {
  const n = rep.times.length;
  if (!(n > 1)) return null;
  const [b0, mid, b1] = rep.bounds || [];
  const out = [0];
  const push = (frame) => {
    if (!Number.isFinite(frame)) return;
    const f = (frame - b0) / (b1 - b0);
    if (f > (out[out.length - 1] ?? 0) + 1e-6 && f < 1 - 1e-6) out.push(f);
  };
  if (Number.isFinite(b0) && Number.isFinite(b1) && b1 > b0) {
    push(mid);
    push(rep.land_frame);
  }
  out.push(1);
  return out;
}

/** Linear resample of `y` (sampled evenly over [0,1]) at fractional position f. */
function sampleAt(y, f) {
  const x = Math.max(0, Math.min(1, f)) * (y.length - 1);
  const i = Math.floor(x), j = Math.min(y.length - 1, i + 1);
  const t = x - i;
  const a = y[i], b = y[j];
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : 0;
  if (!Number.isFinite(b)) return a;
  return a + (b - a) * t;
}

/** Resample `y` so that `src` events land on `dst` events. */
export function resampleEvents(y, src, dst, n = GRID) {
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const p = k / (n - 1);
    let seg = 0;
    while (seg < dst.length - 2 && p > dst[seg + 1]) seg++;
    const d0 = dst[seg], d1 = dst[seg + 1];
    const s0 = src[seg], s1 = src[seg + 1];
    const u = d1 === d0 ? 0 : (p - d0) / (d1 - d0);
    out[k] = sampleAt(y, s0 + (s1 - s0) * u);
  }
  return out;
}

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
function meanDict(reps, get, align) {
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
      curves.push(align ? align(r, a) : resample(r.times, a));
    }
    if (!curves.length) continue;
    const [m, s] = meanAndSd(curves);
    out[key] = m; sd[key] = s;
  }
  return [out, sd];
}

/** Average the frames x muscles force matrix. */
function meanMatrix(reps, key, align) {
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
      const col = mat.map((row) => row[i] ?? 0);
      cols.push(align ? align(r, col) : resample(r.times, col));
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

  // Events, if every rep agrees on how many it has. A rep that reports a
  // touch-down and one that does not cannot be aligned on touch-down, and
  // guessing would be worse than falling back to the ends.
  const fracs = usable.map(eventFracs);
  const nEv = fracs[0] ? fracs[0].length : 0;
  const aligned = fracs.every((f) => f && f.length === nEv) && nEv > 2;
  const dst = aligned
    ? Array.from({ length: nEv }, (_, i) =>
        fracs.reduce((a, f) => a + f[i], 0) / fracs.length)
    : null;
  const align = aligned
    ? (r, y) => resampleEvents(y, fracs[usable.indexOf(r)], dst)
    : null;

  const [coords, coordSd] = meanDict(usable, (r) => r.coords, align);
  const [dyn, dynSd] = meanDict(usable, (r) => r.dyn, align);

  const out = {
    rep: "mean", isMean: true, nReps: usable.length,
    times: pct, timeUnit: "%",
    coords, sd: { coords: coordSd },
    bounds: usable[0].bounds,
    // Where the turnaround falls. When the reps were event-aligned this is
    // exactly where every rep's turnaround now sits; otherwise it is the mean
    // of where they fell, which is the best that unaligned curves allow.
    topPct: 100 * (dst ? dst[1] : usable.reduce((a, r) => {
      const [b0, top, b1] = r.bounds || [];
      return a + (b1 > b0 ? (top - b0) / (b1 - b0) : 0.5);
    }, 0) / usable.length),
    landPct: dst && dst.length > 3 ? 100 * dst[2] : null,
    eventAligned: aligned,
  };
  if (dyn && Object.keys(dyn).length) { out.dyn = dyn; out.sd.dyn = dynSd; }

  const forces = meanMatrix(usable, "forces", align);
  if (forces) {
    out.forces = forces;
    out.forceNames = usable[0].forceNames;
    out.forceModel = usable[0].forceModel;
    out.forceMissing = usable[0].forceMissing;
    out.forceImplausible = Math.max(...usable.map((r) => r.forceImplausible || 0));
  }
  const jrf = meanMatrix(usable, "jrf", align);
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
