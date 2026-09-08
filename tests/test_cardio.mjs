/**
 * cardio.js -- a day can hold several activities, and the units are minutes
 * and kilometres rather than reps.
 *
 *   node tests/test_cardio.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

import { collectCardio, fmtDuration, fmtDistance, pace } from "../src/cardio.js";
import { collectDays } from "../src/dashboard.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/* ---- bucketing ---------------------------------------------------------- */

{
  const days = collectCardio([
    { id: "strava:1", profile: "bas", at: "2026-09-07T16:00:00.000Z", sport: "Run",
      seconds: 1800, metres: 5000 },
    { id: "strava:2", profile: "bas", at: "2026-09-07T06:00:00.000Z", sport: "Ride",
      seconds: 2400, metres: 20000 },
    { id: "strava:3", profile: "someone else", at: "2026-09-07T06:00:00.000Z", sport: "Run",
      seconds: 60, metres: 100 },
  ], "bas");

  const d = days.get("2026-09-07");
  ok(days.size === 1, "one day, for the requested profile only", String(days.size));
  ok(d.items.length === 2, "a commute and an evening run are two activities, not one");
  ok(d.items[0].id === "strava:2", "and they come back in time order");
  ok(d.seconds === 4200 && d.metres === 25000, "totals are summed for the day",
     `${d.seconds}s ${d.metres}m`);
  ok(d.sports.has("Run") && d.sports.has("Ride"), "both sports are named");
}

ok(collectCardio([{ id: "x", at: "not a date", seconds: 60 }]).size === 0,
   "an unparseable timestamp is dropped rather than bucketed under NaN");

/* ---- formatting --------------------------------------------------------- */

ok(fmtDuration(2730) === "46 min", "under an hour reads in minutes", fmtDuration(2730));
ok(fmtDuration(4320) === "1 h 12", "over it, hours and minutes", fmtDuration(4320));
ok(fmtDuration(7200) === "2 h", "and no stray zero on the hour", fmtDuration(7200));
ok(fmtDuration(0) === "" && fmtDuration(null) === "", "no duration is no string");

ok(fmtDistance(8120) === "8.12 km", "kilometres to two decimals", fmtDistance(8120));
ok(fmtDistance(650) === "650 m", "under a kilometre stays in metres", fmtDistance(650));
ok(fmtDistance(0) === "", "a gym class has no distance, not 0 km");

/* ---- pace --------------------------------------------------------------- */

ok(pace(1800, 5000) === "6:00", "30 min over 5 km is 6:00/km", String(pace(1800, 5000)));
ok(pace(1500, 5000) === "5:00", "and 25 min is 5:00/km", String(pace(1500, 5000)));
// 299.6 s/km rounds to 60 seconds, which is not 4:60.
ok(pace(1498, 5000) === "5:00", "a rounded 60th second carries into the minute",
   String(pace(1498, 5000)));
ok(pace(1800, 0) === null, "no distance is no pace, not Infinity");
ok(pace(1800, 50) === null, "and neither is 50 m of GPS drift");

/* ---- the fold into training days ---------------------------------------- */

/* Cardio shares the training calendar rather than getting one of its own, so
 * the thing worth pinning is that it lands on the same day WITHOUT touching
 * reps -- a run that added to rep totals would corrupt every volume bar. */
{
  const sessions = [{
    started: "2026-09-07T17:00:00.000Z", profile: "bas",
    sets: [{ at: "2026-09-07T17:05:00.000Z", reps: 8, activity: "squat" }],
  }];
  const cardio = [
    { id: "strava:1", profile: "bas", at: "2026-09-07T06:00:00.000Z", sport: "Ride",
      seconds: 2400, metres: 20000 },
    { id: "strava:2", profile: "bas", at: "2026-09-06T06:00:00.000Z", sport: "Run",
      seconds: 1800, metres: 5000 },
  ];
  const days = collectDays(sessions, cardio);

  const shared = days.get("2026-09-07");
  ok(shared.reps === 8, "a run on a lifting day leaves the rep count alone", String(shared.reps));
  ok(shared.cardio.length === 1 && shared.cardioMetres === 20000,
     "and rides alongside it on the same day");

  const cardioOnly = days.get("2026-09-06");
  ok(!!cardioOnly, "a day with only a run is still a training day");
  ok(cardioOnly.reps === 0 && cardioOnly.sets.length === 0,
     "with no reps and no sets, because it had none");
  ok(cardioOnly.cardioSeconds === 1800, "but its own duration total");

  ok(collectDays(sessions).get("2026-09-06") === undefined,
     "and calling collectDays the old way, with no cardio, is unchanged");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
