/**
 * trainsummary.js -- the training summary charts: what the last week or month
 * of training looked like, one question at a time.
 *
 *   time       when in the day you train (a smoothed curve over 24 h)
 *   intensity  how heavy the sets were, as a multiple of body weight
 *   weekday    how much was done on each day of the week
 *   movements  which movements the work went into
 *   rest       how many days you usually leave between training days
 *   (weight    the body-weight timeline -- same menu, drawn by dashboard.js)
 *
 * Everything here is counting and smoothing of what was logged -- nothing is
 * estimated. Each chart says what it is made of ("from 14 sets") so a curve
 * drawn through three sets is not read like one drawn through thirty.
 *
 * Pure: takes collectDays()'s map, returns numbers; dashboard.js draws them.
 */

/* "weight" is drawn from the weigh-ins (weight.js), not from here; it is in
 * the list because it is picked from the same menu. */
export const SUMMARY_CHARTS = ["weight", "time", "intensity", "weekday", "movements", "rest"];
export const SUMMARY_WINDOWS = { week: 7, month: 30, year: 365 };

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The training days inside the last `n` days up to and including `today`. */
export function windowDays(days, n, today = new Date()) {
  const out = [];
  const cur = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (let i = 0; i < n; i++) {
    const d = days.get(keyOf(cur));
    if (d) out.push(d);
    cur.setDate(cur.getDate() - 1);
  }
  return out.reverse();
}

/** Local clock time of an ISO timestamp, in hours (14.5 = 14:30), or null. */
function hourOf(iso) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.getHours() + t.getMinutes() / 60;
}

/**
 * When in the day: one point per set (at its recording time) and one per
 * cardio activity, smoothed with a Gaussian that wraps around midnight -- a
 * 23:30 session and a 00:30 one are an hour apart, not twenty-three.
 * Returns `curve` (96 points, one per 15 min, peak = 1), the `peak` hour and
 * how many points it rests on.
 */
export function timeOfDay(list, { bandwidthH = 0.75, steps = 96 } = {}) {
  const hours = [];
  for (const d of list) {
    for (const s of d.sets || []) { const h = hourOf(s.at); if (h !== null) hours.push(h); }
    for (const c of d.cardio || []) { const h = hourOf(c.at); if (h !== null) hours.push(h); }
  }
  if (!hours.length) return { n: 0, curve: [], peak: null };
  const curve = [];
  for (let i = 0; i < steps; i++) {
    const x = (24 * i) / steps;
    let v = 0;
    for (const h of hours) {
      let dx = Math.abs(x - h);
      dx = Math.min(dx, 24 - dx);                         // around the clock
      v += Math.exp(-0.5 * (dx / bandwidthH) ** 2);
    }
    curve.push(v);
  }
  const max = Math.max(...curve);
  const peakI = curve.indexOf(max);
  return { n: hours.length, curve: curve.map((v) => v / max), peak: (24 * peakI) / steps };
}

/**
 * How heavy: each set's total load as a multiple of body weight -- body plus
 * added load minus assistance. A bodyweight push-up is 1.0x, a squat with a
 * bar of your own weight 2.0x, a band-assisted pull-up below 1. Sets without a
 * body mass cannot be placed and are left out (and counted as such).
 * Bins of 0.1x from 0 to 3x; anything above goes in the last bin.
 */
export function intensity(list, { binW = 0.1, maxX = 3 } = {}) {
  const nb = Math.round(maxX / binW);
  const bins = new Array(nb).fill(0);
  let n = 0, skipped = 0, sum = 0;
  for (const d of list) {
    for (const s of d.sets || []) {
      const m = Number(s.massKg);
      if (!(m > 0)) { skipped++; continue; }
      const x = (m + (Number(s.addedKg) || 0) - (Number(s.assistKg) || 0)) / m;
      if (!Number.isFinite(x) || x < 0) { skipped++; continue; }
      bins[Math.min(nb - 1, Math.floor(x / binW + 1e-9))]++;
      n++; sum += x;
    }
  }
  return { n, skipped, bins, binW, maxX, mean: n ? sum / n : null };
}

/** Reps and sets per day of the week, Monday first. */
export function weekdayVolume(list) {
  const reps = new Array(7).fill(0), sets = new Array(7).fill(0), minutes = new Array(7).fill(0);
  for (const d of list) {
    const [y, m, dd] = d.key.split("-").map(Number);
    const w = (new Date(y, m - 1, dd).getDay() + 6) % 7;   // Monday = 0
    for (const s of d.sets || []) { reps[w] += s.reps || 0; sets[w]++; }
    minutes[w] += Math.round((d.cardioSeconds || 0) / 60);
  }
  return { reps, sets, minutes };
}

/** Reps and sets per movement, biggest first. */
export function movementMix(list) {
  const by = new Map();
  for (const d of list) {
    for (const s of d.sets || []) {
      if (!s.activity) continue;
      const r = by.get(s.activity) || { activity: s.activity, reps: 0, sets: 0 };
      r.reps += s.reps || 0; r.sets++;
      by.set(s.activity, r);
    }
  }
  return [...by.values()].sort((a, b) => b.reps - a.reps || b.sets - a.sets);
}

/**
 * Days between consecutive training days in the window: 1 = the next day,
 * 2 = one rest day between, and so on (7+ in the last bin). The first training
 * day in the window is measured from the one before it, when there is one.
 */
export function restGaps(days, n, today = new Date()) {
  const all = [...days.keys()].sort();
  const cur = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const from = new Date(cur); from.setDate(from.getDate() - n + 1);
  const lo = keyOf(from), hi = keyOf(cur);
  const inWin = all.filter((k) => k >= lo && k <= hi);
  const before = all.filter((k) => k < lo).pop();
  const seq = before ? [before, ...inWin] : inWin;
  const bins = new Array(7).fill(0);                    // 1..6, 7+
  const toDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  let sum = 0, count = 0;
  for (let i = 1; i < seq.length; i++) {
    const gap = Math.round((toDate(seq[i]) - toDate(seq[i - 1])) / 86400000);
    if (gap < 1) continue;
    bins[Math.min(7, gap) - 1]++;
    sum += gap; count++;
  }
  return { bins, n: count, mean: count ? sum / count : null, days: inWin.length };
}
