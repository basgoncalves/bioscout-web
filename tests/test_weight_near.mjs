/**
 * The weight the pre-session dialog offers, and the weights the day view's
 * timeline draws.
 *
 *   node tests/test_weight_near.mjs
 */
import { collectWeights, weightNear, weightWindow, addDays } from "../src/weight.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

const W = collectWeights([
  { at: "2026-06-20T07:00:00.000Z", kg: 84.0 },
  { at: "2026-07-03T07:00:00.000Z", kg: 83.4 },
  { at: "2026-07-09T07:00:00.000Z", kg: 82.9 },
  { at: "2026-07-09T19:00:00.000Z", kg: 83.3 },      // later the same day stands
  { at: "2026-09-10T07:00:00.000Z", kg: 83.0 },
]);

const onDay = weightNear(W, "2026-07-09");
ok(onDay.kg === 83.3 && onDay.offset === 0, "a logged day offers its own (latest) figure");
const jul6 = weightNear(W, "2026-07-06");
ok(jul6.kg === 83.4 && jul6.day === "2026-07-03" && jul6.offset === -3,
   "a session on 6 July offers the last weigh-in BEFORE it, not today's",
   JSON.stringify(jul6));
const early = weightNear(W, "2026-06-01");
ok(early.kg === 84.0 && early.offset === 19, "before anything was logged: the nearest one after");
ok(weightNear([], "2026-07-06") === null, "no weights: nothing offered");

ok(addDays("2026-03-01", -1) === "2026-02-28" && addDays("2026-12-31", 1) === "2027-01-01",
   "day arithmetic crosses months and years");

const wk = weightWindow(W, "2026-07-10", 7);
ok(wk.start === "2026-07-04" && wk.end === "2026-07-10", "a week is the 7 days ending on the day");
ok(wk.carried === 83.4, "the weight standing when the window opens is carried in");
ok(wk.points.length === 1 && wk.points[0].kg === 83.3, "one point per weigh-in day, the later one");
const yr = weightWindow(W, "2026-09-10", 365);
ok(yr.carried === null && yr.points.length === 4, "a year with nothing before it carries nothing",
   `${yr.carried} / ${yr.points.length}`);
const empty = weightWindow(W, "2026-06-10", 7);
ok(empty.points.length === 0 && empty.carried === null, "a window before any weigh-in is empty");

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
