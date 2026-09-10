/**
 * A full localStorage must not lose a set, or a session, quietly.
 *
 * The stored curves are the bulk of what the app keeps and the only part that
 * can be lost without losing a record. So when the quota refuses a session
 * write, the oldest curves go first; when even that cannot make room, addSet
 * throws (the page says so) instead of returning a set that is not in the log;
 * and archiving never clears a session it failed to file.
 *
 *   node tests/test_storage_full.mjs
 */
const store = {};
let QUOTA = Infinity;
const used = () => Object.entries(store).reduce((n, [k, v]) => n + k.length + v.length, 0);
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    const before = store[k];
    store[k] = String(v);
    if (used() > QUOTA) {
      if (before === undefined) delete store[k]; else store[k] = before;
      throw new Error("QuotaExceededError");
    }
  },
  removeItem: (k) => { delete store[k]; },
};
const P = await import("../src/profiles.js");

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

const big = (n) => Array.from({ length: n }, (_, i) => i / 7);
const result = (reps = 3) => ({
  activity: "squat", osimModel: "gpk", massKg: 80, addedKg: 0, assistKg: 0, externalKg: 0,
  coverage: 1, pxPerM: 500, view: { view: "sagittal" }, fps: 30,
  reps: Array.from({ length: reps }, (_, i) => ({
    rep: i + 1, duration_s: 2, eccentric_s: 1, concentric_s: 1, knee_flex_max_deg: 90,
    hip_flex_max_deg: 80, depth_m: 0.4, times: big(400), bounds: [0, 1, 2],
    coords: { knee_angle_r: big(400), hip_flexion_r: big(400) } })),
});

// Fill the store with curves from an old session, then cap the quota just
// above what is there.
const old = P.newSession("Bas", "2026-09-01T08:00:00.000Z");
for (let i = 1; i <= 6; i++) { P.addSet(result(), 30); P.saveCurves(old.started, i, result()); }
P.archiveSession();
QUOTA = used() + 300;

const s = P.newSession("Bas", "2026-09-10T08:00:00.000Z");
ok(P.getSession() && P.getSession().started === s.started, "a new session still starts on a full store");
let set = null, err = null;
try { set = P.addSet(result(), 30); } catch (e) { err = e; }
ok(set && !err, "a set is saved by making room", err ? err.message : "");
ok(P.getSession().sets.length === 1, "and it is in the log");
ok(P.curveIndices(old.started).length < 6, "the room came from the oldest curves",
   String(P.curveIndices(old.started).length));

// No room at all -- no curves left to drop: addSet says so rather than pretending.
delete store["bioscout.curves.v1"];
QUOTA = used() + 10;
let threw = false;
try { P.addSet(result(), 30); } catch { threw = true; }
ok(threw, "with no room left, addSet throws instead of losing the set quietly");
ok(P.getSession().sets.length === 1, "and the log is left as it was");

// Archiving a session that cannot be filed leaves it where it is.
const before = JSON.stringify(P.getSession());
const archBefore = P.listArchive().length;
QUOTA = used();                          // nothing can grow
store["bioscout.curves.v1"] && delete store["bioscout.curves.v1"];
QUOTA = used();
P.archiveSession();
const still = P.getSession();
ok(P.listArchive().length === archBefore + 1 || (still && JSON.stringify(still) === before),
   "a session is either filed or still open -- never gone");

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
