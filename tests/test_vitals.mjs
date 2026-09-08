/**
 * vitals.js -- steps and resting heart rate do not carry forward, unlike
 * weight, and either can be logged alone.
 *
 *   node tests/test_vitals.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

import { dayKey, collectVitals, meanSteps } from "../src/vitals.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/* ---- collection --------------------------------------------------------- */

{
  const days = collectVitals([
    { at: "2026-09-07T08:00:00.000Z", profile: "bas", steps: 8432, restingHr: 58 },
    { at: "2026-09-06T08:00:00.000Z", profile: "bas", steps: 5000 },          // steps only
    { at: "2026-09-05T08:00:00.000Z", profile: "bas", restingHr: 61 },        // HR only
    { at: "2026-09-04T08:00:00.000Z", profile: "other", steps: 1 },
  ], "bas");

  ok(days.size === 3, "one entry per logged day, for the requested profile", String(days.size));
  ok(days.get("2026-09-07").steps === 8432 && days.get("2026-09-07").restingHr === 58,
     "both fields kept when both are given");
  ok(days.get("2026-09-06").steps === 5000 && days.get("2026-09-06").restingHr === null,
     "steps alone leaves restingHr null, not zero");
  ok(days.get("2026-09-05").steps === null && days.get("2026-09-05").restingHr === 61,
     "HR alone leaves steps null, not zero");
  ok(!days.has("2026-09-04"), "another profile's day is not in this athlete's map");
}

ok(collectVitals([{ at: "2026-09-07T08:00:00.000Z", steps: null, restingHr: null }]).size === 0,
   "a row with neither field is dropped, not filed as an empty day");

ok(collectVitals([{ at: "2026-09-07T08:00:00.000Z", steps: -5 }]).size === 0,
   "a negative step count is refused");

ok(collectVitals([{ at: "2026-09-07T08:00:00.000Z", restingHr: 0 }]).size === 0,
   "a zero heart rate is refused, not treated as a reading");

{
  // A later entry for the same day is a correction, same rule as sleep.
  const days = collectVitals([
    { at: "2026-09-07T07:00:00.000Z", steps: 100 },
    { at: "2026-09-07T20:00:00.000Z", steps: 9000 },
  ]);
  ok(days.get("2026-09-07").steps === 9000, "a later reading for the same day wins");
}

/* ---- trend --------------------------------------------------------------- */

{
  const today = new Date(2026, 8, 8);   // 8 Sep 2026, local
  const days = collectVitals([
    { at: "2026-09-08T08:00:00.000Z", steps: 10000 },
    { at: "2026-09-07T08:00:00.000Z", steps: 8000 },
    { at: "2026-09-05T08:00:00.000Z", steps: 6000 },   // a gap on the 6th
  ]);
  const trend = meanSteps(days, 14, today);
  ok(trend.days === 3, "the mean rests on the days actually logged, gaps skipped",
     String(trend.days));
  ok(trend.mean === 8000, "and averages only those", String(trend.mean));
}

ok(meanSteps(new Map(), 14, new Date(2026, 8, 8)) === null,
   "no logged days at all is null, not a mean of zero");

ok(dayKey("2026-09-07T22:00:00.000Z") === "2026-09-08" ||
   dayKey("2026-09-07T22:00:00.000Z") === "2026-09-07",
   "dayKey resolves against the local clock", dayKey("2026-09-07T22:00:00.000Z"));

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
