/**
 * Training plans and the rest timer.
 *
 *   node tests/test_plans.mjs
 */
import { normalizePlan, plansOn, planProgress, nextPlanned, plannedDays } from "../src/plans.js";
import { restTimer, restStart, restPause, restLeft, restReset, restAdd, restRunning, fmtClock }
  from "../src/resttimer.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};

/* --- plans ---------------------------------------------------------------- */
{
  const p = normalizePlan({ day: "2026-09-20", profile: "Bas", sport: "strength",
    items: [{ activity: "pullup", sets: "4", reps: 8 }, { activity: "", sets: 3 },
            { activity: "pushup", sets: 99, reps: -3, kg: 12.3 }] });
  ok(p && p.items.length === 2, "empty rows are dropped");
  ok(p.items[1].sets === 20 && p.items[1].reps === 1 && p.items[1].kg === 12.5,
     "numbers are clamped and load rounded to 0.5 kg", JSON.stringify(p.items[1]));
  ok(p.at.startsWith("2026-09-20") && p.id, "a plan carries an id and an `at` on its day");
  ok(normalizePlan({ day: "2026-09-20", items: [] }) === null, "a plan with nothing in it is not saved");
  ok(normalizePlan({ day: "tomorrow", items: [{ activity: "dip" }] }) === null, "the day must be a date");
  ok(normalizePlan({ day: "2026-09-20", note: "rest, walk" })?.note === "rest, walk",
     "a note alone is a plan");
}
{
  const a = normalizePlan({ id: "a", day: "2026-09-12", items: [{ activity: "pushup", sets: 3, reps: 10 }] });
  const b = normalizePlan({ id: "b", day: "2026-09-12", items: [{ activity: "pushup", sets: 2, reps: 10 },
                                                               { activity: "pullup", sets: 2, reps: 5 }] });
  const other = normalizePlan({ id: "c", day: "2026-09-13", items: [{ activity: "dip", sets: 1, reps: 1 }] });
  ok(plansOn([b, other, a], "2026-09-12").map((p) => p.id).join() === "a,b", "the day's plans, in order");
  ok(plannedDays([a, other]).has("2026-09-13"), "planned days are listed");
  const sets = [{ activity: "pushup", reps: 10 }, { activity: "pushup", reps: 9 },
                { activity: "pushup", reps: 8 }, { activity: "pushup", reps: 8 },
                { activity: "squat", reps: 5 }];
  const [pa, pb] = planProgress([a, b], sets);
  ok(pa.items[0].doneSets === 3 && pa.complete, "three push-up sets complete the first plan");
  ok(pb.items[0].doneSets === 1, "and the fourth goes to the second plan, not counted twice",
     String(pb.items[0].doneSets));
  ok(pb.done === 1 && pb.planned === 4 && !pb.complete, "the second plan is 1 of 4 sets");
  ok(nextPlanned([pa, pb])?.activity === "pushup", "what is next: the unfinished push-ups");
  ok(pa.items[0].doneReps === 27, "reps done are summed", String(pa.items[0].doneReps));
}

/* --- rest timer ----------------------------------------------------------- */
{
  let t = restTimer(90);
  ok(!restRunning(t) && restLeft(t, 0) === 90, "a new timer is stopped at its duration");
  t = restStart(t, 1000);
  ok(Math.abs(restLeft(t, 31000) - 60) < 1e-9, "30 s after starting, 60 s are left");
  t = restPause(t, 31000);
  ok(restLeft(t, 99999) === 60, "paused, it does not move");
  t = restStart(t, 100000);
  ok(Math.abs(restLeft(t, 130000) - 30) < 1e-9, "and resumes from where it stopped");
  ok(restLeft(t, 999999) === 0, "it never goes below zero");
  t = restAdd(t, 15, 130000);
  ok(Math.abs(restLeft(t, 130000) - 45) < 1e-9, "+15 s while running adds to what is left");
  t = restReset(t);
  ok(!restRunning(t) && restLeft(t, 0) === 90, "reset: stopped, back at the full time");
  t = restAdd(t, 15, 0);
  ok(t.durS === 105, "+15 before starting makes it a longer timer", String(t.durS));
  const low = restAdd(restPause(restStart(restTimer(30), 0), 20000), -15, 20000);
  ok(restLeft(low, 0) === 5, "-15 s on 10 s left stops at 5 s rather than running out", String(restLeft(low, 0)));
  const done = restStart(restTimer(30), 0);
  ok(restLeft(restStart(restPause(done, 40000), 50000), 50000) === 30,
     "a finished timer starts again from the top");
  ok(fmtClock(90) === "1:30" && fmtClock(4.2) === "0:05" && fmtClock(0) === "0:00" && fmtClock(720) === "12:00",
     "the clock reads m:ss, rounded up");
}

/* --- the day view --------------------------------------------------------- */
{
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
  if (!globalThis.navigator) Object.defineProperty(globalThis, "navigator", { value: { languages: ["en"] }, configurable: true });
  const { renderDashboard } = await import("../src/dashboard.js");
  const today = new Date(2026, 8, 11, 18);
  const plan = (day, id) => normalizePlan({ id, day, profile: "Bas", sport: "strength",
    items: [{ activity: "pushup", sets: 3, reps: 10 }] });
  const sess = { started: "2026-09-11T09:00:00", profile: "Bas", sets: [
    { at: "2026-09-11T09:01:00", activity: "pushup", reps: 10 },
    { at: "2026-09-11T09:04:00", activity: "pushup", reps: 9 }] };
  const view = (sel) => ({ year: 2026, month: 8, selected: sel, mode: "training",
                           plans: [plan("2026-09-11", "t"), plan("2026-09-14", "f")] });
  const draw = (sel) => renderDashboard([sess], [], [], [], [], [], [], [], [], [], view(sel), today);
  const fut = draw("2026-09-14");
  ok(!fut.includes('id="newTrainingBtn"') && !fut.includes('id="trainImport"') && !fut.includes('id="assessBtn"'),
     "a future day offers no recording, import or test");
  ok(fut.includes('id="planAddBtn"') && fut.includes('data-plan="f"'), "only planning, and its plan");
  ok(/class="[^"]*\bplanned\b[^"]*" data-day="2026-09-14"/.test(fut), "the planned day is marked in the calendar");
  const now = draw("2026-09-11");
  ok(now.includes('id="newTrainingBtn"') && now.includes("2/3 sets"), "today: record as usual, plan shows 2 of 3 sets done");
  ok(now.includes('class="planStart"'), "and an unfinished plan today can be started");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
