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
              knee: [], hipA: [], elbow: [], torso: [] };
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
    frames: keys.length,
  };
}

export function score(f) {
  return {
    // Hands overhead, whole body rises, elbows do the work, feet free.
    pullup: mean([
      clamp01(f.hands_overhead_frac / 0.5),
      clamp01(f.body_rise / 1.2),
      clamp01(f.elbow_rom / 80),
      clamp01(f.feet_move / 0.8),
    ]),
    // Feet planted, hips drop, knee and hip flex together, hands down.
    squat: mean([
      clamp01(1 - f.hands_overhead_frac / 0.3),
      clamp01(f.knee_rom / 60),
      clamp01(f.hip_rom / 50),
      clamp01(1 - f.feet_move / 0.5),
      clamp01(f.hip_drop / 0.8),
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
      && f.body_rise < 0.08 && f.hip_drop < 0.08 && f.nose_travel < 0.12;
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
  }[best];
  return { activity: best, confidence: conf, scores: sc, features: f, margin, reason: why };
}
