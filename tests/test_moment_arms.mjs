/* data/moment_arms.json is what turns muscle FORCES into muscle contributions
 * to the joint MOMENT (force x arm). It is generated offline, so the only
 * thing standing between a bad table and a plot full of nonsense is this test.
 *
 * It caught the two ways the generator was wrong: raw poses left Rajagopal's
 * coupled patella at zero and the quadriceps arms came out in METRES, and a
 * wrap object switching on at deep flexion flipped the quadriceps to +19 mm,
 * i.e. into knee flexors. */
import { readFileSync } from "node:fs";

const d = JSON.parse(readFileSync(new URL("../data/moment_arms.json", import.meta.url)));
const mm = (v) => v * 1000;

for (const j of ["hip", "knee", "ankle"]) {
  const t = d.joints[j];
  if (!t) throw new Error(`no ${j} table`);
  if (!Array.isArray(t.grid) || t.grid.length < 10) throw new Error(`${j}: grid too short`);
  if (!t.grid.every((v, i) => i === 0 || v > t.grid[i - 1])) throw new Error(`${j}: grid not ascending`);
  if (!Object.keys(t.muscles).length) throw new Error(`${j}: no muscles`);
  for (const [m, a] of Object.entries(t.muscles)) {
    if (a.length !== t.grid.length) throw new Error(`${j}/${m}: ${a.length} arms for ${t.grid.length} angles`);
    if (!a.every(Number.isFinite)) throw new Error(`${j}/${m}: non-finite arm`);
    // No muscle in a human leg has a moment arm over 10 cm.
    const peak = Math.max(...a.map(Math.abs));
    if (mm(peak) > 100) throw new Error(`${j}/${m}: ${mm(peak).toFixed(0)} mm is not a moment arm`);
    // Smooth in angle: a jump means a wrap object switched, not anatomy.
    for (let i = 1; i < a.length; i++) {
      if (mm(Math.abs(a[i] - a[i - 1])) > 20) {
        throw new Error(`${j}/${m}: ${mm(Math.abs(a[i] - a[i - 1])).toFixed(0)} mm jump at ${t.grid[i]} deg`);
      }
    }
  }
}

/* Sign is OpenSim's for a flexion/dorsiflexion-positive coordinate, so an
 * extensor is negative. Getting this backwards would draw every muscle on the
 * wrong side of zero while looking perfectly plausible. */
const at = (j, m, deg) => {
  const t = d.joints[j], i = t.grid.indexOf(deg);
  if (i < 0 || !t.muscles[m]) throw new Error(`${j}/${m} missing at ${deg} deg`);
  return mm(t.muscles[m][i]);
};
const checks = [
  ["knee", "vaslat_r", 0, -60, -25, "knee extensor"],
  ["knee", "recfem_r", 0, -60, -25, "knee extensor"],
  ["knee", "semiten_r", 0, 15, 60, "knee flexor"],
  ["ankle", "soleus_r", 0, -60, -25, "plantarflexor"],
  ["ankle", "gasmed_r", 0, -60, -25, "plantarflexor"],
  ["ankle", "tibant_r", 0, 25, 60, "dorsiflexor"],
  ["hip", "glmax2_r", 0, -90, -25, "hip extensor"],
  ["hip", "iliacus_r", 0, 15, 70, "hip flexor"],
];
for (const [j, m, deg, lo, hi, what] of checks) {
  const v = at(j, m, deg);
  if (!(v >= lo && v <= hi)) throw new Error(`${j}/${m} is a ${what}: expected ${lo}..${hi} mm at ${deg} deg, got ${v.toFixed(1)}`);
}

console.log(`ok    moment arms: ${Object.keys(d.joints).map((j) => `${j} ${Object.keys(d.joints[j].muscles).length}`).join(", ")} muscles, signs and magnitudes sane`);
