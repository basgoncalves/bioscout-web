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
/* Labelled, not drawn. The bar glyphs this used to carry rendered as empty
 * boxes on Android, and a five-point scale you cannot read is not a scale. The
 * words also fix the direction: nobody has to work out which end is good. */
export const MOODS = [
  { v: 1, key: "moodAwful" },
  { v: 2, key: "moodBad" },
  { v: 3, key: "moodOk" },
  { v: 4, key: "moodGood" },
  { v: 5, key: "moodGreat" },
];

/** Tag levels run 0-10. 0 means the tag is not on the entry at all. */
export const LEVEL_MAX = 10;

/**
 * The level a tag was recorded at, as {tag, n} pairs.
 *
 * Entries written before levels existed carry a bare tag list, and those read
 * as 1 -- present, unquantified. Treating them as 0 would erase them and
 * treating them as 10 would invent an intensity nobody typed.
 */
export function tagLevels(entry) {
  const levels = entry?.levels || {};
  return (entry?.tags || []).map((t) => ({
    tag: t,
    n: Number.isFinite(levels[t]) ? levels[t] : 1,
  }));
}

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
    if (!days.has(key)) days.set(key, { key, entries: [], tags: new Map(), mood: null, rated: 0 });
    const d = days.get(key);
    d.entries.push(e);
    for (const { tag, n } of tagLevels(e)) {
      // A day shows the highest level anything reached: two entries of
      // "stressed 2" and "stressed 8" is an 8 sort of day.
      d.tags.set(tag, Math.max(d.tags.get(tag) ?? 0, n));
    }
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
    for (const { tag } of tagLevels(e)) counts.set(tag, (counts.get(tag) || 0) + 1);
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

/**
 * Nudge a tag's level, clamped to 0..10, where 0 removes it.
 *
 * Returns {tags, levels} so a caller holding a draft can replace both at once
 * and never end up with a level for a tag that is not on the entry.
 */
export function stepTag(tags, levels, tag, delta) {
  const cur = Number.isFinite(levels?.[tag]) ? levels[tag] : (tags || []).includes(tag) ? 1 : 0;
  const n = Math.max(0, Math.min(LEVEL_MAX, cur + delta));
  const nextTags = new Set(tags || []);
  const nextLevels = { ...(levels || {}) };
  if (n === 0) { nextTags.delete(tag); delete nextLevels[tag]; }
  else { nextTags.add(tag); nextLevels[tag] = n; }
  return { tags: [...nextTags], levels: nextLevels };
}
