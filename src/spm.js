/**
 * spm.js -- Statistical Parametric Mapping for 1D curves (spm1d in the browser).
 *
 * The statistic is computed node by node, as in spm1d (Pataky 2012), and the
 * critical threshold comes from random field theory on the residuals'
 * smoothness (rft1d: Worsley 1996 EC densities, Poisson clumping heuristic,
 * Bonferroni when that is less severe), so a t / F curve and its clusters'
 * p-values here are the ones spm1d prints. tests/test_spm.mjs pins that against
 * spm1d 0.4.
 *
 * Nonparametric inference (permutation, max-statistic, cluster integral as in
 * spm1d.stats.nonparam) is offered for the designs that permute cleanly.
 *
 * Y is always J x Q: one row per curve, Q nodes (time-normalised).
 */
import { lstsq, lgamma, tCdf, tSf, fSf, chi2Sf, normInv, mean, sd, isNum, shapiroWilk, dagostinoK2, levene, rmAnova, glm, levelsOf } from "./stats.js";

const LOG4 = 4 * Math.LN2, EPS = 2.220446049250313e-16;

/* ------------------------------------------------------------------ *
 * Smoothness and RFT probabilities
 * ------------------------------------------------------------------ */

/** spm1d.geom.estimate_fwhm: R is the J x Q residual matrix. */
export function estimateFwhm(R) {
  const J = R.length, Q = R[0].length;
  const ssq = new Float64Array(Q), v = new Float64Array(Q);
  for (const r of R) {
    for (let q = 0; q < Q; q++) {
      ssq[q] += r[q] * r[q];
      const dx = q === 0 ? r[1] - r[0] : q === Q - 1 ? r[Q - 1] - r[Q - 2] : (r[q + 1] - r[q - 1]) / 2;
      v[q] += dx * dx;
    }
  }
  let s = 0, c = 0;
  for (let q = 0; q < Q; q++) { const w = v[q] / (ssq[q] + EPS); if (Number.isFinite(w)) { s += Math.sqrt(w / LOG4); c++; } }
  return 1 / (s / c);
}

function ecDensity(STAT, z, df) {
  if (STAT === "T") {
    const v = df[1];
    return [1 - tCdf(z, v), (Math.sqrt(LOG4) / (2 * Math.PI)) * Math.pow(1 + (z * z) / v, (1 - v) / 2)];
  }
  if (STAT === "F") {
    if (z < 0) return [1, Infinity];
    const k = Math.max(df[0], 1), v = df[1];
    const a = LOG4 / (2 * Math.PI), b = lgamma(v / 2) + lgamma(k / 2);
    return [fSf(z, k, v), Math.sqrt(a) * Math.exp(lgamma((v + k - 1) / 2) - b) * Math.SQRT2 * Math.pow((k * z) / v, 0.5 * (k - 1)) * Math.pow(1 + (k * z) / v, -0.5 * (v + k - 2))];
  }
  if (STAT === "X2") {
    const v = df[1], a = LOG4 / (2 * Math.PI);
    return [chi2Sf(z, v), Math.sqrt(a) * (Math.pow(z, (v - 1) / 2) * Math.exp(-z / 2 - lgamma(v / 2))) / Math.pow(2, (v - 2) / 2)];
  }
  throw new Error("unknown statistic " + STAT);
}

const sf0 = (STAT, z, df) => (STAT === "T" ? tSf(z, df[1]) : STAT === "F" ? fSf(z, df[0], df[1]) : chi2Sf(z, df[1]));

/** rft1d.prob.rft for c = 1, n = 1 in 1D: { P, Ec, Ek }. k is the cluster extent in resels. */
function rft(k, STAT, z, df, R, Q) {
  const EC = ecDensity(STAT, z, df).map((e) => Math.max(e, EPS));
  const R1 = R[1] === 0 ? EPS : R[1];
  const EM = [R[0] * EC[0], R1 * EC[1]], EN = EC[0] * R1;
  const Ec = EM[0] + EM[1], Ek = EN / EM[1];
  let p = 1;
  if (k > 0) { const beta = (Math.exp(lgamma(1.5)) / Ek) ** 2; p = Math.exp(-beta * k * k); }
  let P = p === 0 ? 0 : 1 - Math.exp(-(Ec + EPS) * p);
  if (k === 0) {
    P = Math.min(P, Math.min(1, Q * sf0(STAT, z, df)));     // Bonferroni if less severe
    P = Math.max(P, sf0(STAT, z, df));                        // never below the 0D p
  }
  return { P, Ec, Ek };
}

/** Critical threshold: P(max > u*) = alpha. */
export function rftThreshold(STAT, alpha, df, R, Q) {
  let lo = 0, hi = STAT === "T" ? 50 : 500;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (rft(0, STAT, m, df, R, Q).P > alpha) lo = m; else hi = m;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** Supra-threshold clusters with interpolated end points (spm1d _cluster_geom). */
export function clustersOf(z, u, sign = 1) {
  const Q = z.length, out = [];
  let q = 0;
  while (q < Q) {
    if (sign * z[q] >= u) {
      let e = q; while (e + 1 < Q && sign * z[e + 1] >= u) e++;
      let x0 = q, x1 = e;
      if (q > 0) { const z0 = sign * z[q - 1], z1 = sign * z[q]; x0 = q - (z1 - u) / (z1 - z0); }
      if (e < Q - 1) { const z0 = sign * z[e], z1 = sign * z[e + 1]; x1 = e + (z0 - u) / (z0 - z1); }
      let peak = 0, at = q, integ = 0;
      for (let i = q; i <= e; i++) { const v = sign * z[i]; if (v > peak) { peak = v; at = i; } integ += v - u; }
      out.push({ i0: q, i1: e, x0, x1, extent: Math.max(x1 - x0, 1), peak: sign * peak, peakAt: at, sign, integral: integ });
      q = e + 1;
    } else q++;
  }
  return out;
}

/** Parametric inference on a statistic field. */
export function inference(spm, alpha = 0.05, twoTailed = true) {
  const { STAT, z, df, fwhm } = spm, Q = z.length;
  const resels = [1, (Q - 1) / fwhm];
  const tt = STAT === "T" && twoTailed;
  const a = tt ? alpha / 2 : alpha;
  const zstar = rftThreshold(STAT, a, df, resels, Q);
  let clusters = clustersOf(z, zstar, 1);
  if (tt) clusters = clusters.concat(clustersOf(z, zstar, -1)).sort((p, q) => p.x0 - q.x0);
  for (const c of clusters) {
    const k = c.extent / fwhm;
    const P = rft(k, STAT, zstar, df, resels, Q).P;
    c.extentR = k; c.p = tt ? Math.min(1, 2 * P) : P;
  }
  const zmax = Math.max(...Array.from(z, (v) => (tt ? Math.abs(v) : v)));
  return { ...spm, alpha, twoTailed: tt, zstar, resels, clusters, h0reject: zmax > zstar, method: "rft" };
}

/* ------------------------------------------------------------------ *
 * Statistic fields (fast paths, used by both parametric and permutation)
 * ------------------------------------------------------------------ */

const zeros = (Q) => new Float64Array(Q);
function colMean(Y, idx = null) {
  const Q = Y[0].length, m = zeros(Q), rows = idx || Y.map((_, i) => i);
  for (const i of rows) for (let q = 0; q < Q; q++) m[q] += Y[i][q] / rows.length;
  return m;
}

/** one-sample t vs mu */
export function tOne(Y, mu = 0) {
  const J = Y.length, Q = Y[0].length, m = colMean(Y), s = zeros(Q), z = zeros(Q);
  for (const r of Y) for (let q = 0; q < Q; q++) s[q] += (r[q] - m[q]) ** 2;
  for (let q = 0; q < Q; q++) z[q] = (m[q] - mu) / Math.sqrt(s[q] / (J - 1) / J);
  return { STAT: "T", z, df: [1, J - 1], resid: () => Y.map((r) => r.map((v, q) => v - m[q])) };
}

/** two-sample t, equal variance (spm1d ttest2 equal_var=True). labels: 0 / 1. */
export function tTwo(Y, labels) {
  const Q = Y[0].length, a = [], b = [];
  labels.forEach((l, i) => (l === 0 ? a : b).push(i));
  const ma = colMean(Y, a), mb = colMean(Y, b), s = zeros(Q), z = zeros(Q);
  for (const i of a) for (let q = 0; q < Q; q++) s[q] += (Y[i][q] - ma[q]) ** 2;
  for (const i of b) for (let q = 0; q < Q; q++) s[q] += (Y[i][q] - mb[q]) ** 2;
  const df = a.length + b.length - 2;
  for (let q = 0; q < Q; q++) z[q] = (ma[q] - mb[q]) / Math.sqrt((s[q] / df) * (1 / a.length + 1 / b.length));
  return { STAT: "T", z, df: [1, df], resid: () => Y.map((r, i) => r.map((v, q) => v - (labels[i] === 0 ? ma[q] : mb[q]))) };
}

/** simple regression of Y on x: t of the slope */
export function tRegress(Y, x) {
  const J = Y.length, Q = Y[0].length, mx = mean(x), my = colMean(Y);
  let sxx = 0; for (const v of x) sxx += (v - mx) ** 2;
  const b = zeros(Q), z = zeros(Q), r = zeros(Q);
  for (let i = 0; i < J; i++) for (let q = 0; q < Q; q++) b[q] += ((x[i] - mx) * (Y[i][q] - my[q])) / sxx;
  const sse = zeros(Q), syy = zeros(Q);
  for (let i = 0; i < J; i++) for (let q = 0; q < Q; q++) { const e = Y[i][q] - my[q] - b[q] * (x[i] - mx); sse[q] += e * e; syy[q] += (Y[i][q] - my[q]) ** 2; }
  for (let q = 0; q < Q; q++) { z[q] = b[q] / Math.sqrt(sse[q] / (J - 2) / sxx); r[q] = Math.sign(b[q]) * Math.sqrt(Math.max(0, 1 - sse[q] / syy[q])); }
  return { STAT: "T", z, df: [1, J - 2], beta: b, r, resid: () => Y.map((row, i) => row.map((v, q) => v - my[q] - b[q] * (x[i] - mx))) };
}

/** one-way between ANOVA. labels: integer group index. */
export function fOne(Y, labels) {
  const Q = Y[0].length, J = Y.length, k = Math.max(...labels) + 1;
  const idx = [...Array(k)].map(() => []); labels.forEach((l, i) => idx[l].push(i));
  const gm = colMean(Y), ms = idx.map((ix) => colMean(Y, ix)), ssb = zeros(Q), ssw = zeros(Q), z = zeros(Q);
  idx.forEach((ix, g) => { for (let q = 0; q < Q; q++) ssb[q] += ix.length * (ms[g][q] - gm[q]) ** 2; for (const i of ix) for (let q = 0; q < Q; q++) ssw[q] += (Y[i][q] - ms[g][q]) ** 2; });
  for (let q = 0; q < Q; q++) z[q] = ssb[q] / (k - 1) / (ssw[q] / (J - k));
  return { STAT: "F", z, df: [k - 1, J - k], resid: () => Y.map((r, i) => r.map((v, q) => v - ms[labels[i]][q])) };
}

/** one-way repeated measures ANOVA. cube[s][c] = curve. */
export function fRm(cube) {
  const n = cube.length, k = cube[0].length, Q = cube[0][0].length;
  const sm = cube.map((s) => { const o = zeros(Q); for (const c of s) for (let q = 0; q < Q; q++) o[q] += c[q] / k; return o; });
  const cm = [...Array(k)].map((_, j) => { const o = zeros(Q); for (const s of cube) for (let q = 0; q < Q; q++) o[q] += s[j][q] / n; return o; });
  const gm = zeros(Q); for (const m of cm) for (let q = 0; q < Q; q++) gm[q] += m[q] / k;
  const ssa = zeros(Q), sse = zeros(Q), z = zeros(Q);
  for (let j = 0; j < k; j++) for (let q = 0; q < Q; q++) ssa[q] += n * (cm[j][q] - gm[q]) ** 2;
  const R = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) {
    const r = zeros(Q);
    for (let q = 0; q < Q; q++) { r[q] = cube[i][j][q] - sm[i][q] - cm[j][q] + gm[q]; sse[q] += r[q] * r[q]; }
    R.push(r);
  }
  const df1 = k - 1, df2 = (n - 1) * (k - 1);
  for (let q = 0; q < Q; q++) z[q] = ssa[q] / df1 / (sse[q] / df2);
  return { STAT: "F", z, df: [df1, df2], resid: () => R };
}

/* ------------------------------------------------------------------ *
 * Permutation (spm1d.stats.nonparam): max statistic and cluster integral
 * ------------------------------------------------------------------ */

function rngOf(seed = 0) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function shuffle(a, rnd) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

/**
 * permute: () => field (Float64Array) under a random relabelling.
 * The observed statistic's threshold is the (1 - alpha) quantile of the max
 * statistic; cluster p = share of permutations whose largest cluster integral
 * (above that threshold) reaches the observed cluster's.
 */
export function permutationInference(spm, permute, { alpha = 0.05, twoTailed = true, iterations = 1000, seed = 1 } = {}) {
  const rnd = rngOf(seed), tt = spm.STAT === "T" && twoTailed;
  const fieldMax = (z) => { let m = -Infinity; for (const v of z) m = Math.max(m, tt ? Math.abs(v) : v); return m; };
  const maxes = [fieldMax(spm.z)], fields = [spm.z];
  for (let it = 1; it < iterations; it++) { const z = permute(rnd); fields.push(z); maxes.push(fieldMax(z)); }
  const sorted = [...maxes].sort((a, b) => a - b);
  const zstar = sorted[Math.min(sorted.length - 1, Math.ceil((1 - alpha) * sorted.length) - 1)];
  const clusterMax = fields.map((z) => {
    let cs = clustersOf(z, zstar, 1); if (tt) cs = cs.concat(clustersOf(z, zstar, -1));
    return cs.length ? Math.max(...cs.map((c) => c.integral)) : 0;
  });
  let clusters = clustersOf(spm.z, zstar, 1);
  if (tt) clusters = clusters.concat(clustersOf(spm.z, zstar, -1)).sort((p, q) => p.x0 - q.x0);
  for (const c of clusters) c.p = clusterMax.filter((m) => m >= c.integral - 1e-12).length / clusterMax.length;
  return { ...spm, alpha, twoTailed: tt, zstar, clusters, h0reject: fieldMax(spm.z) > zstar, method: "permutation", iterations };
}

/* ------------------------------------------------------------------ *
 * Assumption checks on residuals
 * ------------------------------------------------------------------ */

/** Normality of residuals: spm1d's D'Agostino-Pearson K^2 field (RFT on X2(2)) plus node-wise Shapiro-Wilk. */
export function normalityField(R, alpha = 0.05, fwhm = null) {
  const J = R.length, Q = R[0].length, k2 = zeros(Q), swP = zeros(Q);
  for (let q = 0; q < Q; q++) {
    const col = R.map((r) => r[q]);
    k2[q] = J >= 8 ? dagostinoK2(col).K2 : NaN;
    swP[q] = shapiroWilk(col).p;
  }
  const out = { J, swP, swShare: Array.from(swP).filter((p) => p < alpha).length / Q, k2: null };
  if (J >= 8) {
    const fw = fwhm || estimateFwhm(R);
    const res = inference({ STAT: "X2", z: k2, df: [1, 2], fwhm: fw }, alpha, false);
    out.k2 = res;
  }
  out.ok = out.k2 ? !out.k2.h0reject : out.swShare <= alpha;
  return out;
}

/** Equal variance between cells: Levene (mean-centred) at every node. */
export function varianceField(Y, labels, alpha = 0.05) {
  const Q = Y[0].length, k = Math.max(...labels) + 1, p = zeros(Q), F = zeros(Q);
  for (let q = 0; q < Q; q++) {
    const groups = [...Array(k)].map(() => []);
    Y.forEach((r, i) => groups[labels[i]].push(r[q]));
    const l = levene(groups);
    p[q] = l.p; F[q] = l.F;
  }
  // Bonferroni over nodes is far too strict for smooth curves, so the share of
  // nodes below alpha is reported alongside the smallest p.
  const share = Array.from(p).filter((v) => v < alpha).length / Q;
  return { F, p, share, minP: Math.min(...p), ok: share <= alpha };
}

/** Sphericity for a within factor with > 2 levels: GG epsilon and Mauchly p at each node. */
export function sphericityField(cube, groups = null, alpha = 0.05) {
  const Q = cube[0][0].length, eps = zeros(Q), p = zeros(Q);
  for (let q = 0; q < Q; q++) {
    const r = rmAnova(cube.map((s) => s.map((c) => c[q])), groups);
    eps[q] = r.epsilonGG; p[q] = r.mauchly ? r.mauchly.p : NaN;
  }
  const share = Array.from(p).filter((v) => v < alpha).length / Q;
  return { epsilon: eps, p, share, minEps: Math.min(...eps), ok: share <= alpha };
}

/* ------------------------------------------------------------------ *
 * Designs
 *
 * rows: [{ y: Float64Array(Q), subject, A, B, cov }]   (one per curve)
 * Several curves of one subject in one cell are averaged first.
 * ------------------------------------------------------------------ */

export const TESTS = {
  ttest: { factors: [], needs: [], label: "One-sample t-test" },
  ttest_paired: { factors: ["B"], needs: ["subject"], label: "Paired t-test" },
  ttest2: { factors: ["A"], needs: [], label: "Two-sample t-test" },
  regress: { factors: [], needs: ["cov"], label: "Linear regression" },
  anova1: { factors: ["A"], needs: [], label: "One-way ANOVA" },
  anova1rm: { factors: ["B"], needs: ["subject"], label: "One-way repeated measures ANOVA" },
  anova2: { factors: ["A", "B"], needs: [], label: "Two-way ANOVA" },
  anova2onerm: { factors: ["A", "B"], needs: ["subject"], label: "Mixed ANOVA (A between, B within)" },
  ancova: { factors: ["A"], needs: ["cov"], label: "ANCOVA (group + covariate)" },
};

function avgCells(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!map.has(k)) map.set(k, { ...r, list: [] });
    map.get(k).list.push(r.y);
  }
  return [...map.values()].map((c) => {
    const Q = c.list[0].length, y = zeros(Q);
    for (const v of c.list) for (let q = 0; q < Q; q++) y[q] += v[q] / c.list.length;
    return { ...c, y, nTrials: c.list.length };
  });
}

/** subject x level cube for a within factor; drops subjects missing a level. */
function cubeOf(rows, levels, withGroup = false) {
  const cells = avgCells(rows, (r) => r.subject + "\u0000" + r.B);
  const subs = [...new Set(cells.map((c) => c.subject))];
  const cube = [], group = [], used = [], dropped = [];
  for (const s of subs) {
    const cs = levels.map((L) => cells.find((c) => c.subject === s && c.B === L));
    if (cs.some((c) => !c)) { dropped.push(s); continue; }
    cube.push(cs.map((c) => c.y)); used.push(s); if (withGroup) group.push(cs[0].A);
  }
  return { cube, group, subjects: used, dropped };
}

function curveStats(list) {
  const Q = list[0].length, m = zeros(Q), s = zeros(Q);
  for (const y of list) for (let q = 0; q < Q; q++) m[q] += y[q] / list.length;
  if (list.length > 1) for (const y of list) for (let q = 0; q < Q; q++) s[q] += (y[q] - m[q]) ** 2 / (list.length - 1);
  return { mean: m, sd: s.map(Math.sqrt), n: list.length };
}

/**
 * Run one SPM test. Returns { test, effects: [{ name, spmi }], assumptions, descriptives, posthoc }.
 * opts: { test, alpha, twoTailed, mu, nonparam: false | { iterations }, posthoc: true }
 */
export function runSpm(rowsIn, opts) {
  const { test, alpha = 0.05, twoTailed = true, mu = 0, nonparam = false, posthoc = true } = opts;
  const rows = rowsIn.filter((r) => r.y && Array.from(r.y).every(Number.isFinite)).map((r, i) => ({ ...r, _i: i }));
  const Q = rows[0].y.length;
  const infer = (spm, permute) => (nonparam && permute ? permutationInference(spm, permute, { alpha, twoTailed, iterations: nonparam.iterations || 1000 }) : inference(spm, alpha, twoTailed));
  const out = { test, label: TESTS[test].label, alpha, Q, effects: [], descriptives: [], assumptions: {}, posthoc: [], notes: [] };
  const desc = (name, list) => out.descriptives.push({ name, ...curveStats(list) });
  const finish = (name, f, permute) => {
    const R = f.resid();
    const spm = { ...f, fwhm: estimateFwhm(R) };
    delete spm.resid;
    out.effects.push({ name, spmi: infer(spm, permute) });
    return R;
  };

  if (test === "ttest") {
    const cells = rows.some((r) => r.subject != null && r.subject !== "") ? avgCells(rows, (r) => String(r.subject)) : rows;
    const Y = cells.map((c) => c.y);
    desc("all", Y);
    const R = finish(`mean ≠ ${mu}`, tOne(Y, mu), (rnd) => tOne(Y.map((y) => (rnd() < 0.5 ? y.map((v) => 2 * mu - v) : y)), mu).z);
    out.assumptions.normality = normalityField(R, alpha);
    out.n = Y.length;
  } else if (test === "ttest_paired") {
    const lv = levelsOf(rows.map((r) => r.B));
    if (lv.length !== 2) throw new Error("the paired t-test needs exactly two conditions (found " + lv.length + ")");
    const { cube, subjects, dropped } = cubeOf(rows, lv);
    lv.forEach((L, j) => desc(L, cube.map((s) => s[j])));
    const D = cube.map((s) => s[0].map((v, q) => v - s[1][q]));
    const R = finish(`${lv[0]} − ${lv[1]}`, tOne(D, 0), (rnd) => tOne(D.map((y) => (rnd() < 0.5 ? y.map((v) => -v) : y)), 0).z);
    out.assumptions.normality = normalityField(R, alpha);
    out.n = subjects.length; if (dropped.length) out.notes.push(`dropped (missing a condition): ${dropped.join(", ")}`);
    out.effectSize = { name: "Cohen's dz", y: dzCurve(D) };
  } else if (test === "ttest2" || test === "anova1") {
    const cells = avgCells(rows, (r) => r.subject != null && r.subject !== "" ? r.subject + "\u0000" + r.A : "#" + r._i);
    const lv = levelsOf(cells.map((c) => c.A));
    if (test === "ttest2" && lv.length !== 2) throw new Error("the two-sample t-test needs exactly two groups (found " + lv.length + ")");
    if (lv.length < 2) throw new Error("need at least two groups");
    const Y = cells.map((c) => c.y), lab = cells.map((c) => lv.indexOf(c.A));
    lv.forEach((L, j) => desc(L, Y.filter((_, i) => lab[i] === j)));
    const R = test === "ttest2"
      ? finish(`${lv[0]} − ${lv[1]}`, tTwo(Y, lab), (rnd) => tTwo(Y, shuffle(lab, rnd)).z)
      : finish("group", fOne(Y, lab), (rnd) => fOne(Y, shuffle(lab, rnd)).z);
    out.assumptions.normality = normalityField(R, alpha);
    out.assumptions.variance = varianceField(Y, lab, alpha);
    out.n = Y.length;
    if (test === "ttest2") out.effectSize = { name: "Cohen's d", y: dCurve(Y, lab) };
    if (test === "anova1" && posthoc && lv.length > 2) out.posthoc = pairwise(lv, (i, j) => {
      const ix = lab.map((l, r) => (l === i || l === j ? r : -1)).filter((r) => r >= 0);
      const f = tTwo(ix.map((r) => Y[r]), ix.map((r) => (lab[r] === i ? 0 : 1)));
      return f;
    }, infer, alpha, twoTailed, opts);
  } else if (test === "regress") {
    const cells = avgCells(rows, (r) => r.subject != null && r.subject !== "" ? String(r.subject) : "#" + r._i);
    const ok = cells.filter((c) => isNum(c.cov));
    const Y = ok.map((c) => c.y), x = ok.map((c) => c.cov);
    desc("all", Y);
    const f = tRegress(Y, x);
    const R = finish("slope", f, (rnd) => tRegress(Y, shuffle(x, rnd)).z);
    out.assumptions.normality = normalityField(R, alpha);
    out.n = Y.length;
    out.effectSize = { name: "r", y: f.r };
  } else if (test === "anova1rm") {
    const lv = levelsOf(rows.map((r) => r.B));
    const { cube, subjects, dropped } = cubeOf(rows, lv);
    lv.forEach((L, j) => desc(L, cube.map((s) => s[j])));
    const f = fRm(cube), first = levelsOf(subjects.map(String))[0];
    // spm1d's approximate residuals for RM designs (design.contrasts.C[:3]), so the FWHM matches spm1d
    f.resid = () => approxResid(cube, (i, j) => [1, j > 0 ? 1 : 0, String(subjects[i]) === first ? 0 : 1]);
    const R = finish("condition", f, (rnd) => fRm(cube.map((s) => shuffle(s, rnd))).z);
    out.assumptions.normality = normalityField(R, alpha);
    if (lv.length > 2) out.assumptions.sphericity = sphericityField(cube, null, alpha);
    out.n = subjects.length; if (dropped.length) out.notes.push(`dropped (missing a condition): ${dropped.join(", ")}`);
    if (posthoc && lv.length > 2) out.posthoc = pairwise(lv, (i, j) => tOne(cube.map((s) => s[i].map((v, q) => v - s[j][q])), 0), infer, alpha, twoTailed, opts);
  } else if (test === "anova2" || test === "ancova") {
    const cells = avgCells(rows, (r) => r.subject != null && r.subject !== "" ? r.subject + "\u0000" + r.A + "\u0000" + (test === "anova2" ? r.B : "") : "#" + r._i);
    const use = cells.filter((c) => c.A != null && c.A !== "" && (test === "anova2" ? c.B != null && c.B !== "" : isNum(c.cov)));
    const n = use.length, Y = use.map((c) => Array.from(c.y));
    const data = { A: use.map((c) => c.A), B: use.map((c) => c.B), cov: use.map((c) => c.cov) };
    const levels = test === "anova2" ? { A: levelsOf(data.A), B: levelsOf(data.B) } : { A: levelsOf(data.A) };
    const terms = test === "anova2"
      ? [{ name: "A", factors: ["A"] }, { name: "B", factors: ["B"] }, { name: "A × B", factors: ["A", "B"] }]
      : [{ name: "A", factors: ["A"] }, { name: "covariate", covariates: ["cov"] }];
    const g = glm(data, n, terms, levels, Y);
    const fit = matMulRows(g.X, g.full.beta), R = Y.map((y, i) => y.map((v, q) => v - fit[i][q]));
    const fwhm = estimateFwhm(R);
    for (const row of g.rows) {
      const z = Float64Array.from(row.ss, (ss, q) => ss / row.df / (g.sse[q] / g.dfe));
      out.effects.push({ name: test === "ancova" && row.term === "A" ? "group (adjusted)" : row.term, spmi: inference({ STAT: "F", z, df: [row.df, g.dfe], fwhm }, alpha, false) });
    }
    if (test === "anova2") {
      for (const L of levels.A) desc("A = " + L, Y.filter((_, i) => data.A[i] === L));
      for (const L of levels.B) desc("B = " + L, Y.filter((_, i) => data.B[i] === L));
      const cellLab = data.A.map((a, i) => levels.A.indexOf(a) * levels.B.length + levels.B.indexOf(data.B[i]));
      out.assumptions.variance = varianceField(Y, cellLab, alpha);
    } else {
      for (const L of levels.A) desc(L, Y.filter((_, i) => data.A[i] === L));
      out.assumptions.variance = varianceField(Y, data.A.map((a) => levels.A.indexOf(a)), alpha);
      // homogeneity of regression slopes: the group x covariate interaction field
      const gi = glm(data, n, [...terms, { name: "A × covariate", factors: ["A"], covariates: ["cov"] }], levels, Y);
      const row = gi.rows[gi.rows.length - 1];
      const fi = matMulRows(gi.X, gi.full.beta), Ri = Y.map((y, i) => y.map((v, q) => v - fi[i][q]));
      const z = Float64Array.from(row.ss, (ss, q) => ss / row.df / (gi.sse[q] / gi.dfe));
      const s = inference({ STAT: "F", z, df: [row.df, gi.dfe], fwhm: estimateFwhm(Ri) }, alpha, false);
      out.assumptions.slopes = { spmi: s, ok: !s.h0reject };
      out.adjustedMeans = adjustedMeanCurves(Y, data, levels.A);
    }
    out.assumptions.normality = normalityField(R, alpha, fwhm);
    out.n = n;
  } else if (test === "anova2onerm") {
    const lvB = levelsOf(rows.map((r) => r.B));
    const { cube, group, subjects, dropped } = cubeOf(rows, lvB, true);
    const lvA = levelsOf(group);
    for (const L of lvA) desc("A = " + L, cube.filter((_, i) => group[i] === L).map((s) => mean2(s)));
    lvB.forEach((L, j) => desc("B = " + L, cube.map((s) => s[j])));
    const Qn = cube[0][0].length;
    const zA = zeros(Qn), zB = zeros(Qn), zAB = zeros(Qn);
    let dfs = null;
    for (let q = 0; q < Qn; q++) {
      const r = rmAnova(cube.map((s) => s.map((c) => c[q])), group);
      zA[q] = r.between[0].F; zB[q] = r.within[0].F; zAB[q] = r.within[1].F;
      dfs = dfs || { A: [r.between[0].df, r.between[1].df], B: [r.within[0].df, r.within[2].df], AB: [r.within[1].df, r.within[2].df] };
    }
    // spm1d's approximate residuals for anova2onerm (design.contrasts.C[:5]), so the FWHM matches spm1d
    const firstOf = {};
    for (const L of lvA) firstOf[L] = levelsOf(subjects.filter((_, i) => group[i] === L).map(String))[0];
    const R = approxResid(cube, (i, j) => {
      const a = group[i] === lvA[0] ? 0 : 1, b = j > 0 ? 1 : 0;
      return [1, a, b, String(subjects[i]) === firstOf[group[i]] ? 0 : 1, a * b];
    });
    const fwhm = estimateFwhm(R);
    out.effects.push({ name: "A (between)", spmi: inference({ STAT: "F", z: zA, df: dfs.A, fwhm }, alpha, false) });
    out.effects.push({ name: "B (within)", spmi: inference({ STAT: "F", z: zB, df: dfs.B, fwhm }, alpha, false) });
    out.effects.push({ name: "A × B", spmi: inference({ STAT: "F", z: zAB, df: dfs.AB, fwhm }, alpha, false) });
    out.assumptions.normality = normalityField(R, alpha, fwhm);
    out.assumptions.variance = varianceField(cube.map(mean2), group.map((g) => lvA.indexOf(g)), alpha);
    if (lvB.length > 2) out.assumptions.sphericity = sphericityField(cube, group, alpha);
    out.n = subjects.length; if (dropped.length) out.notes.push(`dropped (missing a condition): ${dropped.join(", ")}`);
  } else throw new Error("unknown test " + test);
  if (nonparam && !["ttest", "ttest_paired", "ttest2", "regress", "anova1", "anova1rm"].includes(test)) out.notes.push("permutation inference is not available for this design; random field theory was used");
  return out;
}

function approxResid(cube, rowOf) {
  const X = [], Y = [];
  cube.forEach((s, i) => s.forEach((c, j) => { X.push(rowOf(i, j)); Y.push(Array.from(c)); }));
  const fit = lstsq(X, Y), F = matMulRows(X, fit.beta);
  return Y.map((y, r) => Float64Array.from(y, (v, q) => v - F[r][q]));
}
function mean2(curves) { const Q = curves[0].length, o = zeros(Q); for (const c of curves) for (let q = 0; q < Q; q++) o[q] += c[q] / curves.length; return o; }
function matMulRows(X, B) { const Q = B[0].length; return X.map((row) => { const o = zeros(Q); row.forEach((x, j) => { if (x) for (let q = 0; q < Q; q++) o[q] += x * B[j][q]; }); return o; }); }
function dzCurve(D) { const s = curveStats(D); return s.mean.map((m, q) => m / s.sd[q]); }
function dCurve(Y, lab) {
  const a = curveStats(Y.filter((_, i) => lab[i] === 0)), b = curveStats(Y.filter((_, i) => lab[i] === 1));
  return a.mean.map((m, q) => (m - b.mean[q]) / Math.sqrt(((a.n - 1) * a.sd[q] ** 2 + (b.n - 1) * b.sd[q] ** 2) / (a.n + b.n - 2)));
}

/** ANCOVA adjusted mean curves: group mean - b_within * (group cov mean - grand cov mean). */
function adjustedMeanCurves(Y, data, lv) {
  const Q = Y[0].length, n = Y.length, gm = mean(data.cov);
  const gi = data.A.map((a) => lv.indexOf(a));
  const cm = lv.map((_, g) => mean(data.cov.filter((_, i) => gi[i] === g)));
  const ym = lv.map((_, g) => curveStats(Y.filter((_, i) => gi[i] === g)).mean);
  return lv.map((L, g) => {
    const out = zeros(Q);
    for (let q = 0; q < Q; q++) {
      let sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { const dx = data.cov[i] - cm[gi[i]]; sxy += dx * (Y[i][q] - ym[gi[i]][q]); sxx += dx * dx; }
      out[q] = ym[g][q] - (sxy / sxx) * (cm[g] - gm);
    }
    return { name: L, mean: out };
  });
}

/** Pairwise post hoc SPM t-tests with Sidak-corrected alpha. */
function pairwise(levels, fieldOf, infer, alpha, twoTailed, opts) {
  const m = (levels.length * (levels.length - 1)) / 2, a = 1 - Math.pow(1 - alpha, 1 / m);
  const out = [];
  for (let i = 0; i < levels.length; i++) for (let j = i + 1; j < levels.length; j++) {
    const f = fieldOf(i, j), R = f.resid(), spm = { ...f, fwhm: estimateFwhm(R) }; delete spm.resid;
    out.push({ name: `${levels[i]} − ${levels[j]}`, alpha: a, spmi: opts.nonparam ? inference(spm, a, twoTailed) : inference(spm, a, twoTailed) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Curves in: resampling to Q nodes
 * ------------------------------------------------------------------ */

/** Linear resample of y (optionally over x) to Q evenly spaced nodes, dropping NaNs at the ends. */
export function normalise(y, Q = 101, x = null) {
  const n = y.length, xs = x || Float64Array.from({ length: n }, (_, i) => i);
  let a = 0, b = n - 1;
  while (a < n && !Number.isFinite(y[a])) a++;
  while (b > a && !Number.isFinite(y[b])) b--;
  const out = new Float64Array(Q), x0 = xs[a], x1 = xs[b];
  let j = a;
  for (let q = 0; q < Q; q++) {
    const t = x0 + ((x1 - x0) * q) / (Q - 1);
    while (j < b - 1 && xs[j + 1] < t) j++;
    const u = xs[j + 1] === xs[j] ? 0 : (t - xs[j]) / (xs[j + 1] - xs[j]);
    const y0 = y[j], y1 = Number.isFinite(y[j + 1]) ? y[j + 1] : y0;
    out[q] = y0 + u * (y1 - y0);
  }
  return out;
}

export const _internal = { rft, ecDensity, normInv, sd };
