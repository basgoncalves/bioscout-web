/**
 * sleep.js -- the arithmetic of a night that crosses midnight.
 *
 * Almost every night wraps past 00:00, so the wrapping case is the normal one
 * and the same-day case is the exception. Getting it backwards gives a
 * negative duration or a 16-hour night, and nothing throws.
 *
 *   node tests/test_sleep.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

import { parseHM, toHM, duration, fmt, collectSleep, meanSleep, dayKey }
  from "../src/sleep.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/* ---- clock times ------------------------------------------------------- */

ok(parseHM("23:15") === 1395, "a time is minutes past midnight");
ok(parseHM("00:00") === 0, "midnight is zero, not null");
ok(parseHM("7:05") === 425, "a single-digit hour parses");
ok(parseHM("24:00") === null, "there is no 24:00");
ok(parseHM("23:60") === null, "nor a 60th minute");
ok(parseHM("half ten") === null, "words are not a time");
ok(parseHM("") === null && parseHM(null) === null, "and neither is nothing");
ok(toHM(1395) === "23:15" && toHM(0) === "00:00", "and back again");

/* ---- duration ---------------------------------------------------------- */

// The normal case: to bed before midnight, up after it.
ok(duration("23:15", "07:00") === 465, "a night that crosses midnight",
   String(duration("23:15", "07:00")));
ok(fmt(465) === "7 h 45", "read as hours and minutes", fmt(465));
ok(fmt(480) === "8 h", "and no stray zero on the hour", fmt(480));

ok(duration("01:30", "09:00") === 450, "a late night still ends the same morning");
ok(duration("22:00", "06:00") === 480, "eight hours");

// 23:00 to 22:00 is 23 hours: overwhelmingly a typo, not a fact.
ok(duration("23:00", "22:00") === null, "an implausibly long night is refused",
   String(duration("23:00", "22:00")));
ok(duration("23:00", "23:10") === null, "and so is ten minutes");
ok(duration("23:00", "23:00") === null, "identical times are not a night");
ok(duration("bed", "07:00") === null, "an unparseable time is no duration");

/* ---- days -------------------------------------------------------------- */
{
  const e = (at, bed, wake, profile = "A") => ({ at, bed, wake, profile });
  const days = collectSleep([
    e("2026-08-14T09:00:00.000Z", "23:15", "07:00"),
    e("2026-08-15T09:00:00.000Z", "00:30", "08:00"),
    e("2026-08-16T09:00:00.000Z", "23:00", "22:00"),      // the typo
    e("2026-08-17T09:00:00.000Z", "22:30", "06:30", "B"), // someone else
  ], "A");

  ok(days.size === 3, "one entry per night, for this athlete only", String(days.size));
  ok(days.get("2026-08-14").minutes === 465, "duration computed on the way in");
  ok(days.get("2026-08-16").minutes === null,
     "a refused duration is null on the day, not missing from it");
  ok(!days.has("2026-08-17"), "another athlete's night is not here");
  ok(collectSleep(null).size === 0, "no entries is an empty map");
}

/* ---- mean -------------------------------------------------------------- */
{
  const e = (at, bed, wake) => ({ at, bed, wake, profile: "A" });
  const days = collectSleep([
    e("2026-08-20T09:00:00.000Z", "23:00", "07:00"),   // 8 h
    e("2026-08-19T09:00:00.000Z", "23:00", "06:00"),   // 7 h
    e("2026-08-18T09:00:00.000Z", "23:00", "22:00"),   // refused
  ], "A");
  const m = meanSleep(days, 7, new Date(2026, 7, 20, 12));
  ok(m.mean === 450 && m.nights === 2,
     "blank and refused nights are skipped, not averaged in",
     `${fmt(m.mean)} over ${m.nights}`);
  ok(meanSleep(collectSleep([]), 7, new Date()) === null,
     "no nights at all is null, so the caller can say nothing rather than 0 h");
}

ok(dayKey("2026-08-15T06:00:00.000Z") === "2026-08-15", "a night is filed on the morning it ended");

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
