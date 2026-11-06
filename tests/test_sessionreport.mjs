// End-of-session report (src/sessionreport.js).
import assert from "node:assert/strict";
import { sessionTotals, sessionDuration, muscleLoad, spiderSVG, topViewSVG,
         MOVEMENT_LOAD, SPIDER_GROUPS } from "../src/sessionreport.js";

const sess = { started: 1, sets: [
  { index: 1, activity: "squat", reps: 10, massKg: 80, addedKg: 40, assistKg: 0,
    at: "2026-11-02T10:00:00Z", perRep: [{ rep: 1, duration_s: 3, peak_knee_Nm: 180 }] },
  { index: 2, activity: "squat", reps: 8, massKg: 80, addedKg: 60, assistKg: 0,
    at: "2026-11-02T10:06:00Z", perRep: [{ rep: 1, duration_s: 3, peak_knee_Nm: 210 }] },
  { index: 3, activity: "pullup", reps: 6, massKg: 80, addedKg: 0, assistKg: 0,
    at: "2026-11-02T10:12:00Z", perRep: [] },
] };

const d = sessionDuration(sess);
assert.ok(d >= 720 && d < 740, "duration " + d);      // 12 min + the last set
const tot = sessionTotals(sess);
assert.equal(tot.sets, 3);
assert.equal(tot.reps, 24);
assert.ok(tot.volume_kg > 0 && tot.density_kg_min > 0);
assert.equal(tot.effort_index, null, "no accelerometer -> no effort index");
assert.equal(sessionTotals(sess, { ok: true, effort_index: 4.2, work_pct: 38 }).effort_index, 4.2);

const ml = muscleLoad(sess);
const by = Object.fromEntries(ml.map((g) => [g.key, g]));
assert.ok(by.knee_ext, "squats load the knee extensors");
assert.ok(by.shoulder_ext, "pull-ups load the shoulder extensors");
// Squats dominate this session, so knee extensors must be the reference group.
assert.equal(by.knee_ext.share, 1);
assert.ok(by.hip_ext.share < 1 && by.hip_ext.share > 0.5, "hip share " + by.hip_ext.share);
// A group no movement here loads is absent, not zero.
assert.ok(!by.elbow_ext, "nothing pressed, so no elbow extensors");
assert.ok(ml.every((g) => g.share <= 1 && g.share >= 0));

// Every movement's groups must be ones the spider can draw.
const known = new Set(SPIDER_GROUPS.map((g) => g.key));
for (const [mv, share] of Object.entries(MOVEMENT_LOAD))
  for (const g of Object.keys(share)) assert.ok(known.has(g), mv + " -> unknown group " + g);

assert.ok(spiderSVG(ml).startsWith("<svg"));
assert.equal(spiderSVG([{ key: "a", label: "a", share: 1, kg: 1 }]), "", "fewer than 3 axes: no plot");

const path = { ok: true, x: [0, 0.5, 1], z: [3, 3.2, 3.4], distance_m: 1.1 };
assert.ok(topViewSVG({ 1: path }).startsWith("<svg"));
assert.equal(topViewSVG({}), "");
// Standing still must not blow the scale up: a 1.5 m minimum span.
assert.ok(topViewSVG({ 1: { ok: true, x: [0, 0.01], z: [3, 3.01] } }).includes("<svg"));
console.log("sessionreport ok", tot.reps, "reps,", ml.length, "groups");
