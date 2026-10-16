/**
 * stats.js -- the statistics engine behind Analysis (src/analysis.js).
 *
 * Dependency-free, so it runs in the page, in a worker and under node for the
 * tests. Every test here is checked against scipy / pingouin in
 * tests/test_stats.mjs (reference values generated once and pasted in), so a
 * p-value on the page is the same p-value JASP, SPSS and Python print.
 *
 * Conventions:
 *   - arrays of numbers; NaN / null are missing and dropped (listwise where
 *     several variables are involved).
 *   - every test returns a plain object; the UI turns those into tables.
 *   - p-values are two-sided unless the function says otherwise.
 */

/* ------------------------------------------------------------------ *
 * Special functions
 * ------------------------------------------------------------------ */

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x). */
export function gammainc(a, x) {
  if (x <= 0) return 0;
  if (!Number.isFinite(x)) return 1;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 1000; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-16) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  return 1 - gammaincc(a, x);
}

/** Regularised upper incomplete gamma Q(a, x) (continued fraction, accurate in the tail). */
export function gammaincc(a, x) {
  if (x <= 0) return 1;
  if (!Number.isFinite(x)) return 0;
  if (x < a + 1) return 1 - gammainc(a, x);
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

function betacf(a, b, x) {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 3000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function betainc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(lbt) * betacf(a, b, x)) / a;
  return 1 - (Math.exp(lbt) * betacf(b, a, 1 - x)) / b;
}

/* ------------------------------------------------------------------ *
 * Distributions: cdf, survival (sf) and inverse
 * ------------------------------------------------------------------ */

export function normCdf(x) {
  if (Number.isNaN(x)) return NaN;
  return x >= 0 ? 0.5 + 0.5 * gammainc(0.5, (x * x) / 2) : 0.5 * gammaincc(0.5, (x * x) / 2);
}
export const normSf = (x) => normCdf(-x);
export const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  // Acklam's rational approximation, then one Halley step against normCdf.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5, r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export function tCdf(t, df) {
  if (!Number.isFinite(df)) return normCdf(t);
  const x = df / (df + t * t);
  const tail = 0.5 * betainc(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}
export const tSf = (t, df) => tCdf(-t, df);
/** two-sided p for a t statistic */
export const tP2 = (t, df) => Math.min(1, 2 * tSf(Math.abs(t), df));

export function fSf(f, d1, d2) {
  if (!(f > 0)) return 1;
  return betainc(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}
export const fCdf = (f, d1, d2) => 1 - fSf(f, d1, d2);
export const chi2Sf = (x, k) => (x <= 0 ? 1 : gammaincc(k / 2, x / 2));
export const chi2Cdf = (x, k) => 1 - chi2Sf(x, k);

/** Invert a monotone increasing cdf by bisection on [lo, hi]. */
function invert(cdf, p, lo, hi) {
  while (cdf(hi) < p) hi *= 2;
  while (cdf(lo) > p) lo = lo < 0 ? lo * 2 : lo / 2 - 1;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (cdf(m) < p) lo = m; else hi = m;
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(m))) break;
  }
  return (lo + hi) / 2;
}
export const tInv = (p, df) => (Number.isFinite(df) ? invert((x) => tCdf(x, df), p, -50, 50) : normInv(p));
export const fInv = (p, d1, d2) => invert((x) => fCdf(x, d1, d2), p, 0, 50);
export const chi2Inv = (p, k) => invert((x) => chi2Cdf(x, k), p, 0, 50);

/* Studentized range distribution (Tukey HSD, Games-Howell), by quadrature.
 *   P(Q < q | k, df) = integral f_s(s) * Pinf(q s, k) ds,
 *   Pinf(w, k)       = k * integral phi(z) [Phi(z) - Phi(z - w)]^(k-1) dz.
 * Gauss-Legendre is enough for 1e-6 at the p-values anyone reads. */
const GL = (() => {
  const n = 64, x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5)), pp = 0;
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0;
      for (let j = 0; j < n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j + 1) * z * p2 - j * p3) / (j + 1); }
      pp = (n * (z * p1 - p2)) / (z * z - 1);
      const z1 = z; z = z1 - p1 / pp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    x[i] = z; w[i] = 2 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
})();
function quad(f, a, b, pieces = 4) {
  let s = 0; const h = (b - a) / pieces;
  for (let p = 0; p < pieces; p++) {
    const lo = a + p * h, c = lo + h / 2;
    for (let i = 0; i < GL.x.length; i++) s += GL.w[i] * f(c + (h / 2) * GL.x[i]);
  }
  return (s * h) / 2;
}
function ptukeyInf(w, k) {
  if (w <= 0) return 0;
  return k * quad((z) => normPdf(z) * Math.pow(Math.max(0, normCdf(z) - normCdf(z - w)), k - 1), -8, 8 + w, 6);
}
export function ptukey(q, k, df) {
  if (!(q > 0)) return 0;
  if (!Number.isFinite(df) || df > 5000) return ptukeyInf(q, k);
  const lc = Math.log(df) * (df / 2) - lgamma(df / 2) - (df / 2 - 1) * Math.log(2);
  const fs = (s) => (s <= 0 ? 0 : Math.exp(lc + (df - 1) * Math.log(s) - (df * s * s) / 2));
  const hi = 1 + 12 / Math.sqrt(df);
  return Math.min(1, quad((s) => fs(s) * ptukeyInf(q * s, k), 0, Math.max(hi, 3), 8));
}
export const tukeySf = (q, k, df) => Math.max(0, 1 - ptukey(q, k, df));

/* ------------------------------------------------------------------ *
 * Basic helpers
 * ------------------------------------------------------------------ */

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const clean = (x) => x.filter(isNum);
export const sum = (x) => { let s = 0; for (const v of x) s += v; return s; };
export const mean = (x) => sum(x) / x.length;
export function variance(x, ddof = 1) {
  const m = mean(x); let s = 0;
  for (const v of x) s += (v - m) * (v - m);
  return s / (x.length - ddof);
}
export const sd = (x, ddof = 1) => Math.sqrt(variance(x, ddof));
export function quantile(x, p) {            // linear interpolation, type 7 (R/numpy default)
  const s = [...x].sort((a, b) => a - b), h = (s.length - 1) * p, lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)]) - s[lo]);
}
export const median = (x) => quantile(x, 0.5);

/** Average ranks (ties share the mean rank). Returns { r, ties } with ties = sum(t^3 - t). */
export function rank(x) {
  const idx = x.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(x.length);
  let ties = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const rr = (i + j) / 2 + 1, t = j - i + 1;
    if (t > 1) ties += t * t * t - t;
    for (let k = i; k <= j; k++) r[idx[k][1]] = rr;
    i = j + 1;
  }
  return { r, ties };
}

export function pAdjust(p, method = "holm") {
  const m = p.length;
  if (method === "none") return [...p];
  if (method === "bonferroni") return p.map((v) => Math.min(1, v * m));
  if (method === "sidak") return p.map((v) => 1 - Math.pow(1 - v, m));
  const o = p.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(m);
  let run = 0;
  o.forEach(([v, i], k) => { run = Math.max(run, Math.min(1, (m - k) * v)); out[i] = run; });   // holm
  return out;
}

/* ------------------------------------------------------------------ *
 * Descriptives and normality
 * ------------------------------------------------------------------ */

export function describe(raw) {
  const x = clean(raw), n = x.length;
  const out = { n, missing: raw.length - n };
  if (!n) return out;
  const m = mean(x), s = n > 1 ? sd(x) : NaN;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const v of x) { const d = v - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  const g1 = m3 / Math.pow(m2, 1.5), g2 = m4 / (m2 * m2) - 3;
  // SPSS / JASP report the bias-adjusted G1, G2 and their standard errors.
  const skew = n > 2 ? (g1 * Math.sqrt(n * (n - 1))) / (n - 2) : NaN;
  const kurt = n > 3 ? ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6) : NaN;
  const seSkew = n > 2 ? Math.sqrt((6 * n * (n - 1)) / ((n - 2) * (n + 1) * (n + 3))) : NaN;
  const seKurt = n > 3 ? 2 * seSkew * Math.sqrt((n * n - 1) / ((n - 3) * (n + 5))) : NaN;
  const se = s / Math.sqrt(n), tc = n > 1 ? tInv(0.975, n - 1) : NaN;
  return {
    ...out, mean: m, sd: s, se, ci95: [m - tc * se, m + tc * se], median: median(x),
    q1: quantile(x, 0.25), q3: quantile(x, 0.75), iqr: quantile(x, 0.75) - quantile(x, 0.25),
    min: Math.min(...x), max: Math.max(...x), skew, seSkew, kurtosis: kurt, seKurt,
    cv: (s / m) * 100,
  };
}

/** Shapiro-Wilk W and p (Royston 1992/1995, as in R, SPSS, JASP, scipy). n in [3, 5000]. */
export function shapiroWilk(raw) {
  const x = clean(raw).sort((a, b) => a - b), n = x.length;
  if (n < 3) return { W: NaN, p: NaN, n };
  const mx = mean(x);
  let ssq = 0; for (const v of x) ssq += (v - mx) * (v - mx);
  if (ssq < 1e-300 * n) return { W: NaN, p: NaN, n };
  const a = new Array(n).fill(0);
  if (n === 3) { a[0] = -Math.SQRT1_2; a[2] = Math.SQRT1_2; }
  else {
    const m = []; for (let i = 1; i <= n; i++) m.push(normInv((i - 0.375) / (n + 0.25)));
    const mm = sum(m.map((v) => v * v)), u = 1 / Math.sqrt(n), c = m.map((v) => v / Math.sqrt(mm));
    const an = c[n - 1] + 0.221157 * u - 0.147981 * u ** 2 - 2.07119 * u ** 3 + 4.434685 * u ** 4 - 2.706056 * u ** 5;
    if (n > 5) {
      const an1 = c[n - 2] + 0.042981 * u - 0.293762 * u ** 2 - 1.752461 * u ** 3 + 5.682633 * u ** 4 - 3.582633 * u ** 5;
      const phi = (mm - 2 * m[n - 1] ** 2 - 2 * m[n - 2] ** 2) / (1 - 2 * an ** 2 - 2 * an1 ** 2);
      for (let i = 2; i < n - 2; i++) a[i] = m[i] / Math.sqrt(phi);
      a[n - 1] = an; a[0] = -an; a[n - 2] = an1; a[1] = -an1;
    } else {
      const phi = (mm - 2 * m[n - 1] ** 2) / (1 - 2 * an ** 2);
      for (let i = 1; i < n - 1; i++) a[i] = m[i] / Math.sqrt(phi);
      a[n - 1] = an; a[0] = -an;
    }
  }
  let num = 0; for (let i = 0; i < n; i++) num += a[i] * x[i];
  const W = Math.min(1, (num * num) / ssq);
  let p;
  if (n === 3) p = Math.max(0, Math.min(1, (6 / Math.PI) * (Math.asin(Math.sqrt(W)) - Math.asin(Math.sqrt(0.75)))));
  else if (n <= 11) {
    const g = -2.273 + 0.459 * n;
    const mu = 0.544 - 0.39978 * n + 0.025054 * n ** 2 - 0.0006714 * n ** 3;
    const s = Math.exp(1.3822 - 0.77857 * n + 0.062767 * n ** 2 - 0.0020322 * n ** 3);
    const y = -Math.log(g - Math.log(1 - W));
    p = normSf((y - mu) / s);
  } else {
    const L = Math.log(n);
    const mu = -1.5861 - 0.31082 * L - 0.083751 * L ** 2 + 0.0038915 * L ** 3;
    const s = Math.exp(-0.4803 - 0.082676 * L + 0.0030302 * L ** 2);
    p = normSf((Math.log(1 - W) - mu) / s);
  }
  return { W, p, n };
}

/** D'Agostino-Pearson K^2 omnibus normality test (scipy.stats.normaltest). n >= 8. */
export function dagostinoK2(raw) {
  const x = clean(raw), n = x.length;
  if (n < 8) return { K2: NaN, p: NaN, n };
  const m = mean(x); let m2 = 0, m3 = 0, m4 = 0;
  for (const v of x) { const d = v - m; m2 += d * d; m3 += d ** 3; m4 += d ** 4; }
  m2 /= n; m3 /= n; m4 /= n;
  const b1 = m3 / m2 ** 1.5, b2 = m4 / m2 ** 2;
  const y = b1 * Math.sqrt(((n + 1) * (n + 3)) / (6 * (n - 2)));
  const beta2 = (3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3)) / ((n - 2) * (n + 5) * (n + 7) * (n + 9));
  const W2 = -1 + Math.sqrt(2 * (beta2 - 1)), delta = 1 / Math.sqrt(0.5 * Math.log(W2)), alpha = Math.sqrt(2 / (W2 - 1));
  const ya = y / alpha, Zs = delta * Math.log(ya + Math.sqrt(ya * ya + 1));
  const E = (3 * (n - 1)) / (n + 1), vb2 = (24 * n * (n - 2) * (n - 3)) / ((n + 1) ** 2 * (n + 3) * (n + 5));
  const xk = (b2 - E) / Math.sqrt(vb2);
  const sb1 = ((6 * (n * n - 5 * n + 2)) / ((n + 7) * (n + 9))) * Math.sqrt((6 * (n + 3) * (n + 5)) / (n * (n - 2) * (n - 3)));
  const A = 6 + (8 / sb1) * (2 / sb1 + Math.sqrt(1 + 4 / (sb1 * sb1)));
  const den = 1 + xk * Math.sqrt(2 / (A - 4));
  const t2 = Math.sign(den) * Math.cbrt((1 - 2 / A) / Math.abs(den));
  const Zk = (1 - 2 / (9 * A) - t2) / Math.sqrt(2 / (9 * A));
  const K2 = Zs * Zs + Zk * Zk;
  return { K2, p: chi2Sf(K2, 2), Zs, Zk, n };
}

/** Q-Q plot points: theoretical normal quantiles vs standardised data. */
export function qqPoints(raw) {
  const x = clean(raw).sort((a, b) => a - b), n = x.length, m = mean(x), s = sd(x);
  return x.map((v, i) => [normInv((i + 1 - 0.375) / (n + 0.25)), (v - m) / s]);
}

/* ------------------------------------------------------------------ *
 * Variance homogeneity
 * ------------------------------------------------------------------ */

/** Levene's test. center "mean" (SPSS/JASP default) or "median" (Brown-Forsythe). */
export function levene(groups, center = "mean") {
  const g = groups.map(clean).filter((x) => x.length);
  const z = g.map((x) => { const c = center === "median" ? median(x) : mean(x); return x.map((v) => Math.abs(v - c)); });
  const a = anovaOneWay(z);
  return { F: a.F, df1: a.df1, df2: a.df2, p: a.p, center };
}

/* ------------------------------------------------------------------ *
 * t-tests
 * ------------------------------------------------------------------ */

function tOut(t, df, d, extra) {
  return { t, df, p: tP2(t, df), pLess: tCdf(t, df), pGreater: tSf(t, df), d, ...extra };
}

export function tTestOneSample(raw, mu = 0) {
  const x = clean(raw), n = x.length, m = mean(x), s = sd(x), se = s / Math.sqrt(n);
  const t = (m - mu) / se, df = n - 1, tc = tInv(0.975, df), d = (m - mu) / s;
  const J = 1 - 3 / (4 * df - 1);
  return tOut(t, df, d, { n, mean: m, sd: s, se, diff: m - mu, ci95: [m - mu - tc * se, m - mu + tc * se], g: d * J, mu });
}

export function tTestPaired(a, b) {
  const pairs = a.map((v, i) => [v, b[i]]).filter(([u, v]) => isNum(u) && isNum(v));
  const r = tTestOneSample(pairs.map(([u, v]) => u - v), 0);
  return { ...r, pairs: pairs.length, meanA: mean(pairs.map((p) => p[0])), meanB: mean(pairs.map((p) => p[1])) };
}

/** Independent samples: Student (equal variances) and Welch. */
export function tTestIndependent(ra, rb) {
  const a = clean(ra), b = clean(rb), n1 = a.length, n2 = b.length;
  const m1 = mean(a), m2 = mean(b), v1 = variance(a), v2 = variance(b);
  const sp2 = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2), seS = Math.sqrt(sp2 * (1 / n1 + 1 / n2));
  const dfS = n1 + n2 - 2, tS = (m1 - m2) / seS;
  const seW = Math.sqrt(v1 / n1 + v2 / n2), tW = (m1 - m2) / seW;
  const dfW = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  const d = (m1 - m2) / Math.sqrt(sp2), J = 1 - 3 / (4 * dfS - 1);
  const ci = (se, df) => { const tc = tInv(0.975, df); return [m1 - m2 - tc * se, m1 - m2 + tc * se]; };
  return {
    n1, n2, mean1: m1, mean2: m2, sd1: Math.sqrt(v1), sd2: Math.sqrt(v2), diff: m1 - m2,
    student: tOut(tS, dfS, d, { se: seS, ci95: ci(seS, dfS), g: d * J }),
    welch: tOut(tW, dfW, d, { se: seW, ci95: ci(seW, dfW), g: d * J }),
    levene: levene([a, b]),
  };
}

/* ------------------------------------------------------------------ *
 * Rank tests
 * ------------------------------------------------------------------ */

/** Mann-Whitney U. Exact when a sample has < 8 values and there are no ties (scipy's rule), else normal with continuity and tie correction. */
export function mannWhitney(ra, rb) {
  const a = clean(ra), b = clean(rb), n1 = a.length, n2 = b.length, N = n1 + n2;
  const { r, ties } = rank([...a, ...b]);
  const R1 = sum(r.slice(0, n1)), U1 = R1 - (n1 * (n1 + 1)) / 2, U2 = n1 * n2 - U1;
  let p, z = NaN, method;
  if (Math.min(n1, n2) < 8 && ties === 0) {
    method = "exact";
    // number of arrangements with U = u, by the standard recursion over (n1, n2)
    const memo = new Map();
    const cnt = (m, n, u) => {
      if (u < 0) return 0;
      if (m === 0 || n === 0) return u === 0 ? 1 : 0;
      const key = m + "," + n + "," + u;
      if (memo.has(key)) return memo.get(key);
      const v = cnt(m - 1, n, u - n) + cnt(m, n - 1, u);
      memo.set(key, v); return v;
    };
    let total = 0; const dist = [];
    for (let u = 0; u <= n1 * n2; u++) { const c = cnt(n1, n2, u); dist.push(c); total += c; }
    const Umax = Math.max(U1, U2);
    let tail = 0; for (let u = Math.round(Umax); u <= n1 * n2; u++) tail += dist[u];
    p = Math.min(1, (2 * tail) / total);
  } else {
    method = "asymptotic";
    const mu = (n1 * n2) / 2, s = Math.sqrt(((n1 * n2) / 12) * (N + 1 - ties / (N * (N - 1))));
    const Umax = Math.max(U1, U2);
    z = (Umax - mu - 0.5) / s;
    p = Math.min(1, 2 * normSf(z));
  }
  const rbis = 1 - (2 * U2) / (n1 * n2);            // rank-biserial, positive when a > b
  return { U: U1, U1, U2, n1, n2, z, p, method, rankBiserial: (2 * U1) / (n1 * n2) - 1, rbis, medianA: median(a), medianB: median(b) };
}

/** Wilcoxon signed-rank (zeros dropped). Exact for n <= 50 without ties, else normal with tie correction. */
export function wilcoxon(a, b = null) {
  let d = b ? a.map((v, i) => v - b[i]) : [...a];
  d = clean(d).filter((v) => v !== 0);
  const n = d.length;
  const { r, ties } = rank(d.map(Math.abs));
  let Wp = 0, Wm = 0; d.forEach((v, i) => { if (v > 0) Wp += r[i]; else Wm += r[i]; });
  const W = Math.min(Wp, Wm);
  let p, z = NaN, method;
  if (n <= 50 && ties === 0) {
    method = "exact";
    const max = (n * (n + 1)) / 2, c = new Float64Array(max + 1); c[0] = 1;
    for (let k = 1; k <= n; k++) for (let s = max; s >= k; s--) c[s] += c[s - k];
    let tail = 0; for (let s = 0; s <= W; s++) tail += c[s];
    p = Math.min(1, (2 * tail) / 2 ** n);
  } else {
    method = "asymptotic";
    const mu = (n * (n + 1)) / 4, s = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - ties / 48);
    z = (W - mu) / s;
    p = Math.min(1, 2 * normCdf(z));
  }
  const total = (n * (n + 1)) / 2;
  return { W, Wplus: Wp, Wminus: Wm, n, z, p, method, rankBiserial: (Wp - Wm) / total };
}

export function kruskalWallis(groups) {
  const g = groups.map(clean).filter((x) => x.length);
  const all = g.flat(), N = all.length, { r, ties } = rank(all);
  let off = 0, H = 0;
  for (const x of g) { const R = sum(r.slice(off, off + x.length)); H += (R * R) / x.length; off += x.length; }
  H = (12 / (N * (N + 1))) * H - 3 * (N + 1);
  H /= 1 - ties / (N ** 3 - N);
  const df = g.length - 1;
  return { H, df, p: chi2Sf(H, df), N, epsilon2: H / ((N * N - 1) / (N + 1)) };
}

/** Friedman test on an n x k matrix (rows = subjects). */
export function friedman(Y) {
  const rows = Y.filter((r) => r.every(isNum)), n = rows.length, k = rows[0].length;
  const R = new Array(k).fill(0); let T = 0;
  for (const row of rows) { const { r, ties } = rank(row); r.forEach((v, j) => (R[j] += v)); T += ties; }
  let Q = (12 / (n * k * (k + 1))) * sum(R.map((v) => v * v)) - 3 * n * (k + 1);
  Q /= 1 - T / (n * (k ** 3 - k));
  return { Q, df: k - 1, p: chi2Sf(Q, k - 1), n, kendallW: Q / (n * (k - 1)) };
}

/* ------------------------------------------------------------------ *
 * ANOVA family
 * ------------------------------------------------------------------ */

export function anovaOneWay(groups) {
  const g = groups.map(clean).filter((x) => x.length);
  const all = g.flat(), N = all.length, k = g.length, gm = mean(all);
  let ssb = 0, ssw = 0;
  for (const x of g) { const m = mean(x); ssb += x.length * (m - gm) ** 2; for (const v of x) ssw += (v - m) ** 2; }
  const df1 = k - 1, df2 = N - k, msb = ssb / df1, msw = ssw / df2, F = msb / msw;
  return { F, df1, df2, p: fSf(F, df1, df2), ssb, ssw, msb, msw, eta2: ssb / (ssb + ssw), omega2: (ssb - df1 * msw) / (ssb + ssw + msw), N, k };
}

/** Welch's ANOVA (unequal variances). */
export function welchAnova(groups) {
  const g = groups.map(clean).filter((x) => x.length > 1), k = g.length;
  const w = g.map((x) => x.length / variance(x)), m = g.map(mean), W = sum(w);
  const mw = sum(w.map((wi, i) => wi * m[i])) / W;
  const A = sum(w.map((wi, i) => wi * (m[i] - mw) ** 2)) / (k - 1);
  const lam = sum(w.map((wi, i) => (1 - wi / W) ** 2 / (g[i].length - 1)));
  const B = 1 + ((2 * (k - 2)) / (k * k - 1)) * lam;
  const F = A / B, df1 = k - 1, df2 = (k * k - 1) / (3 * lam);
  return { F, df1, df2, p: fSf(F, df1, df2) };
}

/** Post hoc pairs after a one-way ANOVA: Tukey HSD, Games-Howell, and Holm / Bonferroni t. */
export function postHocOneWay(groups, names) {
  const g = groups.map(clean), k = g.length, a = anovaOneWay(g);
  const out = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
    const xi = g[i], xj = g[j], ni = xi.length, nj = xj.length, d = mean(xi) - mean(xj);
    const se = Math.sqrt((a.msw / 2) * (1 / ni + 1 / nj));
    const q = Math.abs(d) / se, t = d / Math.sqrt(a.msw * (1 / ni + 1 / nj));
    const vi = variance(xi) / ni, vj = variance(xj) / nj;
    const dfgh = (vi + vj) ** 2 / (vi ** 2 / (ni - 1) + vj ** 2 / (nj - 1));
    const qgh = Math.abs(d) / Math.sqrt((vi + vj) / 2);
    out.push({
      a: names ? names[i] : i, b: names ? names[j] : j, diff: d, se: Math.sqrt(a.msw * (1 / ni + 1 / nj)), t,
      pTukey: tukeySf(q, k, a.df2), pGamesHowell: tukeySf(qgh, k, dfgh), pRaw: tP2(t, a.df2),
      d: d / Math.sqrt(a.msw),
    });
  }
  const raw = out.map((o) => o.pRaw), holm = pAdjust(raw, "holm"), bonf = pAdjust(raw, "bonferroni");
  out.forEach((o, i) => { o.pHolm = holm[i]; o.pBonferroni = bonf[i]; });
  return out;
}

/* ------------------------------------------------------------------ *
 * Linear algebra: least squares by Householder QR
 * ------------------------------------------------------------------ */

/** Solve min ||X b - y|| for one or several right-hand sides. X: n x p (array of rows). Y: n x q.
 *  Returns { beta (p x q), resid (n x q), sse (q), rank, XtXinv (p x p) }. Rank-deficient
 *  columns get beta 0. */
export function lstsq(X, Y) {
  const n = X.length, p = X[0].length, q = Y[0].length;
  const A = X.map((r) => Float64Array.from(r)), B = Y.map((r) => Float64Array.from(r));
  const piv = [], keep = new Array(p).fill(false), tau = [];
  let row = 0;
  for (let j = 0; j < p && row < n; j++) {
    let nrm = 0; for (let i = row; i < n; i++) nrm += A[i][j] * A[i][j];
    nrm = Math.sqrt(nrm);
    let colScale = 0; for (let i = 0; i < n; i++) colScale += X[i][j] * X[i][j];
    if (nrm <= 1e-10 * Math.sqrt(colScale + 1e-300) || nrm < 1e-12) continue;   // dependent column
    const alpha = A[row][j] > 0 ? -nrm : nrm;
    const v = new Float64Array(n); for (let i = row; i < n; i++) v[i] = A[i][j];
    v[row] -= alpha;
    let vn = 0; for (let i = row; i < n; i++) vn += v[i] * v[i];
    if (vn > 0) {
      for (let c = j; c < p; c++) { let s = 0; for (let i = row; i < n; i++) s += v[i] * A[i][c]; s = (2 * s) / vn; for (let i = row; i < n; i++) A[i][c] -= s * v[i]; }
      for (let c = 0; c < q; c++) { let s = 0; for (let i = row; i < n; i++) s += v[i] * B[i][c]; s = (2 * s) / vn; for (let i = row; i < n; i++) B[i][c] -= s * v[i]; }
    }
    piv.push(j); keep[j] = true; tau.push(row); row++;
  }
  const r = piv.length;
  // back substitution on the r x r upper triangle R[t][piv[s]]
  const beta = Array.from({ length: p }, () => new Float64Array(q));
  for (let c = 0; c < q; c++) {
    for (let t = r - 1; t >= 0; t--) {
      let s = B[t][c];
      for (let u = t + 1; u < r; u++) s -= A[t][piv[u]] * beta[piv[u]][c];
      beta[piv[t]][c] = s / A[t][piv[t]];
    }
  }
  const sse = new Float64Array(q);
  for (let c = 0; c < q; c++) { let s = 0; for (let i = r; i < n; i++) s += B[i][c] * B[i][c]; sse[c] = s; }
  // (X'X)^-1 restricted to kept columns: R^-1 R^-T
  const Rinv = Array.from({ length: r }, () => new Float64Array(r));
  for (let t = r - 1; t >= 0; t--) {
    Rinv[t][t] = 1 / A[t][piv[t]];
    for (let u = t + 1; u < r; u++) { let s = 0; for (let w = t + 1; w <= u; w++) s += A[t][piv[w]] * Rinv[w][u]; Rinv[t][u] = -s / A[t][piv[t]]; }
  }
  const XtXinv = Array.from({ length: p }, () => new Float64Array(p));
  for (let a = 0; a < r; a++) for (let b = 0; b < r; b++) {
    let s = 0; for (let w = Math.max(a, b); w < r; w++) s += Rinv[a][w] * Rinv[b][w];
    XtXinv[piv[a]][piv[b]] = s;
  }
  return { beta, sse, rank: r, XtXinv, keep };
}

export function matMul(X, B) {
  return X.map((row) => { const q = B[0].length, o = new Float64Array(q); row.forEach((x, j) => { if (x) for (let c = 0; c < q; c++) o[c] += x * B[j][c]; }); return o; });
}

/* ------------------------------------------------------------------ *
 * General linear model with type III sums of squares
 *
 * Factors are effect (sum-to-zero) coded so the type III tests are the ones
 * SPSS's UNIANOVA and JASP print. Covariates are centred.
 * ------------------------------------------------------------------ */

export function levelsOf(v) {
  const s = [...new Set(v.filter((x) => x != null && x !== ""))];
  return s.every((x) => isNum(+x)) ? s.sort((a, b) => +a - +b) : s.sort();
}

/**
 * Design matrix for a model.
 * terms: array of { name, factors: [factorName...], covariate?: name } -- a term is
 *   a product of factors (effect-coded) and at most one covariate.
 * data: { factorName: [...], covName: [...] }, all the same length (complete cases).
 */
export function designMatrix(data, n, terms, levels) {
  const cols = [{ term: "(Intercept)", v: new Float64Array(n).fill(1) }];
  const coding = {};
  for (const [f, lv] of Object.entries(levels)) {
    coding[f] = lv.slice(0, -1).map((L) => Float64Array.from(data[f], (x) => (x === L ? 1 : x === lv[lv.length - 1] ? -1 : 0)));
  }
  for (const term of terms) {
    let blocks = [new Float64Array(n).fill(1)];
    for (const f of term.factors || []) {
      const next = [];
      for (const b of blocks) for (const c of coding[f]) next.push(b.map((v, i) => v * c[i]));
      blocks = next;
    }
    for (const cv of term.covariates || []) {
      const x = data[cv], m = mean(x);
      blocks = blocks.map((b) => b.map((v, i) => v * (x[i] - m)));
    }
    for (const b of blocks) cols.push({ term: term.name, v: b });
  }
  const X = Array.from({ length: n }, (_, i) => cols.map((c) => c.v[i]));
  return { X, colTerms: cols.map((c) => c.term) };
}

/** Fit y ~ terms and return the type III table. Y may hold several columns (used by SPM). */
export function glm(data, n, terms, levels, Y) {
  const { X, colTerms } = designMatrix(data, n, terms, levels);
  const full = lstsq(X, Y);
  const dfe = n - full.rank, q = Y[0].length;
  const rows = [];
  for (const term of terms) {
    const keepCols = colTerms.map((t) => t !== term.name);
    const Xr = X.map((r) => r.filter((_, j) => keepCols[j]));
    const red = lstsq(Xr, Y);
    const df = full.rank - red.rank;
    const ss = Float64Array.from({ length: q }, (_, c) => Math.max(0, red.sse[c] - full.sse[c]));
    rows.push({ term: term.name, df, ss });
  }
  return { rows, sse: full.sse, dfe, full, X, colTerms };
}

/** Univariate ANOVA / ANCOVA table for one dependent variable. */
export function anovaTable(data, n, terms, levels, y) {
  const g = glm(data, n, terms, levels, y.map((v) => [v]));
  const mse = g.sse[0] / g.dfe;
  let sst = 0; const my = mean(y); for (const v of y) sst += (v - my) ** 2;
  const rows = g.rows.map((r) => {
    const F = r.ss[0] / r.df / mse;
    return { term: r.term, ss: r.ss[0], df: r.df, ms: r.ss[0] / r.df, F, p: fSf(F, r.df, g.dfe),
      partialEta2: r.ss[0] / (r.ss[0] + g.sse[0]), eta2: r.ss[0] / sst,
      omega2: (r.ss[0] - r.df * mse) / (sst + mse) };
  });
  rows.push({ term: "Residuals", ss: g.sse[0], df: g.dfe, ms: mse });
  return { rows, mse, dfe: g.dfe, sst, r2: 1 - g.sse[0] / sst, resid: residualsOf(g, y) };
}

function residualsOf(g, y) {
  const fit = matMul(g.X, g.full.beta);
  return y.map((v, i) => v - fit[i][0]);
}

/** Estimated marginal means for one factor (other factors averaged equally, covariates at their mean). */
export function marginalMeans(data, n, terms, levels, y, factor) {
  const { X, colTerms } = designMatrix(data, n, terms, levels);
  const fit = lstsq(X, y.map((v) => [v]));
  const lv = levels[factor], idx = colTerms.map((t, j) => [t, j]).filter(([t]) => t === factor).map(([, j]) => j);
  const mse = fit.sse[0] / (n - fit.rank);
  return lv.map((L, li) => {
    const c = new Float64Array(X[0].length); c[0] = 1;
    idx.forEach((j, k) => { c[j] = li === lv.length - 1 ? -1 : li === k ? 1 : 0; });
    let est = 0; for (let j = 0; j < c.length; j++) est += c[j] * fit.beta[j][0];
    let v = 0; for (let a = 0; a < c.length; a++) for (let b = 0; b < c.length; b++) v += c[a] * c[b] * fit.XtXinv[a][b];
    const se = Math.sqrt(v * mse), tc = tInv(0.975, n - fit.rank);
    return { level: L, mean: est, se, ci95: [est - tc * se, est + tc * se] };
  });
}

/* ------------------------------------------------------------------ *
 * Repeated measures and mixed ANOVA (multivariate approach)
 *
 * Y: n x k (rows = subjects, columns = levels of the within factor),
 * group: optional between-subject labels. Orthonormal polynomial-free
 * Helmert contrasts give the within effects; the between effect is tested on
 * the subject means. This is exactly SPSS GLM / JASP for one within and one
 * between factor, balanced or not.
 * ------------------------------------------------------------------ */

export function helmert(k) {
  const C = [];
  for (let j = 1; j < k; j++) {
    const c = new Array(k).fill(0);
    for (let i = 0; i < j; i++) c[i] = 1;
    c[j] = -j;
    const nrm = Math.sqrt(sum(c.map((v) => v * v)));
    C.push(c.map((v) => v / nrm));
  }
  return C;            // (k-1) x k
}

function det(M) {
  const n = M.length, A = M.map((r) => [...r]); let d = 1;
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-300) return 0;
    if (p !== i) { [A[p], A[i]] = [A[i], A[p]]; d = -d; }
    d *= A[i][i];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; }
  }
  return d;
}

export function rmAnova(Yraw, groupRaw = null) {
  const keep = Yraw.map((r, i) => r.every(isNum) && (!groupRaw || (groupRaw[i] != null && groupRaw[i] !== "")));
  const Y = Yraw.filter((_, i) => keep[i]), group = groupRaw ? groupRaw.filter((_, i) => keep[i]) : null;
  const n = Y.length, k = Y[0].length, C = helmert(k), p = k - 1;
  const Z = Y.map((r) => C.map((c) => sum(c.map((w, j) => w * r[j]))));
  const levels = group ? { G: levelsOf(group) } : {};
  const data = group ? { G: group } : {};
  const terms = group ? [{ name: "G", factors: ["G"] }] : [];
  // within part: Z ~ 1 (+ G). Intercept SS = time effect, G SS = time x group.
  const { X, colTerms } = designMatrix(data, n, terms, levels);
  const full = lstsq(X, Z);
  const dfeS = n - full.rank;
  const intRed = lstsq(X.map((r) => r.slice(1)), Z);
  const ssTime = sum([...Array(p).keys()].map((c) => intRed.sse[c] - full.sse[c]));
  const sseW = sum(full.sse);
  let ssTxG = 0, dfG = 0;
  if (group) {
    const red = lstsq(X.map((r) => r.filter((_, j) => colTerms[j] !== "G")), Z);
    ssTxG = sum([...Array(p).keys()].map((c) => red.sse[c] - full.sse[c]));
    dfG = full.rank - red.rank;
  }
  // residual covariance of the contrasts -> sphericity
  const fit = matMul(X, full.beta);
  const S = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) S[a][b] += ((Z[i][a] - fit[i][a]) * (Z[i][b] - fit[i][b])) / dfeS;
  const tr = sum(S.map((r, i) => r[i]));
  let tr2 = 0; for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) tr2 += S[a][b] * S[b][a];
  const gg = (tr * tr) / (p * tr2);
  const hf = Math.min(1, (n * p * gg - 2) / (p * (dfeS - p * gg)) * (group ? 1 : 1));
  // Huynh-Feldt with groups (Lecoutre correction): ((N - g + 1) p eps - 2) / (p (N - g - p eps))
  const ng = group ? levels.G.length : 1;
  const hfL = Math.min(1, ((n - ng + 1) * p * gg - 2) / (p * (n - ng - p * gg)));
  let mauchly = null;
  if (p > 1) {
    const W = det(S) / (tr / p) ** p;
    const f = 1 - (2 * p * p + p + 2) / (6 * p * dfeS);
    const chi = -dfeS * f * Math.log(W), df = (p * (p + 1)) / 2 - 1;
    mauchly = { W, chi2: chi, df, p: chi2Sf(chi, df) };
  }
  const dfTime = p, dfErr = dfeS * p, mse = sseW / dfErr;
  const row = (name, ss, df) => {
    const F = ss / df / mse;
    const mk = (e) => ({ df1: df * e, df2: dfErr * e, p: fSf(F, df * e, dfErr * e) });
    return { term: name, ss, df, ms: ss / df, F, p: fSf(F, df, dfErr), gg: mk(gg), hf: mk(hfL), partialEta2: ss / (ss + sseW) };
  };
  const within = [row("within", ssTime, dfTime)];
  if (group) within.push(row("within × group", ssTxG, dfG * p));
  within.push({ term: "Residuals (within)", ss: sseW, df: dfErr, ms: mse });
  // between part: subject means
  let between = null;
  if (group) {
    const m = Y.map((r) => [mean(r) * Math.sqrt(k)]);
    const bfull = lstsq(X, m), bred = lstsq(X.map((r) => r.filter((_, j) => colTerms[j] !== "G")), m);
    const ss = bred.sse[0] - bfull.sse[0], dfb = n - bfull.rank, mseB = bfull.sse[0] / dfb, F = ss / dfG / mseB;
    between = [{ term: "group", ss, df: dfG, ms: ss / dfG, F, p: fSf(F, dfG, dfb), partialEta2: ss / (ss + bfull.sse[0]) },
      { term: "Residuals (between)", ss: bfull.sse[0], df: dfb, ms: mseB }];
  }
  return { n, k, within, between, epsilonGG: gg, epsilonHF: hfL, mauchly, levelsG: levels.G || null };
}

/* ------------------------------------------------------------------ *
 * Correlation, regression, contingency
 * ------------------------------------------------------------------ */

export function pearson(xr, yr) {
  const pr = xr.map((v, i) => [v, yr[i]]).filter(([a, b]) => isNum(a) && isNum(b));
  const x = pr.map((p) => p[0]), y = pr.map((p) => p[1]), n = x.length;
  const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const r = sxy / Math.sqrt(sxx * syy), df = n - 2, t = (r * Math.sqrt(df)) / Math.sqrt(Math.max(1e-300, 1 - r * r));
  const z = Math.atanh(r), se = 1 / Math.sqrt(n - 3);
  return { r, n, t, df, p: tP2(t, df), ci95: [Math.tanh(z - 1.959963985 * se), Math.tanh(z + 1.959963985 * se)] };
}

export function spearman(xr, yr) {
  const pr = xr.map((v, i) => [v, yr[i]]).filter(([a, b]) => isNum(a) && isNum(b));
  const res = pearson(rank(pr.map((p) => p[0])).r, rank(pr.map((p) => p[1])).r);
  return { rho: res.r, n: res.n, p: res.p, t: res.t, df: res.df };
}

/** Multiple linear regression y ~ x1 + x2 + ... (numeric predictors). */
export function linearRegression(yr, Xcols, names) {
  const ok = yr.map((v, i) => isNum(v) && Xcols.every((c) => isNum(c[i])));
  const y = yr.filter((_, i) => ok[i]), Xs = Xcols.map((c) => c.filter((_, i) => ok[i])), n = y.length, p = Xs.length + 1;
  const X = y.map((_, i) => [1, ...Xs.map((c) => c[i])]);
  const fit = lstsq(X, y.map((v) => [v]));
  const dfe = n - fit.rank, mse = fit.sse[0] / dfe, my = mean(y);
  const sst = sum(y.map((v) => (v - my) ** 2)), r2 = 1 - fit.sse[0] / sst;
  const tc = tInv(0.975, dfe), sy = sd(y);
  const coefs = ["(Intercept)", ...names].map((nm, j) => {
    const b = fit.beta[j][0], se = Math.sqrt(fit.XtXinv[j][j] * mse), t = b / se;
    return { term: nm, b, se, t, p: tP2(t, dfe), ci95: [b - tc * se, b + tc * se], beta: j ? (b * sd(Xs[j - 1])) / sy : NaN };
  });
  // VIF: 1 / (1 - R^2 of each predictor on the others)
  coefs.slice(1).forEach((c, j) => {
    if (Xs.length < 2) { c.vif = 1; return; }
    const others = Xs.filter((_, q) => q !== j);
    const Xo = Xs[j].map((_, i) => [1, ...others.map((o) => o[i])]);
    const f = lstsq(Xo, Xs[j].map((v) => [v])), m = mean(Xs[j]);
    c.vif = 1 / (fit && f.sse[0] / sum(Xs[j].map((v) => (v - m) ** 2)));
  });
  const fitted = matMul(X, fit.beta).map((r) => r[0]), resid = y.map((v, i) => v - fitted[i]);
  let dw = 0; for (let i = 1; i < n; i++) dw += (resid[i] - resid[i - 1]) ** 2;
  dw /= fit.sse[0];
  const df1 = fit.rank - 1, F = (sst - fit.sse[0]) / df1 / mse;
  return { n, r2, adjR2: 1 - (1 - r2) * (n - 1) / dfe, R: Math.sqrt(r2), F, df1, df2: dfe, p: fSf(F, df1, dfe),
    rmse: Math.sqrt(mse), coefs, resid, fitted, durbinWatson: dw, shapiroResid: shapiroWilk(resid) };
}

/** Pearson chi-square test of independence, with Cramer's V and Fisher's exact p for 2 x 2. */
export function chiSquare(a, b) {
  const ok = a.map((v, i) => v != null && v !== "" && b[i] != null && b[i] !== "");
  const A = a.filter((_, i) => ok[i]), B = b.filter((_, i) => ok[i]), N = A.length;
  const ra = levelsOf(A), rb = levelsOf(B);
  const O = ra.map((x) => rb.map((y) => A.filter((v, i) => v === x && B[i] === y).length));
  const rs = O.map((r) => sum(r)), cs = rb.map((_, j) => sum(O.map((r) => r[j])));
  let chi = 0, low = 0;
  const E = O.map((r, i) => r.map((_, j) => { const e = (rs[i] * cs[j]) / N; if (e < 5) low++; return e; }));
  O.forEach((r, i) => r.forEach((o, j) => { chi += (o - E[i][j]) ** 2 / E[i][j]; }));
  const df = (ra.length - 1) * (rb.length - 1);
  const out = { rows: ra, cols: rb, O, E, chi2: chi, df, p: chi2Sf(chi, df), N, cramerV: Math.sqrt(chi / (N * (Math.min(ra.length, rb.length) - 1))), lowExpected: low / (ra.length * rb.length) };
  if (ra.length === 2 && rb.length === 2) out.fisherP = fisherExact2x2(O);
  return out;
}

function fisherExact2x2([[a, b], [c, d]]) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const lp = (x) => lgamma(r1 + 1) + lgamma(r2 + 1) + lgamma(c1 + 1) + lgamma(n - c1 + 1) - lgamma(n + 1) - lgamma(x + 1) - lgamma(r1 - x + 1) - lgamma(c1 - x + 1) - lgamma(r2 - c1 + x + 1);
  const p0 = lp(a); let p = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) { const v = lp(x); if (v <= p0 + 1e-7) p += Math.exp(v); }
  return Math.min(1, p);
}

/* ------------------------------------------------------------------ *
 * Formatting helpers shared by the UI and the exports
 * ------------------------------------------------------------------ */

export function fmtP(p) {
  if (!Number.isFinite(p)) return "–";
  if (p < 0.001) return "< .001";
  return p.toFixed(3).replace(/^0/, "");
}
export function fmt(v, d = 3) {
  if (v == null || (typeof v === "number" && !Number.isFinite(v))) return "–";
  if (typeof v !== "number") return String(v);
  if (v !== 0 && (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3)) return v.toExponential(2);
  return v.toFixed(d);
}
