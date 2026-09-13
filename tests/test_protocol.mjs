/**
 * The scripted sessions: the Tom Holland circuit and Tabata.
 *
 *   node tests/test_protocol.mjs
 */
import { PROTOCOLS, TH_STEPS, circuitAt, timeLeft, fmtTime, afterStep, protocolSummary,
         isProtocol, TABATA_ACTIVITIES } from "../src/protocol.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};

ok(isProtocol("tomholland") && isProtocol("tabata") && !isProtocol("strength"),
   "the two scripted sports are known as such");
ok(PROTOCOLS.tomholland.totalS === 1200 && PROTOCOLS.tomholland.record === 28,
   "twenty minutes, and 28 rounds as the mark to chase");
ok(PROTOCOLS.tabata.totalS === 8 * 30 - 10, "Tabata is 8 x (20 + 10), less the last rest",
   String(PROTOCOLS.tabata.totalS));
ok(TH_STEPS.map((s) => `${s.reps} ${s.activity}`).join(", ") === "5 pullup, 10 pushup, 15 squat",
   "the round is 5 pull-ups, 10 push-ups, 15 squats");
ok(TABATA_ACTIVITIES.includes("squat") && !TABATA_ACTIVITIES.includes("walk"),
   "Tabata offers rep movements, not gait");

{
  ok(circuitAt(0).step.activity === "pullup" && circuitAt(0).round === 1, "the circuit opens on pull-ups");
  ok(circuitAt(2).step.activity === "squat" && circuitAt(2).roundsDone === 0,
     "two steps in, squats are next and no round is finished");
  const r = circuitAt(3);
  ok(r.roundsDone === 1 && r.round === 2 && r.stepIndex === 0, "three steps is one round, then round 2");
  ok(circuitAt(28 * 3).roundsDone === 28, "84 steps is the 28 rounds");
}
{
  const t0 = 1000;
  ok(timeLeft("tomholland", t0, t0 + 60000) === 1140, "a minute in, 19 minutes left");
  ok(timeLeft("tomholland", t0, t0 + 3e6) === 0, "and it never goes negative");
  ok(fmtTime(1200) === "20:00" && fmtTime(9.2) === "0:10" && fmtTime(0) === "0:00", "m:ss");
}
{
  const t0 = 0;
  const a = afterStep("tomholland", { done: 1, startedAt: t0, now: 30000 });
  ok(a.do === "next" && a.activity === "pushup" && a.reps === 10, "after the pull-ups: 10 push-ups");
  const b = afterStep("tomholland", { done: 3, startedAt: t0, now: 90000 });
  ok(b.do === "next" && b.roundsDone === 1 && b.activity === "pullup", "a finished round starts the next");
  const c = afterStep("tomholland", { done: 7, startedAt: t0, now: 1201000 });
  ok(c.do === "done" && c.rounds === 2 && c.partial === 1,
     "out of time: two rounds done and one step of a third", JSON.stringify(c));
}
{
  const a = afterStep("tabata", { done: 3, startedAt: 0, now: 1000, activity: "squat" });
  ok(a.do === "next" && a.round === 4 && a.restS === 10 && a.activity === "squat",
     "Tabata: rest ten seconds, then round 4 of the same movement");
  const b = afterStep("tabata", { done: 8, startedAt: 0, now: 1000, activity: "squat" });
  ok(b.do === "done" && b.rounds === 8, "eight rounds and it is over");
}
{
  const sets = [];
  for (let i = 0; i < 7; i++) sets.push({ activity: TH_STEPS[i % 3].activity, reps: TH_STEPS[i % 3].reps });
  const s = protocolSummary("tomholland", sets);
  ok(s.rounds === 2 && s.partialSteps === 1 && s.record === 28, "two rounds and a bit");
  ok(s.reps === 2 * 30 + 5, "reps are summed across the rounds", String(s.reps));
}
{
  const sets = [8, 7, 7, 6, 6, 5, 5, 4].map((n) => ({ activity: "squat", reps: n }));
  const s = protocolSummary("tabata", sets);
  ok(s.rounds === 8 && s.activity === "squat" && s.total === 48 && s.best === 8 && s.worst === 4,
     "eight sets of squats, best and worst named", JSON.stringify([s.total, s.best, s.worst]));
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
