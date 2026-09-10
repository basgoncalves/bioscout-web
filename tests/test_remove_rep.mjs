/**
 * Taking a wrongly tracked rep out of a set, and putting it back.
 *
 * What is pinned: the rep leaves the stored set (count, per-rep summaries,
 * trends) AND its stored curves; nothing is lost, so restoring gives back
 * exactly what was there; it works on a filed (archived) session as well as
 * the open one; and asking to move a rep that is not there changes nothing.
 *
 *   node tests/test_remove_rep.mjs
 */
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const P = await import("../src/profiles.js");

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

const mkRep = (n, depth) => ({
  rep: n, duration_s: 2, eccentric_s: 1, concentric_s: 1,
  knee_flex_max_deg: 90, hip_flex_max_deg: 80, depth_m: depth,
  times: [0, 0.5, 1], bounds: [0, 1, 2],
  coords: { knee_angle_r: [0, -45, -90] },
});
const result = (depths) => ({
  activity: "squat", osimModel: "gpk", massKg: 80, addedKg: 0, assistKg: 0,
  externalKg: 0, coverage: 1, pxPerM: 500, view: { view: "sagittal" }, fps: 30,
  reps: depths.map((d, i) => mkRep(i + 1, d)),
});

const sess = P.newSession("Bas", "2026-09-10T08:00:00.000Z");
const r1 = result([0.40, 0.41, 0.05, 0.42]);          // rep 3 is a tracking glitch
const set1 = P.addSet(r1, 30);
P.saveCurves(sess.started, set1.index, r1);
P.addSet(result([0.30, 0.31]), 30);

const before = P.summariseSession(P.getSession());
ok(before.total_reps === 6, "six reps before", String(before.total_reps));

const s = P.setRepRemoved(sess.started, 1, 3, true);
ok(s && s.reps === 3, "the set's count drops to three", String(s && s.reps));
const live = P.getSession();
ok(live.sets[0].perRep.map((r) => r.rep).join() === "1,2,4", "rep 3 is out of perRep",
   live.sets[0].perRep.map((r) => r.rep).join());
ok(live.sets[0].removedReps.map((r) => r.rep).join() === "3", "and kept in removedReps");
const c = P.getCurves(sess.started, 1);
ok(c.reps.length === 3 && c.removedReps.length === 1 && c.removedReps[0].rep === 3,
   "its curves move the same way");
const after = P.summariseSession(live);
ok(after.total_reps === 5, "session total follows", String(after.total_reps));
const d = after.trends.find((t) => t.key === "depth_m");
ok(d && Math.abs(d.first - 0.41) < 1e-9, "the trend no longer averages the glitch in",
   d && String(d.first));

ok(P.setRepRemoved(sess.started, 1, 3, true) === null, "removing it twice does nothing");
ok(P.setRepRemoved(sess.started, 1, 99, true) === null, "a rep that does not exist does nothing");
ok(P.setRepRemoved(sess.started, 7, 1, true) === null, "nor does a set that does not exist");

const back = P.setRepRemoved(sess.started, 1, 3, false);
ok(back && back.reps === 4 && back.perRep.map((r) => r.rep).join() === "1,2,3,4",
   "restoring puts it back in order", back && back.perRep.map((r) => r.rep).join());
ok(!("removedReps" in P.getSession().sets[0]), "and leaves no empty removedReps behind");
const c2 = P.getCurves(sess.started, 1);
ok(c2.reps.map((r) => r.rep).join() === "1,2,3,4" && !c2.removedReps,
   "the curves come back whole");
ok(c2.reps[2].depth_m === 0.05, "with the rep's own numbers");

/* Filed sessions too. */
P.setRepRemoved(sess.started, 2, 1, true);
P.archiveSession();
ok(!P.getSession(), "session filed");
const a = P.setRepRemoved(sess.started, 2, 2, true);
ok(a && a.reps === 0, "a rep can be removed from an archived session", String(a && a.reps));
const arch = P.listArchive().find((x) => x.started === sess.started);
ok(arch.sets[1].removedReps.length === 2 && arch.sets[1].perRep.length === 0,
   "and the archive keeps both removed reps");
ok(P.setRepRemoved(sess.started, 2, 1, false).reps === 1, "and restores in the archive");

/* A set saved with reps already removed keeps them. */
const s2 = P.newSession("Bas", "2026-09-11T08:00:00.000Z");
const r3 = result([0.4, 0.4]);
r3.removedReps = [mkRep(3, 0.1)];
P.addSet(r3, 30);
P.saveCurves(s2.started, 1, r3);
ok(P.getCurves(s2.started, 1).removedReps.length === 1, "saveCurves stores removedReps");

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
