/**
 * The cervical model behind the neck-hold results (src/neckmuscles.js,
 * data/neck_muscles.json from tools/export_neck_muscles.py), and the
 * isometric-hold path through analyse().
 *
 * The solver is checked against numbers from scipy's trust-constr on the same
 * data (2026-10-01): a 6 kg sideways pull on the head costs 1.237 summed
 * squared activation with gravity, and the largest single muscle is the
 * right acromial trapezius at 83 N.
 *
 *   node tests/test_neckmuscles.mjs
 */
import { readFileSync } from "node:fs";
import * as NM from "../src/neckmuscles.js";
import { analyse } from "../src/kinematics.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const model = JSON.parse(readFileSync(new URL("../data/neck_muscles.json", import.meta.url), "utf8"));

console.log("model file");
ok(model.muscles.length === 72, "72 HYOID muscles", model.muscles.length);
ok(model.dofs.join() === "pitch2,roll2,yaw2,pitch1,roll1,yaw1", "six independent cervical coordinates");
ok(model.loadPoint.aboveT1_m > 0.12 && model.loadPoint.aboveT1_m < 0.25,
   "load point (head COM) sits a plausible height above C7/T1", model.loadPoint.aboveT1_m);
const scmL = model.muscles.find((m) => m.name === "stern_mast_L"), scmR = model.muscles.find((m) => m.name === "stern_mast");
ok(scmL.r[1] < 0 && scmR.r[1] > 0 && Math.abs(scmL.r[1] + scmR.r[1]) < 1e-6,
   "left and right SCM bend the neck opposite ways, symmetrically");

console.log("solver");
const A = [[1, 1, 0], [0, 1, 1]];
const s1 = NM.minActivation(A, [1, 1]);
ok(s1.ok && Math.abs(s1.a[0] - 1 / 3) < 1e-6 && Math.abs(s1.a[1] - 2 / 3) < 1e-6,
   "least-norm solution of a tiny system", s1.a.map((x) => x.toFixed(3)).join());
const s2 = NM.minActivation(A, [3, 3]);
ok(!s2.ok, "an infeasible demand is reported, not faked");

console.log("a sideways hold");
const h6 = NM.neckHold(model, { kg: 6, dir: "left" });
const cost = h6.muscles.reduce((s, m) => s + m.a * m.a, 0);
ok(h6.ok && Math.abs(cost - 1.237) < 0.01, "6 kg pushing left matches the scipy optimum", cost.toFixed(3));
const fmaxOf = (n) => model.muscles.find((m) => m.name === n).fmax;
ok(h6.muscles.every((m) => m.F >= -1e-9 && m.F <= fmaxOf(m.name) + 1e-6), "every muscle within 0..Fmax");
const left = h6.groups.filter((g) => g.side === "L").reduce((s, g) => s + g.F, 0);
const right = h6.groups.filter((g) => g.side === "R").reduce((s, g) => s + g.F, 0);
ok(left > right, "pushing left, the left side does more", `${left.toFixed(0)} vs ${right.toFixed(0)} N`);
ok(Math.abs(h6.moment.lateral - 6 * 9.80665 * model.loadPoint.fromT1[1]) < 1e-6,
   "side-bend moment is force x height above C7/T1", h6.moment.lateral.toFixed(2));
const hr = NM.neckHold(model, { kg: 6, dir: "right" });
ok(Math.abs(hr.moment.lateral + h6.moment.lateral) < 1e-9, "pushing right mirrors the moment");
ok(h6.capacityKg > 6 && Math.abs(h6.pct - 600 / h6.capacityKg) < 1e-6, "capacity and share are consistent",
   `${h6.capacityKg.toFixed(1)} kg`);
const big = NM.neckHold(model, { kg: 3 * h6.capacityKg, dir: "left" });
ok(!big.ok && big.pct > 250 && big.saturated > 0, "past capacity: said, and shown at the model's limit");
const fwd = NM.neckHold(model, { kg: 10, dir: "forward" });
const flexors = fwd.groups.filter((g) => ["scm", "suprahyoid", "infrahyoid", "longus", "scalenes"].includes(g.group))
  .reduce((s, g) => s + g.F, 0);
ok(fwd.ok && fwd.moment.flexion < 0 && Math.abs(fwd.moment.lateral) < 1e-9 && flexors > fwd.totalF / 2,
   "pushing forward: the load tips the head back, and the flexors hold it", `${flexors.toFixed(0)} of ${fwd.totalF.toFixed(0)} N`);

console.log("isometric hold in analyse()");
// A head held still with a few degrees of wobble, in a close-up.
const poses = {};
for (let i = 0; i < 300; i++) {
  const w = 4 * Math.sin(i / 7) + 3 * Math.sin(i / 3.1);      // degrees of roll wobble
  const a = (w * Math.PI) / 180, cx = 500, cy = 300, half = 60;
  poses[i] = {
    left_ear: [cx - half * Math.cos(a), cy - half * Math.sin(a)],
    right_ear: [cx + half * Math.cos(a), cy + half * Math.sin(a)],
    nose: [cx, cy + 20], left_shoulder: [380, 520], right_shoulder: [620, 520],
  };
}
const free = analyse(poses, 30, { activity: "neck", heightM: 1.8 });
const held = analyse(poses, 30, { activity: "neck", heightM: 1.8, hold: true });
ok(held.hold && held.reps.length === 1, "a hold is one rep", `${held.reps.length} (free: ${free.reps.length})`);
const r = held.reps[0];
ok(Math.abs(r.hold_s - 299 / 30) < 0.05, "the hold lasts the whole take", r.hold_s);
ok(r.bend_drift_deg > 2 && r.bend_drift_deg < 12 && r.bend_sd_deg > 1,
   "side-bend wobble reported as spread and drift", `sd ${r.bend_sd_deg}, drift ${r.bend_drift_deg}`);

// Facing the camera the right ear is on the image's LEFT, so the ear and
// shoulder lines both point at ~180 deg and straddle the +-180 seam. The roll
// used to wrap there to -360 and a level head read as -39 +- 18 deg.
const facing = {};
for (let i = 0; i < 120; i++) {
  const a = ((0.5 * Math.sin(i / 5)) * Math.PI) / 180;      // +-0.5 deg either side of level
  facing[i] = {
    right_ear: [440 - 60 * Math.cos(a), 300 - 60 * Math.sin(a)],
    left_ear: [440 + 60 * Math.cos(a), 300 + 60 * Math.sin(a)],
    nose: [440, 320], right_shoulder: [320, 520.5], left_shoulder: [560, 520],
  };
}
const fh = analyse(facing, 30, { activity: "neck", heightM: 1.8, hold: true }).reps[0];
ok(Math.abs(fh.bend_hold_deg) < 2 && fh.bend_drift_deg < 2,
   "a level head facing the camera holds at ~0 deg side bend", `${fh.bend_hold_deg} +- ${fh.bend_sd_deg}`);
const noSh = {};
for (const [k, v] of Object.entries(facing)) noSh[k] = { right_ear: v.right_ear, left_ear: v.left_ear, nose: v.nose };
const nh2 = analyse(noSh, 30, { activity: "neck", heightM: 1.8, hold: true }).reps[0];
ok(Math.abs(nh2.bend_hold_deg) < 2, "and without shoulders in frame", `${nh2.bend_hold_deg}`);
const fr = analyse(facing, 30, { activity: "neck", heightM: 1.8 });
ok(fr.reps.length === 0, "and is no longer cut into movements without a hold", fr.reps.length);

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log("\nall passed");
process.exit(0);
