/**
 * diary.js and the arithmetic half of media.js.
 *
 * The interesting failures here are quiet ones: a mood average that counts
 * blank days as zero, a day bucket that puts an evening entry on tomorrow, a
 * photo key that collides between two athletes on a shared phone. None of them
 * throws; all of them produce a plausible wrong answer.
 *
 *   node test_diary.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

import { collectDiary, tagCounts, moodTrend, toggleTag, isMood, MOODS, dayKey }
  from "./diary.js";
import { photoId, targetDims } from "./media.js";
import { collectWeights, weightOn, latestWeight, weightSeries, daysBetween }
  from "./weight.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

const e = (at, mood, tags = [], note = "", profile = "Bas") => ({ at, mood, tags, note, profile });

/* ---- days -------------------------------------------------------------- */

ok(MOODS.length === 5 && MOODS.every((m) => isMood(m.v)), "five moods, all in range");
ok(!isMood(0) && !isMood(6) && !isMood(2.5) && !isMood(null), "anything else is not a mood");

// 22:30Z in August is 00:30 the next morning in Vienna.
ok(dayKey("2026-08-14T22:30:00.000Z") === "2026-08-15",
   "an after-midnight entry belongs to the local day", dayKey("2026-08-14T22:30:00.000Z"));

{
  const days = collectDiary([
    e("2026-08-14T07:00:00.000Z", 4, ["sleptWell"]),
    e("2026-08-14T19:00:00.000Z", 2, ["sore", "stressed"]),
    e("2026-08-15T08:00:00.000Z", 5, ["sleptWell"]),
  ], "Bas");

  ok(days.size === 2, "entries group by day", `${days.size}`);
  const d14 = days.get("2026-08-14");
  ok(d14.entries.length === 2, "a day can hold a morning and an evening");
  ok(d14.mood === 3, "the day's mood is the mean of its entries", String(d14.mood));
  ok([...d14.tags].sort().join(",") === "sleptWell,sore,stressed",
     "tags across the day are pooled");
}

{
  // A note with no mood must not drag the day toward zero.
  const days = collectDiary([
    e("2026-08-14T07:00:00.000Z", 4, []),
    e("2026-08-14T19:00:00.000Z", null, [], "long day, no idea"),
  ], "Bas");
  const d = days.get("2026-08-14");
  ok(d.mood === 4 && d.rated === 1 && d.entries.length === 2,
     "an unrated entry counts as an entry, not as a zero",
     `mood ${d.mood} from ${d.rated}/${d.entries.length}`);
}

ok(collectDiary([e("2026-08-14T07:00:00.000Z", 4, [], "", "Other")], "Bas").size === 0,
   "one athlete's diary is not another's");
ok(collectDiary(null).size === 0, "no entries is an empty map, not a throw");

/* ---- tags -------------------------------------------------------------- */
{
  const counts = tagCounts([
    e("2026-08-01T07:00:00.000Z", 3, ["sore", "sleptWell"]),
    e("2026-08-02T07:00:00.000Z", 3, ["sore"]),
    e("2026-08-03T07:00:00.000Z", 3, ["sore", "travel"]),
  ], "Bas");
  ok(counts[0][0] === "sore" && counts[0][1] === 3, "commonest tag first",
     JSON.stringify(counts[0]));
  ok(counts.length === 3, "every tag counted once per entry it appears in");

  ok(toggleTag(["a", "b"], "b").join(",") === "a", "toggling off removes");
  ok(toggleTag(["a"], "b").sort().join(",") === "a,b", "toggling on adds");
  ok(toggleTag(undefined, "a").join(",") === "a", "toggling on nothing still works");
}

/* ---- mood trend -------------------------------------------------------- */
{
  const today = new Date(2026, 7, 20, 10, 0);
  const days = collectDiary([
    e("2026-08-20T07:00:00.000Z", 5),
    e("2026-08-19T07:00:00.000Z", 3),
    // Five blank days, then one much older entry that is outside the window.
    e("2026-07-01T07:00:00.000Z", 1),
  ], "Bas");

  const t = moodTrend(days, 7, today);
  ok(t.mean === 4 && t.days === 2,
     "blank days are skipped, not counted as neutral", `${t.mean} over ${t.days}`);
  ok(moodTrend(collectDiary([]), 7, today) === null,
     "no rated days at all is null, so the caller can say nothing rather than 0");
}

/* ---- photos ------------------------------------------------------------ */

ok(photoId("2026-08-14T07:00:00.000Z", "Bas") !== photoId("2026-08-14T07:00:00.000Z", "Ana"),
   "two athletes logging at the same instant do not share a photo");
ok(photoId("2026-08-14T07:00:00.000Z", "Bas") === photoId("2026-08-14T07:00:00.000Z", "Bas"),
   "the key is derived, so a meal can find its photo without storing an id");

ok(targetDims(4000, 3000, 640).w === 640, "the long edge sets the scale");
ok(targetDims(4000, 3000, 640).h === 480, "aspect ratio holds",
   JSON.stringify(targetDims(4000, 3000, 640)));
ok(targetDims(3000, 4000, 640).h === 640, "portrait scales on its long edge too");
{
  const small = targetDims(320, 240, 640);
  ok(small.w === 320 && small.h === 240, "a small photo is left alone, never enlarged");
}
ok(targetDims(8000, 10, 640).h >= 1, "a very wide photo keeps at least one pixel of height",
   JSON.stringify(targetDims(8000, 10, 640)));
ok(targetDims(0, 0, 640) === null, "a zero-sized source is refused rather than divided by");

/* ---- weight carries forward -------------------------------------------- */
{
  const w = (at, kg, profile = "Bas") => ({ at, kg, profile });
  const all = collectWeights([
    w("2026-08-01T07:00:00.000Z", 83.0),
    w("2026-08-15T07:00:00.000Z", 82.4),
    w("2026-08-20T07:00:00.000Z", 99.9, "Other"),
    w("2026-08-10T07:00:00.000Z", NaN),          // a mistyped entry
  ], "Bas");

  ok(all.length === 2, "bad rows and other athletes are dropped", `${all.length}`);

  ok(weightOn(all, "2026-07-31") === null,
     "before the first measurement there is no weight, not a guess");
  ok(weightOn(all, "2026-08-01").kg === 83.0, "on the day of a measurement, that measurement");
  ok(weightOn(all, "2026-08-09").kg === 83.0, "it holds until it is changed");
  ok(weightOn(all, "2026-08-09").stale === 8,
     "and the app knows how old the figure is", String(weightOn(all, "2026-08-09").stale));
  ok(weightOn(all, "2026-08-15").kg === 82.4, "a new measurement takes over on its own day");
  ok(weightOn(all, "2026-12-25").kg === 82.4, "and holds indefinitely afterwards");
  ok(weightOn(all, "2026-08-15").stale === 0, "a fresh measurement is not stale");

  // Two on one day: the later one is what stands.
  const twice = collectWeights([
    w("2026-08-01T07:00:00.000Z", 83.0),
    w("2026-08-01T19:00:00.000Z", 82.6),
  ], "Bas");
  ok(weightOn(twice, "2026-08-01").kg === 82.6,
     "two measurements in a day: the later one stands", String(weightOn(twice, "2026-08-01").kg));

  ok(latestWeight(all, new Date(2026, 7, 18)).kg === 82.4, "latest weight as of a date");
  ok(latestWeight([], new Date()) === null, "no weights at all is null");

  const series = weightSeries(all, 2026, 7);          // August 2026
  ok(series.length === 31, "a day per day of the month", `${series.length}`);
  ok(series[0].kg === 83.0 && series[0].measured === true, "day 1 is a real measurement");
  ok(series[8].kg === 83.0 && series[8].measured === false,
     "day 9 is carried forward, and says so");
  ok(weightSeries(all, 2026, 6).every((d) => d.kg === null),
     "a month before any measurement is empty, not back-filled");

  ok(daysBetween("2026-03-28", "2026-03-30") === 2,
     "a clock change does not shift the day count", String(daysBetween("2026-03-28", "2026-03-30")));
}

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
