/**
 * Glute kick back: one leg driven back into hip extension, on all fours or
 * standing, counted per leg from a side-on clip.
 *
 * The fixtures are geometry, not footage: a thigh swung about the hip by a
 * known angle, so the numbers the analysis reports can be checked against the
 * angle that was put in. What they pin:
 *
 *   - the hip angle is SIGNED -- a thigh behind the trunk line is extension,
 *     not the same flexion mirrored (the unsigned squat angle would fold the
 *     top of every rep back onto itself);
 *   - both legs are counted from one clip, each rep with its side;
 *   - the far leg "kicking" in step with the near one (the pose model painting
 *     one leg onto the other) is one rep, not two;
 *   - the same clip mirrored left-right gives the same answer;
 *   - and, because it shares the path, the heel raise now analyses at all.
 *
 *   node tests/test_kickback.mjs
 */
import { ACTIVITIES, analyse, hipFlexSigned } from "../src/kinematics.js";
import { gradeReps } from "../src/repquality.js";
import { clipAngles } from "../src/jointmetrics.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const D = Math.PI / 180;

/* A quadruped (or standing) athlete facing +x, image y down.
 *   kicks    [{ side, from, to }] in hip flexion degrees, one after another
 *   stance   "fours" | "stand"
 *   mirror   flip the image left-right (athlete faces -x)
 *   ghost    the other leg copies the kicking leg (pose model confusion)   */
function clip({ kicks, stance = "fours", mirror = false, ghost = false,
                repF = 40, gapF = 20, W = 1280 } = {}) {
  const fours = stance === "fours";
  const hip = fours ? [500, 520] : [640, 500];
  const sh = fours ? [800, 520] : [640, 200];
  const thigh = 180, shank = 170;
  const rest = fours ? 90 : 0;
  const series = [];
  for (let i = 0; i < 30; i++) series.push(null);
  for (const k of kicks) {
    for (let i = 0; i < repF; i++) {
      const s = Math.sin(Math.PI * i / repF);
      series.push({ side: k.side, flex: k.from + (k.to - k.from) * s });
    }
    for (let i = 0; i < gapF; i++) series.push(null);
  }
  const poses = {};
  series.forEach((e, i) => {
    // Thigh direction: angle from straight down, positive toward +x; the
    // neutral (trunk continued) is hip - shoulder.
    const neutral = Math.atan2(hip[0] - sh[0], hip[1] - sh[1]);
    const knee = (flex) => {
      const a = neutral + flex * D;
      return [hip[0] + thigh * Math.sin(a), hip[1] + thigh * Math.cos(a)];
    };
    const ankle = (kn, flex) => {
      // Knee bent 90 deg on all fours, straight standing.
      const a = neutral + flex * D + (fours ? -90 * D : 0);
      return [kn[0] + shank * Math.sin(a), kn[1] + shank * Math.cos(a)];
    };
    const fl = e && (e.side === "l" || ghost) ? e.flex : rest;
    const fr = e && (e.side === "r" || ghost) ? e.flex : rest;
    const kl = knee(fl), kr = knee(fr);
    const P = (p, dx = 0) => [mirror ? W - (p[0] + dx) : p[0] + dx, p[1]];
    const head = fours ? [880, 500] : [650, 120];
    poses[i] = {
      nose: P(head, 30), left_ear: P(head, -10), right_ear: P(head, -10),
      left_shoulder: P(sh, -6), right_shoulder: P(sh, 6),
      left_hip: P(hip, -6), right_hip: P(hip, 6),
      left_knee: P(kl), right_knee: P(kr),
      left_ankle: P(ankle(kl, fl)), right_ankle: P(ankle(kr, fr)),
      left_heel: P(ankle(kl, fl), -12), right_heel: P(ankle(kr, fr), -12),
      left_foot_index: P(ankle(kl, fl), 20), right_foot_index: P(ankle(kr, fr), 20),
      left_elbow: P(fours ? [800, 640] : [620, 330]), right_elbow: P(fours ? [806, 640] : [660, 330]),
      left_wrist: P(fours ? [800, 760] : [620, 450]), right_wrist: P(fours ? [806, 760] : [660, 450]),
    };
  });
  return poses;
}

const spec = ACTIVITIES.kickback;
ok(!!spec && spec.perLeg && spec.openChain, "kickback is a per-leg, open-chain activity");

/* The signed angle itself. */
ok(near(hipFlexSigned([0, -1], [0, 0], [0, 1], 1), 0, 1e-6), "standing, thigh down: 0");
ok(near(hipFlexSigned([0, -1], [0, 0], [Math.sin(30 * D), Math.cos(30 * D)], 1), 30, 1e-6),
   "thigh forward: +30 (flexion)");
ok(near(hipFlexSigned([0, -1], [0, 0], [-Math.sin(20 * D), Math.cos(20 * D)], 1), -20, 1e-6),
   "thigh behind: -20 (extension), not +20");

/* All fours, alternating legs, 90 deg -> -15 deg. */
const alt = [];
for (let r = 0; r < 4; r++) alt.push({ side: "l", from: 90, to: -15 }, { side: "r", from: 90, to: -15 });
const fps = 30;
const res = analyse(clip({ kicks: alt }), fps, { heightM: 1.81, activity: "kickback" });
const nl = res.reps.filter((r) => r.stance_side === "l").length;
const nr = res.reps.filter((r) => r.stance_side === "r").length;
ok(!res.refused && res.reps.length === 8, "eight alternating kicks are eight reps", `${res.reps.length}`);
ok(nl === 4 && nr === 4, "four a side, each tagged with its leg", `${nl}/${nr}`);
ok(res.reps.every((r) => near(r.hip_ext_max_deg, 15, 3)),
   "peak hip extension is the 15 deg put in",
   res.reps.map((r) => r.hip_ext_max_deg).join(","));
ok(res.reps.every((r) => near(r.hip_range_deg, 105, 5)),
   "hip range is the 105 deg swung through",
   res.reps.map((r) => r.hip_range_deg).join(","));
ok(res.reps.every((r) => near(r.trunk_motion_deg, 0, 2)), "a still trunk reads as still");
ok(res.reps.every((r) => r.kick_s > 0 && r.return_s > 0), "kick and return times are filled");
ok(res.reps.every((r) => Array.isArray(r.coords.pelvis_tilt)
                         && near(r.coords.pelvis_tilt[0], -90, 3)),
   "the .mot pitches the pelvis forward on all fours", String(res.reps[0].coords.pelvis_tilt[0]));

/* All of one leg, then the other -- uneven counts stay uneven. */
const block = [];
for (let r = 0; r < 6; r++) block.push({ side: "r", from: 90, to: 0 });
for (let r = 0; r < 3; r++) block.push({ side: "l", from: 90, to: 0 });
const res2 = analyse(clip({ kicks: block }), fps, { activity: "kickback" });
ok(res2.reps.filter((r) => r.stance_side === "r").length === 6
   && res2.reps.filter((r) => r.stance_side === "l").length === 3,
   "six right then three left are counted 6 / 3");

/* Mirror image: same counts, same angles. */
const resM = analyse(clip({ kicks: alt, mirror: true }), fps, { activity: "kickback" });
ok(resM.reps.length === 8 && resM.reps.every((r) => near(r.hip_ext_max_deg, 15, 3)),
   "facing the other way gives the same reps and angles",
   resM.reps.map((r) => r.hip_ext_max_deg).join(","));

/* Ghost leg: the far leg copies the near one. One kick, not two. */
const resG = analyse(clip({ kicks: alt.slice(0, 4), ghost: true }), fps, { activity: "kickback" });
ok(resG.reps.length === 4, "a leg painted onto the other does not double the count",
   `${resG.reps.length}`);

/* Standing kick back: 0 -> -30 deg. */
const st = [];
for (let r = 0; r < 5; r++) st.push({ side: "l", from: 0, to: -30 });
const resS = analyse(clip({ kicks: st, stance: "stand" }), fps, { activity: "kickback" });
ok(resS.reps.length === 5 && resS.reps.every((r) => near(r.hip_ext_max_deg, 30, 3)),
   "standing kicks to 30 deg of extension are counted and measured",
   `${resS.reps.length}: ${resS.reps.map((r) => r.hip_ext_max_deg).join(",")}`);

/* Too small to be a rep. */
const tiny = [];
for (let r = 0; r < 5; r++) tiny.push({ side: "l", from: 90, to: 80 });
const resT = analyse(clip({ kicks: tiny }), fps, { activity: "kickback" });
ok(resT.reps.length === 0 && resT.refused === "noKickbacks",
   "a 10 deg twitch is refused, not counted", `${resT.reps.length}`);

/* Grades: a short kick in a set of full ones is not clean. */
const mixed = [];
for (let r = 0; r < 4; r++) mixed.push({ side: "l", from: 90, to: -15 });
mixed.push({ side: "l", from: 90, to: 50 });
const resQ = analyse(clip({ kicks: mixed }), fps, { activity: "kickback" });
const counts = gradeReps(resQ);
ok(resQ.reps.length === 5, "five kicks", `${resQ.reps.length}`);
ok(resQ.reps.slice(0, 4).every((r) => r.quality === "clean"), "full kicks grade clean");
ok(resQ.reps[4].quality === "poor" && resQ.reps[4].qualityNotes[0].code === "travel",
   "the short one is poor, for range", `${resQ.reps[4].quality}`);
ok(counts.clean === 4 && counts.poor === 1, "counts add up");

/* Joint metrics: the hip goes negative, and is offered per leg. */
const F = spec.features(clip({ kicks: alt }));
const ang = clipAngles("kickback", spec, F, null);
ok(Array.isArray(ang.hip_l) && Math.min(...ang.hip_l) < -10,
   "the per-joint hip angle carries extension as negative", String(Math.min(...ang.hip_l).toFixed(1)));

/* The heel raise runs through analyse() now (it threw on its reference
 * positions before). */
{
  const W = 720, H = 1280, poses = {};
  for (let i = 0; i < 30 + 8 * 60 + 30; i++) {
    const k = i - 30;
    const lift = k >= 0 && k < 480 ? 0.55 * Math.max(0, Math.sin(Math.PI * (k % 60) / 60)) : 0;
    const P = (x, y) => [x * W, y * H];
    poses[i] = { nose: P(.5, .15), left_shoulder: P(.46, .3), right_shoulder: P(.54, .3),
      left_hip: P(.47, .55), right_hip: P(.53, .55), left_knee: P(.47, .74), right_knee: P(.53, .74),
      left_ankle: P(.47, .895), right_ankle: P(.53, .895),
      left_heel: P(.455, .93 - lift * .05), right_heel: P(.515, .93 - lift * .05),
      left_foot_index: P(.505, .93), right_foot_index: P(.565, .93) };
  }
  let hr = null, err = "";
  try { hr = analyse(poses, 30, { activity: "heelraise" }); } catch (e) { err = e.message; }
  ok(hr && hr.reps.length === 16, "a heel-raise clip analyses (16 raises)", err || `${hr && hr.reps.length}`);
  ok(hr && hr.reps.every((r) => r.stance_side && r.heel_lift > 0.3),
     "each raise carries its foot and lift");
}

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
