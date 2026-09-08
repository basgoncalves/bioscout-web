/**
 * The tip-toe test: counting single-leg heel raises from a phone camera.
 *
 * This is the smallest movement the app measures -- a heel a few centimetres
 * off the floor -- so the fixtures below check the two things that make it
 * measurable at all: that the signal is heel-above-TOE rather than
 * heel-above-floor (which makes it survive a swaying athlete and a wrong floor
 * line), and that the two legs are counted separately from one clip.
 *
 *   node tests/test_heelraise.mjs
 */
import { ACTIVITIES } from "../src/kinematics.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

/* `sway` drifts the whole body down the image, as an athlete leaning on a wall
 * does and as a hand-held phone does. `lift` is in foot lengths. */
function raises({ nLeft = 8, nRight = 8, repF = 60, lead = 30, peak = 0.55,
                  sway = 0, W = 720, H = 1280 } = {}) {
  const n = lead + Math.max(nLeft, nRight) * repF + 30;
  const footLenN = 0.05;
  const shape = (i, count) => {
    const k = i - lead;
    if (k < 0 || k >= count * repF) return 0;
    return peak * Math.max(0, Math.sin(Math.PI * (k % repF) / repF));
  };
  const poses = {};
  for (let i = 0; i < n; i++) {
    const d = sway * Math.sin(2 * Math.PI * i / 90);
    const P = (x, y) => [x * W, (y + d) * H];
    const toeY = 0.93;
    poses[i] = {
      nose: P(0.5, 0.15), left_shoulder: P(0.46, 0.30), right_shoulder: P(0.54, 0.30),
      left_hip: P(0.47, 0.55), right_hip: P(0.53, 0.55),
      left_knee: P(0.47, 0.74), right_knee: P(0.53, 0.74),
      left_ankle: P(0.47, 0.895), right_ankle: P(0.53, 0.895),
      left_heel: P(0.455, toeY - shape(i, nLeft) * footLenN),
      right_heel: P(0.515, toeY - shape(i, nRight) * footLenN),
      left_foot_index: P(0.505, toeY), right_foot_index: P(0.565, toeY),
    };
  }
  return poses;
}

const spec = ACTIVITIES.heelraise;
const find = (opts) => spec.findReps(spec.features(raises(opts)), spec.defaultCfg);

ok(!!spec, "heelraise is an activity");
ok(spec.perLeg === true, "and is per-leg, because the two sides are the point");

const even = find({ nLeft: 8, nRight: 8 });
ok(!even.refused, "an ordinary set of raises is not refused", even.refused || "");
ok(even.sideReps.l.length === 8 && even.sideReps.r.length === 8,
   "eight raises a side are counted as eight a side",
   `${even.sideReps.l.length}/${even.sideReps.r.length}`);
ok(even.reps.length === 16, "sixteen reps in total from one clip");
ok(even.repSides.filter((s) => s === "l").length === 8,
   "each rep carrying the foot it happened on");

/* One leg to failure, then the other -- the asymmetry is the finding. */
const uneven = find({ nLeft: 12, nRight: 5 });
ok(uneven.sideReps.l.length === 12 && uneven.sideReps.r.length === 5,
   "an uneven set is counted unevenly, not averaged",
   `${uneven.sideReps.l.length}/${uneven.sideReps.r.length}`);

/* The reason the signal is heel-above-toe: both landmarks move together when
 * the athlete sways or the phone does, so the difference is unchanged. */
const swayed = find({ nLeft: 8, nRight: 8, sway: 0.04 });
ok(swayed.sideReps.l.length === 8,
   "a swaying body does not add or lose reps", `${swayed.sideReps.l.length}`);

/* A heel that barely leaves the floor is not a raise. */
const shallow = find({ nLeft: 8, nRight: 8, peak: 0.15 });
ok(shallow.reps.length === 0 && shallow.refused === "noHeelRaises",
   "raises too small to be full range are refused, not counted",
   `${shallow.reps.length} reps`);

/* Standing still is not a set of raises. */
const still = find({ nLeft: 0, nRight: 0 });
ok(still.refused === "noHeelRaises", "standing still is refused");

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
