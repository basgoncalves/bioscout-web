/**
 * The football kick.
 *
 *   node tests/test_kick.mjs
 *
 * A side-on figure (facing +x) stands, swings its right leg back and through
 * fast while the left foot stays planted, follows through, and puts the foot
 * down; then a second kick with the left leg. Also a "run": both feet swing
 * in turn while the hips travel, which must not be called a kick.
 */
import { analyse } from "../src/kinematics.js";

let bad = 0;
const ok = (c, m, extra = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`); if (!c) bad++; };
const FPS = 60, FLOOR = 1000, THIGH = 180, SHANK = 180, HIPH = THIGH + SHANK;
const rad = (d) => (d * Math.PI) / 180;

/* hip flexion (+ forward) and knee flexion, per leg, in degrees, body at x. */
function pose(x, legs) {
  const hip = [x, FLOOR - HIPH], sh = [x, FLOOR - HIPH - 260];
  const lm = { nose: [x + 25, sh[1] - 60], left_ear: [x, sh[1] - 60], right_ear: [x, sh[1] - 60],
               left_shoulder: sh, right_shoulder: sh, left_hip: hip, right_hip: hip,
               left_elbow: [x, sh[1] + 120], right_elbow: [x, sh[1] + 120], left_wrist: [x, sh[1] + 230], right_wrist: [x, sh[1] + 230] };
  for (const [side, [hf, kf]] of Object.entries(legs)) {
    const kn = [hip[0] + THIGH * Math.sin(rad(hf)), hip[1] + THIGH * Math.cos(rad(hf))];
    const sa = rad(hf - kf);
    const an = [kn[0] + SHANK * Math.sin(sa), kn[1] + SHANK * Math.cos(sa)];
    lm[side + "_knee"] = kn; lm[side + "_ankle"] = an; lm[side + "_heel"] = [an[0] - 15, an[1]];
    lm[side + "_foot_index"] = [an[0] + 45 * Math.cos(sa), an[1] - 45 * Math.sin(sa) * 0 + 5];
  }
  return lm;
}
const stand = [0, 0];
/* One kick of leg `sd` over ~0.9 s: back (hip -30, knee 100), then through to hip +70 knee 10 in 0.1 s. */
function kickFrames(sd) {
  const out = [], other = sd === "left" ? "right" : "left";
  const key = (t) => {
    if (t < 0.4) { const f = t / 0.4; return [-30 * f, 100 * f]; }                    // backswing
    if (t < 0.5) { const f = (t - 0.4) / 0.1; return [-30 + 100 * f, 100 - 90 * f]; } // the strike
    if (t < 0.9) { const f = (t - 0.5) / 0.4; return [70 - 70 * f, 10 - 10 * f]; }    // follow, back down
    return stand;
  };
  for (let k = 0; k < 1.4 * FPS; k++) out.push(pose(500, { [sd]: key(k / FPS), [other]: stand }));
  return out;
}
const still = (n) => Array.from({ length: n }, () => pose(500, { left: stand, right: stand }));
const frames = [...still(30), ...kickFrames("right"), ...still(40), ...kickFrames("left"), ...still(30)];
const poses = Object.fromEntries(frames.map((lm, i) => [i, lm]));
const res = analyse(poses, FPS, { heightM: 1.8, activity: "kick" });
ok(res.reps.length === 2, "two kicks found", `got ${res.reps.length}`);
if (res.reps.length === 2) {
  const [a, b] = res.reps;
  ok(a.kick_side === "r" && b.kick_side === "l", "kicking legs right then left", `${a.kick_side} ${b.kick_side}`);
  ok(a.foot_speed_ms > 5, "foot speed in m/s is a kick's", `${a.foot_speed_ms} m/s`);
  ok(Math.abs(a.ball_speed_est_ms / a.foot_speed_ms - 1.25) < 0.02, "ball estimate = 1.25 x foot");
  ok(a.backswing_knee_flex_deg > 80, "backswing knee flexion seen", `${a.backswing_knee_flex_deg}`);
  ok(a.knee_ext_vel_dps > 500, "knee whips straight", `${a.knee_ext_vel_dps} deg/s`);
  ok(a.follow_hip_flex_deg > 50, "follow-through height", `${a.follow_hip_flex_deg}`);
  ok(Math.abs(a.support_knee_flex_deg) < 10, "support knee near straight", `${a.support_knee_flex_deg}`);
}
// running on the spot -> travelling: both legs cycle while the body moves 3 m/s
const run = [];
for (let k = 0; k < 3 * FPS; k++) {
  const t = k / FPS, ph = 2 * Math.PI * 1.5 * t;
  run.push(pose(200 + 3 * 200 * t, { right: [40 * Math.sin(ph), 60 + 50 * Math.sin(ph - 1)], left: [-40 * Math.sin(ph), 60 - 50 * Math.sin(ph - 1)] }));
}
const rr = analyse(Object.fromEntries(run.map((lm, i) => [i, lm])), FPS, { heightM: 1.8, activity: "kick" });
ok(rr.reps.length === 0, "a run is not a kick", `got ${rr.reps.length}`);
console.log(bad ? `\n${bad} failed` : "\nall ok");
process.exit(bad ? 1 : 0);
