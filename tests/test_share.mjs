/**
 * share.js -- what a shared card claims.
 *
 * The dangerous failure is a card that fills a gap with a zero. "0 kcal" for a
 * month nobody logged is a statement about the month, not about the logging,
 * and it goes on a public post where nobody can check it.
 *
 *   node test_share.mjs
 */
import { cardStats, volumeBars, fitName, CARD, shareText, APP_URL } from "../src/share.js";
import { collectDays, collectMeals } from "../src/dashboard.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

const set = (i, at, reps) => ({ index: i, at, activity: "squat", reps, perRep: [] });
const sess = (started, sets) => ({ started, profile: "Bas", sets });

const days = collectDays([
  sess("2026-09-02T09:00:00.000Z", [set(1, "2026-09-02T09:00:00.000Z", 5),
                                    set(2, "2026-09-02T09:20:00.000Z", 5)]),
  sess("2026-09-05T09:00:00.000Z", [set(1, "2026-09-05T09:00:00.000Z", 8)]),
]);
const mealDays = collectMeals([
  { at: "2026-09-02T07:00:00.000Z", text: "oats", kcal: 500, profile: "Bas" },
  { at: "2026-09-02T18:00:00.000Z", text: "dinner", kcal: 900, profile: "Bas" },
  { at: "2026-09-05T07:00:00.000Z", text: "eggs", kcal: 600, profile: "Bas" },
]);
const weights = [{ day: "2026-09-01", kg: 83.4 }, { day: "2026-09-20", kg: 82.6 }];

{
  const s = cardStats({ name: "Bas", year: 2026, month: 8, days, mealDays, weights,
                        today: new Date(2026, 8, 30) });
  ok(s.trained === 2 && s.sessions === 2 && s.sets === 3 && s.reps === 18,
     "the month totals", `${s.trained}d ${s.sessions}s ${s.sets}sets ${s.reps}reps`);
  ok(s.volume.length === 30, "a bar per day of September", String(s.volume.length));
  ok(s.kcal === 1000 && s.kcalDays === 2,
     "kcal is the mean over days that have one", `${s.kcal} over ${s.kcalDays}`);
  ok(s.weightFrom === 83.4 && s.weightTo === 82.6, "first and last weight of the month");
  ok(s.empty === false, "a month with training is not empty");
  ok(s.month === "September 2026", "the month is named", s.month);
}

{
  // The one that matters: nothing logged must be null, never 0.
  const s = cardStats({ name: "Bas", year: 2026, month: 0, days, mealDays, weights,
                        today: new Date(2026, 8, 30) });
  ok(s.kcal === null, "a month with no calories logged says nothing, not zero", String(s.kcal));
  ok(s.weightFrom === null, "and no weight rather than a projected one");
  ok(s.trained === 0 && s.empty === true, "and it knows it is empty");
}

ok(fitName("Bas") === "Bas", "a short name is left alone");
ok(fitName("Bartholomew Fitzgerald-Smythe").length === 18,
   "a long one is cut to fit the card", fitName("Bartholomew Fitzgerald-Smythe"));
ok(fitName("Bartholomew Fitzgerald").endsWith("\u2026"), "and says it was cut");

{
  const bars = volumeBars([0, 10, 5, 0], 60, 100, 400, 80);
  ok(bars.length === 4, "a bar per value");
  ok(bars[1].h === 80, "the busiest day is full height", String(bars[1].h));
  ok(bars[2].h === 40, "and the rest scale to it", String(bars[2].h));
  // A gap in a row of bars reads as missing data; a flat mark reads as a rest.
  ok(bars[0].h === 2 && bars[0].empty === true, "an untrained day is a hairline, not a gap");
  ok(bars[3].x > bars[0].x, "bars run left to right");
  ok(bars[0].x >= 60 && bars[3].x + bars[3].w <= 460, "and stay inside their box",
     `${bars[0].x}..${bars[3].x + bars[3].w}`);
}

ok(CARD.w === 1080 && CARD.h === 1350, "portrait, which is what a share sheet feeds");

// The link that goes with a picture shared outside the app.
{
  const line = `Tracked with BioScout: ${APP_URL}`;
  ok(shareText("Leg day", line) === `Leg day\n\n${line}`, "the caption, then the link");
  ok(shareText("", line) === line, "no caption: just the link");
  ok(shareText(`see ${APP_URL}`, line) === `see ${APP_URL}`, "a caption with the link already is not given it twice");
  ok(APP_URL.startsWith("https://"), "the link is https");
}
console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
