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
                "knee_flex", "hip_flex", "ankle_dorsi", "trunk_lean", "shank_len"];
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
  const feet = [...F.toe_cy, ...F.ankle_cy].filter(isNum);
  F._floorY = feet.length ? Math.max(...feet) : 0;
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
  const { reps: bounds } = spec.findReps(F, conf);
  const view = viewQuality(poses);

  const reps = bounds.map((b, i) => {
    const { times, coords } = activity === "squat"
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
    } else if (activity === "squat") {
      // knee_angle is SIGNED per model family, so report peak flexion as a
      // magnitude; otherwise a GPK export summarises as "-2 deg".
      s.knee_flex_max_deg = Math.max(...coords.knee_angle_r.map(Math.abs));
      s.hip_flex_max_deg = Math.max(...coords.hip_flexion_r);
      s.ankle_dorsi_max_deg = Math.max(...coords.ankle_angle_r.map(Math.abs));
      // pelvis_ty is an ABSOLUTE height, so depth is the drop, not -min.
      s.depth_m = Math.max(...coords.pelvis_ty) - Math.min(...coords.pelvis_ty);
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
           coverage: F._coverage, reps, columns: spec.columns };
}
