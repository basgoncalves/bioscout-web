// Motion-only set: rep counting and summary (src/motionset.js).
import assert from "node:assert/strict";
import { makeRepDetector, motionSummary, motionRepSVG } from "../src/motionset.js";

// Synthetic squat set: 8 reps, 2.4 s each, decaying effort, plus sensor noise
// and a 3 s stand-still before and after.
function run({ n = 8, period = 2400, amp = 0.45, decay = 0, fs = 60 } = {}) {
  const d = makeRepDetector();
  let rnd = 7; const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
  let t = 0;
  const step = 1000 / fs;
  for (; t < 3000; t += step) d.push(t, 1 + noise());
  for (let r = 0; r < n; r++) {
    const a = amp * (1 - decay * r / Math.max(1, n - 1));
    for (let k = 0; k < period / step; k++, t += step) {
      d.push(t, 1 + a * Math.sin(2 * Math.PI * k / (period / step)) + noise());
    }
  }
  const end = t + 3000;
  for (; t < end; t += step) d.push(t, 1 + noise());
  return d;
}

const d = run();
assert.equal(d.count(), 8, "counted " + d.count());
const s = motionSummary(d.reps(), 24);
assert.ok(Math.abs(s.tempo_s - 2.4) < 0.3, "tempo " + s.tempo_s);
assert.ok(s.peak_g > 0.3 && s.peak_g < 0.6, "peak " + s.peak_g);
assert.ok(Math.abs(s.peak_drop_pct) < 10, "steady set should not show decay: " + s.peak_drop_pct);

// A set that fades: the drop must show up.
const fade = motionSummary(run({ decay: 0.5 }).reps(), 24);
assert.ok(fade.peak_drop_pct > 20, "fading set drop " + fade.peak_drop_pct);

// Standing still counts nothing.
const still = makeRepDetector();
for (let t = 0; t < 10000; t += 1000 / 60) still.push(t, 1 + (Math.random() - 0.5) * 0.03);
assert.equal(still.count(), 0);

// Running-speed bouncing is too fast to be a rep.
const fast = run({ n: 20, period: 400, amp: 1.2 });
assert.equal(fast.count(), 0, "steps are not reps: " + fast.count());

assert.equal(motionSummary([], 0).ok, false);
assert.ok(motionRepSVG(s).startsWith("<svg"));
console.log("motionset ok", s.reps, "reps,", s.tempo_s, "s tempo");

// --- session effort trace ---------------------------------------------------
import { makeEffortTrace, effortSummary, effortTraceSVG } from "../src/motionset.js";
const tr = makeEffortTrace();
// 60 s: 20 s working, 40 s still.
let tt = 0; const st = 1000 / 50;
for (; tt < 20000; tt += st) tr.push(tt, 1 + 0.4 * Math.sin(2 * Math.PI * tt / 2400));
for (; tt < 60000; tt += st) tr.push(tt, 1 + (Math.random() - 0.5) * 0.02);
const es = effortSummary(tr.bins());
assert.ok(es.ok);
assert.ok(Math.abs(es.duration_s - 60) <= 1, "duration " + es.duration_s);
assert.ok(es.work_s >= 17 && es.work_s <= 23, "work seconds " + es.work_s);
assert.ok(es.rest_s > 35, "rest seconds " + es.rest_s);
assert.ok(es.effort_index > 0);
assert.equal(effortSummary([]).ok, false);
assert.ok(effortTraceSVG(es).startsWith("<svg"));
console.log("effort ok", es.work_pct + "% working, index", es.effort_index);
