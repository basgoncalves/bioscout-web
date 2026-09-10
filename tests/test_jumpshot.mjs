/**
 * The jump shot.
 *
 *   node tests/test_jumpshot.mjs
 *
 * Built from geometry: a body that dips, jumps, and throws a hand up. There is
 * no ball anywhere in this module, so there is no ball in the test either --
 * what is checked is that the events the module claims to find are the events
 * it actually finds, and that the sign of the one number worth having is the
 * right way round.
 */
import { buildShotFeatures, findShotReps, shotMetrics, DEFAULT_SHOT_CFG, analyse }
  from "../src/kinematics.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};

const FLOOR = 1000, HIP = 380;       // hip height above the floor, px
const px = (m) => m * 420;

/**
 * One frame. `hip` is the hip's height above the floor as a fraction of
 * standing; `hand` is the wrist's height above the floor in the same units as
 * F.hand ends up in; `foot` lifts both feet.
 */
function frame(hip, hand, foot) {
  const hipY = FLOOR - HIP * hip;
  const shY = hipY - 150;
  const wrY = FLOOR - HIP * hand;
  const footY = FLOOR - HIP * foot;
  /* The elbow is placed by two-link geometry rather than by a fudge factor, so
   * the elbow ANGLE follows from where the hand is instead of being asserted:
   * hand near the shoulder folds the arm, hand a full arm's length away
   * straightens it. Getting this wrong once made the test demand that the arm
   * be straighter at the dip than at release, which is backwards. */
  const ARM = 0.38 * HIP;             // upper arm and forearm, each
  const elbow = (shx, wx) => {
    const dx = wx - shx, dy = wrY - shY;
    const sep = Math.min(Math.hypot(dx, dy), 2 * ARM * 0.999);
    const half = sep / 2;
    const out = Math.sqrt(Math.max(0, ARM * ARM - half * half));
    const ux = dx / (sep || 1), uy = dy / (sep || 1);
    // Perpendicular, pointing away from the body's midline.
    return [shx + ux * half + (-uy) * out * Math.sign(shx - 250),
            shY + uy * half + ux * out * Math.sign(shx - 250)];
  };
  // The knee tracks forward as the leg compresses, so knee flexion follows
  // from the crouch instead of staying at zero for every frame.
  const legSpan = footY - hipY;
  const comp = Math.max(0, HIP - legSpan);
  const kneeY = hipY + legSpan / 2, kneeX = 250 + comp * 1.2;
  const [lex, ley] = elbow(240, 236), [rex, rey] = elbow(260, 264);
  return {
    nose: [250, shY - 60], left_ear: [244, shY - 55], right_ear: [256, shY - 55],
    left_shoulder: [240, shY], right_shoulder: [260, shY],
    left_elbow: [lex, ley], right_elbow: [rex, rey],
    left_wrist: [236, wrY + 26], right_wrist: [264, wrY],
    left_hip: [245, hipY], right_hip: [255, hipY],
    left_knee: [kneeX - 5, kneeY], right_knee: [kneeX + 5, kneeY],
    left_ankle: [245, footY], right_ankle: [255, footY],
    left_foot_index: [248, footY + 6], right_foot_index: [258, footY + 6],
    left_heel: [242, footY + 3], right_heel: [252, footY + 3],
  };
}

/**
 * n attempts. `releaseAt` says where in the flight the hand peaks:
 * "rising", "apex" or "falling".
 */
function shots(n, { releaseAt = "apex", dip = 0.22 } = {}) {
  const out = [];
  const push = (hip, hand, foot) => out.push(frame(hip, hand, foot));
  const CHEST = 0.75;                 // ball at chest, well below the head
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 10; i++) push(1, CHEST, 0);
    // The dip: hips and ball both drop.
    for (let i = 1; i <= 8; i++) {
      push(1 - dip * (i / 8), CHEST - 0.22 * (i / 8), 0);
    }
    /* Up. The hips arc to their apex at f = 1; the hand climbs to ITS peak at
     * `peakAt` and starts down immediately after, because a hand that plateaus
     * at the top has no single highest frame and a real one does not do that. */
    const RISE = 20;
    const peakAt = releaseAt === "rising" ? 0.55 : releaseAt === "falling" ? 1.0 : 0.8;
    for (let i = 1; i <= RISE; i++) {
      const f = i / RISE;
      const hip = 1 - dip + (dip + 0.30) * Math.sin(f * Math.PI / 2);
      const foot = Math.max(0, (f - 0.45) * 0.5);
      const hand = f <= peakAt
        ? CHEST - 0.22 + (2.35 - CHEST + 0.22) * (f / peakAt)
        : 2.35 - 0.6 * ((f - peakAt) / Math.max(0.05, 1 - peakAt));
      push(hip, hand, foot);
    }
    // Down, arm coming down with the body.
    for (let i = 1; i <= 14; i++) {
      const f = i / 14;
      push(1.30 - 0.30 * f, 1.75 - 1.00 * f, Math.max(0, 0.27 * (1 - f * 2)));
    }
    for (let i = 0; i < 8; i++) push(1, CHEST, 0);
  }
  const poses = {};
  out.forEach((p, i) => { poses[i] = p; });
  return poses;
}

/* --- finding the attempts ------------------------------------------------- */
{
  const F = buildShotFeatures(shots(3));
  const { reps, shootSide } = findShotReps(F);
  ok(reps.length === 3, "three attempts are three shots", `found ${reps.length}`);
  ok(shootSide === "r", "the shooting hand is the one that goes highest", shootSide);
  const [dip, rel, end] = reps[0] || [];
  ok(dip < rel && rel < end, "the shot runs dip, release, follow-through");
  ok(F.hand[rel] > F.hand[dip], "release is above the dip, not below it");
}

/* --- what is not a shot --------------------------------------------------- */
{
  // A hand held up the whole time: catching, or a rebound, but nothing dipped.
  const flat = [];
  for (let i = 0; i < 60; i++) flat.push(frame(1, 0.75, 0));
  for (let i = 0; i < 60; i++) flat.push(frame(1, 1.9, 0));
  const poses = {}; flat.forEach((p, i) => { poses[i] = p; });
  const out = findShotReps(buildShotFeatures(poses));
  ok(out.reps.length === 0, "a hand that was already up is not a shot");
}
{
  // Dribbling: the hand stays below the head.
  const low = [];
  for (let i = 0; i < 120; i++) low.push(frame(1, 0.5 + 0.25 * Math.sin(i / 3), 0));
  const poses = {}; low.forEach((p, i) => { poses[i] = p; });
  const out = findShotReps(buildShotFeatures(poses));
  ok(out.reps.length === 0 && out.refused === "noShots",
     "a hand that never gets above the head is not a shot");
}

/* --- the number the module exists for ------------------------------------- */
{
  const g = (mode) => {
    const F = buildShotFeatures(shots(2, { releaseAt: mode }));
    const { reps } = findShotReps(F);
    return reps.length ? shotMetrics(F, reps[0], 30, 420) : null;
  };
  const rising = g("rising"), apex = g("apex"), falling = g("falling");
  ok(rising && apex && falling, "all three release timings produce a shot");
  ok(rising.apex_offset_s < 0,
     "released on the way up reads NEGATIVE", `${rising?.apex_offset_s} s`);
  ok(Math.abs(apex.apex_offset_s) <= Math.abs(rising.apex_offset_s),
     "released at the top reads near zero", `${apex?.apex_offset_s} s`);
  ok(falling.apex_offset_s >= apex.apex_offset_s,
     "released while falling reads later than at the top",
     `${falling?.apex_offset_s} s`);
}

/* --- the whole pipeline --------------------------------------------------- */
{
  const res = analyse(shots(3), 30, { activity: "jumpshot", heightM: 1.90 });
  ok(res.reps.length === 3, "analyse finds them", `${res.reps.length}`);
  const r = res.reps[0];
  ok(r.release_height_m > 1.5,
     "release height is a plausible height above the floor",
     `${r?.release_height_m} m`);
  ok(r.release_height_m > r.dip_hand_m,
     "and is above where the hand started");
  ok(r.load_s > 0 && r.follow_s > 0, "both phases have a duration");
  ok(r.release_elbow_deg < r.dip_elbow_deg,
     "the elbow is straighter at release than at the dip",
     `${r?.dip_elbow_deg} -> ${r?.release_elbow_deg} deg`);
  ok(r.shoot_side === "r", "every rep carries the shooting side");
}

/* Deeper knees must read as deeper knees, or the number is decoration. */
{
  const shallow = analyse(shots(2, { dip: 0.10 }), 30, { activity: "jumpshot", heightM: 1.9 });
  const deep = analyse(shots(2, { dip: 0.34 }), 30, { activity: "jumpshot", heightM: 1.9 });
  const k = (r) => r.reps[0]?.knee_flex_at_dip_deg;
  ok(shallow.reps.length && deep.reps.length && k(deep) > k(shallow),
     "a deeper dip reads as more knee flexion",
     `${k(shallow)?.toFixed(0)} vs ${k(deep)?.toFixed(0)} deg`);
}

/* --- a real session: dribbling, passing, picking the ball up -------------
 * What Bas's live test was full of, and what the first version counted as
 * shots: its "above the head" was measured from the FLOOR at 0.95 hip-heights,
 * which a hand hanging at the side already clears. */
const toPoses = (list) => { const P = {}; list.forEach((p, i) => { P[i] = p; }); return P; };
function session({ pickup = true } = {}) {
  const out = [];
  if (pickup) {
    // Bend down to the ball on the floor, then stand with it at the chest.
    for (let i = 0; i < 20; i++) out.push(frame(1 - 0.4 * Math.sin(Math.PI * i / 20), 0.15 + 1.2 * (i / 20), 0));
  }
  // Dribbling: the hand between knee and waist, 4 bounces a second.
  for (let i = 0; i < 90; i++) out.push(frame(1, 0.8 + 0.25 * Math.sin(i / 1.2), 0));
  // Two chest passes: the hand shoots out at chest height and comes back.
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 10; i++) out.push(frame(1, 1.1 + 0.25 * Math.sin(Math.PI * i / 10), 0));
    for (let i = 0; i < 10; i++) out.push(frame(1, 1.1, 0));
  }
  const sh = shots(3);
  for (const k of Object.keys(sh).map(Number).sort((a, b) => a - b)) out.push(sh[k]);
  return toPoses(out);
}
{
  const F = buildShotFeatures(session());
  F._fps = 30;
  const { reps } = findShotReps(F);
  ok(reps.length === 3, "dribbles, passes and a pick-up are not shots; the three shots are",
     `found ${reps.length}`);
  const res = analyse(session(), 30, { activity: "jumpshot", heightM: 1.81 });
  ok(res.reps.length === 3 && res.reps[0].load_s < 1.0,
     "the first shot's load starts at its own dip, not at the pick-up",
     `${res.reps[0]?.load_s} s`);
}

/* --- live frame rates ---------------------------------------------------- */
{
  // Every other frame of a 30 fps take: what a phone manages live.
  const sh = shots(3), keys = Object.keys(sh).map(Number).sort((a, b) => a - b);
  const half = toPoses(keys.filter((k) => k % 2 === 0).map((k) => sh[k]));
  const res = analyse(half, 15, { activity: "jumpshot", heightM: 1.81 });
  ok(res.reps.length === 3, "at 15 fps the three shots are still three", `${res.reps.length}`);
  const r = res.reps[0];
  ok(r && Math.abs(r.follow_s - DEFAULT_SHOT_CFG.followS) < 0.1,
     "the follow-through window is in seconds, not in 30 fps frames", `${r?.follow_s} s`);
  const full = analyse(shots(3), 30, { activity: "jumpshot", heightM: 1.81 }).reps[0];
  ok(r && full && Math.abs(r.apex_offset_s - full.apex_offset_s) < 0.07,
     "and release-vs-apex agrees with the 30 fps take to within a frame",
     `${r?.apex_offset_s} vs ${full?.apex_offset_s}`);
}

/* --- one attempt, however it is shaped ------------------------------------ */
function setShot({ hold = 0 } = {}) {
  const out = [];
  for (let i = 0; i < 10; i++) out.push(frame(1, 1.2, 0));
  for (let i = 1; i <= 8; i++) out.push(frame(1 - 0.2 * i / 8, 1.2 - 0.4 * i / 8, 0));
  // Up to the set point above the forehead, a slight sag there, then release.
  for (let i = 1; i <= 8; i++) out.push(frame(0.8 + 0.2 * i / 8, 0.8 + 1.2 * i / 8, 0));
  for (let i = 0; i < 4; i++) out.push(frame(1, 2.0 - 0.08 * Math.sin(Math.PI * i / 4), 0));
  for (let i = 1; i <= 5; i++) out.push(frame(1 + 0.05 * i / 5, 2.0 + 0.4 * i / 5, 0));
  // Follow-through held, with a little wobble, then the arm comes down.
  for (let i = 0; i < hold; i++) out.push(frame(1, 2.3 + 0.03 * Math.sin(i), 0));
  for (let i = 1; i <= 12; i++) out.push(frame(1, 2.3 - 1.3 * i / 12, 0));
  for (let i = 0; i < 15; i++) out.push(frame(1, 1.0, 0));
  return toPoses(out);
}
{
  const a = findShotReps(buildShotFeatures(setShot()));
  ok(a.reps.length === 1, "a set point then the release is ONE shot", `${a.reps.length}`);
  const b = findShotReps(buildShotFeatures(setShot({ hold: 36 })));
  ok(b.reps.length === 1, "a follow-through held for over a second still counts", `${b.reps.length}`);
}
{
  // One frame where the guide hand is flung above everything by the tracker.
  const sh = shots(2);
  sh[25] = { ...sh[25], left_wrist: [236, 1000 - 380 * 3.2] };
  const { shootSide } = findShotReps(buildShotFeatures(sh));
  ok(shootSide === "r", "one glitched frame does not pick the shooting hand", shootSide);
}

console.log(bad ? `\nFAIL ${bad} check(s)` : "\nAll checks passed");
if (bad) process.exit(1);
