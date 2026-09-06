/**
 * cycle.js -- menstrual cycle tracking.
 *
 * What is stored is one record per logged day: flow, and any symptoms. Cycles
 * themselves are DERIVED from those days rather than entered, because asking
 * someone to declare "this is day 1 of a new cycle" is asking them to do the
 * arithmetic the app is for. A run of consecutive logged days is a period; the
 * first day of a run is a cycle start; the gap between starts is a cycle
 * length.
 *
 * Two things this deliberately will not do.
 *
 * It will not predict from one cycle. A single observed length is a sample of
 * one, and a date drawn from it looks exactly as confident on screen as a date
 * drawn from a year of data. Below three lengths the app says how many it has
 * and stops there.
 *
 * It will not present a prediction as a fact. Cycle length varies by several
 * days in most people, so a bare date is a claim the data does not support --
 * every prediction carries the spread it came from. Nothing here is a
 * contraceptive method and the UI says so.
 *
 * Why it sits in a biomechanics app at all: cycle phase is a live question in
 * this literature, from tendon and ligament stiffness to injury risk, and a
 * training calendar that cannot show it makes that question impossible to
 * look at. Nothing here interprets it. It records what happened next to what
 * was trained, and leaves the reading to whoever is qualified to do it.
 */

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. */
export function dayKey(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Flow is ordinal and coarse on purpose: finer scales do not get used
 *  consistently, and inconsistent data is worse than blunt data. */
export const FLOWS = [
  { v: 1, key: "flowSpotting" },
  { v: 2, key: "flowLight" },
  { v: 3, key: "flowMedium" },
  { v: 4, key: "flowHeavy" },
];

export const DEFAULT_SYMPTOMS = [
  "cramps", "headache", "backPain", "bloating", "fatigue", "moodSwings", "nausea",
];

const dayMs = 86400000;
const toUTC = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);          // noon, so a clock change cannot shift it
};
export const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / dayMs);
export const shiftDay = (key, n) => dayKey(new Date(toUTC(key) + n * dayMs));

/** One athlete's logged days, keyed by local day. */
export function collectCycle(entries, profile = null) {
  const days = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    const key = dayKey(e.at);
    if (!key) continue;
    days.set(key, { key, flow: e.flow ?? null, symptoms: e.symptoms || [], at: e.at });
  }
  return days;
}

/**
 * First day of each run of consecutive logged days, oldest first.
 *
 * A gap of a single day inside a period is common -- light days get missed,
 * or simply not logged -- and treating it as the end of one cycle and the
 * start of another would halve every length. So a run continues across one
 * blank day, and only two or more blanks end it.
 */
export function cycleStarts(days) {
  const keys = [...days.keys()].sort();
  const starts = [];
  let prev = null;
  for (const k of keys) {
    if (prev === null || daysBetween(prev, k) > 2) starts.push(k);
    prev = k;
  }
  return starts;
}

/** Days between consecutive starts. */
export function cycleLengths(starts) {
  const out = [];
  for (let i = 1; i < starts.length; i++) out.push(daysBetween(starts[i - 1], starts[i]));
  // A "cycle" of under 10 days is two periods logged close together, or a
  // mis-entry; over 90 is a gap in logging rather than a cycle. Neither is
  // evidence about length, so neither belongs in the average.
  return out.filter((n) => n >= 10 && n <= 90);
}

/** Mean and spread of the observed lengths, or null if there are none. */
export function lengthStats(lengths) {
  if (!lengths.length) return null;
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const sd = lengths.length > 1
    ? Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / (lengths.length - 1))
    : null;
  return { mean, sd, n: lengths.length, min: Math.min(...lengths), max: Math.max(...lengths) };
}

/**
 * When the next period would be due, with the spread it rests on.
 *
 * Null below three observed lengths. Two points give you a mean with no way to
 * know whether it means anything, and a date on a calendar carries far more
 * authority than the evidence behind it.
 */
export function predictNext(starts, today = new Date()) {
  const lengths = cycleLengths(starts);
  const stats = lengthStats(lengths);
  if (!stats || stats.n < 3) return null;
  const last = starts[starts.length - 1];
  const due = shiftDay(last, Math.round(stats.mean));
  return {
    due,
    // Rounded up so the window is not narrower than the data: half a day of
    // false precision either side is exactly the kind of thing that gets read
    // as certainty.
    spread: Math.max(1, Math.ceil(stats.sd ?? 2)),
    from: last,
    stats,
    overdue: daysBetween(due, dayKey(today)),
  };
}

/**
 * How long each period ran, in days.
 *
 * Counted as logged days within a run rather than first-to-last, so the single
 * unlogged day that cycleStarts() tolerates does not inflate the figure.
 */
export function periodLengths(days) {
  const keys = [...days.keys()].sort();
  const runs = [];
  let n = 0, prev = null;
  for (const k of keys) {
    if (prev !== null && daysBetween(prev, k) > 2) { runs.push(n); n = 0; }
    n++; prev = k;
  }
  if (n) runs.push(n);
  return runs;
}

/* The luteal phase -- ovulation to the next period -- is the stable part of a
 * cycle, near enough 14 days in most people whatever the total length. The
 * follicular phase is what varies. So ovulation is estimated backwards from
 * the NEXT period rather than forwards from the last one, which is the
 * standard convention and the less wrong of the two.
 *
 * It is still an estimate from counting, not a measurement. Without
 * temperature or an LH test this is arithmetic, and it can be several days
 * out in a cycle that behaves normally. The UI says so; nothing here should
 * be read as a fertile-window guarantee in either direction. */
export const LUTEAL_DAYS = 14;

/**
 * The shape of a typical cycle for this athlete, or null.
 *
 * Null below three observed lengths, for the same reason predictNext() is:
 * a ring drawn from two cycles looks exactly as authoritative as one drawn
 * from twenty.
 */
export function phaseModel(days) {
  const starts = cycleStarts(days);
  const lengths = cycleLengths(starts);
  const stats = lengthStats(lengths);
  if (!stats || stats.n < 3) return null;

  const cycle = Math.round(stats.mean);
  const periods = periodLengths(days);
  const period = periods.length
    ? Math.max(1, Math.round(periods.reduce((a, b) => a + b, 0) / periods.length))
    : 5;

  // A very short cycle would put ovulation on or before the period itself,
  // which is not a thing to draw. Below that, the phase split is not
  // meaningful and only the period is shown.
  const ovulation = cycle - LUTEAL_DAYS;
  const usable = ovulation > period + 1;

  return {
    cycle,
    period: Math.min(period, cycle),
    ovulation: usable ? ovulation : null,
    // Sperm survive a few days; the egg does not. Hence the window sits
    // mostly before ovulation rather than around it.
    fertile: usable
      ? { from: Math.max(period + 1, ovulation - 5), to: Math.min(cycle, ovulation + 1) }
      : null,
    stats,
    starts,
  };
}

/**
 * Which day of the cycle `key` falls on, counting the first logged day as 1.
 *
 * Null before the first record and after a gap long enough that the count
 * would be fiction -- a "day 240" is not a cycle day, it is a missing year.
 */
export function dayOfCycle(starts, key) {
  let start = null;
  for (const s of starts) { if (s <= key) start = s; else break; }
  if (!start) return null;
  const n = daysBetween(start, key) + 1;
  return n > 90 ? null : n;
}
