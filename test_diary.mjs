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

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
