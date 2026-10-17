// Step detector on synthetic running: 1 g baseline, an impact bump every step, noise.
import assert from "node:assert/strict";
import { makeStepDetector } from "../src/phonemotion.js";

function run(spm, peakG, secs = 20, hz = 60, noise = 0.08) {
  const d = makeStepDetector(), dt = 1000 / hz, period = 60000 / spm;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  let n = 0;
  for (let t = 0; t < secs * 1000; t += dt) {
    const ph = (t % period) / period;
    // impact spike (first 12% of the step) + mid-stance hump + flight dip
    const a = 1 + (ph < 0.12 ? (peakG - 1) * Math.sin(Math.PI * ph / 0.12) : 0) + 0.3 * Math.sin(2 * Math.PI * ph) * (ph > 0.12 ? 0.5 : 0) + noise * rnd();
    if (d.push(t, a)) n++;
  }
  return { n, v: d.values(secs * 1000 - 10) };
}
for (const [spm, pk] of [[150, 2.2], [170, 2.8], [185, 3.2]]) {
  const { n, v } = run(spm, pk);
  const expect = (spm * 20) / 60;
  assert.ok(Math.abs(n - expect) <= 2, `${spm} spm: ${n} steps, expected ~${expect}`);
  assert.ok(Math.abs(v.cadence - spm) < 4, `${spm} spm: cadence ${v.cadence.toFixed(1)}`);
  assert.ok(v.impact > 1.6 && v.impact < pk + 0.3, `impact ${v.impact.toFixed(2)} g for ${pk} g peaks`);
}
// standing still: no steps
{ const d = makeStepDetector(); let n = 0; for (let t = 0; t < 10000; t += 16) if (d.push(t, 1 + 0.03 * Math.sin(t / 50))) n++; assert.equal(n, 0, "no steps while standing"); }
// stops: values go NaN after 2 s without steps
{ const { v } = run(170, 2.8, 5); const d = makeStepDetector(); assert.ok(Number.isNaN(d.values(1e6).cadence)); assert.ok(Number.isFinite(v.cadence)); }
console.log("test_phonemotion ok");
