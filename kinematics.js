/**
 * kinematics.js -- the movement-agnostic core: pose features, rep detection,
 * joint angles, pixel-to-metre scaling, .mot export and the activity table.
 *
 * Named for what it does. It began life as pullupkit.js when pull-ups were the
 * only movement; it now serves pull-ups, squats and the neck test, and adding a
 * movement means adding an entry to ACTIVITIES rather than touching analyse().
 *
 * This is a deliberate line-by-line port, not a reimplementation: the numeric
 * helpers below reproduce numpy's exact semantics (percentile interpolation,
 * convolve 'same' offset and zero padding, nan handling) so that the browser
 * and the desktop produce identical numbers. test_port.mjs asserts that
 * against real landmark data; if you change anything here, run it.
 *
 * Sign conventions are Rajagopal (knee flexion POSITIVE, anterior pelvic tilt
 * NEGATIVE), matching the OpenSim models this feeds.
 */

export const LANDMARK_NAMES = [
  "nose", "left_eye_inner", "left_eye", "left_eye_outer",
  "right_eye_inner", "right_eye", "right_eye_outer",
  "left_ear", "right_ear", "mouth_left", "mouth_right",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_pinky", "right_pinky",
  "left_index", "right_index", "left_thumb", "right_thumb",
  "left_hip", "right_hip", "left_knee", "right_knee",
  "left_ankle", "right_ankle", "left_heel", "right_heel",
  "left_foot_index", "right_foot_index",
];

export const DEFAULT_FRACTIONS = {
  trunk: 0.288, thigh: 0.245, shank: 0.246, upper_arm: 0.186, forearm: 0.146,
};

export const DRIVEN_COORDS = [
  "pelvis_tilt", "pelvis_tx", "pelvis_ty", "pelvis_tz",
  "hip_flexion_r", "hip_flexion_l", "knee_angle_r", "knee_angle_l",
  "arm_flex_r", "arm_flex_l", "elbow_flex_r", "elbow_flex_l",
  "flex_extension",
];

//: Ankle joint centre height above the floor (m), to turn a measured
// hip-above-ankle distance into an absolute pelvis height.
export const ANKLE_JOINT_HEIGHT_M = 0.07;

// Knee sign per model family. OpenSim accepts out-of-range values silently and
// renders a collapsed figure, so this has to be right, not nearly right.
//   rajagopal     knee_angle 0..+145 deg, flexion POSITIVE
//   gpk/gait2392  knee_angle -145..+10 deg, flexion NEGATIVE
export const KNEE_SIGN = { rajagopal: 1, gpk: -1, gait2392: -1 };

export const SQUAT_DRIVEN_COORDS = [
  "pelvis_tilt", "pelvis_tx", "pelvis_ty", "pelvis_tz",
  "hip_flexion_r", "hip_flexion_l", "knee_angle_r", "knee_angle_l",
  "ankle_angle_r", "ankle_angle_l", "lumbar_extension",
];

// ---------------------------------------------------------------------------
// numpy-equivalent helpers
// ---------------------------------------------------------------------------
const isNum = (v) => typeof v === "number" && !Number.isNaN(v);

export function nanmean(vals) {
  const v = vals.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

export function nanmedian(vals) {
  const v = vals.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** numpy.nanpercentile with the default linear interpolation. */
export function nanpercentile(vals, q) {
  const v = vals.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * (q / 100);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** numpy.interp-style linear fill of interior NaNs; all-NaN becomes zeros. */
export function interpNan(arr) {
  const out = Array.from(arr, Number);
  const idx = [];
  for (let i = 0; i < out.length; i++) if (isNum(out[i])) idx.push(i);
  if (!idx.length) return out.map(() => 0);
  for (let i = 0; i < out.length; i++) {
    if (isNum(out[i])) continue;
    if (i < idx[0]) { out[i] = out[idx[0]]; continue; }          // np.interp clamps
    if (i > idx[idx.length - 1]) { out[i] = out[idx[idx.length - 1]]; continue; }
    let k = 0;
    while (idx[k + 1] < i) k++;
    const a = idx[k], b = idx[k + 1];
    out[i] = out[a] + (out[b] - out[a]) * ((i - a) / (b - a));
  }
  return out;
}

/** numpy.convolve(arr, ones(win)/win, mode='same') -- zero padded, centred. */
export function smooth(arr, win) {
  const a = Array.from(arr, Number);
  if (win <= 1 || a.length < win) return a;
  const n = a.length;
  const full = new Array(n + win - 1).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < win; j++) full[i + j] += a[i] / win;
  }
  const off = (win - 1) >> 1;
  return full.slice(off, off + n);
}

export const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clipArr = (a, lo, hi) => a.map((v) => clip(v, lo, hi));

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------
export function angle3(a, b, c) {
  if (!a || !b || !c) return NaN;
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  const mag = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]);
  if (mag < 1e-9) return NaN;
  return (Math.acos(clip(dot / mag, -1, 1)) * 180) / Math.PI;
}

export function mid(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function segLen(lm, a, b) {
  const pa = lm[a], pb = lm[b];
  return pa && pb ? Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) : NaN;
}

// ---------------------------------------------------------------------------
// pull-ups
// ---------------------------------------------------------------------------
export function buildFeatures(poses) {
  const frames = Object.keys(poses).map(Number).sort((a, b) => a - b);
  if (!frames.length) throw new Error("no pose frames");
  const lo = frames[0], hi = frames[frames.length - 1];
  const n = hi - lo + 1;
  const keys = ["shoulder_cy", "hip_cy", "hip_cx", "wrist_cy", "nose_y",
                "elbow", "shoulder", "hip", "knee", "trunk"];
  const F = {};
  for (const k of keys) F[k] = new Array(n).fill(NaN);

  for (const fi of frames) {
    const i = fi - lo, lm = poses[fi];
    const ls = lm.left_shoulder, rs = lm.right_shoulder;
    const lh = lm.left_hip, rh = lm.right_hip;
    const le = lm.left_elbow, re = lm.right_elbow;
    const lw = lm.left_wrist, rw = lm.right_wrist;
    const lk = lm.left_knee, rk = lm.right_knee;
    const la = lm.left_ankle, ra = lm.right_ankle;
    const sh = mid(ls, rs), hp = mid(lh, rh), wr = mid(lw, rw);
    if (sh) F.shoulder_cy[i] = sh[1];
    if (hp) { F.hip_cy[i] = hp[1]; F.hip_cx[i] = hp[0]; }
    if (wr) F.wrist_cy[i] = wr[1];
    if (lm.nose) F.nose_y[i] = lm.nose[1];
    F.elbow[i] = nanmean([angle3(ls, le, lw), angle3(rs, re, rw)]);
    F.shoulder[i] = nanmean([angle3(lh, ls, le), angle3(rh, rs, re)]);
    F.hip[i] = nanmean([angle3(ls, lh, lk), angle3(rs, rh, rk)]);
    F.knee[i] = nanmean([angle3(lh, lk, la), angle3(rh, rk, ra)]);
    if (sh && hp) {
      F.trunk[i] = Math.abs((Math.atan2(hp[0] - sh[0], hp[1] - sh[1]) * 180) / Math.PI);
    }
  }

  const torso = F.shoulder_cy.map((v, i) => Math.abs(v - F.hip_cy[i]));
  let scale = nanmedian(torso);
  if (!(scale > 1e-6)) scale = 1.0;

  F.hands_overhead = F.shoulder_cy.map((s, i) => {
    const w = F.wrist_cy[i];
    if (!isNum(s) || !isNum(w)) return NaN;
    return (s - w) > 0.30 * scale ? 1 : 0;
  });
  const dead = nanpercentile(F.shoulder_cy, 90);
  F.rise = F.shoulder_cy.map((s) => (dead - s) / scale);

  F._lo = lo; F._n = n; F._scale = scale;
  F._coverage = frames.length / n;
  return F;
}

export const DEFAULT_PULLUP_CFG = {
  topRiseFrac: 0.50, minRepFrames: 12, minElbowFlexionDeg: 40,
  smoothWin: 5, requireOverhead: true,
};

function localMaxima(arr, minDistance, minHeight) {
  const cand = [];
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] >= minHeight && arr[i] >= arr[i - 1] && arr[i] > arr[i + 1]) cand.push(i);
  }
  cand.sort((a, b) => arr[b] - arr[a]);
  const chosen = [];
  for (const i of cand) {
    if (chosen.every((j) => Math.abs(i - j) >= minDistance)) chosen.push(i);
  }
  return chosen.sort((a, b) => a - b);
}

function argmin(arr, from, to) {
  let best = from;
  for (let i = from; i <= to; i++) if (arr[i] < arr[best]) best = i;
  return best;
}

export function findReps(F, cfg = DEFAULT_PULLUP_CFG) {
  const n = F._n;
  const rise = smooth(interpNan(F.rise), cfg.smoothWin);
  const elbow = interpNan(F.elbow);
  const overhead = F.hands_overhead.map((v) => (isNum(v) ? v : 0) > 0.5);
  const tops = localMaxima(rise, cfg.minRepFrames, cfg.topRiseFrac);
  const reps = [];
  for (let k = 0; k < tops.length; k++) {
    const top = tops[k];
    const left = k > 0 ? tops[k - 1] : 0;
    const right = k < tops.length - 1 ? tops[k + 1] : n - 1;
    const b0 = top > left ? argmin(rise, left, top) : left;
    const b1 = right > top ? argmin(rise, top, right) : right;
    const eb = Math.max(elbow[b0], elbow[b1]), et = elbow[top];
    if (isNum(eb) && isNum(et) && (eb - et) < cfg.minElbowFlexionDeg) continue;
    if ((b1 - b0) < cfg.minRepFrames) continue;
    if ((top - b0) < 3 || (b1 - top) < 3) continue;
    if (cfg.requireOverhead) {
      const bout = overhead.slice(b0, b1 + 1);
      const frac = bout.reduce((a, b) => a + (b ? 1 : 0), 0) / bout.length;
      if (!(overhead[b0] || overhead[b1] || frac >= 0.5)) continue;
    }
    reps.push([b0, top, b1]);
  }
  return { reps, rise };
}

export function repCoordinates(F, rep, fps, pxPerM, deadHangY, midX) {
  const [b0, , b1] = rep, lo = F._lo;
  const sl = (a) => interpNan(a).slice(b0, b1 + 1);
  const elbow = sl(F.elbow), shoulder = sl(F.shoulder);
  const hip = sl(F.hip), knee = sl(F.knee), trunk = sl(F.trunk);
  const hipY = sl(F.hip_cy), hipX = sl(F.hip_cx);
  const times = [], z = [];
  for (let i = b0; i <= b1; i++) { times.push((lo + i) / fps); z.push(0); }
  return {
    times,
    coords: {
      pelvis_tilt: z, pelvis_tx: z,
      pelvis_ty: hipY.map((y) => (deadHangY - y) / pxPerM),
      pelvis_tz: hipX.map((x) => (x - midX) / pxPerM),
      hip_flexion_r: clipArr(hip.map((v) => 180 - v), -20, 120),
      hip_flexion_l: clipArr(hip.map((v) => 180 - v), -20, 120),
      knee_angle_r: clipArr(knee.map((v) => 180 - v), 0, 140),
      knee_angle_l: clipArr(knee.map((v) => 180 - v), 0, 140),
      arm_flex_r: clipArr(shoulder, 0, 180), arm_flex_l: clipArr(shoulder, 0, 180),
      elbow_flex_r: clipArr(elbow.map((v) => 180 - v), 0, 150),
      elbow_flex_l: clipArr(elbow.map((v) => 180 - v), 0, 150),
      flex_extension: clipArr(trunk, -30, 30),
    },
  };
}

export function referencePositions(F) {
  return [nanpercentile(interpNan(F.hip_cy), 90), nanmedian(interpNan(F.hip_cx))];
}

// ---------------------------------------------------------------------------
// squats
// ---------------------------------------------------------------------------
export const DEFAULT_SQUAT_CFG = {
  minDepthFrac: 0.12, minRepFrames: 12, minKneeFlexionDeg: 45,
  smoothWin: 5, minHipFlexionDeg: 25,
};

export function buildSquatFeatures(poses) {
  const frames = Object.keys(poses).map(Number).sort((a, b) => a - b);
  if (!frames.length) throw new Error("no pose frames");
  const lo = frames[0], hi = frames[frames.length - 1];
  const n = hi - lo + 1;
  const keys = ["hip_cy", "hip_cx", "shoulder_cy", "shoulder_cx",
                "ankle_cy", "ankle_cx", "knee_cy", "knee_cx", "toe_cy", "toe_cx",
                "knee_flex", "hip_flex", "ankle_dorsi", "trunk_lean", "shank_len",
                // Per side. The two-legged tasks average the sides because they
                // are meant to be symmetric; a single-leg squat, a stride and a
                // side step are not, and averaging them destroys the one thing
                // worth measuring. Filled for every squat-like task so the code
                // below can pick per-leg or averaged without a second pass.
                "knee_flex_l", "knee_flex_r", "hip_flex_l", "hip_flex_r",
                "ankle_dorsi_l", "ankle_dorsi_r", "foot_y_l", "foot_y_r",
                "hip_y_l", "hip_y_r"];
  const F = {};
  for (const k of keys) F[k] = new Array(n).fill(NaN);

  for (const fi of frames) {
    const i = fi - lo, lm = poses[fi];
    const ls = lm.left_shoulder, rs = lm.right_shoulder;
    const lh = lm.left_hip, rh = lm.right_hip;
    const lk = lm.left_knee, rk = lm.right_knee;
    const la = lm.left_ankle, ra = lm.right_ankle;
    const lf = lm.left_foot_index, rf = lm.right_foot_index;
    const sh = mid(ls, rs), hp = mid(lh, rh), an = mid(la, ra);
    const kn = mid(lk, rk), ft = mid(lf, rf);
    if (sh) { F.shoulder_cy[i] = sh[1]; F.shoulder_cx[i] = sh[0]; }
    if (hp) { F.hip_cy[i] = hp[1]; F.hip_cx[i] = hp[0]; }
    if (an) { F.ankle_cy[i] = an[1]; F.ankle_cx[i] = an[0]; }
    if (kn) { F.knee_cy[i] = kn[1]; F.knee_cx[i] = kn[0]; }
    if (ft) { F.toe_cy[i] = ft[1]; F.toe_cx[i] = ft[0]; }
    F.knee_flex[i] = 180 - nanmean([angle3(lh, lk, la), angle3(rh, rk, ra)]);
    F.hip_flex[i] = 180 - nanmean([angle3(ls, lh, lk), angle3(rs, rh, rk)]);
    F.ankle_dorsi[i] = 90 - nanmean([angle3(lk, la, lf), angle3(rk, ra, rf)]);
    F.knee_flex_l[i] = 180 - angle3(lh, lk, la);
    F.knee_flex_r[i] = 180 - angle3(rh, rk, ra);
    F.hip_flex_l[i] = 180 - angle3(ls, lh, lk);
    F.hip_flex_r[i] = 180 - angle3(rs, rh, rk);
    F.ankle_dorsi_l[i] = 90 - angle3(lk, la, lf);
    F.ankle_dorsi_r[i] = 90 - angle3(rk, ra, rf);
    // Lowest point of each foot: whichever of ankle and toe is further down the
    // image. Contact is about the foot, not about one landmark on it.
    const fl = [la && la[1], lf && lf[1]].filter(isNum);
    const fr = [ra && ra[1], rf && rf[1]].filter(isNum);
    if (fl.length) F.foot_y_l[i] = Math.max(...fl);
    if (fr.length) F.foot_y_r[i] = Math.max(...fr);
    if (lh) F.hip_y_l[i] = lh[1];
    if (rh) F.hip_y_r[i] = rh[1];
    if (sh && hp) {
      F.trunk_lean[i] = (Math.atan2(sh[0] - hp[0], Math.max(hp[1] - sh[1], 1e-6)) * 180) / Math.PI;
    }
    if (hp && an) F.shank_len[i] = Math.abs(hp[1] - an[1]);
  }

  const standY = nanpercentile(F.hip_cy, 10);
  let scale = nanmedian(F.shank_len);
  if (!(scale > 1e-6)) scale = 1.0;
  F.depth = F.hip_cy.map((y) => (y - standY) / scale);

  F._lo = lo; F._n = n; F._scale = scale; F._standY = standY;
  // Floor level in image pixels: the lowest foot position observed.
  // The floor is where the feet spend their time, not the single lowest pixel
  // any foot ever reached. One dropped frame or one crouch put the floor below
  // the feet for the whole clip, and everything after looked airborne.
  const feet = [...F.toe_cy, ...F.ankle_cy].filter(isNum);
  F._floorY = feet.length ? nanpercentile(feet, 97) : 0;
  F._coverage = frames.length / n;
  return F;
}

export function findSquatReps(F, cfg = DEFAULT_SQUAT_CFG) {
  const n = F._n;
  const depth = smooth(interpNan(F.depth), cfg.smoothWin);
  const knee = interpNan(F.knee_flex), hip = interpNan(F.hip_flex);
  const bottoms = localMaxima(depth, cfg.minRepFrames, cfg.minDepthFrac);
  const reps = [];
  for (let k = 0; k < bottoms.length; k++) {
    const bot = bottoms[k];
    const left = k > 0 ? bottoms[k - 1] : 0;
    const right = k < bottoms.length - 1 ? bottoms[k + 1] : n - 1;
    const t0 = bot > left ? argmin(depth, left, bot) : left;
    const t1 = right > bot ? argmin(depth, bot, right) : right;
    if ((knee[bot] - Math.min(knee[t0], knee[t1])) < cfg.minKneeFlexionDeg) continue;
    if ((hip[bot] - Math.min(hip[t0], hip[t1])) < cfg.minHipFlexionDeg) continue;
    if ((t1 - t0) < cfg.minRepFrames) continue;
    if ((bot - t0) < 3 || (t1 - bot) < 3) continue;
    reps.push([t0, bot, t1]);
  }
  return { reps, depth };
}

export function squatRepCoordinates(F, rep, fps, pxPerM, standHipY, midX,
                                    { model = "gpk", ankleValid = true } = {}) {
  const [t0, , t1] = rep, lo = F._lo;
  const sl = (a) => interpNan(a).slice(t0, t1 + 1);
  const knee = sl(F.knee_flex), hip = sl(F.hip_flex);
  const ankle = sl(F.ankle_dorsi), lean = sl(F.trunk_lean);
  const hipY = sl(F.hip_cy), hipX = sl(F.hip_cx), ankleY = sl(F.ankle_cy);
  const times = [], z = [];
  for (let i = t0; i <= t1; i++) { times.push((lo + i) / fps); z.push(0); }
  const sign = KNEE_SIGN[model] ?? -1;
  const hipFlex = clipArr(hip, -20, 130);
  const kneeAng = clipArr(knee, 0, 145).map((v) => sign * v);
  // A frontal view pins knee-ankle-toe at the clip bound; a saturated constant
  // would masquerade as data, so emit zero and report it separately instead.
  const ankleAng = ankleValid ? clipArr(ankle, -40, 40) : ankle.map(() => 0);
  return {
    times,
    coords: {
      pelvis_tx: z,
      // ABSOLUTE height above the floor, not a displacement: OpenSim's
      // pelvis_ty is the pelvis origin height (GPK defaults to 0.93 m), so a
      // displacement starting near zero drops the model through the floor.
      pelvis_ty: ankleY.map((ay, i) => (ay - hipY[i]) / pxPerM + ANKLE_JOINT_HEIGHT_M),
      pelvis_tz: hipX.map((x) => (x - midX) / pxPerM),
      hip_flexion_r: hipFlex, hip_flexion_l: hipFlex,
      knee_angle_r: kneeAng, knee_angle_l: kneeAng,
      ankle_angle_r: ankleAng, ankle_angle_l: ankleAng,
      lumbar_extension: clipArr(lean.map((v) => -v), -60, 30),
    },
  };
}

export function squatReferencePositions(F) {
  return [F._standY, nanmedian(interpNan(F.hip_cx))];
}

// ---------------------------------------------------------------------------
// neck (close-up cervical range of motion)
// ---------------------------------------------------------------------------
// Coordinate ranges in bas_v3 / gwen_v3, degrees. Used to split a measured
// angle between the two cervical joints and to clip each to its own limit.
export const NECK_RANGES = {
  pitch1: [-16, 24], pitch2: [-33, 48],
  roll1: [-6, 6],    roll2: [-33, 33],
  yaw1: [-38, 38],   yaw2: [-27, 27],
};
export const NECK_DRIVEN_COORDS = ["pitch1", "roll1", "yaw1", "pitch2", "roll2", "yaw2"];
export const DEFAULT_NECK_CFG = { minExcursionDeg: 20, minRepFrames: 10, smoothWin: 5 };

export function buildNeckFeatures(poses) {
  /* Only head and shoulder landmarks: designed for a camera near the face,
     where hips and knees are out of frame and MediaPipe's estimates of them
     are guesses. */
  const frames = Object.keys(poses).map(Number).sort((a, b) => a - b);
  if (!frames.length) throw new Error("no pose frames");
  const lo = frames[0], hi = frames[frames.length - 1], n = hi - lo + 1;
  const F = {};
  for (const k of ["pitch", "yaw", "roll", "head_px", "shoulder_cy", "hip_cy"]) {
    F[k] = new Array(n).fill(NaN);
  }
  for (const fi of frames) {
    const i = fi - lo, lm = poses[fi];
    const le = lm.left_ear, re = lm.right_ear, nose = lm.nose;
    const ls = lm.left_shoulder, rs = lm.right_shoulder;
    const sh = mid(ls, rs), hp = mid(lm.left_hip, lm.right_hip);
    if (sh) F.shoulder_cy[i] = sh[1];
    if (hp) F.hip_cy[i] = hp[1];
    if (!(le && re && nose)) continue;

    const em = [(le[0] + re[0]) / 2, (le[1] + re[1]) / 2];
    const ev = [re[0] - le[0], re[1] - le[1]];
    const el = Math.hypot(ev[0], ev[1]);
    if (el < 1e-6) continue;
    F.head_px[i] = el;
    const ux = ev[0] / el, uy = ev[1] / el;
    const dx = nose[0] - em[0], dy = nose[1] - em[1];
    // Yaw: nose slides along the ear axis as the head turns.
    const along = dx * ux + dy * uy;
    F.yaw[i] = -(Math.asin(Math.max(-1, Math.min(1, along / (el * 0.9)))) * 180) / Math.PI;
    // Pitch: nose above/below the ear line.
    const perp = dx * -uy + dy * ux;
    F.pitch[i] = (Math.atan2(perp, el * 0.75) * 180) / Math.PI - 35;
    // Roll: ear line tilted against the shoulder line.
    const ea = (Math.atan2(ev[1], ev[0]) * 180) / Math.PI;
    if (ls && rs) {
      const sa = (Math.atan2(rs[1] - ls[1], rs[0] - ls[0]) * 180) / Math.PI;
      F.roll[i] = ((ea - sa + 180) % 360) - 180;
    } else F.roll[i] = ea;
  }
  let scale = nanmedian(F.head_px);
  if (!(scale > 1e-6)) scale = 1;
  F._lo = lo; F._n = n; F._scale = scale; F._coverage = frames.length / n;
  return F;
}

export function findNeckReps(F, cfg = DEFAULT_NECK_CFG) {
  let axis = "pitch", best = -1, v = null;
  for (const k of ["pitch", "yaw", "roll"]) {
    const a = smooth(interpNan(F[k]), cfg.smoothWin);
    const r = a.length ? Math.max(...a) - Math.min(...a) : 0;
    if (r > best) { best = r; axis = k; v = a; }
  }
  const n = v ? v.length : 0;
  if (!v || n < cfg.minRepFrames || best < cfg.minExcursionDeg) {
    return { reps: [], depth: v || [], axis };
  }
  const midv = (Math.max(...v) + Math.min(...v)) / 2;
  const away = v.map((x) => Math.abs(x - midv) > best * 0.30);
  const reps = [];
  let i = 0;
  while (i < n) {
    if (!away[i]) { i++; continue; }
    let j = i;
    while (j < n && away[j]) j++;
    if (j - i >= cfg.minRepFrames) {
      let ext = i, bestd = -1;
      for (let k = i; k < j; k++) {
        const d = Math.abs(v[k] - midv);
        if (d > bestd) { bestd = d; ext = k; }
      }
      const a = Math.max(0, i - 2), b = Math.min(n - 1, j + 1);
      if (ext - a >= 2 && b - ext >= 2) reps.push([a, ext, b]);
    }
    i = j;
  }
  return { reps, depth: v, axis };
}

export function neckRepCoordinates(F, rep, fps) {
  const [t0, , t1] = rep, lo = F._lo;
  const sl = (a) => interpNan(a).slice(t0, t1 + 1);
  const pitch = sl(F.pitch), yaw = sl(F.yaw), roll = sl(F.roll);
  const times = [];
  for (let i = t0; i <= t1; i++) times.push((lo + i) / fps);
  // Share one measured angle between the two cervical joints in proportion to
  // their ranges, so neither is driven past what the model allows.
  const split = (val, upper, lower) => {
    const [lu, hu] = NECK_RANGES[upper], [ll, hl] = NECK_RANGES[lower];
    const su = hu - lu, slw = hl - ll, f = su / Math.max(1e-6, su + slw);
    return [val.map((x) => clip(x * f, lu, hu)),
            val.map((x) => clip(x * (1 - f), ll, hl))];
  };
  const [p1, p2] = split(pitch, "pitch1", "pitch2");
  const [r1, r2] = split(roll, "roll1", "roll2");
  const [y1, y2] = split(yaw, "yaw1", "yaw2");
  return { times, coords: { pitch1: p1, pitch2: p2, roll1: r1, roll2: r2,
                            yaw1: y1, yaw2: y2 } };
}

export function neckReferencePositions() { return [0, 0]; }

// ---------------------------------------------------------------------------
// scaling and export
// ---------------------------------------------------------------------------
const SEGMENT_PAIRS = {
  trunk: [["left_shoulder", "left_hip"], ["right_shoulder", "right_hip"]],
  thigh: [["left_hip", "left_knee"], ["right_hip", "right_knee"]],
  shank: [["left_knee", "left_ankle"], ["right_knee", "right_ankle"]],
  upper_arm: [["left_shoulder", "left_elbow"], ["right_shoulder", "right_elbow"]],
  forearm: [["left_elbow", "left_wrist"], ["right_elbow", "right_wrist"]],
};

export function computePxPerM(poses, heightM, fractions = null) {
  const fr = { ...DEFAULT_FRACTIONS, ...(fractions || {}) };
  const ests = [], detail = {};
  for (const [seg, pairs] of Object.entries(SEGMENT_PAIRS)) {
    const lengths = [];
    for (const lm of Object.values(poses)) {
      for (const [a, b] of pairs) {
        const L = segLen(lm, a, b);
        if (isNum(L)) lengths.push(L);
      }
    }
    if (!lengths.length) continue;
    const medPx = nanmedian(lengths);
    const metric = fr[seg] * heightM;
    const est = medPx / metric;
    ests.push(est);
    detail[seg] = { median_px: medPx, metric_m: metric, px_per_m: est };
  }
  if (!ests.length) throw new Error("no usable segments for pixel scaling");
  return { pxPerM: nanmedian(ests), detail };
}

export function viewQuality(poses) {
  /* How side-on the camera is, and whether the feet are usable.
     Every angle here is SAGITTAL and only meaningful from the side. Filmed
     face-on, knee and hip still produce plausible-looking numbers while
     measuring something else, and the ankle degenerates completely. */
  const seps = [], torsos = [], ankles = [];
  for (const lm of Object.values(poses)) {
    const ls = lm.left_shoulder, rs = lm.right_shoulder;
    const sh = mid(ls, rs), hp = mid(lm.left_hip, lm.right_hip);
    if (ls && rs) seps.push(Math.abs(ls[0] - rs[0]));
    if (sh && hp) torsos.push(Math.hypot(sh[0] - hp[0], sh[1] - hp[1]));
    for (const side of ["left", "right"]) {
      const a = angle3(lm[`${side}_knee`], lm[`${side}_ankle`], lm[`${side}_foot_index`]);
      if (isNum(a)) ankles.push(a);
    }
  }
  const torso = torsos.length ? nanmedian(torsos) : 1;
  const frontality = seps.length && torso > 1e-6 ? nanmedian(seps) / torso : NaN;
  const medAnkle = ankles.length ? nanmedian(ankles) : NaN;
  const view = !isNum(frontality) ? "unknown"
    : frontality < 0.30 ? "sagittal" : frontality < 0.45 ? "oblique" : "frontal";
  return {
    frontality: isNum(frontality) ? +frontality.toFixed(3) : null,
    view,
    ankle_usable: isNum(medAnkle) && medAnkle < 155,
    median_ankle_interior_deg: isNum(medAnkle) ? +medAnkle.toFixed(1) : null,
  };
}

export function writeMot(name, columns, times, coords) {
  const cols = ["time", ...columns];
  const lines = [name, "version=1", `nRows=${times.length}`,
                 `nColumns=${cols.length}`, "inDegrees=yes", "endheader",
                 cols.join("\t")];
  for (let i = 0; i < times.length; i++) {
    const row = [times[i], ...columns.map((c) => (coords[c] ? coords[c][i] : 0))];
    lines.push(row.map((v) => v.toFixed(8).padStart(16)).join("\t"));
  }
  return lines.join("\n") + "\n";
}

export function jointPositionsM(F, rep, pxPerM, floorY) {
  /* Landmark positions for one rep in METRES, world frame, y UP.
     Image y grows downward and the floor is the lowest observed foot position,
     so this flips and offsets into a physical frame the dynamics can use. */
  const [t0, , t1] = rep;
  const grab = (xk, yk) => {
    const x = interpNan(F[xk]).slice(t0, t1 + 1);
    const y = interpNan(F[yk]).slice(t0, t1 + 1);
    return x.map((v, i) => [v / pxPerM, (floorY - y[i]) / pxPerM]);
  };
  return {
    ankle: grab("ankle_cx", "ankle_cy"), knee: grab("knee_cx", "knee_cy"),
    hip: grab("hip_cx", "hip_cy"), shoulder: grab("shoulder_cx", "shoulder_cy"),
    toe: grab("toe_cx", "toe_cy"),
  };
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// vertical jumps: countermovement (CMJ) and squat jump (SJ)
// ---------------------------------------------------------------------------
/* A jump is the one task here with a FLIGHT phase, and that is what makes it
 * findable: during a squat the feet never leave the floor, so a foot rise of
 * more than a few centimetres is not ambiguous. It is also what makes the
 * height computable, by two independent routes that are worth reporting
 * separately because they fail in different ways.
 *
 *   flight time    h = g t^2 / 8. The textbook method. It assumes the body is
 *                  in the same posture at take-off and at touch-down; land
 *                  with more knee flexion than you took off with and it
 *                  overestimates. Its resolution is the frame rate: one frame
 *                  of error at 30 fps is about 2 cm at a 40 cm jump, 1 cm at
 *                  60 fps. Reported with that uncertainty attached.
 *
 *   COM rise       how far the hip centre actually travelled, in metres,
 *                  from take-off to the apex. No posture assumption, but it
 *                  inherits every bit of pose jitter and the pixel-to-metre
 *                  scale, and the hip is not the whole-body centre of mass.
 *
 * They usually disagree by a few centimetres. That disagreement is information
 * about the jump, not an error to hide, so both are shown.
 */
export const DEFAULT_JUMP_CFG = {
  smoothWin: 3,
  // Foot rise that counts as airborne, as a fraction of F._scale, so it scales
  // with the athlete and the camera distance.
  //
  // F._scale is the median HIP-TO-ANKLE distance -- standing hip height, about
  // 0.95 m on a 1.81 m athlete -- not the shank. Reading it as a shank made
  // every threshold here 2.3x what was intended: the take-off edge sat at 4.8
  // cm instead of 2 cm, so the first airborne frames were missed and the flight
  // came up 3 cm short at 60 fps. 0.07 is about 6.6 cm: above heel lift in a
  // deep squat, below any real flight.
  liftFrac: 0.07,
  // The threshold that FINDS a jump is the wrong one to TIME it with. Timing
  // from the moment the foot passes 6 cm cost 30% of the flight in testing
  // (0.35 s measured against 0.50 s true), because the foot spends real time
  // between the floor and 6 cm at both ends. So the edges are located at a
  // near-floor threshold instead, and the crossing is interpolated between
  // frames -- which also buys back most of the frame-rate resolution.
  // About 1.4 cm of hip height: above pose jitter, low enough that the first
  // airborne frames are not skipped. What actually caused the 0.4 s flight to
  // be read as 1.99 s -- a 48 cm jump as 484 cm -- was not this threshold but
  // the walk out to it running unbounded to the ends of the window. The walk
  // is capped now, so the edge can stay where the physics wants it.
  edgeFrac: 0.015,
  maxEdgeWalkS: 0.10,   // the foot clears 2 cm in a frame or two, not in half a second
  minFlightFrames: 2,     // 2 frames at 30 fps is a 6.7 cm jump -- the floor
  maxFlightFrames: 60,
  // A countermovement is a dip below the starting hip height, as a fraction of
  // shank length. 0.08 is about 3 cm, past pose jitter.
  dipFrac: 0.08,
  preRollFrames: 45,      // how far back to look for the start of the movement
  postRollFrames: 30,
  /* Everything here is measured from the FEET, so the feet have to be in the
   * picture. MediaPipe reports a position for every landmark whether or not it
   * can see it, and an off-screen ankle comes back as a confident guess that
   * drifts -- which reads as flight. Below this fraction of frames with a
   * usable foot, a jump is not measurable from this clip and saying so is the
   * only honest output. */
  minFootCoverage: 0.9,
  /* A hard physical ceiling. The best standing vertical jumps ever recorded
   * are a little over a metre; anything past this is not a jump that was
   * mismeasured, it is not a jump. */
  maxHeightM: 1.10,
  /* The two heights are independent -- flight time knows nothing about the
   * pixel scale, hip rise knows nothing about gravity -- so on a clean clip
   * they agree within a few centimetres. A factor of 1.5 is already far outside
   * that. */
  maxHeightRatio: 1.5,
  /* Two physical tests that a squat cannot pass, however the foot signal
   * misbehaves. A frontal-view squat produced three "squat jumps" with peak
   * moments of 77 kN.m, and no threshold on the FEET alone was ever going to
   * stop it -- the feet are exactly what the camera sees worst.
   *
   *   the hip must leave the ground   during flight the hip has to rise above
   *   the highest it reached with the feet down. In a squat it never does; the
   *   hip only ever goes lower than standing.
   *
   *   the hip must be in free fall    fit the hip's path during flight and its
   *   acceleration must be about g. A body in the air has no choice about
   *   this; a body squatting has no reason to obey it.
   */
  minApexRiseFrac: 0.03,   // ~3 cm of hip height above the standing reference
  freeFallMin: 4.0,        // m/s^2 -- wide, because pxPerM and pose both wobble
  freeFallMax: 20.0,
  freeFallMinFrames: 5,
};

export function buildJumpFeatures(poses) {
  const F = buildSquatFeatures(poses);
  // Height of the LOWEST part of the foot above the floor, in pixels. The
  // floor is the lowest foot position seen anywhere in the clip, which for a
  // jump is a stance frame -- the athlete is on the ground far more of the
  // time than in the air.
  const n = F._n;
  F.foot_rise = new Array(n).fill(NaN);
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const a = F.ankle_cy[i], t = F.toe_cy[i];
    const low = Math.max(isNum(a) ? a : -Infinity, isNum(t) ? t : -Infinity);
    if (Number.isFinite(low)) { F.foot_rise[i] = F._floorY - low; seen++; }
  }
  F._footCoverage = n ? seen / n : 0;
  return F;
}

/** Contiguous runs where the feet are off the floor. */
function flightRuns(rise, thresh, cfg) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < rise.length; i++) {
    const air = rise[i] > thresh;
    if (air && start < 0) start = i;
    if ((!air || i === rise.length - 1) && start >= 0) {
      const end = air ? i : i - 1;
      const len = end - start + 1;
      if (len >= cfg.minFlightFrames && len <= cfg.maxFlightFrames) {
        runs.push([start, end]);
      }
      start = -1;
    }
  }
  return runs;
}

/** One "rep" per jump: [start of movement, take-off, end of landing]. */
export function findJumpReps(F, cfg = DEFAULT_JUMP_CFG) {
  const n = F._n;
  // No feet, no jump. Refusing is the answer here, not a number with a
  // caveat: with the ankles off-screen every quantity below is measuring
  // MediaPipe's imagination.
  if ((F._footCoverage ?? 1) < cfg.minFootCoverage) {
    return { reps: [], rise: [], refused: "feet" };
  }
  const rise = smooth(interpNan(F.foot_rise), cfg.smoothWin);
  const hipY = smooth(interpNan(F.hip_cy), cfg.smoothWin);
  const thresh = cfg.liftFrac * (F._scale || 1);
  const reps = [];
  let prevEnd = -1;
  const runs = flightRuns(rise, thresh, cfg);
  /* How high the hip gets while the feet are demonstrably on the floor. The
   * 10th percentile rather than the minimum, so one noisy frame cannot raise
   * the bar the jump has to clear. */
  const edge = cfg.edgeFrac * (F._scale || 1);
  const grounded = [];
  for (let i = 0; i < n; i++) if (!(rise[i] > edge) && isNum(hipY[i])) grounded.push(hipY[i]);
  const standRef = grounded.length ? nanpercentile(grounded, 10) : -Infinity;

  for (let ri = 0; ri < runs.length; ri++) {
    const [a, b] = runs[ri];
    // Smaller y is higher on screen: the apex must beat the standing reference.
    let apexY = Infinity;
    for (let i = a; i <= b; i++) if (isNum(hipY[i]) && hipY[i] < apexY) apexY = hipY[i];
    if (!(standRef - apexY > cfg.minApexRiseFrac * (F._scale || 1))) continue;
    // Never let one jump's trailing window swallow the next one's start. The
    // half-second of post-roll is for watching the landing, not for claiming
    // the frames the following jump needs.
    const nextStart = ri + 1 < runs.length ? runs[ri + 1][0] : n;
    const takeoff = a;
    // Walk back to where the hip stopped being still: the top of the dip for a
    // countermovement jump, the start of the push for a squat jump.
    let t0 = Math.max(prevEnd + 1, takeoff - cfg.preRollFrames);
    // A previous jump's window must not push the start past this take-off.
    if (t0 > takeoff - 3) t0 = Math.max(0, takeoff - 3);
    let best = takeoff;
    for (let i = takeoff; i > t0; i--) {
      if (hipY[i] > hipY[best]) best = i;      // larger y = lower on screen
    }
    // the frame before the descent began, searching back from the lowest point
    let s0 = best;
    while (s0 > t0 && hipY[s0 - 1] < hipY[s0]) s0--;
    t0 = Math.min(best, s0);
    const t1 = Math.min(n - 1, b + cfg.postRollFrames, nextStart - 1);
    if (t1 - t0 < 4) continue;
    reps.push([t0, takeoff, t1]);
    prevEnd = t1;
  }
  return { reps, rise };
}

/**
 * Jump metrics for one rep. `rep` is [t0, takeoff, t1] from findJumpReps.
 * Returns null when the flight phase cannot be located again, which should not
 * happen but is not worth throwing over.
 */
export function jumpMetrics(F, rep, fps, pxPerM, cfg = DEFAULT_JUMP_CFG) {
  const [t0, takeoff, t1] = rep;
  // Two versions of the same signal, on purpose. Smoothing is what makes the
  // FLIGHT PHASE findable through pose jitter, and it is also what ruins the
  // take-off INSTANT: a 3-frame average spreads a transition that really
  // happens between two frames, and at 30 fps the foot covers ~10 cm in one
  // frame, so the smeared edge overestimated height by up to 10 cm. Detect on
  // the smoothed signal, time on the raw one.
  const riseRaw = interpNan(F.foot_rise);
  const rise = smooth(riseRaw, cfg.smoothWin);
  const hipY = smooth(interpNan(F.hip_cy), cfg.smoothWin);
  const thresh = cfg.liftFrac * (F._scale || 1);
  const edge = cfg.edgeFrac * (F._scale || 1);
  let land = takeoff;
  while (land + 1 <= t1 && rise[land + 1] > thresh) land++;
  const flightFrames = land - takeoff + 1;
  if (flightFrames < cfg.minFlightFrames) return null;

  // Walk out to the near-floor crossings, then interpolate between the two
  // frames that straddle each one for a sub-frame instant.
  const walk = Math.max(1, Math.round(cfg.maxEdgeWalkS * fps));
  const aMin = Math.max(t0, takeoff - walk), bMax = Math.min(t1, land + walk);
  let a = takeoff;
  while (a > aMin && riseRaw[a - 1] > edge) a--;
  let b2 = land;
  while (b2 < bMax && riseRaw[b2 + 1] > edge) b2++;
  /* Find the edge with a threshold that sits above pose jitter, then read the
   * instant off the AIRBORNE side of it.
   *
   * Timing the crossing of a 2 cm threshold rather than the floor shortens the
   * flight systematically -- 2 to 4 cm of height at 60 fps in testing. But the
   * two frames either side of the threshold straddle the take-off itself: the
   * earlier one has the foot still on the floor, so a line through them is not
   * the foot's trajectory and extrapolating it lands early. The first two
   * frames that are genuinely in the air are on the trajectory, and just after
   * take-off the foot rises very nearly linearly, so the line through those,
   * run back to zero, is the take-off instant. Same argument in reverse for
   * touch-down. Clamped to one frame either side, since the crossing cannot be
   * further away than that.
   */
  const zeroBefore = (i, j) => {          // i, j airborne; j is further in
    const yi = riseRaw[i], yj = riseRaw[j];
    if (!Number.isFinite(yi) || !Number.isFinite(yj) || yi === yj) return i;
    const t = i + (0 - yi) * (j - i) / (yj - yi);
    const lo = Math.min(i, i - (j - i)), hi = Math.max(i, i - (j - i));
    return Math.max(lo, Math.min(hi, t));
  };
  const offF = a + 1 <= b2 ? zeroBefore(a, a + 1) : a;
  const onF = b2 - 1 >= a ? zeroBefore(b2, b2 - 1) : b2;
  const G = 9.80665;
  const flight_s = Math.max(0, (onF - offF)) / fps;
  const height_flight_m = (G * flight_s * flight_s) / 8;
  // One frame either side of the flight phase, converted to height. This is
  // the resolution of the method, not a confidence interval.
  const dt = 1 / fps;
  const hPlus = (G * (flight_s + dt) ** 2) / 8;
  const hMinus = (G * Math.max(0, flight_s - dt) ** 2) / 8;
  const flight_uncertainty_m = Math.max(hPlus - height_flight_m,
                                        height_flight_m - hMinus);

  // Apex of the hip centre during flight, in metres above its height at the
  // instant the feet left the floor -- not at the threshold crossing, which is
  // already several centimetres into the rise.
  const offIdx = Math.max(0, Math.round(offF));
  let apex = offIdx;
  for (let i = offIdx; i <= b2; i++) if (hipY[i] < hipY[apex]) apex = i;
  const height_com_m = pxPerM > 0 ? (hipY[offIdx] - hipY[apex]) / pxPerM : NaN;

  // Countermovement: how far the hip dipped below where it started.
  let lowest = t0;
  for (let i = t0; i <= offIdx; i++) if (hipY[i] > hipY[lowest]) lowest = i;
  const dip_px = hipY[lowest] - hipY[t0];
  const countermovement_m = pxPerM > 0 ? dip_px / pxPerM : NaN;
  const hasCountermovement = dip_px > cfg.dipFrac * (F._scale || 1);

  /* Two guards, because a number in a table is read as a measurement.
   *
   * A flight longer than the detector will accept is not a flight -- it is the
   * foot signal never coming back to the floor, which is what a lost or
   * out-of-frame foot looks like.
   *
   * And the two heights are independent: flight time knows nothing about the
   * pixel scale, hip rise knows nothing about gravity. When they disagree by
   * more than a factor of two something is wrong with one of them, and which
   * one is not knowable from here. */
  /* Free fall. Least squares parabola through the hip during flight; the
   * quadratic term is half the acceleration. Image y grows downward, so a body
   * in the air gives a POSITIVE acceleration of about g. Anything else was not
   * in the air. */
  let freeFallA = null;
  if (b2 - offIdx + 1 >= cfg.freeFallMinFrames && pxPerM > 0) {
    let n0 = 0, sx1 = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy0 = 0, sxy = 0, sx2y = 0;
    for (let i = offIdx; i <= b2; i++) {
      const y = hipY[i];
      if (!Number.isFinite(y)) continue;
      const x = (i - offIdx) / fps;
      const x2 = x * x;
      n0++; sx1 += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2;
      sy0 += y; sxy += x * y; sx2y += x2 * y;
    }
    if (n0 >= cfg.freeFallMinFrames) {
      // Solve the 3x3 normal equations by elimination; only the quadratic
      // coefficient is wanted.
      const M = [[n0, sx1, sx2, sy0], [sx1, sx2, sx3, sxy], [sx2, sx3, sx4, sx2y]];
      for (let c = 0; c < 3; c++) {
        let piv = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        if (Math.abs(M[c][c]) < 1e-12) { freeFallA = null; break; }
        for (let r = 0; r < 3; r++) {
          if (r === c) continue;
          const f = M[r][c] / M[c][c];
          for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
        }
      }
      if (Math.abs(M[2][2]) > 1e-12) freeFallA = 2 * (M[2][3] / M[2][2]) / pxPerM;
    }
  }
  const notFalling = freeFallA != null
    && (freeFallA < cfg.freeFallMin || freeFallA > cfg.freeFallMax);

  const tooLong = flight_s > cfg.maxFlightFrames / fps;
  const tooHigh = height_flight_m > cfg.maxHeightM
    || (Number.isFinite(height_com_m) && height_com_m > cfg.maxHeightM);
  const comH = Number.isFinite(height_com_m) ? height_com_m : null;
  const R = cfg.maxHeightRatio;
  const disagree = comH != null && comH > 0.02
    && (height_flight_m > R * comH || comH > R * height_flight_m);
  if (tooLong || tooHigh || notFalling) return null;

  return {
    implausible: disagree,
    free_fall_accel_ms2: freeFallA == null ? null : +freeFallA.toFixed(2),
    takeoff_frame: offIdx, land_frame: b2, apex_frame: apex,
    flight_s: +flight_s.toFixed(3),
    height_flight_m: +height_flight_m.toFixed(3),
    flight_uncertainty_m: +flight_uncertainty_m.toFixed(3),
    height_com_m: Number.isFinite(height_com_m) ? +height_com_m.toFixed(3) : null,
    countermovement_m: Number.isFinite(countermovement_m)
      ? +countermovement_m.toFixed(3) : null,
    has_countermovement: hasCountermovement,
    // Time from the start of the movement to take-off. For a CMJ this is the
    // whole countermovement plus push; for an SJ it is the push alone.
    push_s: +((offIdx - t0) / fps).toFixed(3),
  };
}

export function jumpReferencePositions(F) {
  return squatReferencePositions(F);
}


// ---------------------------------------------------------------------------
// single-leg squat, running and the side step
// ---------------------------------------------------------------------------
/* These three share the squat's feature builder and its coordinate set, and
 * differ in what counts as a repetition and in which side is measured.
 *
 * The squat, the pull-up and both jumps are written to the model symmetrically:
 * the two legs are averaged and the same curve is sent to left and right. That
 * is a defensible approximation for a two-legged task filmed from one camera.
 * It is not defensible here. A single-leg squat is asymmetric by definition, a
 * stride is asymmetric by a half-cycle, and a side step is asymmetric on
 * purpose -- so all three write the two legs separately, from the per-side
 * angles filled in by buildSquatFeatures.
 *
 * What they DON'T get is inverse dynamics on the same terms as a squat. Running
 * and the side step move the athlete through the frame, which breaks the fixed
 * pixel-to-metre scale that the ground reaction is derived from, and a side
 * step is a frontal-plane task that a sagittal camera cannot measure at all.
 * Those refusals live in index.html, next to the other view refusals.
 */

/** Which leg is on the floor: the one whose foot sits nearest the floor line
 *  for the largest share of the clip. Returns "l", "r", or null when neither
 *  side is clearly loaded (a two-legged movement mislabelled as single-leg). */
export function stanceSide(F, band = 0.10) {
  const fl = interpNan(F.foot_y_l), fr = interpNan(F.foot_y_r);
  const tol = band * F._scale;
  let nl = 0, nr = 0, both = 0, n = 0;
  for (let i = 0; i < F._n; i++) {
    if (!isNum(fl[i]) || !isNum(fr[i])) continue;
    n++;
    const dl = F._floorY - fl[i], dr = F._floorY - fr[i];
    const downL = dl < tol, downR = dr < tol;
    if (downL && downR) both++;
    else if (downL) nl++;
    else if (downR) nr++;
  }
  if (!n) return null;
  // Both feet down for most of the clip is a two-legged movement, whatever the
  // athlete was asked to do. Saying so is more useful than picking a side.
  if (both / n > 0.6) return null;
  if (nl === nr) return null;
  return nl > nr ? "l" : "r";
}

export const DEFAULT_SLSQUAT_CFG = {
  // Shallower than a two-legged squat on every threshold. A single-leg squat to
  // 45 deg of knee flexion is a normal one; using the squat's 45 deg minimum
  // found no reps at all in the first pass over real footage.
  minDepthFrac: 0.06, minRepFrames: 12, minKneeFlexionDeg: 25,
  smoothWin: 5, minHipFlexionDeg: 15,
};

export function findSLSquatReps(F, cfg = DEFAULT_SLSQUAT_CFG) {
  const side = stanceSide(F);
  if (!side) {
    return { reps: [], depth: F.depth,
             refused: "bothFeetDown", stanceSide: null };
  }
  const knee = interpNan(F["knee_flex_" + side]);
  const hip = interpNan(F["hip_flex_" + side]);
  const depth = smooth(interpNan(F.depth), cfg.smoothWin);
  const bottoms = localMaxima(depth, cfg.minRepFrames, cfg.minDepthFrac);
  const reps = [];
  for (let k = 0; k < bottoms.length; k++) {
    const bot = bottoms[k];
    const left = k > 0 ? bottoms[k - 1] : 0;
    const right = k < bottoms.length - 1 ? bottoms[k + 1] : F._n - 1;
    const t0 = bot > left ? argmin(depth, left, bot) : left;
    const t1 = right > bot ? argmin(depth, bot, right) : right;
    if ((knee[bot] - Math.min(knee[t0], knee[t1])) < cfg.minKneeFlexionDeg) continue;
    if ((hip[bot] - Math.min(hip[t0], hip[t1])) < cfg.minHipFlexionDeg) continue;
    if ((t1 - t0) < cfg.minRepFrames) continue;
    if ((bot - t0) < 3 || (t1 - bot) < 3) continue;
    reps.push([t0, bot, t1]);
  }
  return { reps, depth, stanceSide: side };
}

/* Foot contact, per side. A foot is down when it is within `band` shank lengths
 * of the floor line. The floor is the 97th percentile of every observed foot
 * position, which is robust to the one dropped frame that a plain minimum is
 * not. Returns contiguous [start, end] index pairs. */
function contactPeriods(F, side, band = 0.09, minFrames = 3, mergeGap = 3) {
  const y = interpNan(F["foot_y_" + side]);
  // Hysteresis: a foot has to come well clear of the floor to count as lifted,
  // once it is down. A single threshold chopped one stance into three whenever
  // the ankle landmark wobbled across the line -- and three stances is three
  // strides, which is how a 0.63 s stride came out as 0.42 s.
  const inTol = band * F._scale, outTol = 1.8 * band * F._scale;
  const out = [];
  let start = -1, down = false;
  for (let i = 0; i < F._n; i++) {
    const h = isNum(y[i]) ? F._floorY - y[i] : Infinity;
    down = down ? h < outTol : h < inTol;
    if (down && start < 0) start = i;
    if (!down && start >= 0) { out.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) out.push([start, F._n - 1]);
  // Close brief gaps, then drop anything too short to be a stance. Order
  // matters: dropping first would leave the two halves of a split stance to be
  // discarded separately instead of joined.
  const merged = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && c[0] - last[1] <= mergeGap) last[1] = c[1];
    else merged.push([c[0], c[1]]);
  }
  return merged.filter(([a, b]) => b - a + 1 >= minFrames);
}

/* Keep the contacts that are actually stances.
 *
 * Two kinds of rubbish come out of a threshold on foot height. The swing foot
 * dips back under the line for a frame or two as it passes the stance foot,
 * which looks like a very short contact; and the athlete stands still at both
 * ends of the clip, which looks like one very long one. Neither is a stance,
 * and both corrupt a stride: the short ones cut a 0.63 s stride to 0.42 s, and
 * the long ones put the whole standing period inside the first stride's
 * contact phase.
 *
 * The anchor is the 75th percentile of the observed lengths, not the median.
 * At a slow cadence the short artefacts can OUTNUMBER the real stances -- six
 * of them against four -- and a median then sits among the artefacts and throws
 * the real stances away instead. The upper quartile stays inside the real
 * stances in both cases. */
function realStances(cs, n) {
  if (cs.length < 3) return cs;
  const lens = cs.map(([a, b]) => b - a + 1).sort((a, b) => a - b);
  const typical = lens[Math.min(lens.length - 1,
                                Math.floor(0.75 * lens.length))];
  return cs.filter(([a, b], i) => {
    const len = b - a + 1;
    if (a === 0 || b === n - 1) return false;      // standing at either end
    return len >= 0.5 * typical && len <= 2.0 * typical;
  });
}

export const DEFAULT_RUN_CFG = {
  contactBand: 0.09, minContactFrames: 3, minStrideFrames: 10,
  maxStrideFrames: 90, smoothWin: 3,
};

/* A stride, not a step: contact of one foot to the next contact of the SAME
 * foot. That is the unit every running-gait norm is written in, and it is the
 * only unit whose start and end are the same event, which is what an ensemble
 * average needs. The middle marker is toe-off, so phases come out as
 * stance / swing rather than the squat's down / up. */
export function findRunReps(F, cfg = DEFAULT_RUN_CFG) {
  // Measure the side with more complete contact data; a stride is a stride
  // whichever foot defines it.
  const cl = realStances(contactPeriods(F, "l", cfg.contactBand,
                                        cfg.minContactFrames), F._n);
  const cr = realStances(contactPeriods(F, "r", cfg.contactBand,
                                        cfg.minContactFrames), F._n);
  const side = cl.length >= cr.length ? "l" : "r";
  const cs = side === "l" ? cl : cr;
  if (cs.length < 2) {
    return { reps: [], depth: F.depth, refused: "noStrides", runSide: side,
             contacts: cs };
  }
  const running = cs;
  const reps = [];
  for (let k = 0; k < running.length - 1; k++) {
    const t0 = running[k][0], toeOff = running[k][1], t1 = running[k + 1][0];
    const len = t1 - t0;
    if (len < cfg.minStrideFrames || len > cfg.maxStrideFrames) continue;
    if (toeOff <= t0 || toeOff >= t1) continue;
    reps.push([t0, toeOff, t1]);
  }
  return { reps, depth: F.depth, runSide: side, contacts: cs,
           otherContacts: side === "l" ? cr : cl };
}

export const DEFAULT_SIDESTEP_CFG = {
  // A side step is judged by how far the hips travel sideways, in shank
  // lengths. 0.5 is about a third of a metre on an adult -- below that it is
  // shuffling, not a cut.
  minExcursionFrac: 0.25, minRepFrames: 8, smoothWin: 5,
};

/* One rep is one lateral excursion and return: from a turning point in the hip
 * x-trace, through the far extreme, to the next turning point. The far extreme
 * is the plant, which is the instant the whole task is about. */
export function findSidestepReps(F, cfg = DEFAULT_SIDESTEP_CFG) {
  const x = smooth(interpNan(F.hip_cx), cfg.smoothWin);
  const mid0 = nanmedian(x);
  // Excursions to both sides. localMaxima only finds peaks, so the mirrored
  // trace is searched too and the two sets merged in time order.
  const dev = x.map((v) => Math.abs(v - mid0));
  const peaks = localMaxima(dev, cfg.minRepFrames, cfg.minExcursionFrac * F._scale);
  const reps = [];
  for (let k = 0; k < peaks.length; k++) {
    const pk = peaks[k];
    const left = k > 0 ? peaks[k - 1] : 0;
    const right = k < peaks.length - 1 ? peaks[k + 1] : F._n - 1;
    const t0 = pk > left ? argmin(dev, left, pk) : left;
    const t1 = right > pk ? argmin(dev, pk, right) : right;
    if ((t1 - t0) < cfg.minRepFrames) continue;
    if ((pk - t0) < 2 || (t1 - pk) < 2) continue;
    reps.push([t0, pk, t1]);
  }
  return { reps, depth: dev, midX: mid0 };
}

/* Per-leg coordinates. Same shape as squatRepCoordinates, but left and right
 * carry their own angles instead of one averaged curve. */
export function perLegRepCoordinates(F, rep, fps, pxPerM, standHipY, midX,
                                     { model = "gpk", ankleValid = true } = {}) {
  const [t0, , t1] = rep, lo = F._lo;
  const sl = (a) => interpNan(a).slice(t0, t1 + 1);
  const lean = sl(F.trunk_lean);
  const hipY = sl(F.hip_cy), hipX = sl(F.hip_cx), ankleY = sl(F.ankle_cy);
  const times = [], z = [];
  for (let i = t0; i <= t1; i++) { times.push((lo + i) / fps); z.push(0); }
  const sign = KNEE_SIGN[model] ?? -1;
  const kneeOf = (sd) => clipArr(sl(F["knee_flex_" + sd]), 0, 145).map((v) => sign * v);
  const hipOf = (sd) => clipArr(sl(F["hip_flex_" + sd]), -20, 130);
  const ankOf = (sd) => (ankleValid
    ? clipArr(sl(F["ankle_dorsi_" + sd]), -40, 40)
    : sl(F["ankle_dorsi_" + sd]).map(() => 0));
  return {
    times,
    coords: {
      pelvis_tx: z,
      pelvis_ty: ankleY.map((ay, i) => (ay - hipY[i]) / pxPerM + ANKLE_JOINT_HEIGHT_M),
      pelvis_tz: hipX.map((x) => (x - midX) / pxPerM),
      hip_flexion_r: hipOf("r"), hip_flexion_l: hipOf("l"),
      knee_angle_r: kneeOf("r"), knee_angle_l: kneeOf("l"),
      ankle_angle_r: ankOf("r"), ankle_angle_l: ankOf("l"),
      lumbar_extension: clipArr(lean.map((v) => -v), -60, 30),
    },
  };
}

/** Stride timing, in seconds, for one running rep. */
export function strideMetrics(F, rep, fps, found) {
  const [t0, toeOff, t1] = rep;
  const stride = (t1 - t0) / fps;
  const contact = (toeOff - t0 + 1) / fps;
  const swing = stride - contact;
  // Flight is the part of the stride with NEITHER foot down. On a walk it is
  // zero or negative, which is the honest way to say "this was not a run".
  const other = found.otherContacts || [];
  let bothDown = 0;
  for (const [a, b] of other) {
    const s0 = Math.max(a, t0), s1 = Math.min(b, toeOff);
    if (s1 >= s0) bothDown += s1 - s0 + 1;
  }
  let otherDown = 0;
  for (const [a, b] of other) {
    const s0 = Math.max(a, t0), s1 = Math.min(b, t1);
    if (s1 >= s0) otherDown += s1 - s0 + 1;
  }
  const airborne = Math.max(0, (t1 - t0 + 1) - (toeOff - t0 + 1) - otherDown
                               + bothDown);
  return {
    stride_s: +stride.toFixed(3),
    contact_s: +contact.toFixed(3),
    swing_s: +swing.toFixed(3),
    flight_s: +(airborne / fps).toFixed(3),
    duty_factor: +(contact / stride).toFixed(3),
    cadence_spm: +(120 / stride).toFixed(1),
    // A duty factor at or above 0.5 means at least one foot was always down.
    // That is walking, and it is worth saying out loud on a screen that says
    // "running" at the top.
    walking: contact / stride >= 0.5,
  };
}

/** Lateral excursion and plant timing for one side-step rep. */
export function sidestepMetrics(F, rep, fps, pxPerM, midX) {
  const [t0, pk, t1] = rep;
  const x = interpNan(F.hip_cx);
  const lean = interpNan(F.trunk_lean);
  const side = x[pk] > midX ? "r" : "l";
  const knee = interpNan(F["knee_flex_" + side]);
  return {
    excursion_m: +(Math.abs(x[pk] - midX) / pxPerM).toFixed(3),
    plant_side: side,
    out_s: +((pk - t0) / fps).toFixed(3),
    back_s: +((t1 - pk) / fps).toFixed(3),
    knee_flex_at_plant_deg: isNum(knee[pk]) ? +knee[pk].toFixed(1) : null,
    trunk_lean_at_plant_deg: isNum(lean[pk]) ? +lean[pk].toFixed(1) : null,
  };
}

export const ACTIVITIES = {
  pullup: {
    label: "pull-up", columns: DRIVEN_COORDS, defaultCfg: DEFAULT_PULLUP_CFG,
    features: buildFeatures, findReps, coords: repCoordinates,
    reference: referencePositions, phases: ["concentric_s", "eccentric_s"],
  },
  neck: {
    label: "neck movement", columns: NECK_DRIVEN_COORDS, defaultCfg: DEFAULT_NECK_CFG,
    features: buildNeckFeatures, findReps: findNeckReps,
    coords: neckRepCoordinates, reference: neckReferencePositions,
    phases: ["out_s", "back_s"],
  },
  squat: {
    label: "squat", columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_SQUAT_CFG,
    features: buildSquatFeatures, findReps: findSquatReps,
    coords: squatRepCoordinates, reference: squatReferencePositions,
    phases: ["eccentric_s", "concentric_s"],
  },
  // Both jumps share everything but the label and what the athlete was asked
  // to do. Keeping them as separate activities means the app can say when the
  // recording disagrees with the instruction -- a squat jump with a 9 cm dip
  // in it is a countermovement jump, whatever it was called.
  cmj: {
    label: "countermovement jump", jump: true, expectCountermovement: true,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_JUMP_CFG,
    features: buildJumpFeatures, findReps: findJumpReps,
    coords: squatRepCoordinates, reference: jumpReferencePositions,
    phases: ["push_s", "landing_s"],
  },
  sj: {
    label: "squat jump", jump: true, expectCountermovement: false,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_JUMP_CFG,
    features: buildJumpFeatures, findReps: findJumpReps,
    coords: squatRepCoordinates, reference: jumpReferencePositions,
    phases: ["push_s", "landing_s"],
  },
  // The three asymmetric tasks. `perLeg` means the two legs are written
  // separately rather than averaged; `travels` means the athlete moves across
  // the frame, which invalidates the fixed pixel-to-metre scale the ground
  // reaction is derived from; `frontalTask` means the movement of interest is
  // out of the sagittal plane and a side-on camera is the wrong camera.
  slsquat: {
    label: "single-leg squat", perLeg: true,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_SLSQUAT_CFG,
    features: buildSquatFeatures, findReps: findSLSquatReps,
    coords: perLegRepCoordinates, reference: squatReferencePositions,
    phases: ["eccentric_s", "concentric_s"],
  },
  run: {
    label: "running", perLeg: true, travels: true, cyclic: true,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_RUN_CFG,
    features: buildSquatFeatures, findReps: findRunReps,
    coords: perLegRepCoordinates, reference: squatReferencePositions,
    phases: ["contact_phase_s", "swing_phase_s"],
  },
  sidestep: {
    label: "side step", perLeg: true, travels: true, frontalTask: true,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_SIDESTEP_CFG,
    features: buildSquatFeatures, findReps: findSidestepReps,
    coords: perLegRepCoordinates, reference: squatReferencePositions,
    phases: ["out_s", "back_s"],
  },
};

export function analyse(poses, fps, { heightM = 1.75, activity = "pullup",
                                      cfg = null, osimModel = "gpk" } = {}) {
  const spec = ACTIVITIES[activity];
  if (!spec) throw new Error(`unknown activity ${activity}`);
  const conf = cfg || spec.defaultCfg;
  const F = spec.features(poses);
  let pxPerM = 1, detail = {};
  try { ({ pxPerM, detail } = computePxPerM(poses, heightM)); }
  catch (err) { if (activity !== "neck") throw err; }
  const [refA, refB] = spec.reference(F);
  const found = spec.findReps(F, conf);
  const bounds = found.reps;
  const view = viewQuality(poses);

  const reps = bounds.map((b, i) => {
    const { times, coords } = (activity === "squat" || spec.jump || spec.perLeg)
      ? spec.coords(F, b, fps, pxPerM, refA, refB,
                    { model: osimModel, ankleValid: view.ankle_usable })
      : activity === "neck"
        ? spec.coords(F, b, fps)
        : spec.coords(F, b, fps, pxPerM, refA, refB);
    const [b0, top, b1] = b;
    const s = {
      rep: i + 1, times, coords, bounds: b,
      duration_s: (b1 - b0) / fps,
    };
    if (spec.jump) {
      const jm = jumpMetrics(F, b, fps, pxPerM, conf);
      if (jm) {
        Object.assign(s, jm);
        s.mismatch = spec.expectCountermovement !== jm.has_countermovement;
      }
    }
    s[spec.phases[0]] = (top - b0) / fps;
    s[spec.phases[1]] = (b1 - top) / fps;
    if (activity === "neck") {
      const span = (a, b2) => {
        const t = coords[a].map((v, k) => v + coords[b2][k]);
        return +(Math.max(...t) - Math.min(...t)).toFixed(1);
      };
      s.flexion_extension_range_deg = span("pitch1", "pitch2");
      s.lateral_bend_range_deg = span("roll1", "roll2");
      s.rotation_range_deg = span("yaw1", "yaw2");
    } else if (activity === "squat" || spec.jump || spec.perLeg) {
      // knee_angle is SIGNED per model family, so report peak flexion as a
      // magnitude; otherwise a GPK export summarises as "-2 deg".
      s.knee_flex_max_deg = Math.max(...coords.knee_angle_r.map(Math.abs));
      s.hip_flex_max_deg = Math.max(...coords.hip_flexion_r);
      s.ankle_dorsi_max_deg = Math.max(...coords.ankle_angle_r.map(Math.abs));
      // pelvis_ty is an ABSOLUTE height, so depth is the drop, not -min.
      s.depth_m = Math.max(...coords.pelvis_ty) - Math.min(...coords.pelvis_ty);
      if (spec.perLeg) {
        // Both legs, separately. On an asymmetric task the difference between
        // them IS the measurement, and a single averaged number hides it.
        s.knee_flex_max_l_deg = Math.max(...coords.knee_angle_l.map(Math.abs));
        s.knee_flex_max_r_deg = Math.max(...coords.knee_angle_r.map(Math.abs));
        s.hip_flex_max_l_deg = Math.max(...coords.hip_flexion_l);
        s.hip_flex_max_r_deg = Math.max(...coords.hip_flexion_r);
        s.knee_asymmetry_deg =
          +Math.abs(s.knee_flex_max_l_deg - s.knee_flex_max_r_deg).toFixed(1);
      }
      if (activity === "slsquat") {
        s.stance_side = found.stanceSide || null;
        // Peak knee flexion of the leg that was actually working. Reporting the
        // averaged figure for a single-leg squat is how a 20 deg swinging leg
        // turns a 70 deg rep into a 45 deg one.
        const st = found.stanceSide === "l" ? "l" : "r";
        s.stance_knee_flex_max_deg =
          Math.max(...coords["knee_angle_" + st].map(Math.abs));
        s.stance_hip_flex_max_deg = Math.max(...coords["hip_flexion_" + st]);
      }
      if (activity === "run") Object.assign(s, strideMetrics(F, b, fps, found));
      if (activity === "sidestep") {
        Object.assign(s, sidestepMetrics(F, b, fps, pxPerM, found.midX ?? refB));
      }
    } else {
      s.elbow_flex_min_deg = Math.min(...coords.elbow_flex_r);
      s.elbow_flex_max_deg = Math.max(...coords.elbow_flex_r);
      s.arm_flex_range_deg = Math.max(...coords.arm_flex_r) - Math.min(...coords.arm_flex_r);
    }
    if (coords.pelvis_ty) {
      s.pelvis_travel_m = Math.max(...coords.pelvis_ty) - Math.min(...coords.pelvis_ty);
    }
    return s;
  });

  return { activity, fps, pxPerM, scaleDetail: detail, view, osimModel,
           coverage: F._coverage, reps, columns: spec.columns,
           refused: found.refused || null,
           footCoverage: F._footCoverage ?? null };
}
