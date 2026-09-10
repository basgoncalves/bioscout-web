/**
 * A session's `started` is its identity (archive, sync, curves). Sessions
 * opened from the calendar start at noon on their day, so two opened on the
 * same day -- two athletes on one phone, or one athlete twice -- used to share
 * it: the day view opened the other athlete's empty session, and the second
 * one was skipped by archiveSession as "already filed".
 *
 *   node tests/test_session_ids.mjs
 */
let store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const P = await import("../src/profiles.js");
let bad = 0;
const ok = (c, m, x = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${x ? "  " + x : ""}`); if (!c) bad++; };
const noon = "2026-09-10T10:00:00.000Z";
const set = (activity, n) => ({ activity, reps: Array.from({ length: n }, (_, i) => ({ rep: i + 1 })) });

P.newSession("Bas", noon);
P.addSet(set("pullup", 4), 30, { profile: "Bas" });
P.archiveSession();
const a = P.newSession("Gwen", noon);
ok(a.started !== noon && Math.abs(new Date(a.started) - new Date(noon)) < 5, "a second session on the same day gets its own identity", a.started);
P.addSet(set("squat", 5), 30, { profile: "Gwen" });
P.archiveSession();
const arch = P.listArchive();
ok(arch.length === 2 && arch.some((s) => s.profile === "Gwen" && s.sets.length === 1),
   "and is filed, not skipped as already filed", String(arch.length));

// A session opened before the fix, sharing the identity, is re-keyed at its first set.
store["bioscout.session.v1"] = JSON.stringify({ started: noon, profile: "Ana", sets: [], u: noon });
P.addSet(set("dip", 3), 30, { profile: "Ana" });
ok(P.getSession().started !== noon, "an old empty session with a taken identity is re-keyed at its first set", P.getSession().started);
P.archiveSession();
ok(P.listArchive().length === 3, "and filed too");
ok(P.uniqueStarted("not a date") === "not a date", "a malformed id is left alone");

if (bad) { console.log(`\n${bad} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed");
