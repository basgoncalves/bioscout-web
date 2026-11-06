// Left/right separation (src/kinematics.js sidesSeparable, clipAngles sides).
import assert from "node:assert/strict";
import { sidesSeparable } from "../src/kinematics.js";
import { clipAngles } from "../src/jointmetrics.js";

const full = (v) => new Array(50).fill(v);
const F = { _n: 50, knee_flex_l: full(40), knee_flex_r: full(44) };

// Side-on: the far leg is occluded, so the sides must NOT be called separable
// however complete the landmark arrays look.
assert.equal(sidesSeparable(F, { view: "sagittal", frontality: 0.12 }), false);
assert.equal(sidesSeparable(F, { view: "oblique", frontality: 0.40 }), false);
// Front-on with both legs tracked: separable.
assert.equal(sidesSeparable(F, { view: "frontal", frontality: 0.62 }), true);
// Front-on but one leg barely tracked: not separable.
const gappy = { _n: 50, knee_flex_l: full(40), knee_flex_r: new Array(50).fill(NaN) };
assert.equal(sidesSeparable(gappy, { view: "frontal", frontality: 0.62 }), false);
// No view information at all.
assert.equal(sidesSeparable(F, null), false);
assert.equal(sidesSeparable(F, { view: "unknown", frontality: null }), false);

// clipAngles: per-leg curves appear only when asked for.
const Fj = { knee_flex: full(42), knee_flex_l: full(40), knee_flex_r: full(44),
             hip_flex: full(20), hip_flex_l: full(19), hip_flex_r: full(21),
             ankle_dorsi: full(5), ankle_dorsi_l: full(4), ankle_dorsi_r: full(6) };
const one = clipAngles("squat", {}, Fj, null, {});
assert.ok(one.knee, "the averaged curve is always there");
assert.equal(one.knee_l, undefined, "no per-leg curves without sides");

const two = clipAngles("squat", {}, Fj, null, { sides: true });
assert.ok(two.knee_l && two.knee_r, "per-leg curves with sides");
assert.notDeepEqual(two.knee_l, two.knee_r, "the two legs must not be the same array");
assert.equal(two.knee_l[0], 40);
assert.equal(two.knee_r[0], 44);
console.log("sides ok");
