/**
 * Angle, velocity, moment and power per joint -- the signs, mostly.
 *
 * Every number on these four plots is a sign convention before it is a
 * magnitude, and a flipped sign is not an obvious error: a pull-up whose elbow
 * reads "extensor" looks like data. So the conventions are pinned against
 * movements whose answer is known without any modelling:
 *
 *   pull-up, side-on   the elbow flexors and shoulder extensors hold the body,
 *                      so elbow moment < 0 and shoulder moment > 0; both joints
 *                      do positive work on the way up and absorb it on the way
 *                      down.
 *   dip, side-on       the reverse at the elbow (triceps: moment > 0), and at
 *                      the bottom the shoulder is held from being forced back
 *                      (moment < 0).
 *   mirror image       the same movement filmed from the other side gives the
 *                      same numbers. Facing is read off the elbow, not assumed.
 *
 *   node tests/test_jointmetrics.mjs
 */
const K = await import("../src/kinematics.js");
const J = await import("../src/jointmetrics.js");
const { ensembleRep, mergeSides } = await import("../src/ensemble.js");

let bad = 0;
const check = (ok, msg, detail = "") => {
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${msg}${detail ? "  " + detail : ""}`);
};

const FPS = 60, PX = 200, UA = 0.30, FA = 0.27;
const px = (p, mirror) => [500 + (mirror ? -1 : 1) * p[0] * PX, 1000 - p[1] * PX];

/** Elbow from shoulder and wrist, on the side that folds the arm FORWARD for
 *  an athlete facing +x (counter-clockwise forearm relative to upper arm). */
function elbowIK(S, W) {
  const dx = W[0] - S[0], dy = W[1] - S[1];
  const d = Math.min(Math.hypot(dx, dy), UA + FA - 1e-6);
  const a = (UA * UA - FA * FA + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, UA * UA - a * a));
  const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
  const m = [S[0] + a * ux, S[1] + a * uy];
  for (const sgn of [1, -1]) {
    const E = [m[0] - sgn * h * uy, m[1] + sgn * h * ux];
    const u = [E[0] - S[0], E[1] - S[1]], f = [W[0] - E[0], W[1] - E[1]];
    if (u[0] * f[1] - u[1] * f[0] >= 0) return E;
  }
  return m;
}

/** A rep: shoulder height follows a cosine between lo and hi, hands fixed. */
function clip(kind, mirror = false) {
  const n = 3 * FPS, poses = {};
  const W = kind === "pullup" ? [0.06, 2.30] : [0.0, 1.20];
  // Pull-up: shoulder from near-straight arms up to the bar. Dip: from lockout
  // down to a deep bottom and back.
  const [yA, yB] = kind === "pullup" ? [2.30 - 0.54, 2.30 - 0.18] : [1.20 + 0.54, 1.20 + 0.26];
  const bounds = [FPS / 2, FPS / 2 + FPS, FPS / 2 + 2 * FPS];
  for (let i = 0; i < n; i++) {
    let ph = 0;
    if (i >= bounds[0] && i <= bounds[2]) ph = 0.5 * (1 - Math.cos(2 * Math.PI * (i - bounds[0]) / (2 * FPS)));
    // A dip leans the trunk forward as it sinks, so at the bottom the
    // shoulders are in front of the hands -- which is what makes the shoulder
    // moment a flexor one there.
    const S = [kind === "dip" ? 0.12 * ph : 0, yA + (yB - yA) * ph];
    const E = elbowIK(S, W);
    const H = [0, S[1] - 0.50], Kn = [0.02, H[1] - 0.45], A = [0, Kn[1] - 0.43];
    const lm = {};
    for (const sd of ["left", "right"]) {
      const o = sd === "left" ? -0.01 : 0.01;     // side-on: the arms overlap
      lm[`${sd}_shoulder`] = px([S[0] + o, S[1]], mirror);
      lm[`${sd}_elbow`] = px([E[0] + o, E[1]], mirror);
      lm[`${sd}_wrist`] = px([W[0] + o, W[1]], mirror);
      lm[`${sd}_hip`] = px([H[0] + o, H[1]], mirror);
      lm[`${sd}_knee`] = px([Kn[0] + o, Kn[1]], mirror);
      lm[`${sd}_ankle`] = px([A[0] + o, A[1]], mirror);
    }
    lm.nose = px([0.08, S[1] + 0.25], mirror);
    poses[i] = lm;
  }
  return { poses, bounds };
}

function solve(kind, mirror = false) {
  const { poses, bounds } = clip(kind, mirror);
  const spec = K.ACTIVITIES[kind];
  const F = spec.features(poses);
  const tracks = J.armTracks(poses);
  const angles = J.clipAngles(kind, spec, F, tracks);
  const vels = J.clipVelocities(angles, FPS);
  const prep = J.clipArmMoments(kind, tracks, PX, 75, FPS, { systemKg: 75 });
  const jm = J.repKinematics(angles, vels, bounds);
  const arm = J.armMomentsForRep(prep, bounds, 75, FPS);
  jm.elbow_moment = arm.elbow_moment; jm.shoulder_moment = arm.shoulder_moment;
  jm.hand_force_n = arm.hand_force_vertical;
  J.addPower(jm);
  const half = bounds[1] - bounds[0];
  return { jm, half, bounds };
}
const mean = (a, i0 = 0, i1 = a.length) => a.slice(i0, i1).reduce((s, v) => s + v, 0) / (i1 - i0);
const f1 = (v) => v.toFixed(1);

console.log("side-on pull-up");
{
  const { jm, half } = solve("pullup");
  const n = jm.elbow_moment.length;
  check(mean(jm.elbow_moment) < 0, "elbow moment is a FLEXOR moment (negative)", f1(mean(jm.elbow_moment)) + " N·m");
  check(mean(jm.shoulder_moment) > 0, "shoulder moment is an EXTENSOR moment (positive)", f1(mean(jm.shoulder_moment)) + " N·m");
  check(mean(jm.elbow_vel, 5, half - 5) > 0, "the elbow flexes on the way up (velocity positive)", f1(mean(jm.elbow_vel, 5, half - 5)) + " deg/s");
  check(mean(jm.elbow_power, 5, half - 5) > 0 && mean(jm.elbow_power, half + 5, n - 5) < 0,
        "elbow power: generated up, absorbed down",
        `${f1(mean(jm.elbow_power, 5, half - 5))} / ${f1(mean(jm.elbow_power, half + 5, n - 5))} W`);
  check(mean(jm.shoulder_power, 5, half - 5) > 0 && mean(jm.shoulder_power, half + 5, n - 5) < 0,
        "shoulder power: generated up, absorbed down",
        `${f1(mean(jm.shoulder_power, 5, half - 5))} / ${f1(mean(jm.shoulder_power, half + 5, n - 5))} W`);
  const pk = Math.max(...jm.elbow_moment.map(Math.abs));
  check(pk > 10 && pk < 120, "peak elbow moment is in a human range", f1(pk) + " N·m per arm");
  const bw = Math.max(...jm.hand_force_n) / (75 * 9.80665);
  check(bw > 1.0 && bw < 1.6, "hands carry about body weight, plus the acceleration", bw.toFixed(2) + " BW");
  check(Math.min(...jm.shoulder_angle) > 90, "arms overhead read as large shoulder flexion", f1(Math.min(...jm.shoulder_angle)) + " deg min");
}

console.log("side-on dip");
{
  const { jm, half } = solve("dip");
  check(mean(jm.elbow_moment) > 0, "elbow moment is an EXTENSOR moment (triceps)", f1(mean(jm.elbow_moment)) + " N·m");
  check(jm.shoulder_moment[half] < 0, "at the bottom the shoulder moment is a FLEXOR moment", f1(jm.shoulder_moment[half]) + " N·m");
  check(jm.shoulder_angle[half] < 0, "and the arm is behind the trunk (negative angle), not mirrored in front",
        f1(jm.shoulder_angle[half]) + " deg");
  const n = jm.elbow_power.length;
  check(mean(jm.elbow_power, 5, half - 5) < 0 && mean(jm.elbow_power, half + 5, n - 5) > 0,
        "elbow power: absorbed on the way down, generated on the way up",
        `${f1(mean(jm.elbow_power, 5, half - 5))} / ${f1(mean(jm.elbow_power, half + 5, n - 5))} W`);
}

console.log("the other side of the athlete");
for (const kind of ["pullup", "dip"]) {
  const a = solve(kind).jm, b = solve(kind, true).jm;
  const diff = (k) => Math.max(...a[k].map((v, i) => Math.abs(v - b[k][i])));
  check(diff("elbow_moment") < 1e-6 && diff("shoulder_moment") < 1e-6 && diff("shoulder_angle") < 1e-6,
        `${kind} filmed from the left and from the right agree`,
        `max diff ${diff("elbow_moment").toExponential(1)} N·m`);
}

console.log("defaults and options");
check(J.defaultJoint("pullup") === "elbow" && J.defaultJoint("dip") === "elbow"
      && J.defaultJoint("jumpshot") === "elbow", "arm tasks open on the elbow");
check(J.defaultJoint("squat") === "knee" && J.defaultJoint("run") === "knee"
      && J.defaultJoint("cmj") === "knee", "leg tasks open on the knee");
{
  const { jm } = solve("pullup");
  const joints = (m) => J.jointOptions(jm, m, "pullup").map((o) => o.joint).join(",");
  check(joints("angle") === "elbow,shoulder,hip,knee", "every tracked joint can be plotted", joints("angle"));
  check(joints("power") === "elbow,shoulder", "power only where there is a moment", joints("power"));
  const leg = { knee_angle_l: [1], knee_angle_r: [1], knee_angle: [1], knee_moment: [1] };
  const o = J.jointOptions(leg, "angle", "slsquat");
  check(o.length === 1 && o[0].keys.map((k) => k[1]).join() === "r,l",
        "a per-leg task draws both legs, not their average");
}

console.log("the mean rep");
{
  const reps = [0, 1, 2].map((k) => {
    const { jm, bounds } = solve("pullup");
    const n = jm.elbow_angle.length;
    const jm2 = Object.fromEntries(Object.entries(jm).map(([key, v]) => [key, v.map((x) => x * (1 + 0.1 * k))]));
    return { rep: k + 1, bounds: [0, bounds[1] - bounds[0], n - 1],
             times: Array.from({ length: n }, (_, i) => i / FPS), coords: { elbow_flex_r: jm.elbow_angle }, jm: jm2 };
  });
  const m = ensembleRep(reps);
  check(m.jm && m.jm.elbow_power && m.jm.elbow_power.length === 101, "power is averaged onto the 0-100% grid");
  check(m.sd && m.sd.jm && Math.max(...m.sd.jm.elbow_moment) > 0, "with a between-rep SD");
  const mid = 25, want = reps.reduce((s, r) => s + r.jm.elbow_vel[Math.round((r.jm.elbow_vel.length - 1) * mid / 100)], 0) / 3;
  check(Math.abs(m.jm.elbow_vel[mid] - want) < 0.05 * Math.abs(want) + 1,
        "the mean velocity is the mean of the reps' velocities (deg/s, not deg/%)",
        `${f1(m.jm.elbow_vel[mid])} vs ${f1(want)}`);
  const L = { nReps: 2, times: [0, 1], coords: { knee_angle_l: [1, 2] }, jm: { knee_angle_l: [1, 2], knee_moment: [5, 6] } };
  const R = { nReps: 2, times: [0, 1], coords: { knee_angle_r: [3, 4] }, jm: { knee_angle_r: [3, 4], knee_moment: [7, 8] } };
  const g = mergeSides(L, R);
  check(g.jm.knee_angle_l[0] === 1 && g.jm.knee_angle_r[0] === 3 && g.jm.knee_moment[0] === 5
        && g.jmRight.knee_moment[0] === 7, "gait keeps each leg's angle and each cycle's moment");
}

console.log(bad ? `\n${bad} check(s) FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
