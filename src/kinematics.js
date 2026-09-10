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
/**
 * Moving average, over the samples that EXIST.
 *
 * The window is divided by how many samples fell inside it, not by its nominal
 * width. The previous version convolved with a zero-padded array, which meant
 * the first and last few samples of every signal were mixed with zeros and
 * pulled toward it -- the final sample of a 3-wide smooth came out at two
 * thirds of its true value, and of a 9-wide smooth at five ninths.
 *
 * That is not cosmetic. Every detector in this file thresholds a smoothed
 * signal: foot contacts, jump rise, dip depth, hand height. A clip that ended
 * mid-stride had its last contact pulled below the threshold and lost, and a
 * signal that was flat to the end acquired a cliff at the end that looked
 * exactly like a real fall -- which is how a hand held motionless above the
 * head came to be detected as a shot being released.
 */
export function smooth(arr, win) {
  const a = Array.from(arr, Number);
  if (win <= 1 || a.length < win) return a;
  const n = a.length;
  const half = (win - 1) >> 1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, k = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      const v = a[j];
      if (Number.isFinite(v)) { sum += v; k++; }
    }
    out[i] = k ? sum / k : NaN;
  }
  return out;
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
// dips
// ---------------------------------------------------------------------------
/* A dip is a pull-up read upside down, and almost nothing else has to change.
 *
 * The same landmarks answer it -- elbow, shoulder, trunk, and how far the body
 * travelled -- because in both movements the arms carry the whole body and the
 * legs carry nothing. What differs is the direction and therefore the order of
 * the phases: a pull-up starts at the bottom and the effort raises you, a dip
 * starts at LOCKOUT and the effort stops you falling and then puts you back.
 * So the rep runs top - bottom - top, and the eccentric comes first.
 *
 * The one thing that must not be shared is the hands-overhead test. It is what
 * makes a pull-up a pull-up, and for a dip the same test has to come out the
 * other way: hands at the hips, taking load from below. Without that check the
 * two movements are the same signal with the sign flipped, and a clip of one
 * would happily be measured as the other.
 */
export const DEFAULT_DIP_CFG = {
  // As a fraction of torso length. A dip to 90 degrees of elbow flexion drops
  // the shoulders by roughly a third of a torso; the floor is set below that so
  // a shallow rep is still counted and reported as shallow, rather than being
  // silently dropped and reported as no rep at all.
  minDropFrac: 0.18,
  minRepFrames: 12,
  minElbowFlexionDeg: 40,
  smoothWin: 5,
  // Hands overhead means the athlete is hanging, not supporting. A dip filmed
  // so badly that the wrists read overhead for most of it is not a dip this
  // app can measure.
  maxOverheadFrac: 0.3,
};

/**
 * Dip features: everything buildFeatures gives, plus how far the body has sunk
 * below its own lockout.
 *
 * Lockout is the 10th percentile of shoulder height (image y grows downward,
 * so the smallest y is the highest position) rather than the minimum: one
 * frame of tracking noise at the top would otherwise set the reference for the
 * whole clip and shift every depth in it.
 */
export function buildDipFeatures(poses) {
  const F = buildFeatures(poses);
  const lockY = nanpercentile(F.shoulder_cy, 10);
  F.drop = F.shoulder_cy.map((y) => (isNum(y) && isNum(lockY)
    ? (y - lockY) / F._scale : NaN));
  F._lockY = lockY;
  return F;
}

/** Reps of a dip: lockout, bottom, lockout. */
export function findDipReps(F, cfg = DEFAULT_DIP_CFG) {
  const n = F._n;
  const drop = smooth(interpNan(F.drop), cfg.smoothWin);
  const elbow = interpNan(F.elbow);
  const overhead = F.hands_overhead.map((v) => (isNum(v) ? v : 0) > 0.5);
  const overheadFrac = overhead.reduce((a, b) => a + (b ? 1 : 0), 0) / (n || 1);
  // Hanging, not supporting: refuse rather than measure a pull-up as a dip.
  if (overheadFrac > cfg.maxOverheadFrac) return { reps: [], drop, refused: "handsOverhead" };

  const bottoms = localMaxima(drop, cfg.minRepFrames, cfg.minDropFrac);
  const reps = [];
  for (let k = 0; k < bottoms.length; k++) {
    const bot = bottoms[k];
    const left = k > 0 ? bottoms[k - 1] : 0;
    const right = k < bottoms.length - 1 ? bottoms[k + 1] : n - 1;
    const b0 = bot > left ? argmin(drop, left, bot) : left;
    const b1 = right > bot ? argmin(drop, bot, right) : right;
    // Elbows must actually bend. A body that sinks with straight arms is the
    // shoulders shrugging, or the bar moving, and neither is a dip.
    const straight = Math.max(elbow[b0], elbow[b1]), bent = elbow[bot];
    if (isNum(straight) && isNum(bent)
        && (straight - bent) < cfg.minElbowFlexionDeg) continue;
    if ((b1 - b0) < cfg.minRepFrames) continue;
    if ((bot - b0) < 3 || (b1 - bot) < 3) continue;
    reps.push([b0, bot, b1]);
  }
  return { reps, drop, refused: reps.length ? null : "noDips" };
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
  // The same lowest-foot position in image pixels, NaN where the tracker lost
  // the foot. The jump detector measures it against a LOCAL floor (jumpSignals
  // below); foot_rise, against the one clip-wide floor, is kept for the
  // callers that only need "roughly how high are the feet".
  F.foot_low = new Array(n).fill(NaN);
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const a = F.ankle_cy[i], t = F.toe_cy[i];
    const low = Math.max(isNum(a) ? a : -Infinity, isNum(t) ? t : -Infinity);
    if (Number.isFinite(low)) { F.foot_rise[i] = F._floorY - low; F.foot_low[i] = low; seen++; }
  }
  F._footCoverage = n ? seen / n : 0;
  return F;
}

/* ---- where the floor is, jump by jump --------------------------------------
 *
 * The first version measured every foot against ONE floor for the whole clip:
 * the 97th percentile of every foot position seen. Both halves of that failed
 * on real clips, and a simulated phone recording (tests/jump_sim.mjs) shows
 * each failure on demand:
 *
 *   jitter   the 97th percentile of a wobbling landmark is its wobble's lower
 *            extreme, a centimetre or two BELOW where the foot actually rests.
 *            A standing foot then reads as a little airborne, the take-off and
 *            touch-down edges walk outward into the stance, and every flight is
 *            too long: +7 cm of height on average at ordinary jitter, +22 cm at
 *            worst.
 *   drift    athletes creep between jumps, and a few centimetres nearer the
 *            camera moves the feet down the picture. Against a fixed floor the
 *            standing feet of a later jump sit above it for seconds at a time --
 *            a "flight" too long to be one, so the jump was thrown away. One in
 *            five jumps went missing that way.
 *
 * So the floor is found where the feet are: first roughly (a rolling median,
 * which is the ground whenever the feet spend most of a second on it), then
 * exactly, as the median foot position of each separate stretch of standing
 * between flights. A flight runs from one stretch's floor to the next one's.
 * The detection threshold is raised to sit above this clip's own jitter.
 */
function rollingMedian(arr, half) {
  const n = arr.length, out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const w = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (isNum(arr[j])) w.push(arr[j]);
    }
    if (w.length) { w.sort((a, b) => a - b); out[i] = w[w.length >> 1]; }
  }
  return out;
}

export function jumpSignals(F, cfg = DEFAULT_JUMP_CFG) {
  if (F._jumpSig && F._jumpSig.cfg === cfg) return F._jumpSig;
  const n = F._n, fps = F._fps || 30, scale = F._scale || 1;
  let low = F.foot_low || F.foot_rise.map((r) => (isNum(r) ? F._floorY - r : NaN));
  let observed = low.map(isNum);
  /* One landmark, not whichever is lowest this frame.
   *
   * "Lowest point of the foot" is the toe for the whole of a jump -- flat,
   * on the toes, and in the air. But when the tracker drops the toe and keeps
   * the ankle, the lowest point it has is the ankle, 7 cm higher on a flat
   * foot and 12 on a pointed one: a spike of that size in the middle of the
   * flight, which is what threw the timing off by up to 11 cm of height. So
   * where the toe is usually seen, the toe is the signal; a frame with only
   * the ankle is bridged with the toe-to-ankle offset from the frames around
   * it, and left out of anything that times the flight. */
  const toe = F.toe_cy, ank = F.ankle_cy;
  if (toe && ank && toe.filter(isNum).length >= 0.5 * n) {
    const off = toe.map((t, i) => (isNum(t) && isNum(ank[i]) ? t - ank[i] : NaN));
    const offS = off.some(isNum) ? interpNan(rollingMedian(off, Math.max(2, Math.round(0.25 * fps)))) : off.map(() => 0);
    low = toe.map((t, i) => (isNum(t) ? Math.max(t, isNum(ank[i]) ? ank[i] : -Infinity)
                                      : isNum(ank[i]) ? ank[i] + Math.max(0, offS[i]) : NaN));
    observed = toe.map(isNum);
  }
  // Pass 1: a rough floor, good enough to find the flights.
  const rough = interpNan(rollingMedian(low, Math.max(5, Math.round(fps))));
  const lowI = interpNan(low);
  const rise1 = smooth(rough.map((f, i) => f - lowI[i]), cfg.smoothWin);
  const lift = cfg.liftFrac * scale;
  const pad = Math.max(2, Math.round(0.05 * fps));
  const airish = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (rise1[i] > lift) for (let k = Math.max(0, i - pad); k <= Math.min(n - 1, i + pad); k++) airish[k] = true;
  }
  // Pass 2: each stretch of standing gets its own floor.
  const segs = [];
  for (let i = 0; i < n;) {
    if (airish[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && !airish[j + 1]) j++;
    const v = [];
    for (let k = i; k <= j; k++) if (observed[k]) v.push(low[k]);
    segs.push({ a: i, b: j, floor: v.length ? nanmedian(v) : NaN });
    i = j + 1;
  }
  const floor = rough.slice();
  for (const sg of segs) if (isNum(sg.floor)) for (let k = sg.a; k <= sg.b; k++) floor[k] = sg.floor;
  // Across a flight, from the floor it left to the floor it came down on.
  for (let q = 0; q + 1 < segs.length; q++) {
    const A = segs[q], B = segs[q + 1];
    if (!isNum(A.floor) || !isNum(B.floor)) continue;
    for (let k = A.b + 1; k < B.a; k++) {
      floor[k] = A.floor + (B.floor - A.floor) * (k - A.b) / (B.a - A.b);
    }
  }
  const riseRaw = floor.map((f, i) => f - lowI[i]);
  // This clip's own jitter, from the standing frames: robust SD of the foot
  // about its floor.
  const dev = [];
  for (const sg of segs) {
    for (let k = sg.a; k <= sg.b; k++) if (observed[k]) dev.push(Math.abs(low[k] - sg.floor));
  }
  const sigma = dev.length ? 1.4826 * nanmedian(dev) : 0;
  const sig = {
    cfg, fps, observed, floor, riseRaw, sigma,
    rise: smooth(riseRaw, cfg.smoothWin),
    thresh: Math.max(lift, 4 * sigma),
    edge: Math.max(cfg.edgeFrac * scale, 2.5 * sigma),
    segs,
  };
  F._jumpSig = sig;
  return sig;
}

/** Least-squares y = c0 + c1 x + c2 x^2. Null if singular. */
export function fitParabola(xs, ys) {
  let n0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (!isNum(x) || !isNum(y)) continue;
    const x2 = x * x;
    n0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; t0 += y; t1 += x * y; t2 += x2 * y;
  }
  if (n0 < 3) return null;
  const M = [[n0, s1, s2, t0], [s1, s2, s3, t1], [s2, s3, s4, t2]];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
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
  const sig = jumpSignals(F, cfg);
  const rise = sig.rise;
  const hipY = smooth(interpNan(F.hip_cy), cfg.smoothWin);
  const thresh = sig.thresh;
  const reps = [];
  let prevEnd = -1;
  const runs = flightRuns(rise, thresh, cfg);
  /* How high the hip gets while the feet are demonstrably on the floor. The
   * 10th percentile rather than the minimum, so one noisy frame cannot raise
   * the bar the jump has to clear. Taken from the stretch of standing just
   * before THIS jump: an athlete who has crept toward the camera stands lower
   * in the picture than they did three jumps ago, and a clip-wide reference
   * would make a real jump look like it never left the ground. */
  const edge = sig.edge;
  const standRefBefore = (a) => {
    const sg = [...sig.segs].reverse().find((q) => q.b < a) || sig.segs[0];
    const v = [];
    if (sg) for (let i = sg.a; i <= sg.b; i++) if (!(rise[i] > edge) && isNum(hipY[i])) v.push(hipY[i]);
    if (!v.length) for (let i = 0; i < n; i++) if (!(rise[i] > edge) && isNum(hipY[i])) v.push(hipY[i]);
    return v.length ? nanpercentile(v, 10) : -Infinity;
  };

  for (let ri = 0; ri < runs.length; ri++) {
    const [a, b] = runs[ri];
    const standRef = standRefBefore(a);
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
  const sig = jumpSignals(F, cfg);
  const riseRaw = sig.riseRaw;
  const rise = sig.rise;
  const hipY = smooth(interpNan(F.hip_cy), cfg.smoothWin);
  const hipRaw = interpNan(F.hip_cy);
  const thresh = sig.thresh;
  const edge = sig.edge;
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
  let offF = a + 1 <= b2 ? zeroBefore(a, a + 1) : a;
  let onF = b2 - 1 >= a ? zeroBefore(b2, b2 - 1) : b2;
  /* Better, when there is enough flight to fit: the whole airborne path.
   *
   * The two-frame extrapolation above reads the take-off off the first two
   * airborne frames and the touch-down off the last two, so a single frame of
   * landmark jitter at either end moves the flight by a frame -- at 30 fps,
   * 5 to 10 cm of height. In the air the foot follows a parabola, and a
   * parabola fitted through every frame the foot was actually SEEN airborne
   * (not the ones interpolated across a dropout) crosses its floor at the
   * take-off and touch-down instants with the jitter averaged out.
   *
   * Its roots are trusted only between the frames that bracket each edge in
   * what the camera SAW: take-off after the last frame the foot was seen on
   * the floor and before the first it was seen in the air, touch-down the
   * same way round. Bracketing by frames the tracker dropped -- and so were
   * filled in by interpolation -- let a dropout at take-off drag the edge a
   * frame early and add 6-11 cm; a fixed bound in frames rejected every good
   * fit at 60 fps, where a frame is half as long. Outside the brackets the
   * edges above stand. */
  {
    const obs = sig.observed;
    const isAir = (i) => obs[i] && riseRaw[i] > edge;
    let aO = null, g0 = aMin;
    for (let j = takeoff; j >= aMin; j--) {
      if (!obs[j]) continue;
      if (riseRaw[j] > edge) aO = j; else { g0 = j; break; }
    }
    let bO = null, g1 = bMax;
    for (let j = land; j <= bMax; j++) {
      if (!obs[j]) continue;
      if (riseRaw[j] > edge) bO = j; else { g1 = j; break; }
    }
    const xs = [], ys = [];
    if (aO != null && bO != null) {
      for (let i = aO; i <= bO; i++) if (isAir(i)) { xs.push(i); ys.push(riseRaw[i]); }
    }
    const c = xs.length >= 5 ? fitParabola(xs, ys) : null;
    if (c && c[2] < 0) {
      const disc = c[1] * c[1] - 4 * c[2] * c[0];
      if (disc > 0) {
        const r1 = (-c[1] + Math.sqrt(disc)) / (2 * c[2]);
        const r2 = (-c[1] - Math.sqrt(disc)) / (2 * c[2]);
        const lo = Math.min(r1, r2), hi = Math.max(r1, r2);
        /* A frame read as grounded may still be low in the air -- just under
         * the edge, which sits above the jitter -- so the bracket reaches past
         * it by about the time the foot takes to cross that band: one frame
         * at 30 fps, two at 60. */
        const slack = Math.max(1, Math.round(0.035 * fps));
        if (lo >= g0 - slack && lo <= aO + 0.25 && hi >= bO - 0.25 && hi <= g1 + slack) {
          offF = lo; onF = hi;
        }
      }
    }
  }
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
  let height_com_m = pxPerM > 0 ? (hipY[offIdx] - hipY[apex]) / pxPerM : NaN;
  /* Same idea for the hip: a parabola through the raw hip over the frames
   * strictly inside the flight, read at the take-off instant and at its
   * vertex. Frame-picking on the smoothed hip both rounds the take-off to a
   * whole frame and shaves the apex (a 3-frame average of a peak is below the
   * peak). Kept only if it curves the right way. */
  {
    const xs = [], ys = [];
    for (let i = Math.ceil(offF); i <= Math.floor(onF); i++) if (isNum(hipRaw[i])) { xs.push(i); ys.push(hipRaw[i]); }
    const c = xs.length >= 5 ? fitParabola(xs, ys) : null;
    if (c && c[2] > 0 && pxPerM > 0) {
      const xv = -c[1] / (2 * c[2]);
      if (xv > offF && xv < onF) {
        const at = (x) => c[0] + c[1] * x + c[2] * x * x;
        height_com_m = (at(offF) - at(xv)) / pxPerM;
        apex = Math.round(xv);
      }
    }
  }

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
/* The floor, and the body, as they are AT EACH MOMENT rather than on average.
 *
 * A clip where the athlete walks away from the camera and back breaks both of
 * the constants this used to rely on. Walking away moves the feet UP the image
 * -- that is perspective, not the foot leaving the ground -- so a floor line
 * fixed at the clip's 97th percentile sits far below the planted foot at the
 * far end, and every step there reads as airborne. At the same time the body
 * shrinks, so a contact band that is a fixed fraction of the MEDIAN shank is
 * several times too wide near the camera and far too narrow away from it.
 *
 * Both are therefore taken locally: the floor from a high percentile of the
 * foot's own recent history, and the scale from this frame's shank. The window
 * is deliberately wider than a stride, so it spans stance and swing and lands
 * on the floor rather than on whatever the foot was doing just then.
 */
function rollingStat(y, win, q) {
  const out = new Array(y.length).fill(NaN);
  for (let i = 0; i < y.length; i++) {
    const lo = Math.max(0, i - win), hi = Math.min(y.length - 1, i + win);
    const w = [];
    for (let k = lo; k <= hi; k++) if (isNum(y[k])) w.push(y[k]);
    out[i] = w.length ? nanpercentile(w, q) : NaN;
  }
  return out;
}

function contactPeriods(F, side, band = 0.09, minFrames = 3, mergeGap = 3,
                        hipRelative = false) {
  const y = interpNan(F["foot_y_" + side]);
  // Hysteresis: a foot has to come well clear of the floor to count as lifted,
  // once it is down. A single threshold chopped one stance into three whenever
  // the ankle landmark wobbled across the line -- and three stances is three
  // strides, which is how a 0.63 s stride came out as 0.42 s.
  /* Measure the foot against the HIP, not against the picture.
   *
   * Walking away from the camera moves the feet up the image and shrinks the
   * body, and it does both to the hip as well -- so the drop from hip to foot,
   * divided by the leg, is the same number at either end of the room while an
   * absolute floor line is wrong at both. That ratio is what the contact test
   * runs on now. It is dimensionless, it needs no rolling window chasing the
   * athlete down the corridor, and a clip filmed head-on stops being a special
   * case.
   *
   * A rolling floor was tried first and is not enough: a symmetric window over
   * a moving athlete is biased toward the near end of the window by roughly
   * half the distance travelled across it, which at the far end of a room is
   * several times the contact band.
   */
  const hip = interpNan(F.hip_cy || []);
  const shank = interpNan(F.shank_len || []);
  const rel = new Array(F._n).fill(NaN);
  for (let i = 0; i < F._n; i++) {
    if (isNum(y[i]) && isNum(hip[i]) && isNum(shank[i]) && shank[i] > 1e-6) {
      rel[i] = (y[i] - hip[i]) / shank[i];
    }
  }
  /* Hip-relative ONLY where the hip is a valid stand-in for the ground.
   *
   * In a walk one foot is always down, so the hip stays a fixed height above
   * the floor and moving with it costs nothing. In a run the hip is airborne
   * for part of every stride -- it rises with the feet -- so measuring the
   * feet against it cancels precisely the flight phase the run is defined by.
   * Turned on for walking, it read a run's duty factor as 0.5 with 17 ms of
   * flight, which is a walk's description of a run.
   */
  const usable = hipRelative && rel.filter(isNum).length >= 0.5 * F._n;
  // The planted foot sits at the far end of that ratio; 97th percentile for
  // the same reason the floor used one, to survive a dropped frame.
  const ground = usable ? nanpercentile(rel, 97) : null;

  const out = [];
  let start = -1, down = false;
  for (let i = 0; i < F._n; i++) {
    // Falls back to the absolute floor where the hip is not tracked, which is
    // the close-up shots -- there the camera is not moving relative to the
    // athlete anyway, so the old measure is fine.
    const h = usable
      ? (isNum(rel[i]) ? ground - rel[i] : Infinity)
      : (isNum(y[i]) ? (F._floorY - y[i]) / F._scale : Infinity);
    const inTol = band, outTol = 1.8 * band;
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
  // Below this much horizontal hip travel, in metres, the runner is on the
  // spot. See runTravel().
  stationaryM: 0.35,
};

/* Running on the spot is a different measurement problem from running past a
 * camera, and a better one.
 *
 * The reason this app refuses moments and ground reaction for running is not
 * running itself -- it is TRAVEL. As the athlete crosses the frame their
 * distance to the camera changes, the pixel-to-metre scale drifts with it, and
 * the ground reaction is derived from that scale. On a treadmill, or running on
 * the spot, none of that happens: the athlete stays put, the scale is as fixed
 * as it is in a squat, and the kinetics are as defensible as a squat's.
 *
 * So measure the travel rather than assuming it. The hip's horizontal position
 * is smoothed first, because a stride swings the pelvis a few centimetres
 * side to side and the raw range would count that as travel. The threshold is
 * in metres, not frame fractions: a third of a metre is less than one stride
 * length, so anything genuinely moving down the frame is well past it, while
 * a runner holding station drifts far less.
 */
export function runTravel(F, pxPerM, cfg = DEFAULT_RUN_CFG) {
  const x = smooth(interpNan(F.hip_cx), 9).filter(isNum);
  if (x.length < 5 || !(pxPerM > 0)) return null;
  // 5th to 95th percentile, not min to max: one dropped-out frame at either end
  // would otherwise decide the answer.
  const sorted = [...x].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1,
                                    Math.max(0, Math.round(q * (sorted.length - 1))))];
  const travel_m = (at(0.95) - at(0.05)) / pxPerM;
  return { travel_m: +travel_m.toFixed(3),
           stationary: travel_m <= cfg.stationaryM };
}

/* A stride, not a step: contact of one foot to the next contact of the SAME
 * foot. That is the unit every running-gait norm is written in, and it is the
 * only unit whose start and end are the same event, which is what an ensemble
 * average needs. The middle marker is toe-off, so phases come out as
 * stance / swing rather than the squat's down / up. */
export function findRunReps(F, cfg = DEFAULT_RUN_CFG) {
  // Measure the side with more complete contact data; a stride is a stride
  // whichever foot defines it.
  const cl = realStances(contactPeriods(F, "l", cfg.contactBand,
                                        cfg.minContactFrames, 3, cfg.hipRelative), F._n);
  const cr = realStances(contactPeriods(F, "r", cfg.contactBand,
                                        cfg.minContactFrames, 3, cfg.hipRelative), F._n);
  const side = cl.length >= cr.length ? "l" : "r";
  const cs = side === "l" ? cl : cr;
  // Strides for BOTH feet. The charts and the ensemble mean still run off one
  // side -- they need a single cycle definition -- but reporting only that side
  // throws away the comparison a runner actually wants, and which foot happened
  // to track more cleanly is an accident of the camera, not a choice.
  const strides = (contacts) => {
    const out = [];
    for (let k = 0; k < contacts.length - 1; k++) {
      const t0 = contacts[k][0], toeOff = contacts[k][1], t1 = contacts[k + 1][0];
      const len = t1 - t0;
      if (len < cfg.minStrideFrames || len > cfg.maxStrideFrames) continue;
      if (toeOff <= t0 || toeOff >= t1) continue;
      out.push([t0, toeOff, t1]);
    }
    return out;
  };
  const sideReps = { l: strides(cl), r: strides(cr) };
  // Every stride of BOTH feet, in the order they happened, each carrying the
  // foot it belongs to. Reporting one foot was the old behaviour and it hid the
  // comparison a runner is actually after; which foot tracked more cleanly is
  // an accident of where the camera stood, not a choice worth making for them.
  const tagged = [...sideReps.l.map((b) => ({ b, sd: "l" })),
                  ...sideReps.r.map((b) => ({ b, sd: "r" }))]
    .sort((p, q) => p.b[0] - q.b[0]);
  if (!tagged.length) {
    return { reps: [], depth: F.depth, refused: "noStrides", runSide: side,
             contacts: cs, sideContacts: { l: cl, r: cr }, sideReps,
             repSides: [] };
  }
  return { reps: tagged.map((t) => t.b), repSides: tagged.map((t) => t.sd),
           depth: F.depth, runSide: side, contacts: cs,
           sideContacts: { l: cl, r: cr }, sideReps,
           otherContacts: side === "l" ? cr : cl };
}

/* Walking is the same measurement as running with one thing taken away: the
 * flight phase. Nothing in findRunReps needs flight -- a stride there is one
 * foot's contact to that same foot's next contact, which is exactly the unit
 * the walk test asks for -- so walking reuses it rather than getting a second
 * stride finder that could disagree with the first.
 *
 * What does change is the clock. A walking stride is slower than a running one
 * and a slow walk slower still, so the stride window opens up; and both feet
 * are down together for a fifth of the cycle, which makes the swing foot's
 * dip past the stance foot less pronounced, so the contact band stays where it
 * is rather than being tightened for a task that never leaves the floor.
 */
export const DEFAULT_WALK_CFG = {
  ...DEFAULT_RUN_CFG,
  /* Measure the feet against the hip rather than against a fixed floor line.
   * The assessment asks the athlete to walk away from the camera and back, and
   * filmed head-on that moves the feet up the image and shrinks the body -- so
   * an absolute floor is wrong everywhere except where it was measured, and
   * every step at the far end reads as airborne. The hip moves with both, and
   * in a walk it never leaves the ground. See contactPeriods. */
  hipRelative: true,
  // 1.6 s at 60 fps is a slow but ordinary walking stride; the running ceiling
  // of 90 frames would throw those away as "too long to be a stride".
  maxStrideFrames: 150,
  // Walking down a corridor covers ground, and the kinetics warning that
  // follows from travelling is the same one running gets.
  stationaryM: 0.35,
};

/* --- heel raises (the tip-toe test) --------------------------------------
 *
 * A heel raise is the smallest movement this app measures: the heel comes up a
 * few centimetres while the toe stays where it is. Everything else here is
 * found from how far the body travels, which is useless at this scale, so the
 * signal is the heel's height ABOVE THE TOE OF THE SAME FOOT rather than above
 * the floor. That difference matters: it cancels the camera drifting, the
 * athlete swaying, and the floor line being wrong, because both landmarks move
 * together with all three.
 *
 * Scaled by foot length -- the heel-to-toe distance while the foot is flat --
 * rather than by shank, so "a full raise" means the same thing on a tall
 * athlete and a short one, and so the number has a meaning: a lift of 1.0 is
 * the heel raised by the length of the foot.
 */
export function buildHeelRaiseFeatures(poses) {
  const frames = Object.keys(poses).map(Number).sort((a, b) => a - b);
  if (!frames.length) throw new Error("no pose frames");
  const lo = frames[0], hi = frames[frames.length - 1], n = hi - lo + 1;
  const F = {};
  for (const k of ["lift_l", "lift_r", "heel_y_l", "heel_y_r", "toe_y_l", "toe_y_r",
                   "foot_len_l", "foot_len_r", "hip_cy", "knee_flex_l", "knee_flex_r"]) {
    F[k] = new Array(n).fill(NaN);
  }
  for (const fi of frames) {
    const i = fi - lo, lm = poses[fi];
    const lh = lm.left_heel, rh = lm.right_heel;
    const lt = lm.left_foot_index, rt = lm.right_foot_index;
    const lhip = lm.left_hip, rhip = lm.right_hip;
    const lk = lm.left_knee, rk = lm.right_knee, la = lm.left_ankle, ra = lm.right_ankle;
    if (lh) F.heel_y_l[i] = lh[1];
    if (rh) F.heel_y_r[i] = rh[1];
    if (lt) F.toe_y_l[i] = lt[1];
    if (rt) F.toe_y_r[i] = rt[1];
    if (lh && lt) F.foot_len_l[i] = Math.hypot(lt[0] - lh[0], lt[1] - lh[1]);
    if (rh && rt) F.foot_len_r[i] = Math.hypot(rt[0] - rh[0], rt[1] - rh[1]);
    const hp = mid(lhip, rhip);
    if (hp) F.hip_cy[i] = hp[1];
    F.knee_flex_l[i] = 180 - angle3(lhip, lk, la);
    F.knee_flex_r[i] = 180 - angle3(rhip, rk, ra);
  }
  // Foot length from the flat-footed frames: the 80th percentile, because a
  // raised heel SHORTENS the heel-to-toe distance in the image and the median
  // would be dragged down by the raises themselves.
  for (const sd of ["l", "r"]) {
    const flat = nanpercentile(F["foot_len_" + sd], 80);
    const len = flat > 1e-6 ? flat : 1;
    for (let i = 0; i < n; i++) {
      // y grows downward, so the heel being ABOVE the toe is toe_y - heel_y.
      F["lift_" + sd][i] = (F["toe_y_" + sd][i] - F["heel_y_" + sd][i]) / len;
    }
    // Standing is not lift zero: the heel landmark sits slightly above the toe
    // even flat-footed. Subtract that resting offset so a rep is measured from
    // where this athlete's foot actually rests.
    const rest = nanpercentile(F["lift_" + sd], 20);
    for (let i = 0; i < n; i++) F["lift_" + sd][i] -= rest;
    F["_footLen_" + sd] = len;
  }
  F._lo = lo; F._n = n; F._scale = nanmedian(F.foot_len_l) || 1;
  F._coverage = frames.length / n;
  return F;
}

export const DEFAULT_HEELRAISE_CFG = {
  // A raise counts once the heel is a third of a foot length up. Full range in
  // the standardised test is higher than that, but the test is scored on reps
  // and a threshold set at the ideal would silently drop the late, smaller
  // reps -- which is exactly where the endurance information is.
  minLift: 0.33,
  minRepFrames: 8,      // ~0.3 s at 30 fps: faster than that is a bounce
  smoothWin: 5,
};

/* One rep is one heel lift and return, counted per foot. Both feet are counted
 * from the same clip and each rep carries the side it happened on, so a single
 * recording gives the left count, the right count, and the symmetry between
 * them -- which is the comparison the test is usually run for. */
export function findHeelRaiseReps(F, cfg = DEFAULT_HEELRAISE_CFG) {
  const perSide = (sd) => {
    const y = smooth(interpNan(F["lift_" + sd]), cfg.smoothWin);
    const peaks = localMaxima(y, cfg.minRepFrames, cfg.minLift);
    const out = [];
    for (let k = 0; k < peaks.length; k++) {
      const pk = peaks[k];
      const left = k > 0 ? peaks[k - 1] : 0;
      const right = k < peaks.length - 1 ? peaks[k + 1] : F._n - 1;
      // Down either side of the peak: the rep runs trough to trough, so the
      // return to the floor is inside it rather than being someone else's rep.
      const t0 = pk > left ? argmin(y, left, pk) : left;
      const t1 = right > pk ? argmin(y, pk, right) : right;
      if (t1 - t0 < cfg.minRepFrames) continue;
      out.push([t0, pk, t1]);
    }
    return out;
  };
  const l = perSide("l"), r = perSide("r");
  const tagged = [...l.map((b) => ({ b, sd: "l" })), ...r.map((b) => ({ b, sd: "r" }))]
    .sort((p, q) => p.b[0] - q.b[0]);
  if (!tagged.length) {
    return { reps: [], repSides: [], sideReps: { l, r }, depth: F.lift_l,
             refused: "noHeelRaises" };
  }
  return { reps: tagged.map((t) => t.b), repSides: tagged.map((t) => t.sd),
           sideReps: { l, r }, depth: F.lift_l };
}

/** Per-rep numbers for a heel raise: how high, and how long it took. */
export function heelRaiseMetrics(F, rep, fps, sd) {
  const [t0, pk, t1] = rep;
  const y = F["lift_" + sd];
  return {
    heel_lift: +(y[pk] || 0).toFixed(3),
    up_s: +((pk - t0) / fps).toFixed(2),
    down_s: +((t1 - pk) / fps).toFixed(2),
    stance_side: sd,
  };
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

/** Whole-bout running summary: how long the running lasted, and each foot's
 *  mean stride separately.
 *
 *  The bout is measured first foot-strike to last, not clip start to clip end.
 *  A clip almost always opens with the runner walking into frame and closes
 *  with them slowing down, and counting that as running quietly deflates every
 *  per-minute figure derived from it.
 *
 *  Each side is averaged over ITS OWN strides. A left and a right mean built
 *  from different numbers of strides are still comparable -- they are means --
 *  whereas interleaving both feet into one list and averaging that would hide
 *  exactly the left-right difference the two rows exist to show.
 */
export function runSummary(F, found, fps) {
  const per = (contacts, other) => {
    const reps = [];
    for (let k = 0; k < contacts.length - 1; k++) {
      const t0 = contacts[k][0], toeOff = contacts[k][1], t1 = contacts[k + 1][0];
      if (toeOff <= t0 || toeOff >= t1) continue;
      reps.push(strideMetrics(F, [t0, toeOff, t1], fps, { otherContacts: other }));
    }
    if (!reps.length) return null;
    const mean = (k) => {
      const v = reps.map((r) => r[k]).filter((x) => Number.isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const r3 = (x) => (x == null ? null : +x.toFixed(3));
    return {
      strides: reps.length,
      stride_s: r3(mean("stride_s")),
      contact_s: r3(mean("contact_s")),
      flight_s: r3(mean("flight_s")),
      duty_factor: r3(mean("duty_factor")),
      cadence_spm: mean("cadence_spm") == null ? null
                   : +mean("cadence_spm").toFixed(1),
    };
  };

  const sc = found.sideContacts || { l: [], r: [] };
  const all = [...sc.l, ...sc.r];
  if (!all.length) return null;
  const first = Math.min(...all.map((c) => c[0]));
  const last = Math.max(...all.map((c) => c[1]));
  const left = per(sc.l, sc.r);
  const right = per(sc.r, sc.l);
  return {
    run_time_s: +((last - first + 1) / fps).toFixed(2),
    // A step is one foot going down; a stride is the same foot going down
    // twice. Both are worth printing -- steps is what a watch counts, strides
    // is the unit every running-gait norm is written in.
    steps: all.length,
    strides: (left?.strides || 0) + (right?.strides || 0),
    left, right,
    // Only worth printing when both feet were actually measured; one side alone
    // is a number with nothing to compare against.
    asymmetry: left && right
      ? +Math.abs(left.stride_s - right.stride_s).toFixed(3) : null,
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

// ---------------------------------------------------------------------------
// the jump shot
// ---------------------------------------------------------------------------
/* Shooting mechanics from one side-on camera, and nothing about the ball.
 *
 * WHAT THIS CAN AND CANNOT SEE. There is no ball and no hoop in these
 * measurements: the pose model tracks a body, so what is measured is what the
 * body did. That is most of shooting mechanics -- the dip, the legs, when the
 * hand released relative to the top of the jump, and above all whether the
 * same thing happened on every attempt -- but it is not the shot going in.
 * Whether it went in is the athlete's own tap, and the report never guesses it.
 *
 * RELEASE IS A PROXY. The instant the ball leaves the hand cannot be seen
 * without the ball. The frame used here is peak wrist height, which follows
 * true release by a frame or two as the hand finishes its snap -- at 30 fps
 * that is 30-60 ms, and at 240 fps it is 4-8. Every number timed from release
 * inherits that offset. It is constant across attempts of the same style, so
 * differences BETWEEN shots are trustworthy while the absolute value is not,
 * and the report says so rather than implying a precision it does not have.
 *
 * SIDE-ON ONLY. Elbow flare, guide-hand position and left-right alignment are
 * frontal questions and are not answered here. A frontal clip is refused for
 * this task rather than measured badly.
 */
export const DEFAULT_SHOT_CFG = {
  smoothWin: 3,
  // The hand has to finish above the head for this to be a shot rather than a
  // pass, a dribble or a rebound. In hip-height units (F._scale), the top of
  // the head is around 0.85; 0.95 puts the wrist clearly above it.
  minReleaseRise: 0.95,
  // The hand has to have come DOWN first. A catch-and-shoot dips less than a
  // free throw, so this is deliberately shallow -- it exists to reject a hand
  // that was already up, not to grade the dip.
  minDipFrac: 0.12,
  // Two shots cannot be a third of a second apart. This also stops the little
  // rebound of the follow-through being read as a second attempt.
  minShotFrames: 14,
  // How long after release the follow-through is worth keeping, in seconds.
  followS: 0.45,
  // Below this the clip is frontal and the sagittal measures are not valid.
  minFrontality: 0.6,
};

/** Jump-shot features: the jump, plus the shooting arm. */
export function buildShotFeatures(poses) {
  const F = buildJumpFeatures(poses);
  const frames = Object.keys(poses).map(Number).sort((a, b) => a - b);
  const n = F._n, lo = F._lo;
  for (const k of ["wrist_y_l", "wrist_y_r", "wrist_x_l", "wrist_x_r",
                   "elbow_flex_l", "elbow_flex_r", "head_y"]) {
    F[k] = new Array(n).fill(NaN);
  }
  for (const fi of frames) {
    const i = fi - lo, lm = poses[fi];
    const ls = lm.left_shoulder, rs = lm.right_shoulder;
    const le = lm.left_elbow, re = lm.right_elbow;
    const lw = lm.left_wrist, rw = lm.right_wrist;
    if (lw) { F.wrist_y_l[i] = lw[1]; F.wrist_x_l[i] = lw[0]; }
    if (rw) { F.wrist_y_r[i] = rw[1]; F.wrist_x_r[i] = rw[0]; }
    F.elbow_flex_l[i] = 180 - angle3(ls, le, lw);
    F.elbow_flex_r[i] = 180 - angle3(rs, re, rw);
    if (lm.nose) F.head_y[i] = lm.nose[1];
  }
  /* The shooting hand is the one that goes highest.
   *
   * Not the one that is higher on average, and not a handedness setting: the
   * guide hand rides up with the ball and separates only at the top, so the
   * two are close together for most of every shot and only the peak tells them
   * apart. Picking it per clip rather than per athlete also means a left-handed
   * athlete, or a right-hander shooting lefty for a drill, needs no setting.
   */
  const top = (a) => { const v = a.filter(isNum); return v.length ? Math.min(...v) : Infinity; };
  const side = top(F.wrist_y_r) <= top(F.wrist_y_l) ? "r" : "l";
  F._shootSide = side;
  F.wrist_y = F["wrist_y_" + side];
  F.wrist_x = F["wrist_x_" + side];
  F.elbow_flex = F["elbow_flex_" + side];
  // Hand height above the floor, in hip-heights, so it means the same thing at
  // any camera distance.
  F.hand = F.wrist_y.map((y) => (isNum(y) && isNum(F._floorY)
    ? (F._floorY - y) / F._scale : NaN));
  return F;
}

/**
 * One "rep" per attempt: [dip, release, end of follow-through].
 *
 * Release is peak wrist height -- see the note at the top of this section for
 * what that costs.
 */
export function findShotReps(F, cfg = DEFAULT_SHOT_CFG) {
  const n = F._n;
  const hand = smooth(interpNan(F.hand), cfg.smoothWin);
  const peaks = localMaxima(hand, cfg.minShotFrames, cfg.minReleaseRise);
  const follow = Math.max(3, Math.round(cfg.followS * 30));
  const reps = [];
  for (let k = 0; k < peaks.length; k++) {
    const rel = peaks[k];
    const left = k > 0 ? peaks[k - 1] : 0;
    const dip = rel > left ? argmin(hand, left, rel) : left;
    if (hand[rel] - hand[dip] < cfg.minDipFrac) continue;   // the hand was already up
    if ((rel - dip) < 3) continue;
    const end = Math.min(n - 1, rel + follow);
    if (end <= rel) continue;
    /* The hand must COME DOWN again.
     *
     * Without this, a hand raised and held -- a rebound, a catch above the
     * head, an athlete standing with the ball up while the next player shoots
     * -- has a highest frame like any other, and that frame becomes a
     * "release" with a dip in front of it and a full set of numbers behind it.
     * A shot ends with the arm coming down; anything that does not is not one. */
    let low = hand[rel];
    for (let i = rel + 1; i <= end; i++) if (hand[i] < low) low = hand[i];
    if (hand[rel] - low < cfg.minDipFrac) continue;
    reps.push([dip, rel, end]);
  }
  return { reps, rise: hand,
           refused: reps.length ? null : "noShots",
           shootSide: F._shootSide };
}

/**
 * What one attempt did.
 *
 * `apexOffset_s` is the only number here that is hard to get any other way and
 * is worth the whole module: whether the ball left the hand on the way up, at
 * the top, or on the way down. Negative is before the apex.
 */
export function shotMetrics(F, rep, fps, pxPerM, cfg = DEFAULT_SHOT_CFG) {
  const [dip, rel, end] = rep;
  const wristY = interpNan(F.wrist_y), hipY = interpNan(F.hip_cy);
  const elbow = interpNan(F.elbow_flex), knee = interpNan(F.knee_flex);
  const m = (px) => (pxPerM > 0 ? +(px / pxPerM).toFixed(3) : null);
  // The apex of the BODY, not of the hand: the highest the hips got between
  // the dip and the end of the follow-through.
  let apex = dip;
  for (let i = dip; i <= end; i++) if (hipY[i] < hipY[apex]) apex = i;
  // Flight, by the same rule the jumps use, so a jump shot and a
  // countermovement jump do not report height two different ways.
  const lift = cfg.liftFrac ?? DEFAULT_JUMP_CFG.liftFrac;
  let air = 0;
  for (let i = dip; i <= end; i++) {
    if (F.foot_rise[i] > lift * F._scale) air++;
  }
  const flight = air / fps;
  const G = 9.80665;
  return {
    release_height_m: m(F._floorY - wristY[rel]),
    dip_hand_m: m(F._floorY - wristY[dip]),
    release_elbow_deg: isNum(elbow[rel]) ? +elbow[rel].toFixed(1) : null,
    dip_elbow_deg: isNum(elbow[dip]) ? +elbow[dip].toFixed(1) : null,
    knee_flex_at_dip_deg: isNum(knee[dip]) ? +knee[dip].toFixed(1) : null,
    // Up from the dip to release: the part of a shot a coach calls the motion.
    load_s: +((rel - dip) / fps).toFixed(3),
    follow_s: +((end - rel) / fps).toFixed(3),
    // Negative: released on the way up. Positive: released while falling.
    apex_offset_s: +((rel - apex) / fps).toFixed(3),
    flight_s: air ? +flight.toFixed(3) : 0,
    jump_height_m: air ? +((G * flight * flight) / 8).toFixed(3) : 0,
    shoot_side: F._shootSide,
  };
}

export const ACTIVITIES = {
  pullup: {
    label: "pull-up", columns: DRIVEN_COORDS, defaultCfg: DEFAULT_PULLUP_CFG,
    features: buildFeatures, findReps, coords: repCoordinates,
    reference: referencePositions, phases: ["concentric_s", "eccentric_s"],
  },
  /* The phase order is the whole difference from a pull-up, and it is not
   * cosmetic: `phases` names what the first and second halves of the rep ARE.
   * A dip lowers first, so the eccentric is first, and a dip reported with a
   * pull-up's phase names would put every athlete's descent in the column
   * headed "up". */
  dip: {
    label: "dip", columns: DRIVEN_COORDS, defaultCfg: DEFAULT_DIP_CFG,
    features: buildDipFeatures, findReps: findDipReps, coords: repCoordinates,
    reference: referencePositions, phases: ["eccentric_s", "concentric_s"],
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
  /* Walking and running share every function here. They are separate entries
   * because the athlete was asked for one of them: an assessment that says
   * "walk" and reports "running" is telling them their test was misread, and
   * the refusal text has to talk about the task they actually performed. */
  /* The tip-toe test. Per-leg because the two sides are counted separately and
   * the comparison between them is most of the point; not `travels`, because
   * the athlete stands still, so the kinetics caveat that follows travelling
   * does not apply. */
  heelraise: {
    label: "heel raises", perLeg: true, heelRaise: true,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_HEELRAISE_CFG,
    features: buildHeelRaiseFeatures, findReps: findHeelRaiseReps,
    coords: perLegRepCoordinates, reference: squatReferencePositions,
    phases: ["up_s", "down_s"],
  },
  walk: {
    label: "walking", perLeg: true, travels: true, cyclic: true, gait: true,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_WALK_CFG,
    features: buildSquatFeatures, findReps: findRunReps,
    coords: perLegRepCoordinates, reference: squatReferencePositions,
    phases: ["contact_phase_s", "swing_phase_s"],
  },
  run: {
    label: "running", perLeg: true, travels: true, cyclic: true, gait: true,
    columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_RUN_CFG,
    features: buildSquatFeatures, findReps: findRunReps,
    coords: perLegRepCoordinates, reference: squatReferencePositions,
    phases: ["contact_phase_s", "swing_phase_s"],
  },
  /* A jump shot is a jump plus an arm, so it borrows the jump's coordinate set
   * and its features. It is deliberately NOT flagged `jump: true`: that flag
   * routes a rep into jumpMetrics and the jump table, which report take-off and
   * landing, and a shot is not read that way -- the events that matter are the
   * dip and the release. */
  jumpshot: {
    label: "jump shot", columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_SHOT_CFG,
    features: buildShotFeatures, findReps: findShotReps,
    coords: squatRepCoordinates, reference: jumpReferencePositions,
    phases: ["load_s", "follow_s"], shot: true,
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
  F._fps = fps;          // the jump detector sizes its floor window in seconds
  const found = spec.findReps(F, conf);
  const bounds = found.reps;
  const view = viewQuality(poses);

  const reps = bounds.map((b, i) => {
    const { times, coords } = (activity === "squat" || spec.jump || spec.perLeg
                               || spec.shot)
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
    } else if (activity === "squat" || spec.jump || spec.perLeg || spec.shot) {
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
      if (spec.gait) {
        // Which foot this stride belongs to decides what "the other foot" means
        // when flight is worked out, so it has to be this rep's side and not
        // the clip's dominant one.
        const sd = found.repSides ? found.repSides[i] : found.runSide;
        s.stance_side = sd || null;
        const sc = found.sideContacts || {};
        Object.assign(s, strideMetrics(F, b, fps,
          { otherContacts: sd === "l" ? sc.r : sc.l }));
        /* Stride length, over the ground.
         *
         * How far the hip actually moved between this foot's two contacts.
         * On a treadmill that is close to zero, and that is the true answer to
         * the question asked -- the athlete did not travel. It is not the
         * belt's stride length, which no camera pointed at the runner can see,
         * and the app must not print one as though it could. */
        const hx = F.hip_cx;
        if (hx && Number.isFinite(hx[b[0]]) && Number.isFinite(hx[b[2]])
            && pxPerM > 0) {
          s.stride_length_m = +(Math.abs(hx[b[2]] - hx[b[0]]) / pxPerM).toFixed(3);
        }
      }
      if (spec.shot) {
        Object.assign(s, shotMetrics(F, b, fps, pxPerM, conf));
      }
      if (activity === "sidestep") {
        Object.assign(s, sidestepMetrics(F, b, fps, pxPerM, found.midX ?? refB));
      }
    } else {
      /* The peak is taken from the MEASUREMENT, not from the exported column.
       *
       * `coords.elbow_flex_r` is clipped to the OpenSim model's own range on
       * the way out, which is right for a .mot file and wrong for a summary:
       * three dips in a row reported peak elbow flexion of exactly 150 deg,
       * and identical peaks to three significant figures across independent
       * reps are not a measurement, they are a ceiling. The clipped column
       * still goes to the file; the number the athlete reads is what the
       * camera saw, with a flag when the two differ. */
      const rawElbow = interpNan(F.elbow).slice(b[0], b[2] + 1)
        .map((v) => 180 - v).filter(isNum);
      const capped = Math.max(...coords.elbow_flex_r);
      s.elbow_flex_min_deg = Math.min(...coords.elbow_flex_r);
      s.elbow_flex_max_deg = rawElbow.length
        ? +Math.max(...rawElbow).toFixed(1) : capped;
      s.elbow_clipped = rawElbow.length
        ? Math.max(...rawElbow) > capped + 0.5 : false;
      s.arm_flex_range_deg = Math.max(...coords.arm_flex_r) - Math.min(...coords.arm_flex_r);
    }
    if (coords.pelvis_ty) {
      s.pelvis_travel_m = Math.max(...coords.pelvis_ty) - Math.min(...coords.pelvis_ty);
    }
    return s;
  });

  /* The whole clip as one curve, for gait.
   *
   * Every other panel is one stride cut out of the run, which is the right unit
   * for comparing strides and the wrong one for seeing the run: a limp that
   * builds over eight strides, or one stride that is not like the others, is
   * invisible when each stride is drawn on its own axis at its own scale. This
   * is the same coordinate set over the whole recording, uncut, so the video
   * and the curve can be read against each other end to end. */
  let whole = null;
  if (spec.gait && F._n > 2) {
    try {
      const wb = [0, Math.floor((F._n - 1) / 2), F._n - 1];
      const w = spec.coords(F, wb, fps, pxPerM, refA, refB,
                            { model: osimModel, ankleValid: view.ankle_usable });
      /* Where each foot met the floor, in seconds from the start of the clip.
       *
       * The whole-run panel without them is a wall of oscillation: the eye can
       * see that something changes across the bout and cannot see which stride
       * it changed in. With them the panel becomes readable as strides, and it
       * is the one place the stride boundaries can be shown at all -- every
       * other panel IS a stride. Sides are kept apart because the two feet
       * land at different times and one merged list of marks would say the
       * athlete contacted twice as often as they did. */
      const sc = found.sideContacts || {};
      const at = (cs) => (cs || []).map((c) => +(c[0] / fps).toFixed(3));
      whole = { rep: "all", wholeTrial: true, times: w.times, coords: w.coords,
                bounds: wb,
                contacts: { l: at(sc.l), r: at(sc.r) } };
    } catch { whole = null; }
  }

  return { activity, fps, pxPerM, scaleDetail: detail, view, osimModel,
           coverage: F._coverage, reps, whole, columns: spec.columns,
           refused: found.refused || null,
           runSummary: spec.gait ? runSummary(F, found, fps) : null,
           // Whether the athlete held station. Only running asks -- it is the
           // one task whose kinetics are refused for travel alone.
           travel: spec.gait ? runTravel(F, pxPerM, conf) : null,
           footCoverage: F._footCoverage ?? null };
}
