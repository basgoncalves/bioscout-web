/* Gait tabs are mergeSides() results, every one of them -- not just the mean.
 * It carried the contact force but not the muscle forces that cause it, so
 * running had no muscle plot and no contribution plot. */
import { mergeSides } from "../src/ensemble.js";

const n = 4;
const side = (s, scale) => ({
  nReps: 3, times: [0, 25, 50, 75], timeUnit: "%", bounds: [0, 2, 4],
  coords: { [`knee_angle_${s}`]: [1, 2, 3, 4].map((v) => v * scale) },
  forces: Array.from({ length: n }, () => [10 * scale, 20 * scale]),
  forceNames: ["vaslat_l", "vaslat_r"],
  forceModel: { v: 2 }, forceMissing: [], forceImplausible: 0.1,
  jrf: Array.from({ length: n }, () => [3 * scale, 4 * scale]),
  jrfNames: ["knee_l_mag", "knee_r_mag"],
  jm: { knee_moment: [1, 1, 1, 1] },
});
const m = mergeSides(side("l", 1), side("r", 2));

if (!m.forces || !m.forceNames) throw new Error("mergeSides dropped the muscle forces");
const c = (nm) => m.forces[0][m.forceNames.indexOf(nm)];
// Each leg's column must come from ITS OWN cycle, like the loads and the jrf.
if (c("vaslat_l") !== 10) throw new Error(`left muscle came from the wrong cycle: ${c("vaslat_l")}`);
if (c("vaslat_r") !== 40) throw new Error(`right muscle came from the wrong cycle: ${c("vaslat_r")}`);
if (m.forceImplausible !== 0.1) throw new Error("forceImplausible lost");

// One side only (a clip where one foot never showed) must still carry forces.
const solo = mergeSides(side("l", 1), null);
if (!solo.forces || solo.forces[0].length !== 2) throw new Error("one-sided merge lost the forces");

// Nothing to carry -> no empty arrays left behind for metricAvailable to trust.
const bare = mergeSides({ nReps: 1, times: [0], timeUnit: "%", coords: { knee_angle_l: [1] } }, null);
if (bare.forces) throw new Error("forces invented out of nothing");

console.log("ok    mergeSides carries muscle forces per side (gait muscle + contribution plots)");
