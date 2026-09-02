/**
 * Verify the shipped force model in the browser's own forward pass.
 *
 *   node test_force_model.mjs
 *
 * The model this replaced was exported from a BatchNorm network as bare
 * W1 b1 W2 b2, so the file that shipped was not the network that was trained.
 * Nothing caught it, because nothing ever compared the two. This does:
 * `ref.json` carries inputs and the predictions Python makes from the pickled
 * weights, and this test requires forces.js to reproduce them.
 *
 * Regenerate ref.json from the FAIS repo:
 *   python -m machine_learning.export_json --model ... --out force_model.json
 *   python -m machine_learning.reference   --model ... --out web/ref.json
 */
import { readFileSync, existsSync } from "node:fs";

globalThis.fetch = async (u) => ({ json: async () => JSON.parse(readFileSync(u, "utf8")) });
const { loadForceModel, predictForces, selfTest, peakJRF } = await import("./forces.js");

const m = await loadForceModel("force_model.json");
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) failed++; };

console.log(`model: ${m.info}\n       ${m.provenance}\n`);

const st = selfTest(m);
check(st.plausible,
  `training mean predicts ${st.peakMuscleBW.toFixed(2)} BW peak muscle force (< 12 BW)`);

check(m.muscles.length === 80, `${m.muscles.length} muscle outputs`);
check(m.jrfMagnitudes.length === 6, `${m.jrfMagnitudes.length} joint reaction magnitudes`);
check(m.units === "bodyweight", `outputs in ${m.units}`);

// A pose held still: no velocity, no acceleration. Forces must stay small --
// a static stance is roughly bodyweight, not a sprint.
const still = {};
for (const f of m.feat) if (f.startsWith("q_")) still[f.slice(2)] = new Array(40).fill(0);
const s = predictForces(m, still, 40, { massKg: 80, heightM: 1.8, fps: 100 });
const peakStill = Math.max(...s.forces.flatMap((r) => [...r].map(Math.abs)));
check(peakStill < 5000, `all-zero pose held still peaks at ${peakStill.toFixed(0)} N`);

// Sigma sweeps: the specific failure of the old model, which went from
// 1,110 N to 32,583 N when one input moved one standard deviation.
for (const coord of ["knee_angle_r", "hip_flexion_r", "ankle_angle_r"]) {
  const j = m.feat.indexOf(`q_${coord}`);
  for (const k of [1, 2, 3]) {
    const c = {};
    for (const f of m.feat) if (f.startsWith("q_")) {
      const name = f.slice(2);
      c[name] = new Array(40).fill(m.xMean[m.feat.indexOf(f)]);
    }
    c[coord] = new Array(40).fill(m.xMean[j] + k * m.xStd[j]);
    const p = predictForces(m, c, 40, { massKg: 80, heightM: 1.8, fps: 100 });
    const peak = Math.max(...p.forces.flatMap((r) => [...r].map(Math.abs)));
    check(peak < 12 * 80 * 9.80665, `${coord} +${k}σ peaks at ${peak.toFixed(0)} N`);
  }
}

// Python parity, if a reference is present.
if (existsSync("ref.json")) {
  const ref = JSON.parse(readFileSync("ref.json", "utf8"));
  const out = predictForces(m, ref.coords, ref.times.length,
    { massKg: ref.mass, heightM: ref.height, times: ref.times });
  let worst = 0;
  for (let t = 0; t < ref.times.length; t++)
    for (let i = 0; i < out.muscleNames.length; i++)
      worst = Math.max(worst, Math.abs(out.forces[t][i] - ref.expected_N[t][i]));
  check(worst < 1e-2, `matches the Python forward pass to ${worst.toExponential(2)} N`);
  console.log("  peak joint contact force, bodyweight: " +
    peakJRF(out.jrf, out.jrfNames).map(([n, v]) => `${n.replace("_mag", "")} ${v.toFixed(2)}`).join("  "));
} else {
  console.log("skip  ref.json absent — Python parity not checked");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
