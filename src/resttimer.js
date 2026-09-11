/**
 * resttimer.js -- the rest countdown between sets.
 *
 * A countdown, nothing saved: pick 30 s to 3 min, it counts down, and at zero
 * the page beeps and the phone buzzes. It keeps the END time rather than
 * ticking a counter down, so a phone that throttles the page while the screen
 * is off, or a tab in the background, still finishes on time -- the next
 * tick simply reads a later clock.
 *
 * Pure: the page (index.html) owns the clock, the sound and the buttons.
 */

export const REST_PRESETS = [30, 60, 90, 120, 180];
export const REST_DEFAULT = 90;
export const REST_MIN = 5, REST_MAX = 15 * 60;

const clampS = (s) => Math.max(REST_MIN, Math.min(REST_MAX, Math.round(+s || REST_DEFAULT)));

/** A stopped timer set to `durS` seconds. */
export function restTimer(durS = REST_DEFAULT) {
  const d = clampS(durS);
  return { durS: d, endAt: null, leftS: d };
}

/** Seconds left at `now` (ms), never below zero. */
export function restLeft(t, now) {
  if (t.endAt == null) return t.leftS;
  return Math.max(0, (t.endAt - now) / 1000);
}

export const restRunning = (t) => t.endAt != null;

/** Start, or resume from a pause. A finished timer starts again from the top. */
export function restStart(t, now) {
  const left = t.leftS > 0 ? t.leftS : t.durS;
  return { ...t, endAt: now + left * 1000, leftS: left };
}

export function restPause(t, now) {
  if (t.endAt == null) return t;
  return { ...t, endAt: null, leftS: restLeft(t, now) };
}

/** Back to the full duration, stopped. */
export const restReset = (t) => ({ ...t, endAt: null, leftS: t.durS });

/** A new duration: stops and resets to it. */
export const restSet = (t, durS) => restTimer(durS);

/** +/- seconds on the time left (running or not); the duration follows when
 *  stopped at the top, so "+15" before starting makes it a 1:45 timer. */
export function restAdd(t, deltaS, now) {
  // Never below a few seconds: -15 on a nearly finished timer should leave
  // it nearly finished, not wrap round to a fresh one.
  const left = Math.max(Math.min(REST_MIN, restLeft(t, now)), restLeft(t, now) + deltaS);
  if (t.endAt != null) return { ...t, endAt: now + left * 1000, leftS: left };
  if (t.leftS === t.durS) { const d = clampS(t.durS + deltaS); return { durS: d, endAt: null, leftS: d }; }
  return { ...t, leftS: Math.min(REST_MAX, left) };
}

/** "1:30", "0:05", "12:00". Rounded UP, so it reads 0:01 until it is over. */
export function fmtClock(s) {
  const v = Math.max(0, Math.ceil(s - 1e-9));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}
