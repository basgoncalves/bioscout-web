/**
 * achievements.js -- milestones for the reps an athlete has done of each task.
 *
 * One badge per movement at 10, 100, 500 and 1000 reps. That is the whole
 * scheme: a count of work actually recorded, per task, per athlete. Nothing
 * here grades the reps or the athlete -- a badge says "you have done this
 * many", which the app can know, and never "you are good at this", which it
 * cannot.
 *
 * The count has to be LIFETIME, and the archive is not: profiles.js keeps the
 * last ARCHIVE_MAX sessions and drops older ones. Every session it drops is
 * written to a small ledger first (started, profile, reps per task), so a
 * thousand squats stay a thousand squats after the sessions that held them
 * are gone. The totals are therefore ledger + archive + the open session,
 * deduplicated on `started` -- the session's identity everywhere else too.
 *
 * Badges are derived, not stored. A rep taken out of a set (setRepRemoved)
 * lowers the count, and if that takes a task back under a milestone the badge
 * goes with it: it was earned by a rep that, on second look, was not one.
 * The date shown is when the running total crossed the line -- the set's own
 * time, or the session's day for reps that now live only in the ledger.
 *
 * Pure functions, no DOM and no storage, so test_achievements.mjs can run
 * them in node.
 */

export const MILESTONES = [10, 100, 500, 1000];

/* The order the Movement list uses. A task not listed here (a movement added
 * later) still gets its badges, after these. */
export const TASK_ORDER = ["squat", "slsquat", "pullup", "dip", "pushup", "kickback", "heelraise",
  "cmj", "sj", "jumpshot", "sidestep", "run", "walk", "neck"];

/**
 * One event per (set, task): when, which task, how many reps. Oldest first.
 *
 * `sessions` are that athlete's archive + open session (dashboard
 * allSessions); `ledger` is profiles.js's record of dropped sessions, which is
 * device-wide and filtered here. A ledger entry whose session is still in the
 * archive is skipped -- it can be, after an import brings an old session back.
 */
export function repEvents(sessions, ledger = [], profile = null) {
  const out = [];
  const live = new Set();
  for (const s of sessions || []) {
    if (!s || !Array.isArray(s.sets)) continue;
    live.add(s.started);
    for (const set of s.sets) {
      const n = +set.reps || 0;
      if (!set.activity || n <= 0) continue;
      out.push({ at: set.at || s.started, activity: set.activity, reps: n });
    }
  }
  for (const e of ledger || []) {
    if (!e || !e.s || live.has(e.s)) continue;
    if (profile !== null && e.p !== profile) continue;
    for (const [activity, n] of Object.entries(e.r || {})) {
      if (+n > 0) out.push({ at: e.s, activity, reps: +n });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * Per task: the total, each milestone with the moment it was crossed (null if
 * not yet), and the next one to aim for (null once all four are in).
 * Only tasks with at least one rep are listed.
 */
export function achievements(events) {
  const by = new Map();
  for (const e of events || []) {
    let a = by.get(e.activity);
    if (!a) by.set(e.activity, a = { activity: e.activity, total: 0,
                                     tiers: MILESTONES.map((n) => ({ n, at: null })) });
    const before = a.total;
    a.total += e.reps;
    for (const t of a.tiers) if (before < t.n && a.total >= t.n) t.at = e.at;
  }
  const rank = (k) => { const i = TASK_ORDER.indexOf(k); return i < 0 ? TASK_ORDER.length : i; };
  return [...by.values()]
    .map((a) => ({ ...a, earned: a.tiers.filter((t) => t.at).length,
                   next: (a.tiers.find((t) => !t.at) || { n: null }).n }))
    .sort((x, y) => rank(x.activity) - rank(y.activity) || x.activity.localeCompare(y.activity));
}

/** Badges in `after` that `before` did not have: [{activity, n}]. For the
 *  "unlocked" note after a set is saved. */
export function newlyEarned(before, after) {
  const had = new Set();
  for (const a of before || []) for (const t of a.tiers) if (t.at) had.add(`${a.activity}|${t.n}`);
  const out = [];
  for (const a of after || []) {
    for (const t of a.tiers) if (t.at && !had.has(`${a.activity}|${t.n}`)) out.push({ activity: a.activity, n: t.n });
  }
  return out;
}

/** How many of all possible badges (tasks done x 4) are in. */
export function badgeCount(list) {
  return (list || []).reduce((n, a) => n + a.earned, 0);
}

/** Reps per task in one session: the ledger's summary of a dropped session. */
export function sessionReps(s) {
  const r = {};
  for (const set of (s && s.sets) || []) {
    const n = +set.reps || 0;
    if (set.activity && n > 0) r[set.activity] = (r[set.activity] || 0) + n;
  }
  return r;
}

/* Gait tasks count strides (one per cycle of the driving foot), everything
 * else reps. `tr` is passed in so this file stays free of the i18n import. */
const STRIDE_TASKS = ["run", "walk"];
export function repUnit(n, activity, tr) {
  const stride = STRIDE_TASKS.includes(activity);
  return tr(n === 1 ? (stride ? "nStride" : "nRep") : (stride ? "nStrides" : "nRepsCount"), { n });
}
