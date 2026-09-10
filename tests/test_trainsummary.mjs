/**
 * trainsummary.js -- the training summary charts' numbers.
 *
 *   node tests/test_trainsummary.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";
import { windowDays, timeOfDay, intensity, weekdayVolume, movementMix, restGaps, SUMMARY_CHARTS }
  from "../src/trainsummary.js";
import { collectDays } from "../src/dashboard.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};

const at = (day, hh, mm = 0) => new Date(2026, 8, day, hh, mm).toISOString();
const sessions = [
  { started: at(1, 18), sets: [
    { at: at(1, 18, 5), activity: "squat", reps: 5, massKg: 80, addedKg: 80, assistKg: 0 },
    { at: at(1, 18, 15), activity: "squat", reps: 5, massKg: 80, addedKg: 80, assistKg: 0 }] },
  { started: at(3, 18), sets: [
    { at: at(3, 18, 30), activity: "pushup", reps: 20, massKg: 80, addedKg: 0, assistKg: 0 }] },
  { started: at(8, 7), sets: [
    { at: at(8, 7, 0), activity: "pullup", reps: 8, massKg: 80, addedKg: 0, assistKg: 20 },
    { at: at(8, 7, 10), activity: "pullup", reps: 6, massKg: null }] },
  { started: at(10, 23, 45), sets: [
    { at: at(10, 23, 45), activity: "dip", reps: 10, massKg: 80, addedKg: 0, assistKg: 0 }] },
];
const days = collectDays(sessions);
const today = new Date(2026, 8, 10);

ok(SUMMARY_CHARTS.length === 6 && SUMMARY_CHARTS[0] === "weight", "six charts to choose from, weight first");
ok(windowDays(days, 7, today).map((d) => d.key).join() === "2026-09-08,2026-09-10",
   "the week is the last seven days, today included");
ok(windowDays(days, 30, today).length === 4, "the month holds all four training days");

{
  const t = timeOfDay(windowDays(days, 30, today));
  ok(t.n === 6 && t.curve.length === 96, "time of day: one point per set, 96 steps of 15 min");
  ok(t.peak >= 17.5 && t.peak <= 18.75, "the peak sits where most sets were (around 18:00)", String(t.peak));
  const late = timeOfDay([{ sets: [{ at: at(1, 23, 45) }] }]);
  ok(late.curve[0] > 0.5, "a 23:45 session shows just after midnight too: the day wraps", String(late.curve[0]));
  ok(timeOfDay([]).peak === null, "no training, no curve");
}

{
  const x = intensity(windowDays(days, 30, today));
  ok(x.n === 5 && x.skipped === 1, "intensity: sets without a body mass are left out and counted", `${x.n}/${x.skipped}`);
  ok(x.bins[20] === 2, "a squat with a bar of body weight is 2.0x", String(x.bins[20]));
  ok(x.bins[10] === 2, "push-ups and dips at body weight are 1.0x");
  ok(x.bins[7] === 1, "an assisted pull-up (-20 of 80 kg) is 0.75x");
}

{
  const w = weekdayVolume(windowDays(days, 30, today));
  // 1 Sep 2026 is a Tuesday; 3 Sep Thursday; 8 Sep Tuesday; 10 Sep Thursday.
  ok(w.reps[1] === 24 && w.reps[3] === 30 && w.reps[0] === 0, "reps land on their weekday, Monday first",
     JSON.stringify(w.reps));
}

{
  const m = movementMix(windowDays(days, 30, today));
  ok(m[0].activity === "pushup" && m[0].reps === 20 && m.length === 4, "movements, most reps first");
}

{
  const r = restGaps(days, 30, today);
  // training days 1, 3, 8, 10 -> gaps 2, 5, 2
  ok(r.n === 3 && r.bins[1] === 2 && r.bins[4] === 1, "rest: gaps between training days", JSON.stringify(r.bins));
  ok(Math.abs(r.mean - 3) < 1e-9, "and their mean", String(r.mean));
  const wk = restGaps(days, 7, today);
  ok(wk.n === 2 && wk.bins[4] === 1, "the week's first day is measured from the one before it");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
