/**
 * plans.js -- training planned for a day, and how much of it got done.
 *
 * A plan is a list of movements with sets x reps (and an optional added load)
 * for one day, plus a note. Days after today can only be planned, not
 * recorded; today and earlier show the plan next to what was actually done.
 *
 * "Done" is counted from the day's recorded sets of the same movement,
 * whichever session they are in -- a plan does not own sessions, and a set of
 * push-ups done in the evening still counts toward the morning's plan.
 *
 * Pure: storage is profiles.js (bioscout.plans.v1), drawing is dashboard.js.
 */

export const PLAN_ITEMS_MAX = 12;
const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

/** A plan as stored: numbers clamped, empty rows dropped. Null if nothing
 *  would be left to plan. */
export function normalizePlan(p, { activities = null } = {}) {
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.day || ""))) return null;
  const items = (Array.isArray(p.items) ? p.items : [])
    .filter((it) => it && it.activity && (!activities || activities.includes(it.activity)))
    .slice(0, PLAN_ITEMS_MAX)
    .map((it) => {
      const kg = Number(it.kg);
      return {
        activity: String(it.activity).slice(0, 40),
        sets: int(it.sets, 1, 20, 3),
        reps: int(it.reps, 1, 200, 10),
        kg: Number.isFinite(kg) && kg > 0 ? Math.round(Math.min(kg, 500) * 2) / 2 : 0,
      };
    });
  const note = String(p.note || "").slice(0, 300);
  if (!items.length && !note.trim()) return null;
  return {
    id: String(p.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`),
    profile: p.profile ?? null,
    day: p.day,
    // The day at noon: syncmeta wants every record to carry an `at`.
    at: `${p.day}T12:00:00.000Z`,
    sport: p.sport ? String(p.sport).slice(0, 20) : null,
    items,
    note,
  };
}

/** The plans for one day, oldest first. */
export function plansOn(plans, day) {
  return (plans || []).filter((p) => p && p.day === day)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Days in `plans` (a Set of "YYYY-MM-DD"). */
export const plannedDays = (plans) => new Set((plans || []).map((p) => p && p.day).filter(Boolean));

/**
 * Planned against done, per item. `sets` are that day's recorded sets
 * ({activity, reps}). When a day has two plans with the same movement the
 * done sets are shared out in plan order, so one set is not counted twice.
 */
export function planProgress(plans, sets) {
  const pool = new Map();
  for (const s of sets || []) {
    if (!s || !s.activity) continue;
    if (!pool.has(s.activity)) pool.set(s.activity, []);
    pool.get(s.activity).push(s.reps || 0);
  }
  return (plans || []).map((p) => {
    const items = p.items.map((it) => {
      const got = pool.get(it.activity) || [];
      const mine = got.splice(0, it.sets);
      const doneSets = mine.length, doneReps = mine.reduce((a, b) => a + b, 0);
      return { ...it, doneSets, doneReps, complete: doneSets >= it.sets };
    });
    const planned = items.reduce((a, b) => a + b.sets, 0);
    const done = items.reduce((a, b) => a + Math.min(b.doneSets, b.sets), 0);
    return { ...p, items, planned, done, complete: planned > 0 && done >= planned };
  });
}

/** The first movement of today's plans that still has sets to do. */
export function nextPlanned(progress) {
  for (const p of progress || []) for (const it of p.items) if (!it.complete) return it;
  return null;
}
