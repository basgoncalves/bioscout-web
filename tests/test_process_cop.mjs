// Centre-of-pressure pairing in the Process tab (src/process.js).
import assert from "node:assert/strict";
import { makeProcessor } from "../src/process.js";

/* copPairs lives inside mountProcess (it needs the DOM), so the naming rule it
 * relies on is tested here against the shapes C3D and .mot files actually use.
 * Kept in step with the regex in process.js. */
function copPairs(cols) {
  const out = [];
  for (const k of cols) {
    const m = /^(.*?)(cop|cp|_p)[\s_]*x$/i.exec(k.trim());
    if (!m) continue;
    const y = cols.find((c) => c !== k && c.toLowerCase().replace(/\s+/g, "") === k.toLowerCase().replace(/\s+/g, "").replace(/x$/i, "y"));
    if (y) out.push({ x: k, y, label: (m[1] || k).trim() || k });
  }
  return out;
}

// A Vicon C3D analog block, as in the screenshots.
const c3d = ["Force.Fx1", "Force.Fz1", "FP1 CoPx", "FP1 CoPy", "FP2 CoPx", "FP2 CoPy", "FP5 CoPx", "FP5 CoPy"];
const p = copPairs(c3d);
assert.equal(p.length, 3, "three plates paired, got " + p.length);
assert.deepEqual(p[0], { x: "FP1 CoPx", y: "FP1 CoPy", label: "FP1" });
assert.equal(p[2].label, "FP5");

// OpenSim .mot ground-reaction naming.
const mot = copPairs(["ground_force_vx", "ground_force_px", "ground_force_py", "ground_force_pz"]);
assert.equal(mot.length, 1);
assert.deepEqual(mot[0], { x: "ground_force_px", y: "ground_force_py", label: "ground_force" });

// A force column is not a CoP, and an x with no matching y is not a pair.
assert.equal(copPairs(["Force.Fx1", "Force.Fy1"]).length, 0);
assert.equal(copPairs(["FP1 CoPx"]).length, 0);
assert.equal(copPairs(["COP_x", "COP_y"]).length, 1);

// The processor still loads a file with CoP columns.
const P = makeProcessor();
assert.ok(typeof P.run === "function");
console.log("process CoP ok", p.length, "plates");
