/**
 * reaction.js -- the finger reaction-time test: what counts as a reaction,
 * and what the result is.
 *
 *   node tests/test_reaction.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";
import { TRIALS, foreperiod, classify, summarise, collectReaction, reactionTrend,
         FORE_MIN_MS, FORE_MAX_MS } from "../src/reaction.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

ok(TRIALS === 5, "five counted trials");
ok(foreperiod(0) === FORE_MIN_MS && foreperiod(0.999999) <= FORE_MAX_MS, "the pause stays in 1.5-4 s");
ok(classify(80) === "early" && classify(NaN) === "early", "under 100 ms is a guess, not a reaction");
ok(classify(250) === "ok" && classify(1600) === "slow", "250 ms counts; 1.6 s is a missed trial");

const s = summarise([300, 250, 240, 260, 900]);
ok(s.median === 260, "the median, not dragged by one slow trial", String(s.median));
ok(s.best === 240 && s.n === 5, "best and count");
ok(summarise([250, 270]).median === 260, "an even count averages the middle two");
ok(summarise([]) === null && summarise([NaN, -3]) === null, "nothing counted is no result");

{
  const days = collectReaction([
    { at: "2026-09-10T08:00:00.000Z", profile: "bas", trials: [250, 260, 270, 280, 290], input: "touch" },
    { at: "2026-09-10T18:00:00.000Z", profile: "bas", trials: [240, 250, 260, 270, 280], input: "touch" },
    { at: "2026-09-10T09:00:00.000Z", profile: "ana", trials: [300], input: "mouse" },
  ], "bas");
  const d = days.get("2026-09-10");
  ok(d.length === 2 && d[0].median === 270 && d[1].median === 260,
     "a day keeps every test, each with its own median");
}

{
  const today = new Date(2026, 8, 10);
  const all = [
    { at: "2026-09-10T08:00:00.000Z", trials: [250, 260, 270], input: "touch" },
    { at: "2026-09-05T08:00:00.000Z", trials: [290, 300, 310], input: "touch" },
    { at: "2026-09-06T08:00:00.000Z", trials: [200, 210, 220], input: "mouse" },
    { at: "2026-06-01T08:00:00.000Z", trials: [400, 400, 400], input: "touch" },
  ];
  const t = reactionTrend(all, "touch", 30, today);
  ok(t.tests === 2 && t.median === 280, "the usual time: same input only, last 30 days", JSON.stringify(t));
  ok(reactionTrend(all, "pen", 30, today) === null, "no tests on that input: nothing to compare");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
