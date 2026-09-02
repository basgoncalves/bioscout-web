/**
 * forces.js -- the numpy MLP muscle-force surrogate, in the browser.
 *
 * READ THIS BEFORE USING THE OUTPUT.
 *
 * The bundled model FAILS ITS OWN AUDIT. On a real gait trial drawn from its
 * own training set, with all 34 inputs present, it predicts 113,250 N. The
 * largest human muscle produces a few thousand. Moving one input a single
 * standard deviation off the training mean takes it from 1,110 N to 32,583 N.
 * The likely cause is a forward pass missing its BatchNorm statistics --
 * correct at the training mean, where the weight path drops out, and divergent
 * everywhere else. See android_app/models/MODEL_CARD.md.
 *
 * It is wired in at the user's explicit request, pending a fixed export. Every
 * number it produces is displayed behind a warning, and any value beyond
 * physiological range is flagged rather than quietly rendered.
 */
export const MAX_PLAUSIBLE_FORCE_N = 5000;

let cached = null;

export async function loadForceModel(url = "force_model.json") {
  if (cached) return cached;
  const j = await (await fetch(url)).json();
  const un = (m) => ({ shape: m.shape, data: Float64Array.from(m.data) });
  cached = {
    feat: j.feat, targ: j.targ, info: j.info, provenance: j.provenance,
    activation: j.activation, outputTransform: j.output_transform,
    W1: un(j.W1), b1: un(j.b1), W2: un(j.W2), b2: un(j.b2),
    xm: Float64Array.from(j.xm.data), xs: Float64Array.from(j.xs.data),
    ym: Float64Array.from(j.ym.data), ys: Float64Array.from(j.ys.data),
  };
  return cached;
}

/** Predict (nFrames x nTargets) forces in newtons from a coords dict. */
export function predictForces(model, coords, nFrames) {
  const nIn = model.feat.length, nHid = model.W1.shape[1], nOut = model.targ.length;
  const missing = [];
  // Unmeasurable coordinates take the model's TRAINING MEAN, not zero: zero is
  // itself an extrapolation for a coordinate whose mean is far from it.
  const out = new Array(nFrames);
  const h = new Float64Array(nHid);

  for (let t = 0; t < nFrames; t++) {
    const z = new Float64Array(nIn);
    for (let j = 0; j < nIn; j++) {
      const name = model.feat[j];
      const arr = coords[name];
      if (arr === undefined) { if (t === 0) missing.push(name); z[j] = 0; continue; }
      const sd = Math.abs(model.xs[j]) < 1e-12 ? 1 : model.xs[j];
      z[j] = (arr[Math.min(t, arr.length - 1)] - model.xm[j]) / sd;
    }
    h.fill(0);
    for (let k = 0; k < nHid; k++) {
      let s = model.b1.data[k];
      for (let j = 0; j < nIn; j++) s += z[j] * model.W1.data[j * nHid + k];
      h[k] = model.activation === "relu" ? Math.max(0, s) : Math.tanh(s);
    }
    const row = new Float64Array(nOut);
    for (let o = 0; o < nOut; o++) {
      let s = model.b2.data[o];
      for (let k = 0; k < nHid; k++) s += h[k] * model.W2.data[k * nOut + o];
      let y = s * model.ys[o] + model.ym[o];
      if (model.outputTransform === "expm1") y = Math.expm1(Math.max(-20, Math.min(20, y)));
      row[o] = y;
    }
    out[t] = row;
  }
  return { forces: out, missing };
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
