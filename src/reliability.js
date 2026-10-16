/**
 * reliability.js -- test-retest reliability, discrete and continuous.
 *
 * Discrete: a port of Bas's MATLAB `reliability` toolbox
 * (github.com/basgoncalves/reliability, calculate_realiability_parameters +
 * MultiBlandAltman). Same input convention -- one column per trial, trials of
 * one condition named "<condition>-<N>" (AB-1, AB-2, ER-1 ...) -- and the same
 * outputs per condition: ICC (McGraw & Wong 1996, six forms) with 95% CI, SEM,
 * MDC, CV, bias, limits of agreement and heteroscedasticity, for every pair of
 * trials and for all trials together.
 *
 * Continuous: the same questions for waveforms (one curve per subject per
 * session): CMC (Ferrari et al. 2010), node-by-node ICC / SEM / MDC curves,
 * RMSE and the linear fit method (Iosa et al. 2014).
 *
 * References
 *   McGraw & Wong (1996) Psychol Methods 1:30-46            ICC forms and CIs
 *   Weir (2005) J Strength Cond Res 19:231-240              SEM = sqrt(MSE), MDC
 *   Koo & Li (2016) J Chiropr Med 15:155-163                ICC interpretation
 *   Atkinson & Nevill (1998) Sports Med 26:217-238          heteroscedasticity, CV
 *   Bland & Altman (1986) Lancet 1:307-310                  bias, limits of agreement
 *   Ferrari et al. (2010) Gait Posture 31:540-542           CMC
 *   Iosa et al. (2014) Comput Math Methods Med 2014:214156  linear fit method
 */
import { isNum, mean, sd, sum, fSf, fInv, tInv, tP2, pearson } from "./stats.js";

export const ICC_TYPES = ["1-1", "1-k", "C-1", "C-k", "A-1", "A-k"];

/** Two-way ANOVA mean squares for an n x k matrix without missing cells. */
export function anova2way(Y) {
  const n = Y.length, k = Y[0].length, all = Y.flat(), gm = mean(all);
  const rm = Y.map((r) => mean(r)), cm = Y[0].map((_, j) => mean(Y.map((r) => r[j])));
  let ssr = 0, ssc = 0, sst = 0;
  rm.forEach((m) => (ssr += k * (m - gm) ** 2));
  cm.forEach((m) => (ssc += n * (m - gm) ** 2));
  all.forEach((v) => (sst += (v - gm) ** 2));
  const sse = sst - ssr - ssc;
  return {
    n, k, gm, rowMeans: rm, colMeans: cm,
    MSR: ssr / (n - 1), MSC: ssc / (k - 1), MSE: sse / ((n - 1) * (k - 1)), MSW: (ssc + sse) / (n * (k - 1)),
    dfR: n - 1, dfC: k - 1, dfE: (n - 1) * (k - 1), dfW: n * (k - 1), SST: sst,
  };
}

/** ICC of the given form with its 95% CI and F test (McGraw & Wong 1996, as in SPSS and pingouin). */
export function icc(Y, type = "A-1", alpha = 0.05) {
  const a = anova2way(Y), { n, k, MSR, MSC, MSE, MSW } = a;
  let v, F, df1, df2, lo, hi;
  const Fl = (df1, df2) => fInv(1 - alpha / 2, df1, df2), Fu = (df1, df2) => fInv(1 - alpha / 2, df2, df1);
  if (type === "1-1" || type === "1-k") {
    F = MSR / MSW; df1 = n - 1; df2 = n * (k - 1);
    const FL = F / Fl(df1, df2), FU = F * Fu(df1, df2);
    if (type === "1-1") { v = (MSR - MSW) / (MSR + (k - 1) * MSW); lo = (FL - 1) / (FL + k - 1); hi = (FU - 1) / (FU + k - 1); }
    else { v = (MSR - MSW) / MSR; lo = 1 - 1 / FL; hi = 1 - 1 / FU; }
  } else if (type === "C-1" || type === "C-k") {
    F = MSR / MSE; df1 = n - 1; df2 = (n - 1) * (k - 1);
    const FL = F / Fl(df1, df2), FU = F * Fu(df1, df2);
    if (type === "C-1") { v = (MSR - MSE) / (MSR + (k - 1) * MSE); lo = (FL - 1) / (FL + k - 1); hi = (FU - 1) / (FU + k - 1); }
    else { v = (MSR - MSE) / MSR; lo = 1 - 1 / FL; hi = 1 - 1 / FU; }
  } else {
    F = MSR / MSE; df1 = n - 1; df2 = (n - 1) * (k - 1);
    const r1 = (MSR - MSE) / (MSR + (k - 1) * MSE + (k * (MSC - MSE)) / n);
    // Satterthwaite df for the agreement CI (McGraw & Wong eq. in Table 7)
    const aa = (k * r1) / (n * (1 - r1)), bb = 1 + (k * r1 * (n - 1)) / (n * (1 - r1));
    const vn = (aa * MSC + bb * MSE) ** 2 / ((aa * MSC) ** 2 / (k - 1) + (bb * MSE) ** 2 / ((n - 1) * (k - 1)));
    const FsL = fInv(1 - alpha / 2, n - 1, vn), FsU = fInv(1 - alpha / 2, vn, n - 1);
    const L1 = (n * (MSR - FsL * MSE)) / (FsL * (k * MSC + (k * n - k - n) * MSE) + n * MSR);
    const U1 = (n * (FsU * MSR - MSE)) / (k * MSC + (k * n - k - n) * MSE + n * FsU * MSR);
    if (type === "A-1") { v = r1; lo = L1; hi = U1; }
    else { v = (MSR - MSE) / (MSR + (MSC - MSE) / n); lo = (L1 * k) / (1 + L1 * (k - 1)); hi = (U1 * k) / (1 + U1 * (k - 1)); }
  }
  return { type, icc: v, ci95: [lo, hi], F, df1, df2, p: fSf(F, df1, df2), anova: a };
}

export function iccLabel(v) {               // Koo & Li (2016), on the point estimate
  if (!Number.isFinite(v)) return "–";
  return v < 0.5 ? "poor" : v < 0.75 ? "moderate" : v < 0.9 ? "good" : "excellent";
}

/** Group "<name>-<N>" headers into conditions, keeping column order. */
export function conditionsFromHeaders(headers, sep = "-") {
  const out = [];
  headers.forEach((h, j) => {
    const i = h.lastIndexOf(sep);
    const name = i > 0 && /^\s*\d+\s*$/.test(h.slice(i + 1)) ? h.slice(0, i).trim() : h.trim();
    const last = out[out.length - 1];
    if (last && last.name === name) last.cols.push(j); else out.push({ name, cols: [j] });
  });
  return out;
}

/** Everything for one condition: matrix n x k (k trials). zeroIsMissing mirrors the MATLAB toolbox. */
export function reliabilityOf(Yraw, { type = "A-1", zeroIsMissing = false, trialNames = null } = {}) {
  const Y0 = Yraw.map((r) => r.map((v) => (zeroIsMissing && v === 0 ? NaN : v)));
  const Y = Y0.filter((r) => r.every(isNum));
  const k = Y[0] ? Y[0].length : 0, names = trialNames || [...Array(k).keys()].map((i) => "T" + (i + 1));
  const res = { n: Y.length, excluded: Y0.length - Y.length, k, trials: names, overall: null, pairs: [] };
  if (Y.length < 3 || k < 2) return res;
  res.overall = summary(Y, type);
  if (k > 2) {
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
      const sub = Y0.map((r) => [r[i], r[j]]).filter((r) => r.every(isNum));
      if (sub.length >= 3) res.pairs.push({ a: names[i], b: names[j], ...summary(sub, type) });
    }
  }
  return res;
}

function summary(Y, type) {
  const n = Y.length, k = Y[0].length, I = icc(Y, type), a = I.anova;
  const all = Y.flat(), gm = mean(all), sdAll = sd(all);
  const semMSE = Math.sqrt(a.MSE);                       // Weir 2005 preferred
  const semICC = sdAll * Math.sqrt(Math.max(0, 1 - I.icc));
  const mdc = 1.959963985 * Math.SQRT2 * semMSE;
  // within-subject CV: mean of each subject's SD/mean (Atkinson & Nevill 1998)
  const cvs = Y.map((r) => (sd(r) / Math.abs(mean(r))) * 100).filter(Number.isFinite);
  const out = {
    n, k, icc: I.icc, iccCI: I.ci95, iccF: I.F, iccDf1: I.df1, iccDf2: I.df2, iccP: I.p, iccType: type, label: iccLabel(I.icc),
    grandMean: gm, sdAll, sem: semMSE, semPct: (semMSE / Math.abs(gm)) * 100, semICC,
    mdc95: mdc, mdcPct: (mdc / Math.abs(gm)) * 100, cv: mean(cvs),
    trialMeans: a.colMeans, trialSDs: Y[0].map((_, j) => sd(Y.map((r) => r[j]))),
  };
  if (k === 2) Object.assign(out, blandAltman(Y.map((r) => r[0]), Y.map((r) => r[1])));
  else {
    // systematic change across all trials: the column effect of the two-way ANOVA
    const F = a.MSC / a.MSE;
    out.trialF = F; out.trialP = fSf(F, a.dfC, a.dfE);
  }
  return out;
}

/** Bland-Altman with bias CI, systematic bias test and heteroscedasticity (r of |diff| vs mean). */
export function blandAltman(x1, x2) {
  const d = x1.map((v, i) => x2[i] - v), m = x1.map((v, i) => (v + x2[i]) / 2), n = d.length;
  const bias = mean(d), sdd = sd(d), se = sdd / Math.sqrt(n), tc = tInv(0.975, n - 1);
  const t = bias / se;
  const het = pearson(m, d.map(Math.abs));
  const seLoA = Math.sqrt(3 / n) * sdd;         // Bland & Altman 1999
  return {
    bias, biasSD: sdd, biasCI: [bias - tc * se, bias + tc * se], biasT: t, biasP: tP2(t, n - 1),
    loa: [bias - 1.96 * sdd, bias + 1.96 * sdd],
    loaCI: [[bias - 1.96 * sdd - tc * seLoA, bias - 1.96 * sdd + tc * seLoA], [bias + 1.96 * sdd - tc * seLoA, bias + 1.96 * sdd + tc * seLoA]],
    hetR: het.r, hetR2: het.r * het.r, hetP: het.p, ba: { mean: m, diff: d },
  };
}

/* ------------------------------------------------------------------ *
 * Continuous (waveform) reliability
 *   curves: [{ subject, session, y: Float64Array(Q) }]  (session = trial / day)
 * ------------------------------------------------------------------ */

/** CMC of a G x F block of curves (Ferrari et al. 2010, one protocol). NaN when the ratio exceeds 1. */
export function cmc(curves) {
  const G = curves.length, F = curves[0].length;
  if (G < 2) return NaN;
  const yf = new Float64Array(F); for (const c of curves) for (let f = 0; f < F; f++) yf[f] += c[f] / G;
  const yAll = sum(yf) / F;
  let num = 0, den = 0;
  for (const c of curves) for (let f = 0; f < F; f++) { num += (c[f] - yf[f]) ** 2; den += (c[f] - yAll) ** 2; }
  const ratio = num / (F * (G - 1)) / (den / (G * F - 1));
  return ratio > 1 ? NaN : Math.sqrt(1 - ratio);
}

export function waveformReliability(curves, { type = "A-1", sessions = null } = {}) {
  const ss = sessions || [...new Set(curves.map((c) => c.session))];
  const subs = [...new Set(curves.map((c) => c.subject))];
  const Q = curves[0].y.length;
  // subject x session mean curve (several trials of one session are averaged first)
  const cell = new Map();
  for (const c of curves) {
    const key = c.subject + "\u0000" + c.session;
    if (!cell.has(key)) cell.set(key, []);
    cell.get(key).push(c.y);
  }
  const avg = (list) => { const o = new Float64Array(Q); for (const y of list) for (let q = 0; q < Q; q++) o[q] += y[q] / list.length; return o; };
  const complete = subs.filter((s) => ss.every((t) => cell.has(s + "\u0000" + t)));
  const M = complete.map((s) => ss.map((t) => avg(cell.get(s + "\u0000" + t))));   // n x k x Q
  const n = M.length, k = ss.length;
  const out = { n, k, Q, subjects: complete, sessions: ss, dropped: subs.filter((s) => !complete.includes(s)) };
  if (n < 3 || k < 2) return out;
  // node by node
  const iccQ = new Float64Array(Q), semQ = new Float64Array(Q), mdcQ = new Float64Array(Q), lo = new Float64Array(Q), hi = new Float64Array(Q);
  for (let q = 0; q < Q; q++) {
    const Y = M.map((r) => r.map((y) => y[q]));
    const I = icc(Y, type);
    iccQ[q] = I.icc; lo[q] = I.ci95[0]; hi[q] = I.ci95[1];
    semQ[q] = Math.sqrt(Math.max(0, I.anova.MSE)); mdcQ[q] = 1.959963985 * Math.SQRT2 * semQ[q];
  }
  // within-subject: CMC across sessions, RMSE and linear fit (session k vs session 1)
  const perSubject = M.map((r, i) => {
    const c = cmc(r.map((y) => Array.from(y)));
    const pairs = [];
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
      let e = 0; for (let q = 0; q < Q; q++) e += (r[b][q] - r[a][q]) ** 2;
      const lf = linFit(r[a], r[b]);
      pairs.push({ a: ss[a], b: ss[b], rmse: Math.sqrt(e / Q), ...lf });
    }
    return { subject: complete[i], cmc: c, pairs };
  });
  const fin = (x) => x.filter(Number.isFinite);
  const cm = fin(perSubject.map((p) => p.cmc));
  const allPairs = perSubject.flatMap((p) => p.pairs);
  const range = (() => { let mx = -Infinity, mn = Infinity; for (const r of M) for (const y of r) for (const v of y) { if (v > mx) mx = v; if (v < mn) mn = v; } return mx - mn; })();
  Object.assign(out, {
    icc: iccQ, iccLo: lo, iccHi: hi, sem: semQ, mdc: mdcQ, iccType: type,
    meanICC: mean(Array.from(iccQ)), meanSEM: mean(Array.from(semQ)), meanMDC: mean(Array.from(mdcQ)),
    perSubject, cmcMean: cm.length ? mean(cm) : NaN, cmcSD: cm.length > 1 ? sd(cm) : NaN, cmcUndefined: perSubject.length - cm.length,
    rmseMean: mean(allPairs.map((p) => p.rmse)), rmseSD: allPairs.length > 1 ? sd(allPairs.map((p) => p.rmse)) : NaN,
    rmsePctRange: (mean(allPairs.map((p) => p.rmse)) / range) * 100,
    lfm: { a1: mean(allPairs.map((p) => p.a1)), a0: mean(allPairs.map((p) => p.a0)), r2: mean(allPairs.map((p) => p.r2)) },
    sessionMeans: ss.map((_, j) => { const o = new Float64Array(Q); for (const r of M) for (let q = 0; q < Q; q++) o[q] += r[j][q] / n; return o; }),
    sessionSDs: ss.map((_, j) => Float64Array.from({ length: Q }, (_, q) => sd(M.map((r) => r[j][q])))),
    matrix: M,
  });
  return out;
}

function linFit(x, y) {               // y = a1 x + a0 (Iosa 2014)
  const n = x.length, mx = mean(Array.from(x)), my = mean(Array.from(y));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const a1 = sxy / sxx;
  return { a1, a0: my - a1 * mx, r2: (sxy * sxy) / (sxx * syy) };
}
