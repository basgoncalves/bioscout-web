/**
 * detect.js -- work out which movement was performed, from kinematics alone.
 *
 * Rule-based on purpose. There is no labelled training set, the classes are few
 * and kinematically distinct, and a rule states its own reasoning -- when it is
 * wrong you can read why. It also REFUSES rather than guessing, which a
 * three-class model never will; analysing a squat as a pull-up would produce
 * numbers that look fine and mean nothing.
 *
 * Every feature is scale-free (body proportions or degrees), so camera distance
 * does not matter.
 */
import { angle3, mid, nanmean, nanmedian } from "./kinematics.js";

export const MIN_CONFIDENCE = 0.45;

const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
const range = (a) => {
  const v = a.filter(isNum);
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function features(poses) {
  const keys = Object.keys(poses).map(Number).sort((a, b) => a - b);
  const S = { hipY: [], shY: [], wrY: [], anY: [], earW: [], noseX: [], noseY: [],
              knee: [], hipA: [], elbow: [], torso: [], footY: [], hipYa: [] };
  for (const fi of keys) {
    const lm = poses[fi];
    const ls = lm.left_shoulder, rs = lm.right_shoulder;
    const lh = lm.left_hip, rh = lm.right_hip;
    const lk = lm.left_knee, rk = lm.right_knee;
    const la = lm.left_ankle, ra = lm.right_ankle;
    const le = lm.left_elbow, re = lm.right_elbow;
    const lw = lm.left_wrist, rw = lm.right_wrist;
    const sh = mid(ls, rs), hp = mid(lh, rh), an = mid(la, ra), wr = mid(lw, rw);
    if (sh) S.shY.push(sh[1]);
    if (hp) S.hipY.push(hp[1]);
    // Frame-aligned copy. S.hipY only gets a value when the hip was found, so
    // its indices do not line up with S.footY and the two cannot be compared
    // frame by frame -- which is exactly what the flight test needs to do.
    S.hipYa.push(hp ? hp[1] : NaN);
    if (an) S.anY.push(an[1]);
    if (wr) S.wrY.push(wr[1]);
    if (lm.left_ear && lm.right_ear) {
      S.earW.push(Math.hypot(lm.left_ear[0] - lm.right_ear[0],
                             lm.left_ear[1] - lm.right_ear[1]));
    }
    if (lm.nose) { S.noseX.push(lm.nose[0]); S.noseY.push(lm.nose[1]); }
    S.knee.push(180 - nanmean([angle3(lh, lk, la), angle3(rh, rk, ra)]));
    S.hipA.push(180 - nanmean([angle3(ls, lh, lk), angle3(rs, rh, rk)]));
    S.elbow.push(180 - nanmean([angle3(ls, le, lw), angle3(rs, re, rw)]));
    if (sh && hp) S.torso.push(Math.abs(sh[1] - hp[1]));
    // Lowest point of either foot this frame. Larger y is lower on screen.
    const feet = [la, ra, lm.left_foot_index, lm.right_foot_index]
      .filter(Boolean).map((q) => q[1]).filter(isNum);
    S.footY.push(feet.length ? Math.max(...feet) : NaN);
  }

  let torso = nanmedian(S.torso);
  if (!(torso > 1e-6)) torso = 1;

  // Hands overhead: wrists above the shoulders by a quarter of a torso.
  let overhead = 0, nOver = 0;
  for (const fi of keys) {
    const lm = poses[fi];
    const sh = mid(lm.left_shoulder, lm.right_shoulder);
    const wr = mid(lm.left_wrist, lm.right_wrist);
    if (sh && wr) { nOver++; if (sh[1] - wr[1] > 0.25 * torso) overhead++; }
  }

  /* Flight. This is the one feature that separates a jump from everything
   * else here: in a squat, a pull-up and a neck test the feet never leave the
   * floor, so a foot rise of several centimetres is not ambiguous. The floor is
   * the lowest foot position seen anywhere in the clip -- the athlete is on the
   * ground for most of any recording. */
  const floorY = Math.max(...S.footY.filter(isNum), -Infinity);
  /* The feet alone are not enough. A squat filmed face-on drifts its foot
   * landmark upward as the athlete goes deep -- the model is guessing at feet
   * near the edge of the frame -- and a foot-only test read that as flight,
   * scoring a squat as a countermovement jump at 1.00 confidence.
   *
   * The hip settles it. In a jump the hip rises ABOVE where it ever got with
   * the feet down; in a squat it only ever goes lower. So a frame counts as
   * airborne only if the feet are up AND the hip is higher than the standing
   * reference, which is taken over the frames whose feet are demonstrably
   * down. */
  const grounded = [];
  for (let i = 0; i < S.footY.length; i++) {
    if (isNum(S.footY[i]) && floorY - S.footY[i] <= 0.04 * torso && isNum(S.hipYa[i])) {
      grounded.push(S.hipYa[i]);
    }
  }
  grounded.sort((a, b) => a - b);
  const standRef = grounded.length ? grounded[Math.floor(0.10 * (grounded.length - 1))]
                                   : -Infinity;
  let airborne = 0, nFoot = 0;
  const air = [];
  for (let i = 0; i < S.footY.length; i++) {
    const y = S.footY[i];
    if (!isNum(y)) { air.push(false); continue; }
    nFoot++;
    const feetUp = floorY - y > 0.15 * torso;
    const hipUp = isNum(S.hipYa[i]) && standRef - S.hipYa[i] > 0.06 * torso;
    const up = feetUp && hipUp;
    if (up) airborne++;
    air.push(up);
  }
  // Did the hips dip below where they started, before the feet left the floor?
  // That is the countermovement, and it is what separates the two jumps.
  let firstAir = air.indexOf(true);
  let dip = 0;
  if (firstAir > 0 && S.hipY.length >= firstAir) {
    const start = S.hipY[0];
    let lowest = start;
    for (let i = 0; i < Math.min(firstAir, S.hipY.length); i++) {
      if (isNum(S.hipY[i]) && S.hipY[i] > lowest) lowest = S.hipY[i];
    }
    dip = (lowest - start) / torso;
  }

  const earW = nanmedian(S.earW);
  const headFrac = isNum(earW) && earW > 0 ? earW / torso : 0;
  const noseTravel = Math.hypot(range(S.noseX), range(S.noseY))
                   / Math.max(1e-6, isNum(earW) ? earW : 1);

  return {
    hands_overhead_frac: nOver ? overhead / nOver : 0,
    body_rise: range(S.shY) / torso,
    hip_drop: range(S.hipY) / torso,
    feet_move: range(S.anY) / torso,
    knee_rom: range(S.knee),
    hip_rom: range(S.hipA),
    elbow_rom: range(S.elbow),
    head_frac: headFrac,
    nose_travel: noseTravel,
    flight_frac: nFoot ? airborne / nFoot : 0,
    countermovement_frac: dip,
    frames: keys.length,
  };
}

/** How much this looks like a two-footed vertical jump, flight aside. */
function jumpShape(f) {
  return mean([
    clamp01(1 - f.hands_overhead_frac / 0.4),
    clamp01(f.knee_rom / 55),
    clamp01(f.hip_rom / 40),
  ]);
}

export function score(f) {
  return {
    // Hands overhead, whole body rises, elbows do the work, feet free.
    // Overhead is a veto for the same reason flight is one for the squat: a
    // jump also raises the whole body and frees the feet, and averaging let it
    // score 0.46 as a pull-up. Hands not overhead, not a pull-up.
    pullup: clamp01(f.hands_overhead_frac / 0.3) * mean([
      clamp01(f.hands_overhead_frac / 0.5),
      clamp01(f.body_rise / 1.2),
      clamp01(f.elbow_rom / 80),
      clamp01(f.feet_move / 0.8),
    ]),
    // Feet planted, hips drop, knee and hip flex together, hands down. The
    // flight term is a veto, not an average: a squat with the feet in the air
    // is a jump, and no amount of agreement elsewhere changes that.
    squat: (1 - clamp01(f.flight_frac / 0.04)) * mean([
      clamp01(1 - f.hands_overhead_frac / 0.3),
      clamp01(f.knee_rom / 60),
      clamp01(f.hip_rom / 50),
      clamp01(1 - f.feet_move / 0.5),
      clamp01(f.hip_drop / 0.8),
    ]),
    // The jumps. Flight multiplies for the same reason: without it there is no
    // jump, however squat-like the rest looks. The two are told apart by the
    // countermovement alone, so each keeps a floor of 0.35 -- the movement IS a
    // jump either way, and calling the wrong one is a much smaller error than
    // calling it a squat.
    cmj: clamp01(f.flight_frac / 0.06) * jumpShape(f)
       * (f.countermovement_frac > 0.08 ? 1 : 0.35),
    sj: clamp01(f.flight_frac / 0.06) * jumpShape(f)
       * (f.countermovement_frac > 0.08 ? 0.35 : 1),
    // Head fills the frame and MOVES while the trunk stays put. nose_travel
    // multiplies rather than averages: three of the four terms reward
    // stillness, so without this a motionless person scores as a neck test.
    neck: clamp01(f.nose_travel / 0.5) * mean([
      clamp01(f.head_frac / 0.45),
      clamp01(1 - f.knee_rom / 40),
      clamp01(1 - f.body_rise / 0.5),
    ]),
  };
}

/** Did anything happen at all? Every score is a shape comparison, and a still
 *  frame can match a shape by accident, so this is checked first. */
export function isStill(f) {
  return f.knee_rom < 8 && f.hip_rom < 8 && f.elbow_rom < 8
      && f.body_rise < 0.08 && f.hip_drop < 0.08 && f.nose_travel < 0.12
      && f.flight_frac < 0.01;
}

export function classify(poses) {
  const f = features(poses);
  if (isStill(f)) {
    return { activity: null, confidence: 0, scores: score(f), features: f,
             margin: 0,
             reason: "Nothing moved: no joint changed by more than a few degrees "
                   + "and the body did not translate. Record during the movement." };
  }
  const sc = score(f);
  const entries = Object.entries(sc).sort((a, b) => b[1] - a[1]);
  const [best, conf] = entries[0];
  const margin = conf - (entries[1] ? entries[1][1] : 0);

  if (conf < MIN_CONFIDENCE) {
    return { activity: null, confidence: conf, scores: sc, features: f, margin,
      reason: `Nothing matched: the strongest was ${best} at ${conf.toFixed(2)}, `
            + `below the ${MIN_CONFIDENCE} threshold.` };
  }
  const why = {
    pullup: `hands overhead ${(100 * f.hands_overhead_frac).toFixed(0)}% of the time, `
          + `body rose ${f.body_rise.toFixed(1)} torso lengths, `
          + `elbow range ${f.elbow_rom.toFixed(0)}°`,
    squat: `feet stayed planted, knee range ${f.knee_rom.toFixed(0)}°, `
         + `hip range ${f.hip_rom.toFixed(0)}°, hips dropped `
         + `${f.hip_drop.toFixed(1)} torso lengths`,
    neck: `head fills ${(100 * f.head_frac).toFixed(0)}% of a torso length, `
        + `nose moved ${f.nose_travel.toFixed(1)} head widths, trunk barely moved`,
    cmj: `feet off the floor and hips above standing for `
       + `${(100 * f.flight_frac).toFixed(0)}% of the clip, `
       + `hips dipped ${f.countermovement_frac.toFixed(2)} torso lengths before `
       + `take-off, knee range ${f.knee_rom.toFixed(0)}°`,
    sj: `feet off the floor and hips above standing for `
      + `${(100 * f.flight_frac).toFixed(0)}% of the clip `
      + `with no dip before take-off (${f.countermovement_frac.toFixed(2)} torso `
      + `lengths), knee range ${f.knee_rom.toFixed(0)}°`,
  }[best];
  return { activity: best, confidence: conf, scores: sc, features: f, margin, reason: why };
}
