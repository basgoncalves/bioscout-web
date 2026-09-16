import assert from "node:assert/strict";
import { collectDays } from "../src/dashboard.js";
import { athleteSummary, taskStats, labelSets, curveSummary, taskTableHTML, generalHTML,
         curveSVG, resample, mr } from "../src/athsummary.js";

const today = new Date(2026, 8, 16, 18);
const at = (d, h) => new Date(2026, 8, d, h).toISOString();
let idx = 0;
const set = (d, h, reps, dur, extra = {}) => ({ index: ++idx, at: at(d, h), activity: "squat", reps,
  perRep: Array.from({ length: reps }, () => ({ duration_s: dur, knee_flex_max_deg: 100 })), ...extra });
const sessions = [
  { started: at(15, 9), sets: [set(15, 9, 10, 1.0), set(15, 10, 8, 1.2), set(15, 11, 6, 1.5)] },
  { started: at(14, 9), sets: [set(14, 9, 5, 1.0), set(14, 10, 0, 0), set(14, 11, 5, 1.0, { assess: "x" })] },
  { started: at(1, 9), sets: [set(1, 9, 4, 2.0)] },
];
const days = collectDays(sessions);
assert.equal(labelSets(days).length, 5, "zero-rep and assessment sets are not good sets");
assert.equal(labelSets(days).filter((s) => s.fatigued).length, 1);
const sum = athleteSummary({ days, weights: [{ day: "2026-09-10", kg: 84 }, { day: "2026-09-15", kg: 83 }] }, today);
assert.deepEqual(sum.tasks, ["squat"]);
const ts = taskStats(sum, "squat");
assert.equal(ts.fresh.n, 3); assert.equal(ts.tired.n, 1);
assert.equal(ts.tired.reps.mean, 6);
assert.deepEqual([ts.fresh.reps.min, ts.fresh.reps.max], [5, 10]);
assert.equal(ts.byWin[1].n, 5, "month includes the 1st");
assert.equal(sum.wins[0].weight.mean, 83.5);
assert.equal(sum.weekly.at(-1).reps, 34);
assert.match(mr({ mean: 2, min: 1, max: 3, n: 2 }, 0), /2 .*\(1–3\)/);
// curves: fresh flat 10, fatigued flat 20
const curves = (sess, i) => ({ reps: [{ jm: { knee_angle_l: [i === 3 ? 20 : 10, i === 3 ? 20 : 10, i === 3 ? 20 : 10] } }] });
const c = curveSummary(ts.weekSets, curves, "angle");
assert.equal(c.length, 1); assert.equal(c[0].joint, "knee"); assert.equal(c[0].side, "l");
assert.equal(c[0].fresh[50], 10); assert.equal(c[0].tired[50], 20);
assert.equal(resample([0, 10], 3)[1], 5);
const html = taskTableHTML(sum, ts, "squat", ["week", "year"]) + generalHTML(sum, ["week"], 1.8)
  + curveSVG([{ y: c[0].fresh, color: "#000" }, { y: c[0].tired, color: "#000", dash: true }]);
assert.ok(html.includes("100–130"), "squat depth shows the app band");
assert.ok(html.includes("stroke-dasharray"));
console.log("athsummary ok");
