import assert from "node:assert/strict";
import { collectDays } from "../src/dashboard.js";
import { athleteSummary, athleteSummaryHTML, labelSets } from "../src/athsummary.js";

const today = new Date(2026, 8, 16, 18);
const at = (d, h) => new Date(2026, 8, d, h).toISOString();
const set = (d, h, reps, dur, extra = {}) => ({ at: at(d, h), activity: "pullup", reps,
  perRep: Array.from({ length: reps }, () => ({ duration_s: dur })), ...extra });
const sessions = [
  { started: at(15, 9), sets: [set(15, 9, 10, 1.0), set(15, 10, 8, 1.2), set(15, 11, 6, 1.5)] },
  { started: at(14, 9), sets: [set(14, 9, 5, 1.0), set(14, 10, 0, 0), set(14, 11, 5, 1.0, { assess: "x" })] },
  { started: at(1, 9), sets: [set(1, 9, 4, 2.0)] },
];
const days = collectDays(sessions);
const lab = labelSets(days);
assert.equal(lab.length, 5, "zero-rep and assessment sets are not good sets");
assert.equal(lab.filter((s) => s.fatigued).length, 1, "only the multi-set session has a fatigued set");
const sum = athleteSummary({ days, weights: [{ day: "2026-09-10", kg: 84 }, { day: "2026-09-15", kg: 83 }] }, today);
const f = sum.fatigue[0];
assert.equal(f.fresh.n, 3); assert.equal(f.tired.n, 1);
assert.equal(f.tired.reps, 6); assert.equal(f.tired.duration_s, 1.5);
assert.equal(sum.wins[0].volume.sessions, 2);
assert.equal(sum.wins[1].metrics, undefined);
assert.equal(sum.metrics[0].byWin[1].n, 5, "month includes the 1st");
assert.equal(sum.wins[0].weight.mean, 83.5);
assert.equal(sum.weekly.at(-1).reps, 34);
const html = athleteSummaryHTML(sum, { name: "A", heightM: 1.8 });
assert.ok(html.includes("asmTable"));
console.log("athsummary ok");
