/**
 * src/reliability.js: the six McGraw & Wong ICC forms against pingouin 0.7
 * (fixture), plus the hand-checkable identities of SEM, MDC, Bland-Altman,
 * the "<condition>-<N>" header grouping and CMC.
 *
 *   node tests/test_reliability.mjs
 */
import { readFileSync } from "node:fs";
import { icc, reliabilityOf, conditionsFromHeaders, cmc, waveformReliability } from "../src/reliability.js";

const F = JSON.parse(readFileSync(new URL("./fixtures/analysis_ref.json", import.meta.url))).icc;
let bad = 0;
const check = (name, ok, extra = "") => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); };
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));

for (const [type, [v, f, p]] of Object.entries(F.ref)) {
  const r = icc(F.Y, type);
  check(`ICC(${type}) = pingouin`, rel(r.icc, v) < 1e-9 && rel(r.F, f) < 1e-9 && rel(r.p, p) < 1e-6, JSON.stringify([r.icc, r.F, r.p, v, f, p]));
}
const conds = conditionsFromHeaders(["AB-1", "AB-2", "ER-1", "ER-2", "ER-3", "solo"]);
check("headers group into conditions", JSON.stringify(conds.map((c) => [c.name, c.cols])) === JSON.stringify([["AB", [0, 1]], ["ER", [2, 3, 4]], ["solo", [5]]]));

const Y = F.Y.map((r) => r.slice(0, 2));
const R = reliabilityOf(Y, { type: "A-1" }).overall;
check("MDC95 = 1.96 * sqrt(2) * SEM", rel(R.mdc95, 1.959963985 * Math.SQRT2 * R.sem) < 1e-12);
const d = Y.map((r) => r[1] - r[0]), mean = d.reduce((a, b) => a + b, 0) / d.length;
check("bias = mean of T2 - T1", rel(R.bias, mean) < 1e-12);
const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1));
check("limits of agreement = bias -/+ 1.96 SD", rel(R.loa[0], mean - 1.96 * sd) < 1e-12 && rel(R.loa[1], mean + 1.96 * sd) < 1e-12);
// SEM = sqrt(MSE): for two trials MSE = var(diff) / 2
check("SEM = sqrt(MSE) = SD(diff)/sqrt(2) for two trials", rel(R.sem, sd / Math.SQRT2) < 1e-12);
const Z = reliabilityOf([[1, 2], [0, 3], [2, 2], [3, 5]], { zeroIsMissing: true });
check("zero treated as missing drops that participant", Z.n === 3 && Z.excluded === 1);

const base = Array.from({ length: 51 }, (_, i) => Math.sin(i / 8));
check("CMC of identical curves = 1", Math.abs(cmc([base, base, base]) - 1) < 1e-12);
check("CMC of offset curves < 1", cmc([base, base.map((v) => v + 0.3)]) < 1);
const curves = [];
for (let s = 0; s < 8; s++) for (const ses of ["d1", "d2"]) curves.push({ subject: "s" + s, session: ses, y: Float64Array.from(base, (v, i) => v * (1 + s / 5) + s / 3 + (ses === "d2" ? 0.01 * Math.cos(i + s) : 0)) });
const W = waveformReliability(curves);
check("waveform: high ICC everywhere for near-identical sessions", Math.min(...W.icc) > 0.95, String(Math.min(...W.icc)));
check("waveform: CMC defined for every subject", W.cmcUndefined === 0 && W.cmcMean > 0.99);

console.log(bad ? `\n${bad} FAILED` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
