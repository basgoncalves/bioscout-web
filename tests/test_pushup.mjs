/**
 * Push-ups.
 *
 *   node tests/test_pushup.mjs
 *
 * Geometry, not footage: a body lying along the floor, pivoting at the toes,
 * lowered and raised on two arms whose hands stay put. What is tested is the
 * decision rule -- that push-ups are counted, that an upright clip is refused,
 * and that depth comes from the shoulders and a sagging body is noticed.
 */
import { buildPushupFeatures, findPushupReps, DEFAULT_PUSHUP_CFG, ACTIVITIES, analyse }
  from "../src/kinematics.js";
import { gradeReps } from "../src/repquality.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};

const T = 180;                 // torso (shoulder-hip) in px
const LEG = 1.45 * T;          // hip to toe
const ARM = 0.30 * T;          // upper arm and forearm, each
const FLOOR = 560, TOE_X = 80;

/**
 * One side-on clip. `drops` is how far the shoulders are lowered from lockout,
 * per frame, as a fraction of torso length; `sag` bends the body at the hip
 * (degrees, hips dropping toward the floor).
 */
function clip(drops, { sag = 0, upright = false } = {}) {
  const poses = {};
  const lockH = 2 * ARM * 0.97;                 // shoulder height at lockout
  const handX = TOE_X + Math.sqrt((LEG + T) ** 2 - lockH ** 2);
  drops.forEach((d, i) => {
    const h = lockH - d * T;                     // shoulder height above the floor
    let sh, hip, toe;
    if (upright) {
      // A dip-like upright body: the same arms, but standing on end.
      sh = [300, 200 + d * T]; hip = [300, sh[1] + T]; toe = [300, hip[1] + LEG];
    } else {
      const len = LEG + T;
      const ang = Math.asin(Math.min(0.99, h / len));
      toe = [TOE_X, FLOOR];
      sh = [TOE_X + len * Math.cos(ang), FLOOR - h];
      const f = LEG / len;
      hip = [toe[0] + f * (sh[0] - toe[0]), toe[1] + f * (sh[1] - toe[1]) + sag * 2];
    }
    const wr = upright ? [300, 200 + 0.5 * T] : [handX, FLOOR];
    // Elbow: two equal links from shoulder to wrist, bent toward the feet/up.
    const dx = wr[0] - sh[0], dy = wr[1] - sh[1], dist = Math.hypot(dx, dy);
    const half = Math.min(dist / 2, ARM * 0.999);
    const off = Math.sqrt(Math.max(0, ARM * ARM - half * half));
    const mx = (sh[0] + wr[0]) / 2, my = (sh[1] + wr[1]) / 2;
    const el = [mx - (dy / dist) * off * -1, my + (dx / dist) * off * -1];
    const knee = [(hip[0] + toe[0]) / 2, (hip[1] + toe[1]) / 2];
    const head = [sh[0] + 0.35 * T, sh[1] - 0.1 * T];
    const P = (p, dz = 0) => [p[0] + dz, p[1]];
    poses[i] = {
      nose: head, left_ear: P(head, -8), right_ear: P(head, 8),
      left_shoulder: P(sh, -3), right_shoulder: P(sh, 3),
      left_elbow: P(el, -3), right_elbow: P(el, 3),
      left_wrist: P(wr, -3), right_wrist: P(wr, 3),
      left_hip: P(hip, -3), right_hip: P(hip, 3),
      left_knee: P(knee, -3), right_knee: P(knee, 3),
      left_ankle: P(toe, -3), right_ankle: P(toe, 3),
      left_foot_index: [toe[0] - 12, toe[1] + 4], right_foot_index: [toe[0] - 12, toe[1] + 4],
      left_heel: [toe[0] + 6, toe[1] - 14], right_heel: [toe[0] + 6, toe[1] - 14],
    };
  });
  return poses;
}

/** n push-ups of a given depth, a short hold at lockout between them. */
function reps(n, depth = 0.38, down = 12, up = 12, hold = 8) {
  const d = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < hold; i++) d.push(0);
    for (let i = 1; i <= down; i++) d.push(depth * (i / down));
    for (let i = up - 1; i >= 0; i--) d.push(depth * (i / up));
  }
  for (let i = 0; i < hold; i++) d.push(0);
  return d;
}

{
  const F = buildPushupFeatures(clip(reps(3)));
  const out = findPushupReps(F);
  ok(out.reps.length === 3, "three push-ups are three reps", `found ${out.reps.length} (${out.refused})`);
  const [b0, bot, b1] = out.reps[0] || [];
  ok(b0 < bot && bot < b1, "the rep runs lockout, bottom, lockout");
}
{
  const out = findPushupReps(buildPushupFeatures(clip(reps(3), { upright: true })));
  ok(out.reps.length === 0 && out.refused === "notLying",
     "an upright body is refused, not measured as push-ups", String(out.refused));
}
{
  const out = findPushupReps(buildPushupFeatures(clip(reps(3, 0.05))));
  ok(out.reps.length === 0, "a few centimetres of wobble in a plank is not push-ups");
}
{
  const out = findPushupReps(buildPushupFeatures(clip(new Array(100).fill(0))));
  ok(out.reps.length === 0, "holding a plank is no reps at all");
}

{
  ok(ACTIVITIES.pushup.phases[0] === "eccentric_s", "lowered first: the eccentric comes first");
  const res = analyse(clip(reps(3)), 30, { activity: "pushup", heightM: 1.81 });
  ok(res.reps.length === 3, "analyse finds the three", String(res.reps.length));
  const r = res.reps[0];
  ok(r && r.depth_m > 0.1 && r.depth_m < 0.5, "depth from the shoulders, in metres",
     r && String(r.depth_m));
  ok(r && r.depth_m > (r.pelvis_travel_m || 0), "and more than the hips travel (they pivot at the toes)",
     r && `${r.depth_m} vs ${r.pelvis_travel_m}`);
  ok(r && r.elbow_flex_max_deg > 60, "the elbow folds", r && String(r.elbow_flex_max_deg));
  ok(r && r.body_bend_deg < 10, "a straight body reads as straight", r && String(r.body_bend_deg));

  const sagged = analyse(clip(reps(3), { sag: 20 }), 30, { activity: "pushup", heightM: 1.81 });
  const s = sagged.reps[0];
  ok(s && s.body_bend_deg > r.body_bend_deg + 5, "sagging hips show as a bend at the hip",
     s && String(s.body_bend_deg));
  gradeReps(sagged);
  ok((s.qualityNotes || []).some((n) => n.code === "bodyLine"),
     "and the quality check names it", JSON.stringify(s.qualityNotes));
  gradeReps(res);
  ok(!(r.qualityNotes || []).some((n) => n.code === "bodyLine"), "a straight body is not flagged");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
