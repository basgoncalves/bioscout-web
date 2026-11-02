// Canvas -> frame mapping for the landmark editor (src/lmreview.js).
import assert from "node:assert/strict";
import { frameFromClient } from "../src/lmreview.js";

/* The hard case, and the one that shipped broken once: a portrait clip on a
 * phone. The canvas bitmap is 960 x 1707 for a 478 x 850 frame, and CSS caps
 * it with object-fit:contain, so the bitmap is letterboxed inside the element
 * AND the frame is letterboxed inside the bitmap. */
const SW = 478, SH = 850;
const CW = 960, CH = Math.round(CW * (SH / SW));          // 1707
const rect = { left: 8, top: 40, width: 396, height: 476 };  // as measured on a 412x915 phone

/* Round trip: frame -> client -> frame must land back on the same point. */
function toClient(fx, fy) {
  const fit = Math.min(rect.width / CW, rect.height / CH);
  const kk = Math.min(CW / SW, CH / SH);
  const ox = (CW - SW * kk) / 2, oy = (CH - SH * kk) / 2;
  return [rect.left + (rect.width - CW * fit) / 2 + (ox + fx * kk) * fit,
          rect.top + (rect.height - CH * fit) / 2 + (oy + fy * kk) * fit];
}
for (const [fx, fy] of [[0, 0], [239, 425], [180, 560], [477, 849], [20, 800]]) {
  const [cx, cy] = toClient(fx, fy);
  const [bx, by] = frameFromClient(cx, cy, rect, CW, CH, SW, SH);
  assert.ok(Math.abs(bx - fx) < 0.5 && Math.abs(by - fy) < 0.5,
            `round trip ${fx},${fy} -> ${bx.toFixed(1)},${by.toFixed(1)}`);
}

// The centre of the element maps to the centre of the frame.
const [mx, my] = frameFromClient(rect.left + rect.width / 2, rect.top + rect.height / 2,
                                 rect, CW, CH, SW, SH);
assert.ok(Math.abs(mx - SW / 2) < 1 && Math.abs(my - SH / 2) < 1,
          `centre -> ${mx.toFixed(1)},${my.toFixed(1)}`);

/* Ignoring the object-fit padding is the bug this guards: with a LANDSCAPE
 * element holding a portrait bitmap the bars are wide, and a naive
 * (clientX-left)*cw/width mapping is off by many frame pixels. */
const wide = { left: 0, top: 0, width: 900, height: 400 };
const [gx] = frameFromClient(450, 200, wide, CW, CH, SW, SH);
const naive = (450 - wide.left) * (CW / wide.width);
assert.ok(Math.abs(gx - SW / 2) < 1, "centre still maps to centre: " + gx.toFixed(1));
assert.ok(Math.abs(naive - SW / 2) > 10, "the naive mapping really is wrong here");
console.log("lmreview mapping ok");
