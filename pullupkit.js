/**
 * pullupkit.js -- rep detection and joint angles, ported from the Python
 * pullupkit package.
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

const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
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
  const keys = ["hip_cy", "hip_cx", "shoulder_cy", "ankle_cy",
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
    if (sh) F.shoulder_cy[i] = sh[1];
    if (hp) { F.hip_cy[i] = hp[1]; F.hip_cx[i] = hp[0]; }
    if (an) F.ankle_cy[i] = an[1];
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

export function squatRepCoordinates(F, rep, fps, pxPerM, standHipY, midX) {
  const [t0, , t1] = rep, lo = F._lo;
  const sl = (a) => interpNan(a).slice(t0, t1 + 1);
  const knee = sl(F.knee_flex), hip = sl(F.hip_flex);
  const ankle = sl(F.ankle_dorsi), lean = sl(F.trunk_lean);
  const hipY = sl(F.hip_cy), hipX = sl(F.hip_cx);
  const times = [], z = [];
  for (let i = t0; i <= t1; i++) { times.push((lo + i) / fps); z.push(0); }
  const hipFlex = clipArr(hip, -20, 130);
  const kneeAng = clipArr(knee, 0, 145);      // Rajagopal: flexion POSITIVE
  const ankleAng = clipArr(ankle, -40, 40);
  return {
    times,
    coords: {
      pelvis_tx: z,
      pelvis_ty: hipY.map((y) => (standHipY - y) / pxPerM),
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

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------
export const ACTIVITIES = {
  pullup: {
    label: "pull-up", columns: DRIVEN_COORDS, defaultCfg: DEFAULT_PULLUP_CFG,
    features: buildFeatures, findReps, coords: repCoordinates,
    reference: referencePositions, phases: ["concentric_s", "eccentric_s"],
  },
  squat: {
    label: "squat", columns: SQUAT_DRIVEN_COORDS, defaultCfg: DEFAULT_SQUAT_CFG,
    features: buildSquatFeatures, findReps: findSquatReps,
    coords: squatRepCoordinates, reference: squatReferencePositions,
    phases: ["eccentric_s", "concentric_s"],
  },
};

export function analyse(poses, fps, { heightM = 1.75, activity = "pullup",
                                      cfg = null } = {}) {
  const spec = ACTIVITIES[activity];
  if (!spec) throw new Error(`unknown activity ${activity}`);
  const conf = cfg || spec.defaultCfg;
  const F = spec.features(poses);
  const { pxPerM, detail } = computePxPerM(poses, heightM);
  const [refA, refB] = spec.reference(F);
  const { reps: bounds } = spec.findReps(F, conf);

  const reps = bounds.map((b, i) => {
    const { times, coords } = spec.coords(F, b, fps, pxPerM, refA, refB);
    const [b0, top, b1] = b;
    const s = {
      rep: i + 1, times, coords, bounds: b,
      duration_s: (b1 - b0) / fps,
    };
    s[spec.phases[0]] = (top - b0) / fps;
    s[spec.phases[1]] = (b1 - top) / fps;
    if (activity === "squat") {
      s.knee_flex_max_deg = Math.max(...coords.knee_angle_r);
      s.hip_flex_max_deg = Math.max(...coords.hip_flexion_r);
      s.ankle_dorsi_max_deg = Math.max(...coords.ankle_angle_r);
      s.depth_m = -Math.min(...coords.pelvis_ty);
    } else {
      s.elbow_flex_min_deg = Math.min(...coords.elbow_flex_r);
      s.elbow_flex_max_deg = Math.max(...coords.elbow_flex_r);
      s.arm_flex_range_deg = Math.max(...coords.arm_flex_r) - Math.min(...coords.arm_flex_r);
    }
    s.pelvis_travel_m = Math.max(...coords.pelvis_ty) - Math.min(...coords.pelvis_ty);
    return s;
  });

  return { activity, fps, pxPerM, scaleDetail: detail,
           coverage: F._coverage, reps, columns: spec.columns };
}
