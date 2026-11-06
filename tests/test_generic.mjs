// "Generic": the whole trial as one, no task assumed (src/kinematics.js).
import assert from "node:assert/strict";
import { ACTIVITIES, analyse } from "../src/kinematics.js";

assert.ok(ACTIVITIES.generic, "the generic activity exists");
assert.equal(ACTIVITIES.generic.wholeTrial, true);
assert.equal(ACTIVITIES.generic.phases, null, "a trial never cut into reps has no phases");

/* A side-on clip with three clear squat cycles in it. A rep finder would find
 * three; Generic must still return exactly one, spanning the whole clip. */
function clip(n = 90) {
  // A real two-link leg: the ankle is planted, the shank rotates forward and
  // the thigh folds back over it, so the knee ANGLE changes instead of the
  // whole body just translating down the image.
  const poses = {};
  const SHANK = 150, THIGH = 150, TRUNK = 200;
  for (let i = 0; i < n; i++) {
    const f = Math.max(0, Math.sin((i / n) * 3 * 2 * Math.PI));   // 0..1, three cycles
    const th = (f * 35 * Math.PI) / 180;            // shank forward from vertical
    const ph = (f * 45 * Math.PI) / 180;            // thigh back from vertical
    const ax = 200, ay = 600;
    const kx = ax + SHANK * Math.sin(th), ky = ay - SHANK * Math.cos(th);
    const hx = kx - THIGH * Math.sin(ph), hy = ky - THIGH * Math.cos(ph);
    const sx = hx, sy = hy - TRUNK;
    poses[i] = {
      left_shoulder: [sx, sy], right_shoulder: [sx + 6, sy],
      left_elbow: [sx - 5, sy + 100], right_elbow: [sx + 11, sy + 100],
      left_wrist: [sx - 7, sy + 190], right_wrist: [sx + 13, sy + 190],
      left_hip: [hx, hy], right_hip: [hx + 6, hy],
      left_knee: [kx, ky], right_knee: [kx + 6, ky],
      left_ankle: [ax, ay], right_ankle: [ax + 6, ay],
      left_heel: [ax - 15, ay + 5], right_heel: [ax - 9, ay + 5],
      left_foot_index: [ax + 55, ay], right_foot_index: [ax + 61, ay],
    };
  }
  return poses;
}
const poses = clip();
const n = Object.keys(poses).length;

const g = analyse(poses, 30, { heightM: 1.8, activity: "generic", osimModel: "gpk" });
assert.equal(g.reps.length, 1, "generic is always one rep, got " + g.reps.length);
const [b0, , b1] = g.reps[0].bounds;
assert.equal(b0, 0, "starts at the first frame");
assert.equal(b1, n - 1, "ends at the last frame — no trimming");
assert.ok(Math.abs(g.reps[0].duration_s - (n - 1) / 30) < 0.05, "covers the whole clip");

// It still measures: the point of Generic is angles without a task.
const r = g.reps[0];
assert.ok(r.knee_range_deg > 20, "knee range measured: " + r.knee_range_deg);
assert.ok(r.hip_range_deg > 10, "hip range measured: " + r.hip_range_deg);
assert.ok(Array.isArray(r.times) && r.times.length > 10, "a time base");
assert.ok(r.coords && r.coords.knee_angle_r.length === r.times.length, "angle curves");
// No phase columns invented, and no stray key from a null phase list.
assert.ok(!Object.keys(r).includes("undefined"), "no 'undefined' key");
assert.equal(r.concentric_s, undefined, "no phase times claimed");

// The same clip analysed as a squat DOES get cut into reps — so the one-rep
// result above is Generic's doing, not a clip with nothing in it.
const sq = analyse(poses, 30, { heightM: 1.8, activity: "squat", osimModel: "gpk" });
assert.ok(sq.reps.length > 1, "the squat finder sees several reps here: " + sq.reps.length);
console.log("generic ok — 1 rep over the whole clip vs", sq.reps.length, "as a squat");
