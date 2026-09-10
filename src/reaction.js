/**
 * reaction.js -- a simple visual reaction-time test, done with one finger.
 *
 * No camera. The pad goes from "wait" to green after a random pause, and the
 * athlete taps (or clicks, or presses Space) as fast as they can. Five counted
 * trials; the test reports the MEDIAN, because one slow blink in five would
 * drag a mean around and one lucky guess would make the best time meaningless
 * on its own.
 *
 * What is and is not being measured, said plainly on the page too: the time
 * includes the screen's delay in showing the green and the touchscreen's or
 * mouse's delay in reporting the tap -- often tens of milliseconds, and
 * different on every device. So a result is comparable with the athlete's own
 * earlier results ON THE SAME DEVICE AND INPUT, and not with a lab figure or
 * with someone else's phone. The input type is stored with every test for
 * exactly that reason.
 *
 * Pure: no DOM, no storage, so tests/test_reaction.mjs runs it in node.
 */

export const TRIALS = 5;
/* The random pause before green. Long enough and variable enough that it
 * cannot be timed by rhythm; not so long that attention drifts. */
export const FORE_MIN_MS = 1500, FORE_MAX_MS = 4000;
/* Under 100 ms nobody is reacting to the light -- that is a guess that
 * happened to land after it, and it counts as a false start. Over 1500 ms
 * nobody was paying attention, and the trial is repeated as missed. */
export const ANTICIPATION_MS = 100, SLOW_MS = 1500;

/** The pause before the next green, from a random number in [0, 1). */
export const foreperiod = (r = Math.random()) =>
  Math.round(FORE_MIN_MS + r * (FORE_MAX_MS - FORE_MIN_MS));

/** What a tap `rt` ms after green was: "ok", "early" (false start) or "slow". */
export function classify(rt) {
  if (!Number.isFinite(rt) || rt < ANTICIPATION_MS) return "early";
  if (rt > SLOW_MS) return "slow";
  return "ok";
}

/** Median, best, mean and SD of the counted trials (ms), or null for none. */
export function summarise(trials) {
  const v = (trials || []).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const n = v.length;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, median: Math.round(median), best: Math.round(v[0]), mean: Math.round(mean),
           sd: Math.round(sd) };
}

/** Local calendar day of an ISO time, as YYYY-MM-DD (same rule as the app). */
function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One athlete's tests grouped by day, each day's tests oldest first. */
export function collectReaction(entries, profile = null) {
  const days = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    const key = dayKey(e.at);
    const s = summarise(e.trials);
    if (!key || !s) continue;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push({ ...e, ...s });
  }
  for (const list of days.values()) list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return days;
}

/**
 * The athlete's usual time: the median of each test's median over the last
 * `n` days, on the given input only (touch against touch, mouse against
 * mouse). Null when there is nothing to compare with.
 */
export function reactionTrend(entries, input, n = 30, today = new Date()) {
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n + 1).getTime();
  const meds = (entries || [])
    .filter((e) => (!input || e.input === input) && new Date(e.at).getTime() >= from)
    .map((e) => summarise(e.trials)?.median).filter(Number.isFinite);
  const s = summarise(meds);
  return s ? { median: s.median, tests: s.n } : null;
}
