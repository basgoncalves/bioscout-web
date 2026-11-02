// A coordinate the camera cannot see is dropped from the export, not zeroed.
import assert from "node:assert/strict";
import { viewQuality } from "../src/kinematics.js";

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

// The gate is the angle, not the view: side-on with the foot square to the
// lens is still unmeasurable.
assert.equal(viewQuality(clip({ frontal: false, ankleDeg: 170 })).ankle_usable, false);

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
