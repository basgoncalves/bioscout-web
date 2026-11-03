// A coordinate the camera cannot see is dropped from the export, not zeroed.
import assert from "node:assert/strict";
import { viewQuality, ankleValidMask } from "../src/kinematics.js";

/* Built from the real front-on CMJ (cmj_2.mp4): filmed face-on the foot points
 * at the lens, so the knee-ankle-toe angle flattens to ~164 deg and stays
 * there through the whole jump -- dorsiflexion happens in a plane the camera
 * cannot see. Side-on, the same joint sits near 105 deg and moves. */
function clip({ frontal, ankleDeg }) {
  const poses = {};
  const sep = frontal ? 120 : 12;            // shoulder separation in pixels
  for (let i = 0; i < 40; i++) {
    // Place the toe so that knee-ankle-toe lands on ankleDeg.
    const a = (ankleDeg * Math.PI) / 180;
    poses[i] = {
      left_shoulder: [200 - sep / 2, 100], right_shoulder: [200 + sep / 2, 100],
      left_hip: [200 - sep / 4, 300], right_hip: [200 + sep / 4, 300],
      left_knee: [200, 450], right_knee: [210, 450],
      left_ankle: [200, 600], right_ankle: [210, 600],
      // knee is straight up from the ankle; rotate by ankleDeg to get the toe
      left_foot_index: [200 + 60 * Math.sin(a), 600 - 60 * Math.cos(a)],
      right_foot_index: [210 + 60 * Math.sin(a), 600 - 60 * Math.cos(a)],
    };
  }
  return poses;
}

const front = viewQuality(clip({ frontal: true, ankleDeg: 164 }));
assert.equal(front.view, "frontal", "view " + front.view);
assert.equal(front.ankle_usable, false, "a flattened ankle must not be called usable");

const side = viewQuality(clip({ frontal: false, ankleDeg: 105 }));
assert.equal(side.view, "sagittal", "view " + side.view);
assert.equal(side.ankle_usable, true, "a side-on ankle is measurable");
assert.ok(side.ankle_saturated_frac < 0.25, "a real ankle sits inside the clip bounds");

// Degenerate angle, even side-on: the foot square to the lens.
assert.equal(viewQuality(clip({ frontal: false, ankleDeg: 170 })).ankle_usable, false);

/* A FRONTAL view disqualifies the ankle even when the interior angle looks
 * innocent. Regression for the squat jump filmed face-on: interior sat at
 * ~143 deg, which cleared the old <155 check, but the dorsiflexion it implies
 * (90 - 143 = -53 deg) is outside any real ankle and the export flatlined on
 * the -40 clip bound. */
const sneaky = viewQuality(clip({ frontal: true, ankleDeg: 143 }));
assert.equal(sneaky.view, "frontal");
assert.ok(sneaky.median_ankle_interior_deg < 155, "clears the old degeneracy check");
assert.equal(sneaky.ankle_usable, false, "but a frontal view still cannot show dorsiflexion");

/* SATURATION on its own: an oblique clip whose implied dorsiflexion spends
 * most of its time past +-40 deg is the clip bound talking, not the ankle. */
const sat = viewQuality(clip({ frontal: false, ankleDeg: 143 }));
assert.ok(sat.ankle_saturated_frac >= 0.25, "saturation measured: " + sat.ankle_saturated_frac);
assert.equal(sat.ankle_usable, false, "a saturated ankle is not a measured one");

/* The export contract: analyse() drops the ankle columns when the camera could
 * not see them. Mirrors the filter in kinematics.js -- a zero column would
 * plot as a flat line and load into OpenSim as a held joint. */
const DROP = (cols) => cols.filter((c) => !/^ankle_angle(_[lr])?$/.test(c));
const full = ["pelvis_tilt", "hip_flexion_r", "knee_angle_r", "knee_angle_l",
              "ankle_angle_r", "ankle_angle_l", "lumbar_extension"];
const kept = DROP(full);
assert.ok(!kept.some((c) => /ankle/.test(c)), "no ankle column survives");
assert.equal(kept.length, full.length - 2);
assert.ok(kept.includes("knee_angle_r") && kept.includes("lumbar_extension"),
          "only the ankle goes");
console.log("ankle view gate ok");


/* --- per-frame validity -----------------------------------------------------
 * The regression this guards: a clip where the athlete starts facing the
 * camera, turns side-on, and turns back. One verdict for the whole trial
 * called it "frontal" and threw away the side-on stretch, where the ankle was
 * perfectly measurable. */
function turning(nFront = 40, nSide = 40) {
  const poses = {};
  let i = 0;
  const put = (sep, ankleDeg) => {
    const a = (ankleDeg * Math.PI) / 180;
    poses[i++] = {
      left_shoulder: [200 - sep / 2, 100], right_shoulder: [200 + sep / 2, 100],
      left_hip: [200 - sep / 4, 300], right_hip: [200 + sep / 4, 300],
      left_knee: [200, 450], right_knee: [210, 450],
      left_ankle: [200, 600], right_ankle: [210, 600],
      left_foot_index: [200 + 60 * Math.sin(a), 600 - 60 * Math.cos(a)],
      right_foot_index: [210 + 60 * Math.sin(a), 600 - 60 * Math.cos(a)],
    };
  };
  for (let n = 0; n < nFront; n++) put(120, 164);   // face-on, flattened ankle
  for (let n = 0; n < nSide; n++) put(12, 105);     // side-on, a real ankle
  return poses;
}

const mixed = turning();
const vq = viewQuality(mixed);
assert.ok(vq.ankle_usable, "a clip with a side-on stretch is not a write-off");
assert.ok(Math.abs(vq.ankle_valid_frac - 0.5) < 0.05, "half measurable: " + vq.ankle_valid_frac);

const m = ankleValidMask(mixed);
assert.equal(m[0], false, "a face-on frame is not measurable");
assert.equal(m[60], true, "a side-on frame is");
assert.equal(Object.keys(m).length, Object.keys(mixed).length, "one entry per frame");

/* Keyed by FRAME INDEX, not by position: feature arrays span lo..hi including
 * the holes a dropped frame leaves, so a dense array would slide out of step. */
const holey = {}; for (const k of [0, 1, 5, 9]) holey[k] = mixed[k];
const hm = ankleValidMask(holey);
assert.deepEqual(Object.keys(hm).sort((x, y) => x - y).map(Number), [0, 1, 5, 9],
                 "the mask keeps the original frame numbers");

// All frontal is still a refusal, not a partial.
assert.equal(viewQuality(turning(40, 0)).ankle_usable, false);
// All side-on is fully measurable, so the .mot keeps its ankle column.
assert.equal(viewQuality(turning(0, 40)).ankle_valid_frac, 1);
console.log("per-frame ankle validity ok");
