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


/* --- front-on and angled -------------------------------------------------
 * Bas filmed from the front / at an angle (2026-09-11) and got refusals and
 * dropped reps: the old rule wanted the shoulder-hip line flat in the picture
 * and the elbow folding in the picture, and from the front neither happens.
 * So: a body in 3-D, in metres, seen through a pinhole camera placed in front
 * of the head (theta = 0), at 45 degrees, or side-on (90). */
function clip3d(drops, { theta = 0, camH = 0.30, camDist = 1.1, stand = 0 } = {}) {
  const Hm = 1.80, Tm = 0.288 * Hm, LEGm = 0.50 * Hm, UA = 0.186 * Hm, FA = 0.146 * Hm;
  const f = 900, cx = 640, cy = 360;
  const th = (theta * Math.PI) / 180;
  // Body frame: z runs from the hands (0) toward the feet, y up, x lateral.
  // Rotated about the vertical axis through the hands, then seen along +z
  // from (0, camH, -camDist).
  const view = ([x, y, z]) => {
    const xr = x * Math.cos(th) + z * Math.sin(th), zr = -x * Math.sin(th) + z * Math.cos(th);
    const d = zr + camDist;
    return [cx + (f * xr) / d, cy - (f * (y - camH)) / d];
  };
  const lockH = (UA + FA) * 0.97;
  const len = LEGm + Tm;
  const frames = [];
  const P = (name, side, pt) => [`${side}_${name}`, view(pt)];
  const both = (fn) => { const o = {}; for (const sd of ["left", "right"]) Object.assign(o, fn(sd, sd === "left" ? -1 : 1)); return o; };
  for (let i = 0; i < stand; i++) {
    const z = 0.9;
    frames.push({ nose: view([0, 1.64, 0.8]), ...both((sd, L) => Object.fromEntries([
      P("shoulder", sd, [L * 0.2, 1.46, z]), P("elbow", sd, [L * 0.22, 1.12, z]),
      P("wrist", sd, [L * 0.22, 0.86, z]), P("hip", sd, [L * 0.1, 0.95, z]),
      P("knee", sd, [L * 0.1, 0.5, z]), P("ankle", sd, [L * 0.1, 0.08, z]),
      P("heel", sd, [L * 0.1, 0.03, z + 0.05]), P("foot_index", sd, [L * 0.1, 0.02, z - 0.12]),
      P("ear", sd, [L * 0.07, 1.66, z])])) });
  }
  // Shoulders over the hands at lockout; the toes stay put.
  const toeZ = Math.sqrt(len * len - lockH * lockH);
  for (const dd of drops) {
    const h = lockH - dd * Tm;
    const ang = Math.asin(Math.min(0.99, h / len));
    const sh = [toeZ - len * Math.cos(ang), h], toe = [toeZ, 0];
    const fr = LEGm / len;
    const hip = [toe[0] + fr * (sh[0] - toe[0]), toe[1] + fr * (sh[1] - toe[1])];
    const knee = [(hip[0] + toe[0]) / 2, (hip[1] + toe[1]) / 2];
    const wr = [0, 0.02];
    // Elbow by two-link geometry, tucked: bent back toward the feet.
    const dz = wr[0] - sh[0], dy = wr[1] - sh[1], dist = Math.hypot(dz, dy);
    const a = (UA * UA - FA * FA + dist * dist) / (2 * dist);
    const hh = Math.sqrt(Math.max(0, UA * UA - a * a));
    const bz = sh[0] + (a * dz) / dist, by = sh[1] + (a * dy) / dist;
    const e1 = [bz - (hh * dy) / dist, by + (hh * dz) / dist];
    const e2 = [bz + (hh * dy) / dist, by - (hh * dz) / dist];
    const el = e1[0] > e2[0] ? e1 : e2;
    frames.push({ nose: view([0, h + 0.1, sh[0] - 0.2]), ...both((sd, L) => {
      const pt = (lat, [z, y]) => [L * lat, y, z];
      return Object.fromEntries([
        P("shoulder", sd, pt(0.2, sh)), P("elbow", sd, pt(0.2, el)), P("wrist", sd, pt(0.2, wr)),
        P("hip", sd, pt(0.1, hip)), P("knee", sd, pt(0.1, knee)), P("ankle", sd, pt(0.1, [toe[0], 0.08])),
        P("heel", sd, pt(0.1, [toe[0] + 0.03, 0.1])), P("foot_index", sd, pt(0.1, [toe[0] - 0.02, 0])),
        P("ear", sd, pt(0.07, [sh[0] - 0.12, h + 0.12]))]);
    }) });
  }
  const poses = {};
  frames.forEach((p, i) => { poses[i] = p; });
  return poses;
}

for (const theta of [0, 45, 90]) {
  const res = analyse(clip3d(reps(5)), 30, { activity: "pushup", heightM: 1.8 });
  ok(res.reps.length === 5, `filmed at ${theta} deg: five push-ups are five reps`,
     `found ${res.reps.length}${res.refused ? " (" + res.refused + ")" : ""}`);
  const r = res.reps[0];
  ok(r && r.depth_m > 0.12 && r.depth_m < 0.5, `  and the depth is a plausible shoulder travel`,
     r && `${r.depth_m} m`);
}
{
  const res = analyse(clip3d(reps(5), { theta: 0 }), 30, { activity: "pushup", heightM: 1.8 });
  ok(res.reps[0] && res.reps[0].body_bend_deg == null,
     "front-on, the body-line angle is left out rather than read as a sag",
     String(res.reps[0]?.body_bend_deg));
}
{
  // Standing in front of the phone for three seconds before getting down.
  const res = analyse(clip3d(reps(5), { theta: 0, stand: 90 }), 30, { activity: "pushup", heightM: 1.8 });
  ok(res.reps.length === 5, "walking into position first does not refuse the clip or add reps",
     `found ${res.reps.length}${res.refused ? " (" + res.refused + ")" : ""}`);
}
{
  const out = findPushupReps(buildPushupFeatures(clip3d(reps(4, 0.05), { theta: 0 })));
  ok(out.reps.length === 0, "front-on, wobbling in a plank is still not push-ups");
}
{
  // Live: every other frame.
  const P = clip3d(reps(5), { theta: 45 });
  const half = {};
  Object.keys(P).map(Number).filter((k) => k % 2 === 0).forEach((k, i) => { half[i] = P[k]; });
  const res = analyse(half, 15, { activity: "pushup", heightM: 1.8 });
  ok(res.reps.length === 5, "at 15 fps the five are still five", `${res.reps.length}`);
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
