/**
 * vitals.js -- steps and resting heart rate, one reading per day.
 *
 * These come from a watch, not from the app: nothing here is measured or
 * derived, only typed in after the fact. That is why it does not carry
 * forward the way weight.js does. A body mass measured a week ago is still
 * roughly true today; yesterday's step count says nothing about today's, so a
 * day with no entry has no vitals, not yesterday's numbers repeated.
 *
 * The two fields are independent on purpose. A watch on the charger
 * overnight still counted steps; a reading taken mid-afternoon is not a
 * resting rate. Either can be logged alone, and the day shows whichever
 * arrived.
 */

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. */
export function dayKey(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One athlete's days, keyed on the day the reading is filed under. Later
 *  entries for the same day win, same rule as sleep and cycle logging: a
 *  second entry is a correction, not a second reading. */
export function collectVitals(entries, profile = null) {
  const days = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    const key = dayKey(e.at);
    if (!key) continue;
    // Unary `+` turns null/undefined/"" into 0, which would read as a real
    // "0 steps" reading rather than "not provided" -- so absence is checked
    // before coercion, same as setVitals does on the way into storage.
    const steps = e.steps === null || e.steps === undefined || e.steps === ""
      ? null : (Number.isFinite(+e.steps) && +e.steps >= 0 ? +e.steps : null);
    const restingHr = e.restingHr === null || e.restingHr === undefined || e.restingHr === ""
      ? null : (Number.isFinite(+e.restingHr) && +e.restingHr > 0 ? +e.restingHr : null);
    if (steps === null && restingHr === null) continue;
    days.set(key, { key, steps, restingHr });
  }
  return days;
}

/**
 * Mean daily steps over the last `n` days that have a reading.
 *
 * Days with no steps logged are skipped, not counted as zero -- a fortnight
 * with four days logged is four days of evidence, not a light two weeks.
 */
export function meanSteps(days, n = 14, today = new Date()) {
  const cur = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const hit = days.get(dayKey(cur));
    if (hit && Number.isFinite(hit.steps)) { sum += hit.steps; count++; }
    cur.setDate(cur.getDate() - 1);
  }
  return count ? { mean: Math.round(sum / count), days: count } : null;
}
