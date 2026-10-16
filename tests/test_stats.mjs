/**
 * src/stats.js against scipy 1.18 / pingouin 0.7 / statsmodels.
 *
 * The reference numbers in tests/fixtures/analysis_ref.json were produced once
 * in Python from the same data and are pasted, not recomputed, so this runs
 * with node alone. A p-value on the Analysis page must be the one JASP, SPSS
 * and Python print -- that is the whole point of the page.
 *
 *   node tests/test_stats.mjs
 */
import { readFileSync } from "node:fs";
import * as S from "../src/stats.js";

const R = JSON.parse(readFileSync(new URL("./fixtures/analysis_ref.json", import.meta.url))).stats, D = R.data;
let bad = 0;
function near(name, mine, ref, tol = 1e-6) {
  mine = [mine].flat(3); ref = [ref].flat(3);
  const e = Math.max(...mine.map((v, i) => Math.abs(v - ref[i]) / Math.max(1e-12, Math.abs(ref[i]))));
  const ok = e < tol && mine.length === ref.length;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  mine ${JSON.stringify(mine)} ref ${JSON.stringify(ref)}`}`);
}

near("normal cdf / inverse", [S.normCdf(-3.1), S.normInv(1e-4), S.normInv(0.975)], R.norm);
near("t, F, chi2", [S.tCdf(2.1, 7), S.tInv(0.975, 12.5), S.fSf(3.2, 3, 17.5), S.chi2Sf(7.7, 3), S.chi2Inv(0.95, 2)], R.t);
near("studentized range", [S.tukeySf(3.5, 3, 20), S.tukeySf(4.2, 5, 9.3), S.tukeySf(2.1, 2, 100)], R.tukey, 1e-5);
near("Shapiro-Wilk n = 6, 30, 15", [D.x6, D.x30, D.a].map((x) => { const r = S.shapiroWilk(x); return [r.W, r.p]; }), R.sw);
const k = S.dagostinoK2(D.x30); near("D'Agostino K2", [k.K2, k.p], R.k2);
const l = S.levene([D.a, D.b, D.c]); near("Levene (mean)", [l.F, l.p], R.lev);
const t1 = S.tTestOneSample(D.a, 9.5); near("one-sample t", [t1.t, t1.p], R.t1);
const ti = S.tTestIndependent(D.a, D.b); near("Student t", [ti.student.t, ti.student.p], R.t2s); near("Welch t", [ti.welch.t, ti.welch.p], R.t2w);
const tp = S.tTestPaired(D.a.slice(0, 12), D.b); near("paired t", [tp.t, tp.p], R.tp);
let m = S.mannWhitney(D.s1, D.s2); near("Mann-Whitney exact", [m.U, m.p], R.mw_exact);
m = S.mannWhitney(D.a, D.b); near("Mann-Whitney asymptotic", [m.U, m.p], R.mw_asy);
const w = S.wilcoxon(D.a.slice(0, 12), D.b); near("Wilcoxon exact", [w.W, w.p], R.wx);
const kw = S.kruskalWallis([D.a, D.b, D.c]); near("Kruskal-Wallis", [kw.H, kw.p], R.kw);
const an = S.anovaOneWay([D.a, D.b, D.c]); near("one-way ANOVA", [an.F, an.p], R.anova);
const we = S.welchAnova([D.a, D.b, D.c]); near("Welch ANOVA", [we.F, we.df2, we.p], R.welch);
const ph = S.postHocOneWay([D.a, D.b, D.c]); near("Tukey HSD", ph.map((o) => o.pTukey), R.tukeyp, 1e-5); near("Games-Howell", ph.map((o) => o.pGamesHowell), R.ghp, 1e-5);
const y = [...D.a, ...D.b, ...D.c], g = [...Array(15).fill("A"), ...Array(12).fill("B"), ...Array(14).fill("C")];
const lv = { g: S.levelsOf(g), h: S.levelsOf(D.h) };
let tb = S.anovaTable({ g, h: D.h }, 41, [{ name: "g", factors: ["g"] }, { name: "h", factors: ["h"] }, { name: "g:h", factors: ["g", "h"] }], lv, y);
near("two-way ANOVA, unbalanced, type III", tb.rows.slice(0, 3).map((r) => [r.F, r.p]), R.aov2);
tb = S.anovaTable({ g, cov: D.cov }, 41, [{ name: "g", factors: ["g"] }, { name: "cov", covariates: ["cov"] }], { g: lv.g }, y);
near("ANCOVA", tb.rows.slice(0, 2).map((r) => [r.F, r.p]), R.ancova);
let rm = S.rmAnova(D.Y); near("RM ANOVA + GG", [rm.within[0].F, rm.within[0].p, rm.epsilonGG, rm.within[0].gg.p], R.rm);
near("Mauchly W", rm.mauchly.W, R.mauchly[0]);   // (pingouin 0.7's Mauchly p is off; ours is scipy's chi2.sf of its own chi2)
rm = S.rmAnova(D.Y, [..."aaaaabbbbb"]); near("mixed ANOVA", [[rm.between[0].F, rm.between[0].p], [rm.within[0].F, rm.within[0].p], [rm.within[1].F, rm.within[1].p]], R.mixed);
const fr = S.friedman(D.Y); near("Friedman", [fr.Q, fr.p], R.fried);
const pe = S.pearson(D.a.slice(0, 12), D.b); near("Pearson", [pe.r, pe.p], R.pear);
const sp = S.spearman(D.a.slice(0, 12), D.b); near("Spearman", [sp.rho, sp.p], R.spear);
const lr = S.linearRegression(D.b, [D.a.slice(0, 12), D.c.slice(0, 12)], ["a", "c"]);
near("OLS", [lr.r2, lr.F, lr.p, ...lr.coefs.map((c) => c.b), ...lr.coefs.map((c) => c.p)], R.ols);
const A = [], B = [];
[[8, "x", "u"], [3, "x", "v"], [2, "y", "u"], [9, "y", "v"]].forEach(([n, p, q]) => { for (let i = 0; i < n; i++) { A.push(p); B.push(q); } });
const ch = S.chiSquare(A, B); near("chi-square + Fisher", [ch.chi2, ch.p, ch.fisherP], [...R.chi, R.fisher]);

console.log(bad ? `\n${bad} FAILED` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
