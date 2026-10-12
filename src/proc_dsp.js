/**
 * proc_dsp.js -- signal processing and analyses for the Process page.
 *
 * A port of the BD2II 2026W course helpers (analysis_toolkit/bd2ii_tools.py),
 * function for function and with the same defaults, so a value read off this
 * page is the value the student's Colab notebook or Excel template gives.
 * Where numpy/scipy/pandas have a convention (filtfilt's odd padding,
 * pandas' centred rolling window, np.gradient's uneven-spacing formula,
 * ddof=1 standard deviations) it is reproduced, not approximated.
 *
 * Pure functions on plain arrays; tests/test_process.mjs checks them.
 */
export const G = 9.81;

const F = (x) => Float64Array.from(x, Number);
const finite = (a) => Array.from(a).filter(Number.isFinite);

// ---------------------------------------------------------------- basics
export function mean(a) { const v = finite(a); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; }
export function sd(a, ddof = 1) {
  const v = finite(a); if (v.length <= ddof) return v.length ? 0 : NaN;
  const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - ddof));
}
export function meanSd(values) { const v = finite(values); return [mean(v), v.length > 1 ? sd(v) : 0]; }
export function max(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }
export function min(a) { let m = Infinity; for (const x of a) if (x < m) m = x; return m; }
export function argmax(a) { let m = -Infinity, k = -1; for (let i = 0; i < a.length; i++) if (a[i] > m) { m = a[i]; k = i; } return k; }
export function argmin(a) { let m = Infinity, k = -1; for (let i = 0; i < a.length; i++) if (a[i] < m) { m = a[i]; k = i; } return k; }
export const nanToNum = (a) => Float64Array.from(a, (x) => (Number.isFinite(x) ? x : 0));

/** Summary of one signal (optionally over a sample window). */
export function stats(y, time) {
  const v = finite(y);
  const i = argmax(y), j = argmin(y);
  return { mean: mean(v), sd: sd(v), min: min(v), max: max(v), range: max(v) - min(v),
    rms: Math.sqrt(v.reduce((s, x) => s + x * x, 0) / (v.length || 1)),
    t_max: time ? time[i] : i, t_min: time ? time[j] : j, n: v.length };
}

// ---------------------------------------------------------------- smoothing
/** pandas Series.rolling(n, center=True, min_periods=1).mean() */
export function movingAverage(x, n) {
  // trunc(n + 1e-6): a window of 0.1 s at an fs read as 1999.99999 Hz is 200 samples, as in pandas' 2000.0000001
  n = Math.max(1, Math.trunc(n + 1e-6));
  const len = x.length, out = new Float64Array(len);
  // pandas centres an even window one sample to the left: i - n/2 .. i + n/2 - 1
  const before = Math.floor(n / 2), after = n - 1 - before;
  // prefix sums over finite values
  const cs = new Float64Array(len + 1), cn = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) { const ok = Number.isFinite(x[i]); cs[i + 1] = cs[i] + (ok ? x[i] : 0); cn[i + 1] = cn[i] + (ok ? 1 : 0); }
  for (let i = 0; i < len; i++) {
    const a = Math.max(0, i - before), b = Math.min(len - 1, i + after);
    const c = cn[b + 1] - cn[a];
    out[i] = c ? (cs[b + 1] - cs[a]) / c : NaN;
  }
  return out;
}
/** pandas rolling(n, center=True, min_periods=1).max() */
export function movingMax(x, n) {
  const len = x.length, out = new Float64Array(len);
  const before = Math.floor(n / 2), after = n - 1 - before;
  for (let i = 0; i < len; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - before); k <= Math.min(len - 1, i + after); k++) if (x[k] > m) m = x[k];
    out[i] = m;
  }
  return out;
}

// ---------------------------------------------------------------- Butterworth (scipy.signal.butter, digital)
const C = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; },
  sqrt: (a) => { const r = Math.hypot(a[0], a[1]), t = Math.atan2(a[1], a[0]) / 2; return [Math.sqrt(r) * Math.cos(t), Math.sqrt(r) * Math.sin(t)]; },
  scale: (a, k) => [a[0] * k, a[1] * k],
};
function poly(roots) {
  let c = [[1, 0]];
  for (const r of roots) {
    const n = new Array(c.length + 1).fill(0).map(() => [0, 0]);
    for (let i = 0; i < c.length; i++) { n[i] = C.add(n[i], c[i]); n[i + 1] = C.sub(n[i + 1], C.mul(c[i], r)); }
    c = n;
  }
  return c.map((x) => x[0]);
}
/**
 * butter(order, Wn, btype) with Wn normalised to Nyquist (0..1), as scipy.
 * btype: "low" | "high" | "band". Returns { b, a }.
 */
export function butter(order, Wn, btype = "low") {
  const fs = 2, fs2 = 2 * fs;
  const warp = (w) => 2 * fs * Math.tan(Math.PI * w / fs);
  let p = [];
  for (let m = -order + 1; m < order; m += 2) { const th = Math.PI * m / (2 * order); p.push([-Math.cos(th), -Math.sin(th)]); }
  let z = [], k = 1;
  if (btype === "low") {
    const wo = warp(Wn); p = p.map((x) => C.scale(x, wo)); k = wo ** order;
  } else if (btype === "high") {
    const wo = warp(Wn); p = p.map((x) => C.div([wo, 0], x)); z = new Array(order).fill([0, 0]);
    // k * real(prod(-z)/prod(-p)) with z=0 prototype zeros none -> k = 1/real(prod(-p_proto)) = 1
    k = 1;
  } else {
    const w1 = warp(Wn[0]), w2 = warp(Wn[1]), bw = w2 - w1, wo = Math.sqrt(w1 * w2);
    const plp = p.map((x) => C.scale(x, bw / 2));
    p = [];
    for (const x of plp) { const s = C.sqrt(C.sub(C.mul(x, x), [wo * wo, 0])); p.push(C.add(x, s)); }
    for (const x of plp) { const s = C.sqrt(C.sub(C.mul(x, x), [wo * wo, 0])); p.push(C.sub(x, s)); }
    z = new Array(order).fill([0, 0]); k = bw ** order;
  }
  // bilinear
  let num = [1, 0], den = [1, 0];
  for (const x of z) num = C.mul(num, C.sub([fs2, 0], x));
  for (const x of p) den = C.mul(den, C.sub([fs2, 0], x));
  const kz = k * C.div(num, den)[0];
  const zz = z.map((x) => C.div(C.add([fs2, 0], x), C.sub([fs2, 0], x)));
  const pz = p.map((x) => C.div(C.add([fs2, 0], x), C.sub([fs2, 0], x)));
  while (zz.length < pz.length) zz.push([-1, 0]);
  return { b: poly(zz).map((v) => v * kz), a: poly(pz) };
}

function lfilter(b, a, x, zi) {
  const n = Math.max(a.length, b.length);
  const bb = b.concat(new Array(n - b.length).fill(0)).map((v) => v / a[0]);
  const aa = a.concat(new Array(n - a.length).fill(0)).map((v) => v / a[0]);
  const z = zi ? zi.slice() : new Array(n - 1).fill(0);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = bb[0] * xi + (z[0] || 0);
    for (let k = 1; k < n - 1; k++) z[k - 1] = bb[k] * xi + z[k] - aa[k] * yi;
    if (n > 1) z[n - 2] = bb[n - 1] * xi - aa[n - 1] * yi;
    y[i] = yi;
  }
  return y;
}
function solve(A, bv) {
  const n = bv.length, M = A.map((r, i) => r.concat([bv[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
/** scipy.signal.lfilter_zi */
export function lfilterZi(b, a) {
  const n = Math.max(a.length, b.length);
  const bb = b.concat(new Array(n - b.length).fill(0)).map((v) => v / a[0]);
  const aa = a.concat(new Array(n - a.length).fill(0)).map((v) => v / a[0]);
  const m = n - 1;
  // IminusA = I - companion(a).T
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => {
    // companion(a): first row -a[1:]/a[0], subdiagonal ones; transposed: first column -a[1:], superdiagonal ones
    const compT = (j === 0 ? -aa[i + 1] : 0) + (i + 1 === j ? 1 : 0);
    return (i === j ? 1 : 0) - compT;
  }));
  const B = Array.from({ length: m }, (_, i) => bb[i + 1] - aa[i + 1] * bb[0]);
  return solve(A, B);
}
/** scipy.signal.filtfilt(b, a, x) with the default odd padding of 3*max(len(a), len(b)). */
export function filtfilt(b, a, x) {
  x = F(x);
  const padlen = 3 * Math.max(a.length, b.length);
  if (x.length <= padlen) throw new Error(`signal too short to filter (needs more than ${padlen} samples)`);
  const n = x.length, ext = new Float64Array(n + 2 * padlen);
  for (let i = 0; i < padlen; i++) ext[i] = 2 * x[0] - x[padlen - i];
  ext.set(x, padlen);
  for (let i = 0; i < padlen; i++) ext[padlen + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  const zi = lfilterZi(b, a);
  let y = lfilter(b, a, ext, zi.map((v) => v * ext[0]));
  y = y.reverse();
  y = lfilter(b, a, y, zi.map((v) => v * y[0]));
  y = y.reverse();
  return y.slice(padlen, padlen + n);
}
export function lowpass(x, fs, fc, order = 4) { const { b, a } = butter(order, fc / (fs / 2), "low"); return filtfilt(b, a, x); }
export function highpass(x, fs, fc, order = 4) { const { b, a } = butter(order, fc / (fs / 2), "high"); return filtfilt(b, a, x); }
export function bandpass(x, fs, lo = 20, hi = 450, order = 4) {
  hi = Math.min(hi, 0.45 * fs);
  const { b, a } = butter(order, [lo / (fs / 2), hi / (fs / 2)], "band"); return filtfilt(b, a, x);
}

// ---------------------------------------------------------------- EMG
/** Raw EMG -> offset removal (or band-pass) -> rectify -> moving average. bd2ii emg_envelope. */
export function emgEnvelope(raw, fs, windowMs = 100, band = null) {
  raw = nanToNum(raw);
  const m = mean(raw);
  const filtered = band ? bandpass(raw, fs, band[0], band[1]) : raw.map((v) => v - m);
  const rectified = filtered.map(Math.abs);
  const envelope = movingAverage(rectified, (windowMs / 1000) * fs);
  return { raw, filtered, rectified, envelope };
}

// ---------------------------------------------------------------- time
export function interp(xq, x, y) {
  const out = new Float64Array(xq.length); let j = 0;
  for (let i = 0; i < xq.length; i++) {
    const v = xq[i];
    if (v <= x[0]) { out[i] = y[0]; continue; }
    if (v >= x[x.length - 1]) { out[i] = y[y.length - 1]; continue; }
    while (j < x.length - 2 && x[j + 1] < v) j++;
    while (j > 0 && x[j] > v) j--;
    const t = (v - x[j]) / (x[j + 1] - x[j]); out[i] = y[j] + t * (y[j + 1] - y[j]);
  }
  return out;
}
/** Resample a curve to n points (0-100 %). */
export function timeNormalise(y, n = 101) {
  const L = y.length; if (L < 2) return new Float64Array(n).fill(y[0] ?? NaN);
  const xq = Float64Array.from({ length: n }, (_, i) => i / (n - 1));
  const x = Float64Array.from({ length: L }, (_, i) => i / (L - 1));
  return interp(xq, x, y);
}
/** numpy.gradient(f, x) -- second-order interior, first-order edges, uneven spacing allowed. */
export function numGradient(f, x) {
  const n = f.length, g = new Float64Array(n);
  if (n < 2) return g;
  const X = typeof x === "number" ? Float64Array.from({ length: n }, (_, i) => i * x) : x;
  g[0] = (f[1] - f[0]) / (X[1] - X[0]);
  g[n - 1] = (f[n - 1] - f[n - 2]) / (X[n - 1] - X[n - 2]);
  for (let i = 1; i < n - 1; i++) {
    const h1 = X[i] - X[i - 1], h2 = X[i + 1] - X[i];
    g[i] = (h1 * h1 * f[i + 1] - h2 * h2 * f[i - 1] + (h2 * h2 - h1 * h1) * f[i]) / (h1 * h2 * (h1 + h2));
  }
  return g;
}
/** Cumulative trapezoid integral, starting at 0. */
export function cumtrapz(y, t) {
  const o = new Float64Array(y.length);
  for (let i = 1; i < y.length; i++) o[i] = o[i - 1] + 0.5 * (y[i] + y[i - 1]) * (t[i] - t[i - 1]);
  return o;
}

// ---------------------------------------------------------------- force plates
/** Contacts: [start, end) sample pairs where fz > threshold for at least min_samples. */
export function contacts(fz, threshold = 20, minSamples = 20) {
  const on = Array.from(fz, (v) => v > threshold);
  const starts = [], ends = [];
  if (on[0]) starts.push(0);
  for (let i = 1; i < on.length; i++) { if (on[i] && !on[i - 1]) starts.push(i); if (!on[i] && on[i - 1]) ends.push(i); }
  if (on[on.length - 1]) ends.push(on.length);
  const out = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) if (ends[i] - starts[i] >= minSamples) out.push([starts[i], ends[i]]);
  return out;
}
/** First (loading) and second (push-off) peak of a stance vertical GRF. */
export function twoPeaks(stance) {
  const m = stance.length >> 1;
  return [max(stance.slice(0, m)), max(stance.slice(m))];
}
/** Indices above threshold that are the largest within +/- halfWindow (the Excel template's rule). */
export function simplePeaks(y, threshold, halfWindow) {
  const lm = movingMax(y, 2 * halfWindow + 1), out = [];
  for (let i = 0; i < y.length; i++) if (y[i] > threshold && y[i] === lm[i]) out.push(i);
  return out;
}
/** Jump height from flight time (h = g t^2 / 8); flight = longest run below threshold. */
export function jumpHeightFlight(fz, fs, threshold = 20) {
  let best = [0, 0], run = 0, start = 0;
  for (let i = 0; i < fz.length; i++) {
    if (fz[i] < threshold) { if (run === 0) start = i; run++; if (run > best[1] - best[0]) best = [start, i + 1]; }
    else run = 0;
  }
  const t = (best[1] - best[0]) / fs;
  return { height: (G * t * t) / 8, flight: t, window: best };
}
/** Jump height from the net impulse up to take-off. */
export function jumpHeightImpulse(fz, fs, quietS = 1.0, threshold = 20) {
  const bw = mean(Array.from(fz).slice(0, Math.trunc(quietS * fs))), m = bw / G;
  const to = jumpHeightFlight(fz, fs, threshold).window[0];
  let v = 0;
  for (let i = 0; i < to; i++) v += ((fz[i] - bw) / m) / fs;
  return { height: (v * v) / (2 * G), vTakeoff: v, bodyWeight: bw };
}

/** Which columns look like a vertical ground force, best first. */
export function verticalForceCandidates(ds) {
  const keys = Object.keys(ds.cols);
  const pref = [
    (k) => / - Fz$/.test(k) && /Force/.test(k),            // Vicon CSV
    (k) => /^FP\d+ Fz$/.test(k),                              // C3D plates
    (k) => /^(Fz|Fz_N|Fz \(N\)|vGRF|GRF)$/i.test(k),          // plain exports
    (k) => /ground_force(_\d+)?_vy$|_force_vy$/.test(k),      // OpenSim (y up)
    (k) => /fz/i.test(k),
  ];
  for (const p of pref) { const hit = keys.filter(p); if (hit.length) return hit; }
  return [];
}
/** Positive vertical force from the plate with the largest load (bd2ii vertical_force). */
export function verticalForce(ds, plate = null) {
  let c = verticalForceCandidates(ds);
  if (plate) c = c.filter((k) => k.startsWith(plate) || k === plate);
  if (!c.length) throw new Error("no vertical force column found");
  const col = c.reduce((b, k) => (max(ds.cols[k].map(Math.abs)) > max(ds.cols[b].map(Math.abs)) ? k : b), c[0]);
  let y = F(ds.cols[col]);
  if (mean(y) < 0) y = y.map((v) => -v);
  return { y: nanToNum(y), col };
}

// ---------------------------------------------------------------- centre of pressure
export function copFromForces(fz, mx, my) {
  const x = new Float64Array(fz.length), y = new Float64Array(fz.length);
  for (let i = 0; i < fz.length; i++) { const f = Math.abs(fz[i]) < 1e-6 ? NaN : fz[i]; x[i] = -my[i] / f; y[i] = mx[i] / f; }
  return { x, y };
}
/** Path length, ranges, mean velocity and 95 % ellipse area of a CoP trace (mm). */
export function copMetrics(x, y, fs) {
  const X = [], Y = [];
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i])) { X.push(x[i]); Y.push(y[i]); }
  let path = 0; for (let i = 1; i < X.length; i++) path += Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
  const mx = mean(X), my = mean(Y), n = X.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (X[i] - mx) ** 2; syy += (Y[i] - my) ** 2; sxy += (X[i] - mx) * (Y[i] - my); }
  sxx /= n - 1; syy /= n - 1; sxy /= n - 1;
  return { path_length_mm: path, range_ML_mm: max(X) - min(X), range_AP_mm: max(Y) - min(Y),
    mean_velocity_mm_s: path / (n / fs), ellipse95_area_mm2: Math.PI * 5.991 * Math.sqrt(sxx * syy - sxy * sxy) };
}
/** CoP column pairs a dataset already has: [{ plate, x, y }]. */
export function copPairs(ds) {
  const keys = Object.keys(ds.cols), out = [];
  for (const k of keys) {
    let m;
    if ((m = k.match(/^(.*) - CoP - Cx$/)) && ds.cols[`${m[1]} - CoP - Cy`]) out.push({ plate: m[1], x: k, y: `${m[1]} - CoP - Cy` });
    else if ((m = k.match(/^(FP\d+) CoPx$/))) out.push({ plate: m[1], x: k, y: `${m[1]} CoPy` });
    else if ((m = k.match(/^CoPx(_mm)?$/i)) && ds.cols[k.replace(/x/i, "y")]) out.push({ plate: "CoP", x: k, y: k.replace(/x/i, "y") });
  }
  return out;
}

// ---------------------------------------------------------------- joints
export function angularVelocity(angleDeg, time) { return numGradient(Float64Array.from(angleDeg, (v) => (v * Math.PI) / 180), time); }
export function jointPower(moment, angleDeg, time) { const w = angularVelocity(angleDeg, time); return Float64Array.from(moment, (m, i) => m * w[i]); }
export function workPhases(power, time) {
  const dt = numGradient(Float64Array.from(time), 1);
  let pos = 0, neg = 0;
  for (let i = 0; i < power.length; i++) { const p = power[i] * dt[i]; if (power[i] > 0) pos += p; else neg += p; }
  return { positive: pos, negative: neg };
}
/** Matching moment column for an angle column in OpenSim ID output (knee_angle_r -> knee_angle_r_moment). */
export function momentFor(angleCol, momentCols) {
  return momentCols.find((c) => c === `${angleCol}_moment` || c === `${angleCol}_force`) || null;
}

// ---------------------------------------------------------------- statistics
function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function lgamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lgamma(1 - z);
  z -= 1; let x = 0.99999999999980993; for (let i = 0; i < 8; i++) x += g[i] / (z + i + 1);
  const t = z + 7.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
export function betainc(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Two-sided p of Student's t with df degrees of freedom. */
export function tTwoSided(t, df) { return betainc(df / 2, 0.5, df / (df + t * t)); }
/** Mean difference, SD of differences, Cohen's dz and paired t-test (bd2ii paired_summary). */
export function pairedSummary(a, b) {
  const n = Math.min(a.length, b.length), d = [];
  for (let i = 0; i < n; i++) d.push(b[i] - a[i]);
  const out = { n, mean_A: mean(a.slice(0, n)), mean_B: mean(b.slice(0, n)), mean_diff: mean(d), sd_diff: n > 1 ? sd(d) : NaN };
  out.cohens_dz = n > 1 && out.sd_diff > 0 ? out.mean_diff / out.sd_diff : NaN;
  if (n > 2 && out.sd_diff > 0) { const t = out.mean_diff / (out.sd_diff / Math.sqrt(n)); out.t = t; out.p_paired_t = tTwoSided(t, n - 1); }
  else out.p_paired_t = NaN;
  return out;
}
/** Mean +/- SD across equally long curves. */
export function meanSdCurves(curves) {
  const n = curves[0].length, m = new Float64Array(n), s = new Float64Array(n);
  for (let i = 0; i < n; i++) { const v = curves.map((c) => c[i]); m[i] = mean(v); s[i] = curves.length > 1 ? sd(v) : 0; }
  return { mean: m, sd: s };
}
/** Spread of repeated measures (raters, trials): mean, SD, min, max, range, CV %. */
export function reliability(values) {
  const v = finite(values), m = mean(v), s = sd(v);
  return { mean: m, sd: s, min: min(v), max: max(v), range: max(v) - min(v), cv_pct: (100 * s) / m };
}

/** Participant and condition from a file name (Project_analysis.ipynb's parse()). */
export function parseName(name) {
  const base = String(name).replace(/^.*[\\/]/, "").replace(/ · .*$/, "").replace(/\.[^.]+$/, "");
  const parts = base.split("_");
  const pid = parts.find((p) => /^P\d+$/.test(p)) || parts[0];
  const cond = parts.find((p) => p !== pid && !/^\d+$/.test(p) && !["squat", "jump", "trial1"].includes(p)) || "cond";
  return { participant: pid, condition: cond };
}
