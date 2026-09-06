/**
 * diary.js -- how the day went, in the shape Daylio made familiar.
 *
 * An entry is a mood, any number of tags, and an optional note. Tags are the
 * point: the useful question is not "how was Tuesday" on its own, it is which
 * days had slept-badly on them and whether those are the same days the bar
 * felt heavy. So the tag list is the athlete's own, not a fixed one -- what a
 * person wants to track daily is not something this app can guess.
 *
 * Moods are a five-point scale because a coarse scale gets used honestly and a
 * hundred-point one does not. They are stored as numbers, not labels, so the
 * scale survives translation.
 *
 * Nothing here scores anyone. There is no streak to protect, no target, and a
 * missing day is a missing day rather than a failure -- a diary that nags is a
 * diary that gets filled in dishonestly, and dishonest data is worse than no
 * data in a tool that sits next to joint loads.
 */

/** 1 is worst, 5 is best. The key names a translation string; the number is
 *  what gets stored and averaged. */
export const MOODS = [
  { v: 1, key: "moodAwful", glyph: "▁" },
  { v: 2, key: "moodBad", glyph: "▃" },
  { v: 3, key: "moodOk", glyph: "▅" },
  { v: 4, key: "moodGood", glyph: "▆" },
  { v: 5, key: "moodGreat", glyph: "█" },
];

/** A starting set, meant to be edited. Chosen to be things that plausibly
 *  move a training day, not a lifestyle checklist. */
export const DEFAULT_TAGS = [
  "sleptWell", "sore", "stressed", "restDay", "travel", "illness", "caffeine",
];

export const isMood = (v) => Number.isInteger(v) && v >= 1 && v <= 5;

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. Same rule as the
 *  rest of the app: an 11pm entry belongs to the day it was written, locally. */
export function dayKey(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Group an athlete's entries into local days.
 *
 * A day can hold more than one entry -- mornings and evenings differ, and
 * forcing one per day would mean overwriting the morning. `mood` on the day is
 * the mean of the entries that carry one, so a note with no mood does not drag
 * the day toward zero.
 */
export function collectDiary(entries, profile = null) {
  const days = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    const key = dayKey(e.at);
    if (!key) continue;
    if (!days.has(key)) days.set(key, { key, entries: [], tags: new Set(), mood: null, rated: 0 });
    const d = days.get(key);
    d.entries.push(e);
    for (const t of e.tags || []) d.tags.add(t);
    if (isMood(e.mood)) {
      d.mood = (d.mood ?? 0) + e.mood;
      d.rated++;
    }
  }
  for (const d of days.values()) {
    d.entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (d.rated) d.mood = d.mood / d.rated;
  }
  return days;
}

/**
 * How often each tag appears, commonest first.
 *
 * This is what makes the tag list worth keeping: after a month it says what
 * the athlete actually records, which is rarely what they thought they would.
 */
export function tagCounts(entries, profile = null) {
  const counts = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    for (const t of e.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Mean mood over the last `n` days that have one.
 *
 * Days without an entry are skipped rather than counted as neutral: a week
 * with two good days and five blanks is not an average week, it is two days of
 * evidence, and the count is returned so the caller can say so.
 */
export function moodTrend(days, n = 30, today = new Date()) {
  const cur = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const hit = days.get(dayKey(cur));
    if (hit && hit.rated) { sum += hit.mood; count++; }
    cur.setDate(cur.getDate() - 1);
  }
  return count ? { mean: sum / count, days: count } : null;
}

/** Add or remove a tag, returning a new array. */
export function toggleTag(tags, tag) {
  const set = new Set(tags || []);
  if (set.has(tag)) set.delete(tag); else set.add(tag);
  return [...set];
}
