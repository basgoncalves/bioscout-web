/**
 * src/spm.js against spm1d 0.4.54: statistic curves, FWHM, critical threshold
 * and cluster p-values for every design the Analysis page offers (ANCOVA is
 * the GLM checked in test_stats.mjs). The fixture holds the curves and
 * spm1d's answers; the statistic curves themselves were compared to 1e-13
 * when the fixture was made and are not stored.
 *
 *   node tests/test_spm.mjs
 */
import { readFileSync } from "node:fs";
import { runSpm, normalise } from "../src/spm.js";

const D = JSON.parse(readFileSync(new URL("./fixtures/analysis_ref.json", import.meta.url))).spm, O = D.out;
let bad = 0;
const F = (a) => Float64Array.from(a), rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
function cmp(name, eff, ref) {
  const s = eff.spmi;
  const ok = rel(s.fwhm, ref.fwhm) < 1e-8 && rel(s.zstar, ref.zstar) < 1e-6 && s.clusters.length === ref.p.length && s.clusters.every((c, i) => rel(c.p, ref.p[i]) < 1e-5);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  fwhm ${s.fwhm}/${ref.fwhm} z* ${s.zstar}/${ref.zstar} p ${s.clusters.map((c) => c.p)}/${ref.p}`}`);
}
const A = D.YA.map((y, i) => ({ y: F(y), subject: i, B: "a", A: "g0" })), B = D.YB.map((y, i) => ({ y: F(y), subject: i, B: "b", A: "g1" })), C = D.YC.map((y, i) => ({ y: F(y), subject: i, B: "c", A: "g2" }));
const indep = (rows) => rows.map((r) => ({ ...r, subject: r.A + r.subject }));
cmp("one-sample t", runSpm(A, { test: "ttest" }).effects[0], O.ttest);
cmp("paired t", runSpm([...A, ...B], { test: "ttest_paired" }).effects[0], O.paired);
cmp("two-sample t", runSpm(indep([...A, ...B]), { test: "ttest2" }).effects[0], O.ttest2);
cmp("regression", runSpm(D.Yr.map((y, i) => ({ y: F(y), subject: i, cov: D.x[i] })), { test: "regress" }).effects[0], O.regress);
const all = [...A, ...B, ...C];
cmp("one-way ANOVA", runSpm(indep(all), { test: "anova1" }).effects[0], O.anova1);
cmp("RM ANOVA", runSpm(all, { test: "anova1rm" }).effects[0], O.anova1rm);
runSpm(all.map((r, i) => ({ y: r.y, A: r.A, B: i % 10 < 5 ? "x" : "y", subject: "s" + i })), { test: "anova2" }).effects.forEach((e, i) => cmp("two-way ANOVA " + e.name, e, O.anova2[i]));
runSpm(all.map((r) => ({ y: r.y, subject: r.subject, A: r.subject < 5 ? "p" : "q", B: r.B })), { test: "anova2onerm" }).effects.forEach((e, i) => cmp("mixed ANOVA " + e.name, e, O.anova2onerm[i]));

const np = runSpm(indep([...A, ...B]), { test: "ttest2", nonparam: { iterations: 1000 } }).effects[0].spmi;
const okp = np.method === "permutation" && np.clusters.length === 1 && np.clusters[0].p < 0.05 && np.zstar > 2.5 && np.zstar < 4.5;
if (!okp) bad++; console.log(`${okp ? "ok  " : "FAIL"}  permutation two-sample t finds the same cluster (t* ${np.zstar.toFixed(2)})`);
const n = normalise([0, 1, 2, 3, 4], 9);
const okn = n.length === 9 && Math.abs(n[4] - 2) < 1e-12 && Math.abs(n[8] - 4) < 1e-12;
if (!okn) bad++; console.log(`${okn ? "ok  " : "FAIL"}  time normalisation`);

console.log(bad ? `\n${bad} FAILED` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
