/**
 * Assert the JavaScript port matches the Python pipeline exactly.
 *
 * Run the Python side first to produce the reference:
 *   python ../android_app/tests/dump_reference.py
 * then:
 *   node test_port.mjs
 *
 * The browser and the desktop must not disagree about how many reps you did.
 */
import fs from "node:fs";
import { analyse } from "./pullupkit.js";

const TOL = 1e-9;
const failures = [];

function check(label, a, b, tol = TOL) {
  if (a.length !== b.length) {
    failures.push(`${label}: length ${a.length} vs ${b.length}`);
    console.log(`  [FAIL] ${label.padEnd(30)} length ${a.length} vs ${b.length}`);
    return;
  }
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  const ok = d <= tol;
  if (!ok) failures.push(`${label}: max abs diff ${d.toExponential(3)}`);
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label.padEnd(30)} max|diff| = ${d.toExponential(3)}`);
}

const ref = JSON.parse(fs.readFileSync("reference.json", "utf8"));

for (const caseName of Object.keys(ref.cases)) {
  const c = ref.cases[caseName];
  console.log(`\n${caseName}  (${c.activity}, ${Object.keys(c.poses).length} frames)`);
  const got = analyse(c.poses, c.fps, { heightM: c.height_m, activity: c.activity });

  const okCount = got.reps.length === c.reps.length;
  if (!okCount) failures.push(`${caseName}: rep count ${got.reps.length} vs ${c.reps.length}`);
  console.log(`  [${okCount ? "OK  " : "FAIL"}] rep count                     ${got.reps.length} (python ${c.reps.length})`);
  check(`${caseName} px_per_m`, [got.pxPerM], [c.px_per_m], 1e-6);

  for (let i = 0; i < Math.min(got.reps.length, c.reps.length); i++) {
    const g = got.reps[i], p = c.reps[i];
    check(`rep${i + 1} bounds`, g.bounds, p.bounds, 0);
    check(`rep${i + 1} time`, g.times, p.times);
    for (const col of c.columns) {
      check(`rep${i + 1} ${col}`, g.coords[col] || [], p.coords[col] || []);
    }
  }
}

console.log("\n" + (failures.length
  ? "FAILED:\n  " + failures.join("\n  ")
  : "ALL CHECKS PASSED - browser and desktop agree exactly"));
process.exit(failures.length ? 1 : 0);
