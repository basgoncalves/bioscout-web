/**
 * sleep.js -- time in bed, which is the one number people can actually report.
 *
 * An entry is a bedtime, a wake time, and the day it is filed under. Duration
 * is derived rather than typed, because "23:15 to 07:00" is something someone
 * knows and "7 h 45" is something they estimate.
 *
 * The day a night belongs to is the morning it ended. Someone who goes to bed
 * at 01:30 on Saturday and wakes at 09:00 slept on Saturday, not partly on
 * Friday -- that is how people talk about it, and it is the only convention
 * under which "last night's sleep" lines up with "today's training".
 *
 * This does not score anyone, set a target, or call any duration good. It
 * records what was reported. Sleep advice from a phone that has measured
 * nothing is worth exactly what it costs.
 */

/** "23:15" -> 1395 minutes past midnight, or null if it is not a time. */
export function parseHM(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 1395 -> "23:15". */
export function toHM(mins) {
  if (!Number.isFinite(mins)) return "";
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Minutes asleep between two clock times.
 *
 * Bedtime is almost always the day before the wake time, so a wake time that
 * is earlier in the clock means the night crossed midnight and gets a day
 * added. The awkward case is a bedtime AFTER the wake time on the same
 * reading -- 23:00 to 22:00 -- which is 23 hours and is far more likely to be
 * a typo than a fact, so it is refused.
 */
export function duration(bed, wake) {
  const b = parseHM(bed), w = parseHM(wake);
  if (b === null || w === null) return null;
  const mins = w >= b ? w - b : 1440 - b + w;
  // Under 30 minutes is a nap mis-entered or two identical times; over 16
  // hours is not a night's sleep. Neither belongs in an average.
  if (mins < 30 || mins > 960) return null;
  return mins;
}

/** "7 h 45", or "7 h" on the hour. */
export function fmt(mins) {
  if (!Number.isFinite(mins)) return "";
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** Local calendar day of an ISO timestamp. */
export function dayKey(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One athlete's nights, keyed by the morning they ended on. */
export function collectSleep(entries, profile = null) {
  const days = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    const key = dayKey(e.at);
    if (!key) continue;
    days.set(key, { key, bed: e.bed, wake: e.wake, minutes: duration(e.bed, e.wake) });
  }
  return days;
}

/**
 * Mean sleep over the last `n` days that have an entry.
 *
 * Nights with no entry are skipped, not counted as zero, and the count comes
 * back with the mean so the caller can say what it rests on. A week with two
 * logged nights is two nights of evidence, not a bad week.
 */
export function meanSleep(days, n = 14, today = new Date()) {
  const cur = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const hit = days.get(dayKey(cur));
    if (hit && Number.isFinite(hit.minutes)) { sum += hit.minutes; count++; }
    cur.setDate(cur.getDate() - 1);
  }
  return count ? { mean: sum / count, nights: count } : null;
}
