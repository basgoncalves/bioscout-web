/**
 * tasks.mjs -- run the APP's analysis on a model's landmarks.
 *
 * The point of the whole harness is that a pose model is not judged on its
 * landmarks. It is judged on what BioScout reports after it: how many reps,
 * which task, how deep the squat, how high the jump, what the knee did. So
 * nothing here reimplements any of that -- it calls src/kinematics.js's own
 * analyse(), src/detect.js's classify() and src/jointmetrics.js, exactly as
 * index.html does, and only collects the answers.
 *
 * That has a consequence worth stating: when a future change to the app's
 * analysis changes these numbers, the harness will say so, and it should. The
 * comparison is always "this model, through today's app".
 */

import { ACTIVITIES, analyse } from "../../../src/kinematics.js";
import { classify } from "../../../src/detect.js";
import { clipAngles, clipVelocities, limbTracks, armTracks, isUpperBody }
  from "../../../src/jointmetrics.js";
import { framesToPoses, clipFps } from "./format.mjs";

/** The per-task headline numbers -- what a comparison table should carry. */
export const TASK_OUTCOMES = {
  squat:     ["knee_flex_max_deg", "hip_flex_max_deg", "depth_m"],
  slsquat:   ["stance_knee_flex_max_deg", "knee_asymmetry_deg", "depth_m"],
  cmj:       ["jump_height_m", "countermovement_depth_m", "contact_time_s"],
  sj:        ["jump_height_m", "contact_time_s"],
  pullup:    ["elbow_flex_max_deg", "arm_flex_range_deg"],
  dip:       ["elbow_flex_min_deg", "arm_flex_range_deg"],
  pushup:    ["elbow_flex_max_deg", "elbow_flex_min_deg"],
  walk:      ["stride_time_s", "stride_length_m", "contact_phase_s"],
  run:       ["stride_time_s", "stride_length_m", "contact_phase_s"],
  heelraise: ["heel_rise_px", "up_s", "down_s"],
  kickback:  ["hip_ext_max_deg", "kick_s"],
  sidestep:  ["knee_flex_max_deg", "knee_asymmetry_deg"],
  jumpshot:  ["release_height_m", "release_s", "elbow_flex_max_deg"],
  neck:      ["flexion_extension_range_deg", "lateral_bend_range_deg",
              "rotation_range_deg"],
};

/**
 * One clip, one model, through the app.
 *
 * @param frames  [{i,t,lm}]
 * @param opts.activity  the task the clip IS (from the manifest). The app's own
 *                       classifier is run too, and disagreeing with the
 *                       manifest is itself a reportable failure -- but the
 *                       analysis uses the manifest's answer, so that a model
 *                       which misclassifies is not also scored on the wrong
 *                       analysis and penalised twice.
 */
export function runTask(frames, { activity, heightM = 1.75, massKg = 75,
                                  gridFps = null, osimModel = "rajagopal" } = {}) {
  const poses = framesToPoses(frames);
  const { fps, assumed } = clipFps(frames, gridFps);
  const out = { activity, fps, fpsAssumed: assumed, ok: false, error: null };

  // --- what the app THINKS it is ------------------------------------------
  try {
    const c = classify(poses);
    out.classified = c.activity;
    out.classifyConfidence = c.confidence;
    out.classifyScores = c.scores;
    out.classifyOk = c.activity === activity;
  } catch (err) {
    out.classified = null; out.classifyOk = false; out.classifyError = err.message;
  }

  // --- the analysis itself -------------------------------------------------
  let A = null;
  try {
    A = analyse(poses, fps, { heightM, activity, osimModel });
  } catch (err) {
    out.error = `analyse: ${err.message}`;
    return out;
  }
  out.ok = true;
  out.pxPerM = A.pxPerM;
  out.view = A.view && A.view.view;
  out.ankleUsable = !!(A.view && A.view.ankle_usable);
  out.coverage = A.coverage;
  out.refused = A.refused;
  out.nReps = A.reps.length;
  out.reps = A.reps.map((r) => ({ rep: r.rep, bounds: r.bounds,
                                  duration_s: r.duration_s }));

  // Rep boundary times, for timing agreement against lab events.
  out.repStartS = A.reps.map((r) => r.bounds[0] / fps);
  out.repPeakS = A.reps.map((r) => r.bounds[1] / fps);

  // The headline numbers, per rep and as a mean -- the mean is what a table
  // compares, the per-rep spread is what says whether the mean means anything.
  const keys = TASK_OUTCOMES[activity] || [];
  out.outcomes = {};
  for (const k of keys) {
    const v = A.reps.map((r) => r[k]).filter((x) => typeof x === "number" && Number.isFinite(x));
    out.outcomes[k] = { n: v.length, mean: v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN,
                        values: v.map((x) => +x.toFixed(4)) };
  }
  if (A.runSummary) out.runSummary = A.runSummary;

  // --- whole-clip joint angles, which is what ground truth is compared to --
  const spec = ACTIVITIES[activity];
  try {
    const F = spec.features(poses);
    const tracks = isUpperBody(activity) ? armTracks(poses) : limbTracks(poses);
    const angles = clipAngles(activity, spec, F, tracks,
                              { ankleUsable: out.ankleUsable });
    out.angles = angles;
    out.vels = clipVelocities(angles, fps);
    // Angle sample times, in seconds from the first tracked frame. clipAngles
    // returns one value per GRID index from F._lo, so the time base is the
    // grid, not the frames that survived.
    const lo = F._lo ?? 0, n = F._n ?? 0;
    out.angleT = Array.from({ length: n }, (_, k) => (lo + k) / fps);
  } catch (err) {
    out.anglesError = err.message;
  }
  return out;
}

/** Joint keys worth scoring for a task, in the order a report should show. */
export function scoredJoints(activity, angles) {
  const spec = ACTIVITIES[activity] || {};
  const order = isUpperBody(activity) ? ["elbow", "shoulder", "hip", "knee"]
                                      : ["knee", "hip", "ankle"];
  const keys = [];
  for (const j of order) {
    if (angles[j]) keys.push(j);
    if (spec.perLeg) for (const s of ["_l", "_r"]) if (angles[j + s]) keys.push(j + s);
  }
  return keys;
}
