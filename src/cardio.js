/**
 * cardio.js -- endurance sessions, which are a different animal from sets.
 *
 * A training session in this app is reps: a set of squats, counted from video,
 * with joint angles behind every one of them. A 40-minute run has no reps and
 * never will, and pretending otherwise -- filing it as a session with one set
 * of one rep -- would corrupt every rep total and volume bar in the app.
 *
 * So cardio is its own record, and the dashboard folds it into the SAME
 * training day rather than giving it a calendar of its own. That is the
 * honest arrangement: the day you ran and the day you squatted are both
 * training days, but a run is described in minutes and kilometres, not reps
 * and load.
 *
 * Nothing here is measured by this app. These numbers come from a watch, via
 * whatever source imported them, and the app's job is to record them
 * faithfully and say where they came from -- not to recompute or improve them.
 */

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. */
export function dayKey(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * One athlete's cardio, bucketed by local day.
 *
 * A day can hold several: a commute ride and an evening run are two
 * activities on one day, not one merged blob, so `items` is a list and the
 * totals are alongside it rather than instead of it.
 */
export function collectCardio(entries, profile = null) {
  const days = new Map();
  for (const c of entries || []) {
    if (profile && c.profile !== profile) continue;
    const key = dayKey(c.at);
    if (!key) continue;
    if (!days.has(key)) {
      days.set(key, { key, items: [], seconds: 0, metres: 0, sports: new Set() });
    }
    const d = days.get(key);
    d.items.push(c);
    d.seconds += Number.isFinite(+c.seconds) ? +c.seconds : 0;
    d.metres += Number.isFinite(+c.metres) ? +c.metres : 0;
    if (c.sport) d.sports.add(c.sport);
  }
  for (const d of days.values()) {
    d.items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  return days;
}

/** "42 min", or "1 h 12" once it passes the hour. Seconds are noise here: no
 *  one reports a run to the second, and showing them implies a precision the
 *  watch's auto-pause already broke. */
export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** "8.12 km", or metres under a kilometre. Two decimals because a tenth of a
 *  kilometre is 100 m, which is a visible chunk of a short run. */
export function fmtDistance(metres) {
  if (!Number.isFinite(metres) || metres <= 0) return "";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

/**
 * Pace as min/km, the unit runners actually think in.
 *
 * Returns null for anything that has no distance -- a rowing machine or a
 * gym class has a duration and no metres, and "Infinity/km" is not a pace.
 */
export function pace(seconds, metres) {
  if (!Number.isFinite(seconds) || !Number.isFinite(metres) || metres < 100 || seconds <= 0) {
    return null;
  }
  const secPerKm = seconds / (metres / 1000);
  const m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
  // 4:60/km is not a thing; rounding the seconds up has to carry.
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
}
