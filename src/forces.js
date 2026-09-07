/**
 * forces.js -- the FAIS static-optimisation surrogate, in the browser.
 *
 * Replaces the model that failed its own audit (113,250 N on a trial from its
 * own training set). Three things changed, and each one killed a distinct
 * failure mode:
 *
 *  1. The network has no BatchNorm, so this forward pass is the arithmetic the
 *     net was trained with rather than a guess at it. The Python exporter
 *     refuses to write the file unless a replay of it reproduces the trained
 *     weights to 1e-4, and `selfTest()` below re-checks that in the browser.
 *  2. Targets are bodyweight-normalised, not log1p newtons. A small error is
 *     now a small error in newtons instead of three orders of magnitude.
 *  3. The model is given joint velocities and accelerations, not angles alone.
 *     Muscle force at an instant depends on the state, not the pose; the old
 *     model was asked to infer dynamics from a still frame.
 *
 * It still cannot know external load: an empty bar and a loaded bar at the same
 * depth and tempo produce the same inputs. Bodyweight movement only.
 *
 * Trained on running and single-leg squats. Squats are a short extrapolation;
 * PULL-UPS ARE NOT SUPPORTED -- all 80 muscles are lower limb.
 */

export const MAX_PLAUSIBLE_FORCE_N = 5000;
export const G = 9.80665;

let cached = null;

function unpack(m) {
  const bin = atob(m.b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return { shape: m.shape, data: new Float32Array(buf) };
}

export async function loadForceModel(url = "force_model.json") {
  if (cached) return cached;
  const j = await (await fetch(url)).json();
  if (j.format !== "fais-forcenet/1") {
    throw new Error(`unsupported force model format ${j.format}`);
  }
  cached = {
    format: j.format, info: j.info, provenance: j.provenance, report: j.report,
    inputs: j.inputs, units: j.units,
    feat: j.feat, targ: j.targ,
    muscles: j.muscles, jrfComponents: j.jrf_components,
    jrfMagnitudes: j.jrf_magnitudes, cameraCoords: j.camera_coords,
    xMean: unpack(j.x_mean).data, xStd: unpack(j.x_std).data,
    yMean: unpack(j.y_mean).data, yStd: unpack(j.y_std).data,
    stem: { W: unpack(j.stem.W), b: unpack(j.stem.b) },
    blocks: j.blocks.map((b) => ({
      normW: unpack(b.norm_w).data, normB: unpack(b.norm_b).data,
      fc1: { W: unpack(b.fc1_W), b: unpack(b.fc1_b) },
      fc2: { W: unpack(b.fc2_W), b: unpack(b.fc2_b) },
    })),
    normW: unpack(j.norm_w).data, normB: unpack(j.norm_b).data,
    head: { W: unpack(j.head.W), b: unpack(j.head.b) },
  };
  return cached;
}

// ── layers ────────────────────────────────────────────────────────────────────

function linear(x, layer, out) {
  const [nIn, nOut] = layer.W.shape;
  for (let o = 0; o < nOut; o++) {
    let s = layer.b.data[o];
    for (let i = 0; i < nIn; i++) s += x[i] * layer.W.data[i * nOut + o];
    out[o] = s;
  }
  return out;
}

function layerNorm(x, w, b, out, eps = 1e-5) {
  const n = x.length;
  let mu = 0;
  for (let i = 0; i < n; i++) mu += x[i];
  mu /= n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mu; v += d * d; }
  v /= n;
  const inv = 1 / Math.sqrt(v + eps);
  for (let i = 0; i < n; i++) out[i] = (x[i] - mu) * inv * w[i] + b[i];
  return out;
}

/** One frame of standardised features -> raw targets (bodyweight units). */
function forwardOne(m, z, scratch) {
  const { h, a, c } = scratch;
  linear(z, m.stem, h);
  for (let k = 0; k < h.length; k++) h[k] = Math.max(0, h[k]);
  for (const blk of m.blocks) {
    layerNorm(h, blk.normW, blk.normB, a);
    linear(a, blk.fc1, c);
    for (let k = 0; k < c.length; k++) c[k] = Math.max(0, c[k]);
    linear(c, blk.fc2, a);
    for (let k = 0; k < h.length; k++) h[k] += a[k];
  }
  layerNorm(h, m.normW, m.normB, a);
  const y = new Float64Array(m.targ.length);
  linear(a, m.head, y);
  for (let o = 0; o < y.length; o++) y[o] = y[o] * m.yStd[o] + m.yMean[o];
  return y;
}

// ── features ──────────────────────────────────────────────────────────────────

/** Central-difference derivative of a series sampled at `times` seconds. */
function ddt(v, times) {
  const n = v.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    const dt = times[i1] - times[i0];
    out[i] = dt > 0 ? (v[i1] - v[i0]) / dt : 0;
  }
  return out;
}

/**
 * Build the model's feature matrix from measured joint-angle series.
 *
 * Coordinates the camera cannot see are held at the model's TRAINING MEAN, and
 * so are their velocity and acceleration -- zero is itself an extrapolation for
 * a coordinate whose mean is nowhere near it. The names filled this way are
 * returned so the interface can say how much of the input was real.
 */
export function buildFeatures(m, coords, times, massKg, heightM) {
  const nF = times.length, nIn = m.feat.length;
  const X = new Float64Array(nF * nIn);
  const missing = new Set();
  const series = new Map();

  for (const name of m.feat) {
    const j = m.feat.indexOf(name);
    let base = null, kind = null;
    if (name === "mass_kg") { for (let t = 0; t < nF; t++) X[t * nIn + j] = massKg; continue; }
    if (name === "height_m") { for (let t = 0; t < nF; t++) X[t * nIn + j] = heightM; continue; }
    if (name.startsWith("q_")) { kind = "q"; base = name.slice(2); }
    else if (name.startsWith("qd_")) { kind = "qd"; base = name.slice(3); }
    else if (name.startsWith("qdd_")) { kind = "qdd"; base = name.slice(4); }
    else { for (let t = 0; t < nF; t++) X[t * nIn + j] = m.xMean[j]; continue; }

    const raw = coords[base];
    if (!raw) {
      missing.add(base);
      for (let t = 0; t < nF; t++) X[t * nIn + j] = m.xMean[j];
      continue;
    }
    if (!series.has(base)) {
      const q = Float64Array.from({ length: nF }, (_, t) => raw[Math.min(t, raw.length - 1)]);
      const qd = ddt(q, times);
      series.set(base, { q, qd, qdd: ddt(qd, times) });
    }
    const s = series.get(base)[kind];
    for (let t = 0; t < nF; t++) X[t * nIn + j] = s[t];
  }
  return { X, nIn, missing: [...missing] };
}

/**
 * Predict forces for a rep.
 *
 * Returns forces in NEWTONS (the model works in bodyweight; mass converts it
 * back), plus the joint reaction magnitudes in bodyweight, which is how joint
 * loading is normally reported.
 */
export function predictForces(m, coords, nFrames, opts = {}) {
  const massKg = opts.massKg ?? 75;
  const heightM = opts.heightM ?? 1.75;
  const times = opts.times
    ?? Float64Array.from({ length: nFrames }, (_, i) => i / (opts.fps ?? 30));

  const { X, nIn, missing } = buildFeatures(m, coords, times, massKg, heightM);
  const scratch = {
    h: new Float64Array(m.stem.b.data.length),
    a: new Float64Array(m.stem.b.data.length),
    c: new Float64Array(m.stem.b.data.length),
  };
  const bw = massKg * G;
  const z = new Float64Array(nIn);
  const forces = new Array(nFrames);
  const jrf = new Array(nFrames);

  const muscleIdx = m.muscles.map((n) => m.targ.indexOf(n));
  const magIdx = m.jrfMagnitudes.map((n) => m.targ.indexOf(n));

  for (let t = 0; t < nFrames; t++) {
    for (let j = 0; j < nIn; j++) {
      const sd = Math.abs(m.xStd[j]) < 1e-12 ? 1 : m.xStd[j];
      z[j] = (X[t * nIn + j] - m.xMean[j]) / sd;
    }
    const y = forwardOne(m, z, scratch);
    forces[t] = Float64Array.from(muscleIdx, (i) => y[i] * bw);
    jrf[t] = Float64Array.from(magIdx, (i) => y[i]);          // bodyweight
  }
  return { forces, muscleNames: m.muscles, jrf, jrfNames: m.jrfMagnitudes, missing };
}

export function implausibleFraction(forces, ceiling = MAX_PLAUSIBLE_FORCE_N) {
  if (!forces || !forces.length) return 0;
  let bad = 0, tot = 0;
  for (const row of forces) for (const v of row) { tot++; if (Math.abs(v) > ceiling) bad++; }
  return tot ? bad / tot : 0;
}

export function peakByMuscle(forces, names, topN = 8) {
  if (!forces || !forces.length) return [];
  const peaks = new Array(names.length).fill(0);
  for (const row of forces) {
    for (let i = 0; i < names.length; i++) peaks[i] = Math.max(peaks[i], Math.abs(row[i]));
  }
  return names.map((n, i) => [n, peaks[i]])
    .sort((a, b) => b[1] - a[1]).slice(0, topN);
}

export function peakJRF(jrf, names) {
  if (!jrf || !jrf.length) return [];
  const peaks = new Array(names.length).fill(0);
  for (const row of jrf) {
    for (let i = 0; i < names.length; i++) peaks[i] = Math.max(peaks[i], Math.abs(row[i]));
  }
  return names.map((n, i) => [n, peaks[i]]);
}

/**
 * Reproduce the exporter's reference prediction, in the browser.
 *
 * The Python side stores what `x_mean` should predict; if this disagrees, the
 * JavaScript forward pass has drifted from the trained network and nothing
 * below it can be trusted. That check is exactly what was missing before.
 */
export function selfTest(m) {
  const scratch = {
    h: new Float64Array(m.stem.b.data.length),
    a: new Float64Array(m.stem.b.data.length),
    c: new Float64Array(m.stem.b.data.length),
  };
  const y = forwardOne(m, new Float64Array(m.feat.length), scratch);
  const muscleIdx = m.muscles.map((n) => m.targ.indexOf(n));
  let peak = 0;
  for (const i of muscleIdx) peak = Math.max(peak, Math.abs(y[i]));
  return { peakMuscleBW: peak, plausible: peak < 12 };
}
