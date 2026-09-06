/**
 * cycle.js, where every failure is a quiet one.
 *
 * A missed light day that splits one cycle into two halves the mean length. A
 * prediction from two observations looks identical on screen to one from a
 * year. A day count that runs past a gap in logging reports "day 240" as
 * though it were a cycle day. None of these throw.
 *
 *   node test_cycle.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

import { collectCycle, cycleStarts, cycleLengths, lengthStats, predictNext,
         dayOfCycle, daysBetween, shiftDay, dayKey, FLOWS,
         periodLengths, phaseModel, LUTEAL_DAYS } from "./cycle.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/** Logged days from YYYY-MM-DD strings, at local midday. */
const on = (...keys) => keys.map((k) => ({ at: `${k}T10:00:00.000Z`, flow: 3, profile: "A" }));
const run = (start, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(shiftDay(start, i));
  return on(...out);
};

/* ---- dates ------------------------------------------------------------- */

ok(daysBetween("2026-01-01", "2026-01-08") === 7, "a week is seven days");
ok(daysBetween("2026-03-28", "2026-04-01") === 4,
   "a spring clock change does not shift the count", String(daysBetween("2026-03-28", "2026-04-01")));
ok(shiftDay("2026-02-27", 2) === "2026-03-01", "February 2026 has 28 days", shiftDay("2026-02-27", 2));
ok(shiftDay("2024-02-27", 2) === "2024-02-29", "February 2024 has 29", shiftDay("2024-02-27", 2));
ok(FLOWS.length === 4, "four flow levels");

/* ---- runs -------------------------------------------------------------- */
{
  const days = collectCycle([...run("2026-01-05", 5), ...run("2026-02-02", 4)], "A");
  ok(days.size === 9, "each logged day is one record", `${days.size}`);
  const starts = cycleStarts(days);
  ok(starts.length === 2 && starts[0] === "2026-01-05" && starts[1] === "2026-02-02",
     "the first day of each run is a cycle start", starts.join(" "));
}

{
  // The important one: a light day that never got logged, mid-period.
  const days = collectCycle(on("2026-01-05", "2026-01-06", "2026-01-08", "2026-01-09"), "A");
  const starts = cycleStarts(days);
  ok(starts.length === 1,
     "a single missed day does not split one period into two cycles", starts.join(" "));
}

{
  // Two blank days does end it -- that is a gap, not a missed entry.
  const days = collectCycle(on("2026-01-05", "2026-01-06", "2026-01-10"), "A");
  ok(cycleStarts(days).length === 2, "a three-day gap starts a new run");
}

ok(collectCycle(on("2026-01-05")[0] ? [{ at: "2026-01-05T10:00:00.000Z", flow: 3, profile: "B" }] : [], "A").size === 0,
   "one athlete's log is not another's");

/* ---- lengths ----------------------------------------------------------- */
{
  const starts = ["2026-01-01", "2026-01-29", "2026-02-26", "2026-03-27"];
  const lens = cycleLengths(starts);
  ok(lens.join(",") === "28,28,29", "lengths are gaps between starts", lens.join(","));

  const s = lengthStats(lens);
  ok(Math.abs(s.mean - 28.33) < 0.01, "mean length", s.mean.toFixed(2));
  ok(s.n === 3 && s.min === 28 && s.max === 29, "count and range");
  ok(lengthStats([28]).sd === null, "one observation has no spread, and says null rather than 0");
  ok(lengthStats([]) === null, "no observations at all is null");

  // Nonsense gaps are evidence of missed logging, not of cycle length.
  ok(cycleLengths(["2026-01-01", "2026-01-04"]).length === 0, "a three-day gap is not a cycle");
  ok(cycleLengths(["2026-01-01", "2026-09-01"]).length === 0, "an eight-month gap is not a cycle");
}

/* ---- prediction -------------------------------------------------------- */
{
  const today = new Date(2026, 3, 10);                 // 10 April 2026
  ok(predictNext(["2026-01-01"], today) === null, "no prediction from one start");
  ok(predictNext(["2026-01-01", "2026-01-29"], today) === null,
     "no prediction from a single observed length");
  ok(predictNext(["2026-01-01", "2026-01-29", "2026-02-26"], today) === null,
     "still nothing from two: a mean of two says nothing about its own reliability");

  const p = predictNext(["2026-01-01", "2026-01-29", "2026-02-26", "2026-03-27"], today);
  ok(p !== null, "three lengths is enough to say something");
  ok(p.due === "2026-04-24", "due date is the last start plus the mean", p.due);
  ok(p.spread >= 1, "and it carries a spread, never a bare date", String(p.spread));
  ok(p.stats.n === 3, "the caller can say how many cycles it rests on");
  ok(p.overdue === -14, "and how far off it is from today", String(p.overdue));

  // A wildly variable history must produce a wider window, not a confident one.
  const erratic = predictNext(["2026-01-01", "2026-01-22", "2026-02-26", "2026-03-15"], today);
  const steady = predictNext(["2026-01-01", "2026-01-29", "2026-02-26", "2026-03-26"], today);
  ok(erratic.spread > steady.spread,
     "an irregular history widens the window", `${erratic.spread} vs ${steady.spread}`);
}

/* ---- day of cycle ------------------------------------------------------ */
{
  const starts = ["2026-01-05", "2026-02-02"];
  ok(dayOfCycle(starts, "2026-01-05") === 1, "the first logged day is day 1");
  ok(dayOfCycle(starts, "2026-01-19") === 15, "counting continues through the cycle");
  ok(dayOfCycle(starts, "2026-02-02") === 1, "a new start resets the count");
  ok(dayOfCycle(starts, "2026-01-01") === null, "before any record there is no cycle day");
  ok(dayOfCycle(starts, "2026-08-01") === null,
     "and after a long silence the count is not fiction", String(dayOfCycle(starts, "2026-08-01")));
}

/* ---- period length and phases ------------------------------------------ */
{
  const days = collectCycle([...run("2026-01-05", 5), ...run("2026-02-02", 4)], "A");
  ok(periodLengths(days).join(",") === "5,4", "each run's length", periodLengths(days).join(","));

  // A missed day mid-period must not read as a longer period: it is counted
  // as logged days, not first-to-last.
  const gappy = collectCycle(on("2026-01-05", "2026-01-06", "2026-01-08", "2026-01-09"), "A");
  ok(periodLengths(gappy)[0] === 4, "a missed day does not inflate the length",
     String(periodLengths(gappy)[0]));
}

{
  const days = collectCycle([
    ...run("2026-01-01", 5), ...run("2026-01-29", 5),
    ...run("2026-02-26", 5), ...run("2026-03-26", 5),
  ], "A");
  const m = phaseModel(days);
  ok(m !== null, "three lengths is enough for a phase model");
  ok(m.cycle === 28, "mean cycle length", String(m.cycle));
  ok(m.period === 5, "mean period length", String(m.period));
  ok(m.ovulation === 28 - LUTEAL_DAYS,
     "ovulation is counted back from the next period, not forward from the last",
     String(m.ovulation));
  ok(m.fertile.from === m.ovulation - 5 && m.fertile.to === m.ovulation + 1,
     "the window sits mostly before ovulation, because sperm outlive the egg",
     `${m.fertile.from}-${m.fertile.to}`);
  ok(m.fertile.from > m.period, "and never overlaps the period itself");

  ok(phaseModel(collectCycle([...run("2026-01-01", 5), ...run("2026-01-29", 5)], "A")) === null,
     "two starts give one length, which is not a model");
}

{
  // A short cycle would put ovulation inside the period. Draw the period and
  // nothing else rather than an impossible split.
  const days = collectCycle([
    ...run("2026-01-01", 6), ...run("2026-01-17", 6),
    ...run("2026-02-02", 6), ...run("2026-02-18", 6),
  ], "A");
  const m = phaseModel(days);
  ok(m.cycle === 16, "a short cycle is still modelled", String(m.cycle));
  ok(m.ovulation === null && m.fertile === null,
     "but its phases are not invented when they would not fit");
}

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
