/**
 * gt.mjs -- marker/OpenSim ground truth, put on the same footing as the app's
 * own angles so the two can be subtracted.
 *
 * Three things have to happen before an IK column and a BioScout angle mean
 * the same number:
 *
 *   1. NAME.       knee_angle_r is the app's `knee_r`.
 *   2. SIGN.       Rajagopal's knee flexion is positive; gait2392's is
 *                  negative. src/kinematics.js already carries that table
 *                  (KNEE_SIGN) because the .mot export needs it -- it is
 *                  imported here rather than repeated, so the harness cannot
 *                  drift from the app.
 *   3. CLOCK.      The camera and the lab started at different moments. Either
 *                  the manifest states the offset, or it is recovered by
 *                  cross-correlating one channel. An offset that is quietly
 *                  wrong turns a good model into a bad one, so alignment
 *                  reports its own correlation and the harness refuses a clip
 *                  whose best alignment is weak.
 *
 * The convention names accepted here ("rajagopal", "gait2392", "gpk") are the
 * ones the app already knows.
 */

import { KNEE_SIGN } from "../../../src/kinematics.js";
import { resample } from "./mot.mjs";

/**
 * OpenSim coordinate -> [BioScout angle key, sign multiplier].
 * The sign is a function of the model for the knee only; everything else is
 * flexion-positive / dorsiflexion-positive in all three conventions.
 */
export function coordMap(convention = "rajagopal") {
  const knee = KNEE_SIGN[convention] ?? 1;
  return {
    knee_angle_r: ["knee_r", knee], knee_angle_l: ["knee_l", knee],
    hip_flexion_r: ["hip_r", 1], hip_flexion_l: ["hip_l", 1],
    ankle_angle_r: ["ankle_r", 1], ankle_angle_l: ["ankle_l", 1],
    elbow_flex_r: ["elbow_r", 1], elbow_flex_l: ["elbow_l", 1],
    arm_flex_r: ["shoulder_r", 1], arm_flex_l: ["shoulder_l", 1],
    // Some IK setups write the plain names; accept both spellings.
    knee_angle_r_moment: null, // ignored: a kinetic column, not an angle
  };
}

/** Mean of the two sides, for the app's side-less `knee` / `hip` / `ankle`. */
const AVERAGED = { knee: ["knee_l", "knee_r"], hip: ["hip_l", "hip_r"],
                   ankle: ["ankle_l", "ankle_r"], elbow: ["elbow_l", "elbow_r"],
                   shoulder: ["shoulder_l", "shoulder_r"] };

/**
 * A storage file -> { time, angles: { knee_r: [...], knee: [...], ... } }
 * in the app's own keys, signs and degrees.
 */
export function gtAngles(store, convention = "rajagopal") {
  const map = coordMap(convention);
  const angles = {};
  for (const [col, spec] of Object.entries(map)) {
    if (!spec) continue;
    const [key, sign] = spec;
    const src = store.cols[col];
    if (!src) continue;
    angles[key] = src.map((v) => sign * v);
  }
  for (const [avg, pair] of Object.entries(AVERAGED)) {
    const [a, b] = pair.map((k) => angles[k]);
    if (a && b) angles[avg] = a.map((v, i) => (v + b[i]) / 2);
    else if (a || b) angles[avg] = (a || b).slice();
  }
  const missing = !Object.keys(angles).length;
  if (missing) {
    throw new Error(`${store.path}: no recognised coordinate columns ` +
                    `(looked for ${Object.keys(map).filter((k) => map[k]).join(", ")})`);
  }
  return { time: store.time, angles };
}

/** Pearson r of two equal-length series, NaNs dropped pairwise. */
export function pearson(a, b) {
  const xs = [], ys = [];
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  }
  if (xs.length < 3) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/**
 * Recover the lag (seconds) that puts the ground truth on the video's clock.
 *
 * `videoT` are the video sample times in seconds and `videoY` the app's angle
 * on that channel; `gt` is { time, values }. Positive lag means the ground
 * truth event happens LATER in lab time than in video time, i.e. the returned
 * lag is what must be SUBTRACTED from gt.time.
 *
 * Searched on a grid rather than by FFT: the clips are seconds long, the grid
 * is the video's own sample spacing, and being able to read the loop matters
 * more here than the milliseconds it costs.
 */
export function alignLag(videoT, videoY, gt, { maxLagS = 2.0, stepS = null } = {}) {
  const dt = stepS ?? Math.max(0.005, (videoT[videoT.length - 1] - videoT[0]) / (videoT.length - 1));
  let best = { lag: 0, r: -Infinity };
  for (let lag = -maxLagS; lag <= maxLagS + 1e-9; lag += dt) {
    const sampled = resample(gt.time.map((t) => t - lag), gt.values, videoT);
    const r = pearson(videoY, sampled);
    if (Number.isFinite(r) && r > best.r) best = { lag, r };
  }
  return best;
}

/**
 * Put the ground truth on the video's frame times.
 *
 * @param gtA      { time, angles } from gtAngles()
 * @param videoT   video sample times, seconds
 * @param opts.offsetS   fixed lag; when null the lag is recovered from
 *                       opts.syncChannel (default: the busiest shared channel)
 * @param opts.syncAgainst  the app's angles, needed only for auto-alignment
 */
export function alignGt(gtA, videoT, { offsetS = null, syncChannel = null,
                                       syncAgainst = null, maxLagS = 2.0,
                                       minR = 0.5 } = {}) {
  let lag = offsetS, r = null, channel = syncChannel;
  if (lag === null || lag === undefined) {
    if (!syncAgainst) throw new Error("auto-alignment needs the app's angles to align against");
    const shared = Object.keys(gtA.angles).filter((k) => syncAgainst[k]);
    if (!shared.length) throw new Error("no channel in common between ground truth and app angles");
    // The busiest shared channel: the one whose ground truth moves most is the
    // one whose alignment peak is sharpest. A near-still channel (a trunk that
    // barely rotates) correlates well at every lag and would pick one at random.
    channel = channel && shared.includes(channel) ? channel
      : shared.map((k) => [k, spread(gtA.angles[k])]).sort((a, b) => b[1] - a[1])[0][0];
    const got = alignLag(videoT, syncAgainst[channel], { time: gtA.time, values: gtA.angles[channel] },
                         { maxLagS });
    lag = got.lag; r = got.r;
    if (!(r >= minR)) {
      throw new Error(`alignment failed on ${channel}: best r=${Number(r).toFixed(2)} ` +
                      `at lag ${lag.toFixed(3)} s (needs r>=${minR}). ` +
                      `State offsetS in the manifest, or check the clip matches the trial.`);
    }
  }
  const shifted = gtA.time.map((t) => t - lag);
  const out = {};
  for (const [k, v] of Object.entries(gtA.angles)) out[k] = resample(shifted, v, videoT);
  return { angles: out, lag, r, channel };
}

const spread = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
};
