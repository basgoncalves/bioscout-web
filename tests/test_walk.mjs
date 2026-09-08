/**
 * Walking as its own task.
 *
 * Walking is running with the flight phase taken away, and that absence is the
 * whole difficulty: every gait check written for running asks whether a foot
 * left the floor, and in a walk one never does. These fixtures are synthetic
 * gait -- a 62% duty cycle, feet alternating, never both airborne -- which is
 * exactly the clip the running detector is entitled to refuse.
 *
 *   node tests/test_walk.mjs
 */
import { ACTIVITIES } from "../src/kinematics.js";
import { score, features } from "../src/detect.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

/* Landmarks in pixel space, the shape the page builds: [x*w, y*h] per name.
 * `duty` is the fraction of the cycle each foot spends on the floor -- above
 * 0.5 the two overlap, which is double support, which is what makes it a walk.
 * `flight` lifts BOTH feet together to make the running comparison. */
function gait({ duty = 0.62, strideF = 66, cycles = 12, W = 720, H = 1280,
                travelN = 0, flight = false } = {}) {
  const n = strideF * cycles, floorN = 0.90, lift = 0.055;
  const footN = (i, ph) => {
    const t = ((i / strideF) + ph) % 1;
    if (t < duty) return floorN;
    return floorN - lift * Math.sin(Math.PI * (t - duty) / (1 - duty));
  };
  const poses = {};
  for (let i = 0; i < n; i++) {
    const dx = travelN * (i / n);
    const hipY = 0.55 - (flight ? 0.02 * Math.max(0, Math.sin(2 * Math.PI * i / strideF)) : 0);
    const P = (x, y) => [(x + dx) * W, y * H];
    poses[i] = {
      nose: P(0.5, 0.18), left_shoulder: P(0.46, 0.32), right_shoulder: P(0.54, 0.32),
      left_hip: P(0.47, hipY), right_hip: P(0.53, hipY),
      left_knee: P(0.47, hipY + 0.17), right_knee: P(0.53, hipY + 0.17),
      left_ankle: P(0.47, footN(i, 0)), right_ankle: P(0.53, footN(i, 0.5)),
      left_heel: P(0.46, footN(i, 0) + 0.008), right_heel: P(0.52, footN(i, 0.5) + 0.008),
      left_foot_index: P(0.49, footN(i, 0) + 0.015),
      right_foot_index: P(0.55, footN(i, 0.5) + 0.015),
    };
  }
  return poses;
}

const findWith = (act, poses) => {
  const spec = ACTIVITIES[act];
  return spec.findReps(spec.features(poses), spec.defaultCfg);
};

/* --- the activity exists and is gait ------------------------------------ */
const walk = ACTIVITIES.walk;
ok(!!walk, "walk is an activity");
ok(walk.gait === true && ACTIVITIES.run.gait === true,
   "walk and run are both marked gait, so the pipeline treats them alike");
ok(walk.perLeg && walk.cyclic && walk.travels,
   "walk is per-leg, cyclic and travels, like running");
ok(walk.defaultCfg.maxStrideFrames > ACTIVITIES.run.defaultCfg.maxStrideFrames,
   "with a longer stride allowed, because walking is slower",
   `${walk.defaultCfg.maxStrideFrames} > ${ACTIVITIES.run.defaultCfg.maxStrideFrames}`);

/* --- strides are found in a walk, contact to contact -------------------- */
const w = findWith("walk", gait());
ok(!w.refused, "an ordinary walk is not refused", w.refused || "");
ok(w.reps.length >= 20, "and yields a stride per foot per cycle", `${w.reps.length} strides`);
ok(w.sideReps.l.length === w.sideReps.r.length,
   "both feet contribute, evenly on a symmetric walk",
   `${w.sideReps.l.length}/${w.sideReps.r.length}`);
ok(w.repSides.filter((s) => s === "l").length === w.sideReps.l.length,
   "and every stride carries the foot it belongs to");

/* A slow walk: the stride window is the reason walk is not just run relabelled. */
const slow = findWith("walk", gait({ strideF: 110 }));
const slowAsRun = findWith("run", gait({ strideF: 110 }));
ok(slow.reps.length >= 18, "a slow walk still yields strides", `${slow.reps.length}`);
ok(slowAsRun.reps.length < slow.reps.length,
   "which the running window would have thrown away",
   `run ${slowAsRun.reps.length} vs walk ${slow.reps.length}`);

/* --- the classifier tells a walk from a run ----------------------------- */
const sWalk = score(features(gait({ travelN: 0.15 })));
ok(sWalk.walk > sWalk.run, "walking scores above running",
   `walk ${sWalk.walk.toFixed(2)} vs run ${sWalk.run.toFixed(2)}`);
ok(sWalk.walk > sWalk.squat && sWalk.walk > sWalk.cmj,
   "and above the standing tasks",
   `squat ${sWalk.squat.toFixed(2)}, cmj ${sWalk.cmj.toFixed(2)}`);
ok(sWalk.run < 0.2, "a clip with no flight in it barely scores as a run",
   sWalk.run.toFixed(2));

/* --- the protocol the assessment actually asks for ----------------------
 *
 * "Walk away from the camera and back." Filmed head-on, that does two things
 * at once that a fixed reference cannot survive: the feet climb the image as
 * the athlete recedes -- perspective, not the foot leaving the ground -- and
 * the whole body shrinks, so a contact band that is a fixed fraction of the
 * clip's median shank is far too wide near the camera and far too narrow away
 * from it. A planted foot at the far end then sits well above a floor line
 * fixed at the clip's 97th percentile, and every step there reads as airborne.
 *
 * This fixture reproduces exactly that: the same gait, with the feet and the
 * body scaled by distance over the clip.
 */
function walkAwayAndBack({ strideF = 66, cycles = 12, duty = 0.62,
                           W = 720, H = 1280, near = 1, far = 0.45 } = {}) {
  const n = strideF * cycles, lift = 0.10;
  const phase = (i, ph) => {
    const t = ((i / strideF) + ph) % 1;
    return t < duty ? 0 : lift * Math.sin(Math.PI * (t - duty) / (1 - duty));
  };
  const poses = {};
  for (let i = 0; i < n; i++) {
    // Out to the far end and back: scale 1 -> far -> 1.
    const u = i / (n - 1);
    const k = near + (far - near) * (1 - Math.abs(2 * u - 1));
    // Everything converges toward the vanishing point as the body recedes,
    // which lifts the feet up the image exactly as a real walk does.
    const horizon = 0.45;
    const at = (yStand) => horizon + (yStand - horizon) * k;
    const P = (x, y) => [(0.5 + (x - 0.5) * k) * W, at(y) * H];
    const hipY = 0.55, toeY = 0.93;
    poses[i] = {
      nose: P(0.5, 0.18), left_shoulder: P(0.46, 0.32), right_shoulder: P(0.54, 0.32),
      left_hip: P(0.47, hipY), right_hip: P(0.53, hipY),
      left_knee: P(0.47, hipY + 0.17), right_knee: P(0.53, hipY + 0.17),
      left_ankle: P(0.47, toeY - phase(i, 0)), right_ankle: P(0.53, toeY - phase(i, 0.5)),
      left_heel: P(0.46, toeY - phase(i, 0) + 0.008),
      right_heel: P(0.52, toeY - phase(i, 0.5) + 0.008),
      left_foot_index: P(0.49, toeY - phase(i, 0) + 0.015),
      right_foot_index: P(0.55, toeY - phase(i, 0.5) + 0.015),
    };
  }
  return poses;
}

{
  const poses = walkAwayAndBack();
  const found = findWith("walk", poses);
  ok(!found.refused, "a walk away from the camera and back is not refused",
     found.refused || "");
  ok(found.reps.length >= 16,
     "and still yields strides at both ends of the room", `${found.reps.length} strides`);
  ok(found.sideReps.l.length >= 6 && found.sideReps.r.length >= 6,
     "on both feet", `${found.sideReps.l.length}/${found.sideReps.r.length}`);

  /* The far half is the half that used to disappear, so check it explicitly
   * rather than trusting a total that the near half could carry on its own. */
  const mid = (66 * 12) / 2;
  const far = found.reps.filter((r) => r[0] > mid * 0.55 && r[2] < mid * 1.45);
  ok(far.length >= 4, "including in the middle of the clip, at the far end",
     `${far.length} strides out there`);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
