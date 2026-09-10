/**
 * jointmetrics.js -- angle, angular velocity, moment and power, per joint.
 *
 * One dictionary per rep, `rep.jm`, keyed `<joint>_<metric>[_l|_r]`:
 *
 *   angle    degrees, FLEXION POSITIVE at every joint (ankle: dorsiflexion;
 *            shoulder: upper arm from the trunk in the plane the camera sees,
 *            negative behind it side-on). These
 *            are the measured angles, NOT the .mot columns: the .mot is
 *            clipped to the OpenSim model's range, and a velocity taken off a
 *            clipped curve is a flat line followed by a spike.
 *   vel      degrees per second, the time derivative of `angle`. Positive
 *            while the joint flexes.
 *   moment   N·m, EXTENSION POSITIVE (see dynamics.js), per leg or per arm.
 *   power    W, moment x angular velocity in the extension sense. Positive:
 *            the muscles are shortening and doing work (concentric).
 *            Negative: lengthening under load, absorbing it (eccentric).
 *
 * Velocity and power are worked out on each rep in SECONDS, before any
 * averaging. The mean rep is on a 0-100% axis, and a derivative taken on that
 * axis is in degrees per percent -- a unit that changes with the tempo of the
 * rep. So the mean velocity is the mean of the reps' velocities, which is what
 * ensembleRep does with anything it finds in `jm`.
 *
 * Angles and velocities are computed over the whole clip and then cut into
 * reps, so a rep boundary is not also a differentiation boundary: the one-sided
 * difference at the ends of an array is the noisiest sample in it, and cutting
 * first would put one at the start and end of every rep.
 */
import { interpNan, smooth, angle3, mid } from "./kinematics.js";
import { armInverseDynamics, armFacing } from "./dynamics.js";

export const METRICS = ["angle", "vel", "moment", "power"];

/* The tasks whose work is done by the arms. The jump shot has legs in it --
 * they are tracked and can be ticked -- but what a shooting coach is looking
 * at first is the elbow, so it opens there. */
export const UPPER_BODY_TASKS = ["pullup", "dip", "jumpshot"];
export const isUpperBody = (activity) => UPPER_BODY_TASKS.includes(activity);
export const defaultJoint = (activity) => (isUpperBody(activity) ? "elbow" : "knee");

/** Display order: the task's default joint first, then top to bottom. */
export function jointOrder(activity) {
  return isUpperBody(activity)
    ? ["elbow", "shoulder", "hip", "knee", "ankle"]
    : ["knee", "hip", "ankle", "shoulder", "elbow"];
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const finiteSome = (a) => Array.isArray(a) && a.some(isNum);
const odd = (k) => (k % 2 ? k : k + 1);

/** Central difference, one-sided at the ends. */
export function derivative(y, dt) {
  const n = y.length, d = new Array(n).fill(0);
  if (n < 2) return d;
  for (let i = 1; i < n - 1; i++) d[i] = (y[i + 1] - y[i - 1]) / (2 * dt);
  d[0] = (y[1] - y[0]) / dt;
  d[n - 1] = (y[n - 1] - y[n - 2]) / dt;
  return d;
}

/** Smoothing for a first derivative: a moving average of about 0.12 s (never
 *  under 5 frames), applied twice. */
export const velWindow = (fps) => odd(Math.max(5, Math.round(0.12 * fps)));

/**
 * Angular velocity of a whole-clip angle, deg/s.
 *
 * Two passes of a short moving average -- a triangular window about a quarter
 * of a second wide -- rather than one wide pass. The reference pull-up is
 * filmed face-on at 30 fps with the arms overhead, where the pose model's
 * shoulder angle jitters by 20-30 degrees from one frame to the next; one
 * 5-frame pass let that through as 400 deg/s spikes in a dead hang, and one
 * pass wide enough to stop them flattens the real start of the pull. The
 * triangle suppresses frame-to-frame jitter far better for the same loss of
 * genuine peak.
 */
export function angularVelocity(angle, fps) {
  const w = velWindow(fps);
  return derivative(smooth(smooth(interpNan(angle), w), w), 1 / fps);
}

/* ---- tracks ------------------------------------------------------------- */

/**
 * Per-frame landmark positions over the whole clip, image pixels, NaN-filled
 * where the pose model lost them and then interpolated. `side` "l" or "r" for
 * one arm (the shooting arm); null for the midpoint of both, which is what the
 * two-armed tasks and their features already use.
 */
export function limbTracks(poses, side = null) {
  const frames = Object.keys(poses).map(Number).sort((a, b) => a - b);
  if (!frames.length) return null;
  const lo = frames[0], n = frames[frames.length - 1] - lo + 1;
  const names = { sh: "shoulder", el: "elbow", wr: "wrist", hp: "hip",
                  kn: "knee", an: "ankle" };
  const xs = {}, ys = {};
  for (const k of Object.keys(names)) {
    xs[k] = new Array(n).fill(NaN); ys[k] = new Array(n).fill(NaN);
  }
  for (const fi of frames) {
    const lm = poses[fi], i = fi - lo;
    for (const [k, nm] of Object.entries(names)) {
      const p = side ? lm[`${side === "l" ? "left" : "right"}_${nm}`]
                     : mid(lm[`left_${nm}`], lm[`right_${nm}`]);
      if (p && isNum(p[0]) && isNum(p[1])) { xs[k][i] = p[0]; ys[k][i] = p[1]; }
    }
  }
  const out = { lo, n };
  for (const k of Object.keys(names)) {
    // A landmark never seen is absent, not a line of zeros at the image corner.
    if (!xs[k].some(isNum)) { out[k] = null; continue; }
    const x = interpNan(xs[k]), y = interpNan(ys[k]);
    out[k] = x.map((v, i) => [v, y[i]]);
  }
  return out;
}

/**
 * The tracks an arm task needs: each arm on its own, and the midline for the
 * body's centre of mass. `side` restricts it to one labelled arm (the shooting
 * arm, which buildShotFeatures picks by label).
 *
 * For two arms the slots are by IMAGE POSITION, not by label: "l" is whichever
 * arm's shoulder is further left in the picture, frame by frame, and the whole
 * chain -- shoulder, elbow, wrist, hip of that label -- moves with it. The pose
 * model swaps left and right when an athlete faces the camera or turns away,
 * and the reference pull-up does it mid-rep; a labelled track then jumps from
 * one arm to the other in a single frame, and its second derivative reads as
 * thousands of newtons. Side-on the two arms overlap, a swap changes nothing
 * the two-arm average can see, and the slots are harmless either way.
 */
export function armTracks(poses, side = null) {
  const out = { mid: limbTracks(poses, null) };
  if (side) { out[side] = limbTracks(poses, side); return out; }
  const chain = ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"];
  const slotted = { l: {}, r: {} };
  for (const [fi, lm] of Object.entries(poses)) {
    const L = lm.left_shoulder, R = lm.right_shoulder;
    const swap = L && R && isNum(L[0]) && isNum(R[0]) && L[0] > R[0];
    const a = {}, b = {};
    for (const nm of chain) {
      a[`left_${nm}`] = lm[`${swap ? "right" : "left"}_${nm}`];
      b[`right_${nm}`] = lm[`${swap ? "left" : "right"}_${nm}`];
    }
    slotted.l[fi] = a; slotted.r[fi] = b;
  }
  out.l = limbTracks(slotted.l, "l");
  out.r = limbTracks(slotted.r, "r");
  return out;
}

/** Tracks in metres, y UP -- the frame dynamics.js works in. */
function toMetres(track, pxPerM, from = 0, to = null) {
  if (!track) return null;
  const s = track.slice(from, to == null ? track.length : to + 1);
  return s.map(([x, y]) => [x / pxPerM, -y / pxPerM]);
}

/**
 * Signed shoulder angle, degrees: from the trunk (shoulder toward hip) to the
 * upper arm, in the plane the camera sees, positive in the direction this arm's
 * elbow folds. Side-on that is flexion, and an arm behind the body is
 * negative; face-on it is abduction.
 *
 * The .mot's arm_flex is angle3(hip, shoulder, elbow), which has no sign: an
 * arm 40 degrees BEHIND the body at the bottom of a dip reads as 40 degrees of
 * flexion, the same as an arm 40 degrees in front. For a picture of a dip that
 * is the difference between the right answer and its mirror image.
 */
export function shoulderFlexionSigned(tr, facing) {
  if (!tr.sh || !tr.el || !tr.hp) return null;
  const f = facing || 1;
  const raw = tr.sh.map((s, i) => {
    // y flipped to point up, so "counter-clockwise" means what it says.
    const t = [tr.hp[i][0] - s[0], -(tr.hp[i][1] - s[1])];
    const a = [tr.el[i][0] - s[0], -(tr.el[i][1] - s[1])];
    return Math.atan2(t[0] * a[1] - t[1] * a[0], t[0] * a[0] + t[1] * a[1]);
  });
  // Arms overhead sit right on the +-180 seam; unwrap so a hang does not
  // flicker between +175 and -175.
  const un = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    let d = raw[i] - raw[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    un.push(un[i - 1] + d);
  }
  let deg = un.map((v) => (f * v * 180) / Math.PI);
  const sorted = [...deg].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  if (med < -90) deg = deg.map((v) => v + 360);
  else if (med > 270) deg = deg.map((v) => v - 360);
  return deg;
}

/* ---- angles per task ---------------------------------------------------- */

const LOWER = { knee: "knee_flex", hip: "hip_flex", ankle: "ankle_dorsi" };

/**
 * Every joint angle this task tracks, over the whole clip, flexion positive.
 * Keys are `<joint>` (both sides, or the one side a one-sided task uses) and,
 * for the per-leg tasks, `<joint>_l` / `<joint>_r` as well.
 *
 * `F` is the feature set analyse() built for this activity (spec.features);
 * `tracks` is armTracks() for the arm(s) the task uses.
 */
export function clipAngles(activity, spec, F, tracks, { ankleUsable = true } = {}) {
  const out = {};
  const put = (k, a) => { if (finiteSome(a)) out[k] = Array.from(a, Number); };
  if (activity === "pullup" || activity === "dip") {
    // buildFeatures keeps INCLUDED angles; flexion is 180 minus.
    put("elbow", F.elbow && F.elbow.map((v) => 180 - v));
    put("hip", F.hip && F.hip.map((v) => 180 - v));
    put("knee", F.knee && F.knee.map((v) => 180 - v));
  } else {
    for (const [j, fk] of Object.entries(LOWER)) {
      if (j === "ankle" && !ankleUsable) continue;
      put(j, F[fk]);
      if (spec && spec.perLeg) {
        put(j + "_l", F[fk + "_l"]);
        put(j + "_r", F[fk + "_r"]);
        // A per-leg feature set with no averaged column still needs one for
        // power, which pairs a single sagittal moment with a single angle.
        if (!out[j] && out[j + "_l"] && out[j + "_r"]) {
          out[j] = out[j + "_l"].map((v, i) => (v + out[j + "_r"][i]) / 2);
        }
      }
    }
    if (activity === "jumpshot") put("elbow", F.elbow_flex);
  }
  /* The shoulder, one arm at a time and then averaged -- never off the
   * midpoint of the two. Filmed face-on, the midpoint of two elbows sits on
   * the body's midline whatever the arms are doing, and the "arm" it defines
   * is a few pixels long and points anywhere. Each arm is signed by its OWN
   * fold direction, so two arms that mirror each other face-on agree. */
  if (tracks && isUpperBody(activity)) {
    const per = [];
    for (const sd of ["l", "r"]) {
      const t = tracks[sd];
      if (!t || !t.sh || !t.el || !t.wr || !t.hp) continue;
      const face = armFacing(...["sh", "el", "wr"].map((k) => t[k].map(([x, y]) => [x, -y])));
      const a = shoulderFlexionSigned(t, face);
      if (a) per.push(a);
    }
    if (per.length) put("shoulder", per[0].map((v, i) => per.reduce((s, a) => s + a[i], 0) / per.length));
  }
  // Every angle the same length as the clip, gaps filled, so slicing by a
  // rep's frame bounds is always safe.
  for (const k of Object.keys(out)) if (k[0] !== "_") out[k] = interpNan(out[k]);
  return out;
}

/** Velocities for every angle in `angles`, same keys. */
export function clipVelocities(angles, fps) {
  const out = {};
  for (const [k, a] of Object.entries(angles)) {
    if (k[0] === "_") continue;
    out[k] = angularVelocity(a, fps);
  }
  return out;
}

/** Split a key into joint and side: "knee_l" -> ["knee", "l"]. */
const splitSide = (k) => {
  const m = /^(.*)_([lr])$/.exec(k);
  return m ? [m[1], m[2]] : [k, null];
};

/** One rep's slice of the whole-clip angles and velocities, as jm keys. */
export function repKinematics(angles, vels, bounds) {
  const [b0, , b1] = bounds;
  const jm = {};
  for (const [k, a] of Object.entries(angles)) {
    if (k[0] === "_") continue;
    const [j, sd] = splitSide(k);
    const suf = sd ? "_" + sd : "";
    jm[`${j}_angle${suf}`] = a.slice(b0, b1 + 1);
    jm[`${j}_vel${suf}`] = vels[k].slice(b0, b1 + 1);
  }
  return jm;
}

/**
 * Arm moments for one clip, cut into reps afterwards. Null when the arm is not
 * in frame or the task is not one of the arm tasks.
 */
export function clipArmMoments(activity, tracks, pxPerM, massKg, fps,
                               { systemKg = massKg, smoothWin = 9 } = {}) {
  if (!isUpperBody(activity) || !tracks || !(pxPerM > 0)) return null;
  const arm = (t) => (t && t.sh && t.el && t.wr && t.hp ? {
    shoulder: toMetres(t.sh, pxPerM), elbow: toMetres(t.el, pxPerM),
    wrist: toMetres(t.wr, pxPerM), hip: toMetres(t.hp, pxPerM) } : null);
  const arms = ["l", "r"].map((sd) => arm(tracks[sd])).filter(Boolean);
  if (!arms.length) return null;
  const mode = activity === "jumpshot" ? "free" : "hang";
  // The shot's ball is released rep by rep, so the free-arm case is solved
  // per rep by armMomentsForRep below; this whole-clip path is the closed
  // chain only.
  if (mode === "free") return { mode, arms };
  /* The body's centre of mass, once, from the midline -- the one place the
   * midpoints ARE right. Each arm then carries half of what it implies. */
  const md = tracks.mid;
  const bm = (k) => (md && md[k] ? toMetres(md[k], pxPerM) : null);
  const com = comTrack(bm("hp"), bm("sh"), bm("kn"), bm("an"));
  const per = arms.map((p) => armInverseDynamics({ ...p, com }, massKg, fps,
                                                 { mode, systemKg, smoothWin }));
  const avg = (k) => per[0][k].map((_, i) => per.reduce((s, d) => s + d[k][i], 0) / per.length);
  return { mode, arms, d: { elbow_moment: avg("elbow_moment"),
                            shoulder_moment: avg("shoulder_moment"),
                            hand_force_vertical: per[0].hand_force_vertical,
                            body_weight_n: per[0].body_weight_n } };
}

/** Whole-body centre of mass, metres, from the segments in frame (Winter). */
function comTrack(hip, shoulder, knee, ankle) {
  if (!hip || !shoulder) return null;
  const parts = [[0.678, 0.626, hip, shoulder]];
  if (knee) parts.push([0.2, 0.433, hip, knee]);
  if (knee && ankle) parts.push([0.122, 0.433, knee, ankle]);   // shanks + feet
  const w = parts.reduce((s, q) => s + q[0], 0);
  return hip.map((_, i) => {
    let x = 0, y = 0;
    for (const [m, c, a, b] of parts) {
      x += m * (a[i][0] + c * (b[i][0] - a[i][0]));
      y += m * (a[i][1] + c * (b[i][1] - a[i][1]));
    }
    return [x / w, y / w];
  });
}

/** One rep's arm moments, from what clipArmMoments prepared. */
export function armMomentsForRep(prep, bounds, massKg, fps, { ballKg = 0.6, smoothWin = 9 } = {}) {
  if (!prep) return null;
  const [b0, mid0, b1] = bounds;
  if (prep.mode !== "free") {
    const sl = (a) => (a ? a.slice(b0, b1 + 1) : null);
    return { elbow_moment: sl(prep.d.elbow_moment),
             shoulder_moment: sl(prep.d.shoulder_moment),
             hand_force_vertical: sl(prep.d.hand_force_vertical),
             body_weight_n: prep.d.body_weight_n };
  }
  /* The shot: the ball is in the hand from the start of the window to release
   * (the rep's middle bound) and gone after. Solved on the rep's own window,
   * padded so the smoothing has something either side of it. */
  const pad = Math.max(smoothWin, 5);
  const full = prep.arms[0];
  const a0 = Math.max(0, b0 - pad), a1 = Math.min(full.elbow.length - 1, b1 + pad);
  const cut = (arr) => (arr ? arr.slice(a0, a1 + 1) : null);
  const p = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, cut(v)]));
  const d = armInverseDynamics(p, massKg, fps,
    { mode: "free", ballKg, releaseIdx: mid0 - a0, smoothWin });
  const back = (arr) => arr.slice(b0 - a0, b1 - a0 + 1);
  return { elbow_moment: back(d.elbow_moment), shoulder_moment: back(d.shoulder_moment),
           body_weight_n: d.body_weight_n };
}

/**
 * Power for every joint that has both a moment and an (unsided) velocity.
 * Extension-positive moment times extension-positive angular velocity, which
 * is minus the flexion velocity, in rad/s.
 */
export function addPower(jm) {
  for (const k of Object.keys(jm)) {
    const m = /^(.*)_moment$/.exec(k);
    if (!m) continue;
    const M = jm[k], w = jm[`${m[1]}_vel`];
    if (!Array.isArray(M) || !Array.isArray(w) || w.length !== M.length) continue;
    jm[`${m[1]}_power`] = M.map((v, i) => -v * w[i] * Math.PI / 180);
  }
  return jm;
}

/**
 * The joints a rep can show for one metric, in display order, each with the
 * keys that draw it: one key for an unsided joint, two for a per-leg one.
 * A per-leg task keeps an averaged angle for power; it is not offered when the
 * two legs are there, because it would be a third curve that is neither leg.
 */
export function jointOptions(jm, metric, activity) {
  if (!jm) return [];
  const out = [];
  for (const j of jointOrder(activity)) {
    const l = jm[`${j}_${metric}_l`], r = jm[`${j}_${metric}_r`];
    const u = jm[`${j}_${metric}`];
    const keys = [];
    if (Array.isArray(r) && r.length) keys.push([`${j}_${metric}_r`, "r"]);
    if (Array.isArray(l) && l.length) keys.push([`${j}_${metric}_l`, "l"]);
    if (!keys.length && Array.isArray(u) && u.length) keys.push([`${j}_${metric}`, null]);
    if (keys.length) out.push({ joint: j, keys });
  }
  return out;
}

/**
 * Rebuild `jm` for a rep that came back from storage without one -- a set
 * recorded before this module existed. Only what the stored curves allow: the
 * .mot angles (clipped, so the velocity inherits the clip) and the leg moments.
 * Times must be seconds; a mean rep is rebuilt from its reps, never from itself.
 */
export function jmFromStored(rep, activity, kneeSign = -1) {
  const c = rep && rep.coords;
  if (!c || !Array.isArray(rep.times) || rep.times.length < 3 || rep.timeUnit === "%") return null;
  const dt = (rep.times[rep.times.length - 1] - rep.times[0]) / (rep.times.length - 1) || 1 / 30;
  const fps = 1 / dt;
  const angles = {};
  const add = (k, a) => { if (finiteSome(a)) angles[k] = Array.from(a, Number); };
  const knee = (a) => a && a.map((v) => v * (kneeSign < 0 ? -1 : 1));
  if (activity === "pullup" || activity === "dip") {
    add("elbow", c.elbow_flex_r); add("shoulder", c.arm_flex_r);
    add("hip", c.hip_flexion_r); add("knee", c.knee_angle_r);
  } else {
    add("knee", knee(c.knee_angle_r)); add("hip", c.hip_flexion_r);
    add("ankle", c.ankle_angle_r);
  }
  const vels = clipVelocities(angles, fps);
  const jm = repKinematics(angles, vels, [0, 0, rep.times.length - 1]);
  if (rep.dyn) {
    for (const j of ["hip", "knee", "ankle"]) {
      if (Array.isArray(rep.dyn[`${j}_moment`])) jm[`${j}_moment`] = rep.dyn[`${j}_moment`];
    }
  }
  return addPower(jm);
}
