/**
 * format.mjs -- the one place that knows what a "frame" is here.
 *
 * Every model adapter, whatever it runs, has to hand back the SAME thing the
 * app's own tracker produces, or nothing downstream can be compared:
 *
 *     frame  = { i, t, lm }        i = grid index, t = ms, lm = named pixels
 *     lm     = { left_hip: [x, y], ... }   image pixels, origin top-left
 *     poses  = { [i]: lm }         what every src/ analyser takes
 *
 * The visibility cut and the pixel scaling below are copied from index.html's
 * toNamed(). If that changes, change it here too -- selftest.mjs asserts the
 * two still agree, so a drift is caught rather than quietly biasing a model
 * comparison in favour of whichever model happens to report visibility
 * differently.
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

/** The app's visibility cut. A landmark below it is ABSENT, not low-confidence. */
export const VIS_CUT = 0.3;

/** Normalised MediaPipe landmarks -> the app's named pixel dictionary. */
export function toNamed(lms, w, h, visCut = VIS_CUT) {
  const out = {};
  lms.forEach((l, i) => {
    if ((l.visibility ?? 1) >= visCut) out[LANDMARK_NAMES[i]] = [l.x * w, l.y * h];
  });
  return out;
}

/** frames[] -> poses{} keyed by grid index, which is what src/ analysers want. */
export function framesToPoses(frames) {
  const poses = {};
  for (const f of frames) poses[f.i] = f.lm;
  return poses;
}

/**
 * The clip's frame rate.
 *
 * A tracked file was stepped on a fixed grid, so the grid rate is exact and is
 * used as-is; anything else falls back to the wall clock over the frames that
 * survived, exactly as finish() does in index.html. Getting this wrong scales
 * every velocity, moment and power in the comparison, so it is never guessed
 * silently -- `assumed` says which branch was taken.
 */
export function clipFps(frames, gridFps = null) {
  if (gridFps > 0) return { fps: gridFps, assumed: false };
  if (frames.length < 2) return { fps: 30, assumed: true };
  const span = (frames[frames.length - 1].t - frames[0].t) / 1000;
  return span > 0 ? { fps: (frames.length - 1) / span, assumed: false }
                  : { fps: 30, assumed: true };
}

/** The bones the app draws, by name -- used for the rigid-body quality check. */
export const BONES = [
  ["left_shoulder", "right_shoulder"], ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"], ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"], ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"], ["left_hip", "right_hip"],
  ["left_hip", "left_knee"], ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"], ["right_knee", "right_ankle"],
  ["left_ankle", "left_foot_index"], ["right_ankle", "right_foot_index"],
];

/** Torso length in pixels, the scale every pixel metric here is divided by. */
export function torsoPx(lm) {
  const sh = midPt(lm.left_shoulder, lm.right_shoulder);
  const hp = midPt(lm.left_hip, lm.right_hip);
  if (!sh || !hp) return null;
  const d = Math.hypot(sh[0] - hp[0], sh[1] - hp[1]);
  return d > 1 ? d : null;
}

export function midPt(a, b) {
  if (!a && !b) return null;
  if (!a) return b.slice();
  if (!b) return a.slice();
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
