/**
 * weight.js -- body mass as a step function.
 *
 * Nobody weighs themselves daily, and a chart that draws a line between two
 * measurements a fortnight apart invents twelve days of data. So a weight
 * holds until it is changed: the value on any given day is the most recent
 * entry on or before it, and days before the first entry have no weight at
 * all rather than a guess.
 *
 * This is not cosmetic. Mass scales every joint moment and contact force the
 * app reports, and `applyProfile` deliberately refuses to restore a stored
 * mass for exactly that reason -- silently reusing a figure from weeks ago is
 * the kind of wrong that never announces itself. A dated log fixes that
 * honestly: the app can say which measurement it used and how old it is,
 * instead of either guessing or asking every session.
 *
 * There are no goals here, and no trend line. It is a record of what the
 * scale said.
 */

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. */
export function dayKey(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One athlete's weights, oldest first, bad rows dropped. */
export function collectWeights(entries, profile = null) {
  return (entries || [])
    .filter((w) => (!profile || w.profile === profile) &&
                   Number.isFinite(+w.kg) && +w.kg > 0 && dayKey(w.at))
    .map((w) => ({ ...w, kg: +w.kg, day: dayKey(w.at) }))
    .sort((a, b) => a.day.localeCompare(b.day) || String(a.at).localeCompare(String(b.at)));
}

/**
 * What the athlete weighed on `key`, and when that was actually measured.
 *
 * Returns null before the first entry: an app that reports a mass it was
 * never told is worse than one that says it does not know.
 *
 * `stale` is the age in days of the measurement being used, so the caller can
 * show "83.0 kg, measured 24 days ago" rather than presenting a month-old
 * figure as today's.
 */
export function weightOn(weights, key) {
  if (!key) return null;
  let hit = null;
  // Sorted ascending, so the last one that is not in the future wins. More
  // than one on the same day: the later measurement is the one that stands.
  for (const w of weights) {
    if (w.day <= key) hit = w; else break;
  }
  if (!hit) return null;
  return { kg: hit.kg, at: hit.at, day: hit.day, stale: daysBetween(hit.day, key) };
}

/** The most recent measurement overall. */
export function latestWeight(weights, today = new Date()) {
  return weightOn(weights, dayKey(today));
}

/** Whole days from `a` to `b`, both YYYY-MM-DD. Uses UTC noon so a clock
 *  change in between cannot round the answer off by one. */
export function daysBetween(a, b) {
  const t = (k) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12);
  };
  return Math.round((t(b) - t(a)) / 86400000);
}

/**
 * A weight for each day of a month, carried forward.
 *
 * Days before the first ever measurement are null, not the first value
 * projected backwards -- that would be inventing history rather than
 * continuing it.
 */
export function weightSeries(weights, year, month) {
  const p = (n) => String(n).padStart(2, "0");
  const last = new Date(year, month + 1, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    const key = `${year}-${p(month + 1)}-${p(d)}`;
    const w = weightOn(weights, key);
    out.push({ key, kg: w ? w.kg : null, measured: w ? w.stale === 0 : false });
  }
  return out;
}
