// Position tracking + lift report (src/postrack.js).
import assert from "node:assert/strict";
import { floorPath, liftReport, leaderboardEntry, e1rm, pathMapSVG } from "../src/postrack.js";

// Synthetic person walking a 2 m x 1 m rectangle at 3-4 m from a 1080x1920
// portrait camera, with pose noise.
const W = 1080, H = 1920, fPx = (H / 2) / Math.tan(63 * Math.PI / 360), hM = 1.8;
const frames = [];
let rnd = 1; const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5) * 6;
const corners = [[-1, 3], [1, 3], [1, 4], [-1, 4], [-1, 3]];
let t = 0;
for (let c = 0; c < 4; c++) {
  const [ax, az] = corners[c], [bx, bz] = corners[c + 1];
  for (let k = 0; k < 60; k++, t += 1000 / 30) {
    const x = ax + (bx - ax) * k / 60, z = az + (bz - az) * k / 60;
    const s = fPx / z;                     // px per metre at that depth
    const u = W / 2 + x * s, footV = H / 2 + 1.0 * s;
    const lm = {};
    for (const side of ["left", "right"]) {
      const du = side === "left" ? -0.1 * s : 0.1 * s;
      lm[side + "_ankle"] = [u + du + noise(), footV + noise(), 0];
      lm[side + "_knee"] = [u + du + noise(), footV - 0.45 * s + noise(), 0];
      lm[side + "_hip"] = [u + du + noise(), footV - 0.9 * s + noise(), 0];
      lm[side + "_shoulder"] = [u + du * 1.5 + noise(), footV - 0.9 * s - 0.5 * s + noise(), 0];
    }
    frames.push({ t, lm });
  }
}
const p = floorPath(frames, { heightM: hM, frameW: W, frameH: H });
assert.ok(p.ok);
// Perimeter 6 m; the low-pass rounds the corners and trims the step sway, so less.
assert.ok(p.distance_m > 4.5 && p.distance_m < 6.8, "distance " + p.distance_m);
assert.ok(Math.abs(p.extent.x1 - p.extent.x0 - 2) < 0.5, "x span");
assert.ok(p.extent.z0 > 2.4 && p.extent.z1 < 4.6, "depth range " + JSON.stringify(p.extent));
assert.ok(pathMapSVG({ 1: p }).startsWith("<svg"));

// Standing still -> next to no distance.
const still = frames.slice(0, 60).map((f) => ({ ...f, lm: frames[0].lm }));
assert.ok(floorPath(still, { heightM: hM, frameW: W, frameH: H }).distance_m < 0.2);

// Lift report.
assert.equal(e1rm(100, 1), 100);
assert.equal(e1rm(100, 20), null);
const sess = { started: 1, sets: [
  { activity: "pullup", reps: 10, massKg: 80, addedKg: 0, assistKg: 0, at: "2026-11-02T10:00:00Z" },
  { activity: "pullup", reps: 5, massKg: 80, addedKg: 20, assistKg: 0, at: "2026-11-02T10:05:00Z" },
  { activity: "curl", reps: 8, massKg: 80, addedKg: 12, assistKg: 0, at: "2026-11-02T10:10:00Z" },
] };
const rep = liftReport(sess);
const pu = rep.find((r) => r.activity === "pullup");
assert.equal(pu.volume_kg, 10 * 80 + 5 * 100);
assert.equal(pu.reps, 15);
assert.equal(rep.find((r) => r.activity === "curl").volume_kg, 96);
const lb = leaderboardEntry(sess, { 1: p });
assert.equal(lb.total_reps, 23);
console.log("postrack ok", p.distance_m, "m");
