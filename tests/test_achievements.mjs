/**
 * Achievements: badges at 10 / 100 / 500 / 1000 reps per movement, counted
 * over a LIFETIME even though the archive keeps only the last ARCHIVE_MAX
 * sessions -- dropped sessions go to a ledger first.
 *
 *   node tests/test_achievements.mjs
 */
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const P = await import("../src/profiles.js");
const A = await import("../src/achievements.js");
const { allSessions } = await import("../src/dashboard.js");

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

// --- pure --------------------------------------------------------------
const sess = (day, sets, profile = "Bas") => ({
  started: `2026-01-${String(day).padStart(2, "0")}T10:00:00.000Z`, profile,
  sets: sets.map(([activity, reps], i) => ({ index: i + 1, activity, reps,
    at: `2026-01-${String(day).padStart(2, "0")}T10:0${i}:00.000Z` })),
});
let list = A.achievements(A.repEvents([sess(1, [["squat", 6]]), sess(2, [["squat", 6], ["cmj", 3]])]));
const sq = list.find((a) => a.activity === "squat");
ok(sq.total === 12 && sq.earned === 1 && sq.next === 100, "12 squats: the 10 badge, next is 100", JSON.stringify(sq.tiers));
ok(sq.tiers[0].at === "2026-01-02T10:00:00.000Z", "dated by the set that crossed 10, not the first set");
ok(list[0].activity === "squat" && list[1].activity === "cmj", "movements in Movement-list order");
ok(list.find((a) => a.activity === "cmj").earned === 0, "3 jumps: nothing yet");
ok(A.achievements([]).length === 0, "no training, no rows");

const before = list;
const after = A.achievements(A.repEvents([sess(1, [["squat", 6]]), sess(2, [["squat", 6], ["cmj", 3]]),
                                          sess(3, [["squat", 90], ["cmj", 8]])]));
const got = A.newlyEarned(before, after).map((g) => `${g.activity}${g.n}`).sort();
ok(JSON.stringify(got) === JSON.stringify(["cmj10", "squat100"]), "newlyEarned names exactly the new badges", got.join(","));
ok(A.achievements(A.repEvents([sess(1, [["squat", 1200]])]))[0].next === null, "1200 in one set: all four, no next");

// --- lifetime through the archive cap ------------------------------------
for (let d = 1; d <= 60; d++) {
  P.newSession("Bas", new Date(Date.UTC(2026, 0, 1) + d * 864e5).toISOString());
  P.addSet({ activity: "squat", reps: Array.from({ length: 10 }, (_, i) => ({ rep: i + 1 })) }, 30, { profile: "Bas" });
  P.archiveSession();
}
const arch = P.listArchive(), ledger = P.listLedger();
ok(arch.length === 50 && ledger.length === 10, "60 sessions: 50 in the archive, 10 in the ledger", `${arch.length}/${ledger.length}`);
const total = () => A.achievements(A.repEvents(allSessions(P.listArchive(), P.getSession(), "Bas"),
                                               P.listLedger(), "Bas"))[0];
let t = total();
ok(t.total === 600 && t.earned === 3 && t.next === 1000, "600 squats counted, not 500", `${t.total}`);
ok(t.tiers[1].at === ledger[9].s, "the 100 badge keeps its date from a dropped session");

// Someone else's dropped sessions are not mine.
ok(A.repEvents([], [{ s: "x", p: "Ana", r: { squat: 999 } }], "Bas").length === 0, "ledger is per athlete");

// --- export / import -----------------------------------------------------
const file = JSON.parse(JSON.stringify(P.exportAll()));
ok(Array.isArray(file.ledger) && file.ledger.length === 10, "the export carries the ledger");
const rep = P.importAll(file);
t = total();
ok(rep.ledgerAdded === 0 && t.total === 600, "re-importing the same file changes nothing", `${t.total}`);

// A fresh device imports it and counts the same lifetime.
for (const k of Object.keys(store)) delete store[k];
P.importAll(file);
t = total();
ok(t.total === 600, "a new device counts the same 600", `${t.total}`);

// An old export that still has a now-dropped session in its archive: counted once.
const old = JSON.parse(JSON.stringify(file));
old.archive = [{ started: ledger[0].s, profile: "Bas", sets: [{ index: 1, activity: "squat", reps: 10, at: ledger[0].s }] }];
old.ledger = [];
P.importAll(old);
t = total();
ok(t.total === 600, "a session both in the ledger and imported back is counted once", `${t.total}`);

// --- removing a rep lowers the count -------------------------------------
for (const k of Object.keys(store)) delete store[k];
P.newSession("Bas");
const set = P.addSet({ activity: "squat", reps: Array.from({ length: 10 }, (_, i) => ({ rep: i + 1 })) }, 30, { profile: "Bas" });
ok(total().earned === 1, "10 squats: badge");
P.setRepRemoved(P.getSession().started, set.index, 3, true);
ok(total().earned === 0 && total().total === 9, "a rep taken out takes the badge back to 9/10");

if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed");
