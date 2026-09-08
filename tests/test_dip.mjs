/**
 * Dips.
 *
 *   node tests/test_dip.mjs
 *
 * The clips are geometry, not footage: a dip is a body hanging from the hands
 * that sinks and rises while the elbows bend and straighten, and that is all
 * these build. What is being tested is the decision rule.
 *
 * The pull-up case matters more than the dip cases. The two movements are the
 * same signal with the sign flipped -- body up, body down, elbows doing the
 * work -- and the only thing that tells them apart is where the hands are. If
 * that check ever stops working, a pull-up will be measured as a dip and every
 * number it produces will look entirely reasonable.
 */
import { buildDipFeatures, findDipReps, DEFAULT_DIP_CFG, ACTIVITIES, analyse }
  from "../src/kinematics.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};

const T = 180;                       // torso length in px

/**
 * One clip. `depths` is the shoulder's sink below lockout, per frame, as a
 * fraction of torso length. `overhead` puts the wrists above the shoulders --
 * a pull-up rather than a dip.
 */
function clip(depths, { overhead = false, stiffArms = false } = {}) {
  const poses = {};
  const HAND_Y = 400;                // the bars do not move
  const ARM = 0.26 * T;              // upper arm and forearm, each
  depths.forEach((d, i) => {
    /* At lockout the shoulders sit half a torso ABOVE the hands and the arms
     * are nearly straight; sinking brings the shoulders down toward the hands
     * and folds the elbow. That is the geometry the detector has to read, so
     * the clip states it rather than asserting an elbow angle directly. */
    const shY = HAND_Y - 0.5 * T + d * T;
    const hipY = shY + T;
    const handY = overhead ? shY - 0.55 * T : HAND_Y;
    const sep = Math.abs(handY - shY);
    const half = Math.min(sep / 2, ARM * 0.999);
    const out = stiffArms ? 0 : Math.sqrt(Math.max(0, ARM * ARM - half * half));
    const elbY = (shY + handY) / 2;
    poses[i] = {
      nose: [250, shY - 90], left_ear: [244, shY - 80], right_ear: [256, shY - 80],
      left_shoulder: [235, shY], right_shoulder: [265, shY],
      left_elbow: [235 - out, elbY], right_elbow: [265 + out, elbY],
      left_wrist: [232, handY], right_wrist: [268, handY],
      left_hip: [242, hipY], right_hip: [258, hipY],
      left_knee: [242, hipY + 0.7 * T], right_knee: [258, hipY + 0.7 * T],
      left_ankle: [242, hipY + 1.4 * T], right_ankle: [258, hipY + 1.4 * T],
      left_foot_index: [242, hipY + 1.5 * T], right_foot_index: [258, hipY + 1.5 * T],
      left_heel: [242, hipY + 1.45 * T], right_heel: [258, hipY + 1.45 * T],
    };
  });
  return poses;
}

/** n dips of a given depth, held briefly at lockout between them. */
function dips(n, depth = 0.42, down = 12, up = 12, hold = 8) {
  const d = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < hold; i++) d.push(0);
    for (let i = 1; i <= down; i++) d.push(depth * (i / down));
    for (let i = up - 1; i >= 0; i--) d.push(depth * (i / up));
  }
  for (let i = 0; i < hold; i++) d.push(0);
  return d;
}

/* --- how many, and where ------------------------------------------------- */
{
  const F = buildDipFeatures(clip(dips(3)));
  const { reps } = findDipReps(F);
  ok(reps.length === 3, "three dips are three reps", `found ${reps.length}`);
  const [b0, bot, b1] = reps[0] || [];
  ok(b0 < bot && bot < b1, "the rep runs lockout, bottom, lockout");
  ok(F.drop[bot] > F.drop[b0] && F.drop[bot] > F.drop[b1],
     "the middle of a dip is its LOWEST point, not its highest");
}

/* --- what is not a dip ---------------------------------------------------- */
{
  const F = buildDipFeatures(clip(dips(3), { overhead: true }));
  const out = findDipReps(F);
  ok(out.reps.length === 0 && out.refused === "handsOverhead",
     "hands overhead is a pull-up and is refused, not measured as a dip");
}
{
  // Straight arms throughout: the body sinks because the whole apparatus does.
  const out = findDipReps(buildDipFeatures(clip(dips(3), { stiffArms: true })));
  ok(out.reps.length === 0,
     "a body that sinks with straight arms is not a dip");
}
{
  const shallow = findDipReps(buildDipFeatures(clip(dips(3, 0.06))));
  ok(shallow.reps.length === 0,
     "a sway of a few centimetres is not three dips");
}
{
  const still = findDipReps(buildDipFeatures(clip(new Array(120).fill(0))));
  ok(still.reps.length === 0, "hanging at lockout is no reps at all");
}

/* --- the phases are in the right order ------------------------------------ */
{
  const res = analyse(clip(dips(3)), 30, { activity: "dip", heightM: 1.81 });
  ok(res.reps.length === 3, "the whole pipeline finds them too",
     `${res.reps.length} reps`);
  const r = res.reps[0];
  ok(r.eccentric_s > 0 && r.concentric_s > 0, "both phases have a duration");
  ok(ACTIVITIES.dip.phases[0] === "eccentric_s",
     "the DOWN comes first: a dip lowers before it presses");
  ok(r.elbow_flex_max_deg > 40,
     "peak elbow flexion is reported", `${r.elbow_flex_max_deg?.toFixed(0)} deg`);
  ok(r.pelvis_travel_m > 0.05,
     "and the depth the body travelled", `${r.pelvis_travel_m?.toFixed(3)} m`);
}

/* Deeper dips must read as deeper, or the number is decoration. */
{
  const a = analyse(clip(dips(2, 0.25)), 30, { activity: "dip", heightM: 1.81 });
  const b = analyse(clip(dips(2, 0.50)), 30, { activity: "dip", heightM: 1.81 });
  const depth = (r) => r.reps[0].pelvis_travel_m;
  ok(a.reps.length && b.reps.length && depth(b) > depth(a) * 1.5,
     "twice the sink reads as roughly twice the depth",
     `${depth(a)?.toFixed(3)} m vs ${depth(b)?.toFixed(3)} m`);
}

console.log(bad ? `\nFAIL ${bad} check(s)` : "\nAll checks passed");
if (bad) process.exit(1);

/* --- the peak angle must be the measurement, not the model's ceiling ------ */
{
  const res = analyse(clip(dips(3, 0.62)), 30, { activity: "dip", heightM: 1.81 });
  const peaks = res.reps.map((r) => r.elbow_flex_max_deg);
  const capped = res.reps.map((r) => Math.max(...r.coords.elbow_flex_r));
  ok(peaks.every((v) => v >= Math.max(...capped) - 0.5),
     "the reported peak is at least the exported one", peaks.join(" "));
  const clippedFlag = res.reps.some((r) => r.elbow_clipped);
  const anyOver = peaks.some((v, i) => v > capped[i] + 0.5);
  ok(clippedFlag === anyOver,
     "and a rep past the model's range is flagged, never silently capped");
  ok(capped.every((v) => v <= 150.0001),
     "while the exported column stays inside the model's range", capped.join(" "));
}
