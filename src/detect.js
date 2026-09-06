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
              knee: [], hipA: [], elbow: [], torso: [], footY: [], hipYa: [],
              // Per side, plus the hip's horizontal position. The three tasks
              // added here are all asymmetric or lateral, and none of them can
              // be told apart from a squat using two-legged averages.
              lFootY: [], rFootY: [], hipXa: [], kneeL: [], kneeR: [] };
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
    const fl = [la, lm.left_foot_index].filter(Boolean).map((q) => q[1]).filter(isNum);
    const fr = [ra, lm.right_foot_index].filter(Boolean).map((q) => q[1]).filter(isNum);
    S.lFootY.push(fl.length ? Math.max(...fl) : NaN);
    S.rFootY.push(fr.length ? Math.max(...fr) : NaN);
    S.hipXa.push(hp ? hp[0] : NaN);
    S.kneeL.push(180 - angle3(lh, lk, la));
    S.kneeR.push(180 - angle3(rh, rk, ra));
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

  /* Lateral travel of the hips, in torso lengths. A side step is the only
   * task here whose defining motion is sideways; everything else is vertical. */
  const lateral = range(S.hipXa) / torso;

  /* Support pattern. `alternating` is the fraction of onFloor frames with
   * exactly ONE foot down, and it is what separates running from jumping: both
   * leave the floor repeatedly, but a jump is two-footed on both sides of the
   * flight and a stride is never two-footed at all. `oneFootUp` is the fraction
   * of frames with one foot clearly raised and the other planted, which is what
   * a single-leg squat looks like from start to finish.
   *
   * `bouts` counts separate airborne periods. One is a jump; four in three
   * seconds is running. */
  const upTol = 0.15 * torso, downTol = 0.07 * torso;
  let oneDown = 0, onFloor = 0, oneUp = 0, nSide = 0, bouts = 0, wasAir = false;
  for (let i = 0; i < S.footY.length; i++) {
    const l = S.lFootY[i], r = S.rFootY[i];
    const inAir = air[i];
    if (inAir && !wasAir) bouts++;
    wasAir = inAir;
    if (!isNum(l) || !isNum(r)) continue;
    nSide++;
    const lUp = floorY - l > upTol, rUp = floorY - r > upTol;
    const lDown = floorY - l < downTol, rDown = floorY - r < downTol;
    if (!inAir) {
      onFloor++;
      if (lDown !== rDown) oneDown++;
    }
    if ((lUp && rDown) || (rUp && lDown)) oneUp++;
  }

  // Peak-to-peak difference between the two knees. On a single-leg squat the
  // working knee bends and the free one does not.
  const kneeAsym = Math.abs(range(S.kneeL) - range(S.kneeR));

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
    lateral_travel: lateral,
    alternating_frac: onFloor ? oneDown / onFloor : 0,
    one_foot_up_frac: nSide ? oneUp / nSide : 0,
    flight_bouts: bouts,
    knee_asymmetry_deg: kneeAsym,
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
    // A single-leg squat also has planted feet, a dropping hip and flexing
    // knees, so it scores well as a squat unless the raised foot vetoes it.
    squat: (1 - clamp01(f.flight_frac / 0.04))
         * (1 - clamp01(f.one_foot_up_frac / 0.55))
         * (1 - clamp01(f.lateral_travel / 1.2)) * mean([
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
    // Both jumps are two-footed. `alternating_frac` is near zero for a jump and
    // near one for a stride, so it separates the two cleanly without needing
    // either to know about the other.
    cmj: clamp01(f.flight_frac / 0.06) * (1 - clamp01(f.alternating_frac / 0.5))
       * jumpShape(f) * (f.countermovement_frac > 0.08 ? 1 : 0.35),
    sj: clamp01(f.flight_frac / 0.06) * (1 - clamp01(f.alternating_frac / 0.5))
      * jumpShape(f) * (f.countermovement_frac > 0.08 ? 0.35 : 1),
    // Single-leg squat: one foot up for most of the clip, the other planted,
    // knees disagreeing, nothing leaving the floor. The raised-foot term
    // multiplies because without it this is simply a squat.
    slsquat: clamp01(f.one_foot_up_frac / 0.55)
           * (1 - clamp01(f.flight_frac / 0.04)) * mean([
      clamp01(1 - f.hands_overhead_frac / 0.3),
      clamp01(f.knee_rom / 40),
      clamp01(f.knee_asymmetry_deg / 25),
      clamp01(1 - f.lateral_travel / 1.0),
    ]),
    // Running: repeated flight, single support between flights, low hip rise.
    // Two multiplying terms, because a run without either is not a run: several
    // separate flights, and one foot down at a time when there is contact.
    run: clamp01((f.flight_bouts - 1) / 2) * clamp01(f.alternating_frac / 0.6)
       * mean([
      clamp01(1 - f.hands_overhead_frac / 0.3),
      clamp01(f.knee_rom / 45),
      clamp01(1 - f.countermovement_frac / 0.25),
    ]),
    // Side step: the hips travel sideways further than anything else here does,
    // the feet move, and the athlete stays on the floor.
    sidestep: clamp01(f.lateral_travel / 0.8)
            * (1 - clamp01(f.flight_bouts / 4)) * mean([
      clamp01(1 - f.hands_overhead_frac / 0.3),
      clamp01(f.feet_move / 0.4),
      clamp01(1 - f.hip_drop / 1.0),
    ]),
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
      && f.flight_frac < 0.01 && f.lateral_travel < 0.15;
}

export function classify(poses) {
  const f = features(poses);
  if (isStill(f)) {
    return { activity: null, confidence: 0, scores: score(f), features: f,
             margin: 0,
             reasonKey: "whyStill", reasonVals: {},
             reason: "Nothing moved: no joint changed by more than a few degrees "
                   + "and the body did not translate. Record during the movement." };
  }
  const sc = score(f);
  const entries = Object.entries(sc).sort((a, b) => b[1] - a[1]);
  const [best, conf] = entries[0];
  const margin = conf - (entries[1] ? entries[1][1] : 0);

  if (conf < MIN_CONFIDENCE) {
    return { activity: null, confidence: conf, scores: sc, features: f, margin,
      reasonKey: "whyNoMatch",
      reasonVals: { best, conf: conf.toFixed(2), min: MIN_CONFIDENCE },
      reason: `Nothing matched: the strongest was ${best} at ${conf.toFixed(2)}, `
            + `below the ${MIN_CONFIDENCE} threshold.` };
  }
  /* The reason is built twice: once as an English sentence, which is what the
   * export and the .json carry, and once as a translation key plus its numbers,
   * which is what the screen shows. Two representations of one thing is a cost,
   * but the alternative was a sentence assembled from English fragments that no
   * translation could reach -- which is exactly what the German and Portuguese
   * pages were showing.
   */
  const pc = (x) => (100 * x).toFixed(0);
  const vals = {
    pullup: { pct: pc(f.hands_overhead_frac), rise: f.body_rise.toFixed(1),
              elbow: f.elbow_rom.toFixed(0) },
    squat: { knee: f.knee_rom.toFixed(0), hip: f.hip_rom.toFixed(0),
             drop: f.hip_drop.toFixed(1) },
    neck: { pct: pc(f.head_frac), nose: f.nose_travel.toFixed(1) },
    cmj: { pct: pc(f.flight_frac), cmv: f.countermovement_frac.toFixed(2),
           knee: f.knee_rom.toFixed(0) },
    sj: { pct: pc(f.flight_frac), cmv: f.countermovement_frac.toFixed(2),
          knee: f.knee_rom.toFixed(0) },
    slsquat: { pct: pc(f.one_foot_up_frac), asym: f.knee_asymmetry_deg.toFixed(0),
               knee: f.knee_rom.toFixed(0) },
    run: { bouts: f.flight_bouts, alt: pc(f.alternating_frac),
           knee: f.knee_rom.toFixed(0) },
    sidestep: { lat: f.lateral_travel.toFixed(1), feet: f.feet_move.toFixed(1),
                knee: f.knee_rom.toFixed(0) },
  }[best] || {};

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
    slsquat: `one foot raised for ${pc(f.one_foot_up_frac)}% of the clip with `
           + `the other planted, the two knees differing by `
           + `${f.knee_asymmetry_deg.toFixed(0)}°, knee range `
           + `${f.knee_rom.toFixed(0)}°`,
    run: `${f.flight_bouts} separate flight phases with one foot down between `
       + `them (${pc(f.alternating_frac)}% single support), knee range `
       + `${f.knee_rom.toFixed(0)}°`,
    sidestep: `hips travelled ${f.lateral_travel.toFixed(1)} torso lengths `
            + `sideways and the feet moved ${f.feet_move.toFixed(1)}, with no `
            + `flight phase`,
  }[best];
  return { activity: best, confidence: conf, scores: sc, features: f, margin,
           reason: why, reasonKey: "why_" + best, reasonVals: vals };
}
