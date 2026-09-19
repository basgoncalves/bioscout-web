/**
 * quality.mjs -- what can be said about a tracker WITHOUT ground truth.
 *
 * These matter because the ground truth covers a handful of lab trials and the
 * app runs on everything else. A model that is accurate on the trials but
 * jitters, drops the feet, or swaps left and right on ordinary phone footage
 * will produce worse numbers in the field than its RMSE suggests -- and these
 * five checks are the ones that actually predicted that here:
 *
 *   detection      fraction of sampled frames with a body at all
 *   presence       per-landmark, because a model can be "present" and still
 *                  never see a heel -- and heels are what gait, heel raises
 *                  and the tip-toe test are measured from
 *   jitter         RMS of the second difference of each landmark, in PERCENT
 *                  OF TORSO LENGTH, so it is comparable across clips and
 *                  camera distances. Jitter is differentiated twice more for
 *                  moment and power, where it dominates.
 *   segment CV     coefficient of variation of each bone's length. A real limb
 *                  does not change length; whatever fraction it appears to is
 *                  the model's depth error leaking into the image plane.
 *   swaps          frames where the left/right labels cross over. One swap
 *                  puts thousands of newtons into an arm moment (see the note
 *                  in jointmetrics.js armTracks).
 */

import { BONES, torsoPx, LANDMARK_NAMES } from "./format.mjs";

const finite = (a) => a.filter(Number.isFinite);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const rms = (a) => (a.length ? Math.sqrt(mean(a.map((v) => v * v))) : NaN);
const median = (a) => {
  const v = finite(a).slice().sort((x, y) => x - y);
  if (!v.length) return NaN;
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
};

/**
 * @param frames  [{ i, t, lm }] as produced by a model adapter
 * @param nGrid   how many frames were OFFERED to the model (>= frames.length);
 *                without it, detection rate is 1 by construction and says
 *                nothing.
 */
export function quality(frames, nGrid = null) {
  const n = nGrid ?? frames.length;
  const out = { frames: frames.length, offered: n,
                detection: n ? frames.length / n : 0 };
  if (frames.length < 3) return { ...out, jitterPct: NaN, segmentCV: NaN,
                                  swapsPerS: NaN, presence: {}, torsoPx: NaN };

  // --- presence, per landmark ---------------------------------------------
  const presence = {};
  for (const nm of LANDMARK_NAMES) presence[nm] = 0;
  for (const f of frames) for (const nm of Object.keys(f.lm)) presence[nm] = (presence[nm] ?? 0) + 1;
  for (const nm of Object.keys(presence)) presence[nm] /= frames.length;

  // --- scale ---------------------------------------------------------------
  const torso = median(frames.map((f) => torsoPx(f.lm)));
  out.torsoPx = torso;

  // --- jitter: second difference on the CONSECUTIVE grid -------------------
  // Only triples that are consecutive grid indices are used. A gap is a gap;
  // differencing across it measures the movement in the hole, not noise.
  const jit = [];
  for (const nm of LANDMARK_NAMES) {
    const acc = [];
    for (let k = 1; k < frames.length - 1; k++) {
      const a = frames[k - 1], b = frames[k], c = frames[k + 1];
      if (b.i - a.i !== 1 || c.i - b.i !== 1) continue;
      const pa = a.lm[nm], pb = b.lm[nm], pc = c.lm[nm];
      if (!pa || !pb || !pc) continue;
      acc.push(Math.hypot(pa[0] - 2 * pb[0] + pc[0], pa[1] - 2 * pb[1] + pc[1]));
    }
    if (acc.length > 5) jit.push([nm, rms(acc)]);
  }
  out.jitterPx = median(jit.map(([, v]) => v));
  out.jitterPct = torso ? (out.jitterPx / torso) * 100 : NaN;
  out.jitterWorst = jit.slice().sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([nm, v]) => `${nm} ${(torso ? (v / torso) * 100 : v).toFixed(2)}`);

  // --- segment length stability -------------------------------------------
  const cvs = [];
  for (const [a, b] of BONES) {
    const L = [];
    for (const f of frames) {
      const p = f.lm[a], q = f.lm[b];
      if (p && q) L.push(Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
    if (L.length < frames.length * 0.5) continue;
    const m = mean(L);
    if (!(m > 1)) continue;
    const sd = Math.sqrt(mean(L.map((v) => (v - m) * (v - m))));
    cvs.push([`${a}->${b}`, (sd / m) * 100]);
  }
  out.segmentCV = median(cvs.map(([, v]) => v));
  out.segmentWorst = cvs.slice().sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([nm, v]) => `${nm} ${v.toFixed(1)}%`);

  // --- left/right swaps ----------------------------------------------------
  // A swap shows as the sign of (left.x - right.x) flipping on a pair that is
  // otherwise well separated. Filmed side-on the two sides genuinely cross, so
  // only pairs separated by more than a tenth of a torso are counted, and a
  // flip must persist for two frames to count -- one-frame flicker is the
  // model being undecided, which the app's own tracking already tolerates.
  let swaps = 0;
  for (const nm of ["shoulder", "hip", "knee", "ankle", "wrist"]) {
    let prev = null, pending = 0;
    for (const f of frames) {
      const l = f.lm[`left_${nm}`], r = f.lm[`right_${nm}`];
      if (!l || !r) { prev = null; continue; }
      const d = l[0] - r[0];
      if (torso && Math.abs(d) < 0.1 * torso) { prev = null; continue; }
      const s = Math.sign(d);
      if (prev !== null && s !== prev) { pending++; if (pending >= 2) { swaps++; prev = s; pending = 0; } }
      else { prev = s; pending = 0; }
    }
  }
  const durS = (frames[frames.length - 1].t - frames[0].t) / 1000;
  out.swaps = swaps;
  out.swapsPerS = durS > 0 ? swaps / durS : NaN;

  // --- the landmarks the lower-limb tasks cannot do without ----------------
  const KEY = ["left_hip", "right_hip", "left_knee", "right_knee",
               "left_ankle", "right_ankle", "left_heel", "right_heel",
               "left_foot_index", "right_foot_index"];
  out.presence = presence;
  out.keyPresence = mean(KEY.map((k) => presence[k] ?? 0));
  out.weakLandmarks = KEY.filter((k) => (presence[k] ?? 0) < 0.8);
  return out;
}
