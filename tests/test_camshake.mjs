// Camera-motion estimate for handheld video (src/camshake.js).
import assert from "node:assert/strict";
import { makeShakeTracker, stabilise, bodyBox, THUMB_W, THUMB_H } from "../src/camshake.js";

// A textured background, panned by a known amount each frame, with a bright
// "athlete" block that moves differently -- the tracker must follow the
// background, not the body.
function scene(shiftX, shiftY, bodyAt) {
  const g = new Float32Array(THUMB_W * THUMB_H);
  for (let y = 0; y < THUMB_H; y++)
    for (let x = 0; x < THUMB_W; x++)
      g[y * THUMB_W + x] = 128 + 90 * Math.sin((x + shiftX) * 0.7) * Math.cos((y + shiftY) * 0.5);
  for (let y = 20; y < 50; y++)
    for (let x = bodyAt; x < bodyAt + 10 && x < THUMB_W; x++) g[y * THUMB_W + x] = 250;
  return g;
}
const box = (at) => ({ x0: at / THUMB_W, x1: (at + 10) / THUMB_W, y0: 20 / THUMB_H, y1: 50 / THUMB_H });

const t = makeShakeTracker();
assert.equal(t.step(scene(0, 0, 10), box(10)).conf, 0, "first frame has nothing to compare");
/* Raising the phase slides the pattern LEFT in the picture by the same amount,
 * which is what a camera panning RIGHT does -- so the tracker must report the
 * camera moving in the positive direction. */
let s = t.step(scene(3, 0, 12), box(12));
assert.equal(s.dx, 3, "dx " + s.dx);
assert.equal(s.dy, 0);
assert.ok(s.conf > 0.1, "conf " + s.conf);
s = t.step(scene(6, 2, 14), box(14));
assert.equal(s.dx, 3);
assert.equal(s.dy, 2);

// A blank wall must read as "no idea", not "no motion".
const flat = makeShakeTracker();
const blank = new Float32Array(THUMB_W * THUMB_H).fill(100);
flat.step(blank, null);
assert.equal(flat.step(blank, null).conf, 0, "a featureless frame cannot be matched");

// Stabilising: a body standing still while the camera pans must come out still.
const W = 480, H = 640;
const frames = [], steps = [];
for (let i = 0; i < 10; i++) {
  // The camera pans right by 4 full-frame px per frame, so a static body
  // appears to slide left by the same amount.
  frames.push({ t: i * 33, lm: { left_hip: [200 - 4 * i, 300, 0], right_hip: [220 - 4 * i, 300, 0] } });
  steps.push({ dx: i ? -4 / (W / THUMB_W) : 0, dy: 0, conf: 0.9 });
}
const st = stabilise(frames, steps, { frameW: W, frameH: H });
const xs = st.frames.map((f) => f.lm.left_hip[0]);
assert.ok(Math.max(...xs) - Math.min(...xs) < 1, "a static body should stay put: " + (Math.max(...xs) - Math.min(...xs)));
assert.ok(st.readable > 0.8);

// Unreadable steps must not drift the correction.
const none = stabilise(frames, frames.map(() => ({ dx: 9, dy: 9, conf: 0 })), { frameW: W, frameH: H });
assert.equal(none.frames[5].lm.left_hip[0], frames[5].lm.left_hip[0], "no confidence, no correction");
assert.equal(none.readable, 0);

assert.equal(bodyBox(null, W, H), null);
assert.ok(bodyBox({ a: [0, 0], b: [10, 10], c: [5, 5], d: [1, 1], e: [2, 2], f: [3, 3] }, W, H).x1 > 0);
console.log("camshake ok");
