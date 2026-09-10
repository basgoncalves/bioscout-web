/**
 * Sync-readiness: edits and deletions travel between devices through the
 * export file, by the same merge a server sync will use (syncmeta.js).
 *
 * Two devices are simulated by swapping the contents of one fake
 * localStorage -- profiles.js reads the store on every call.
 *
 *   node tests/test_syncmeta.mjs
 */
let store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const devices = { A: {}, B: {} };
const on = (d) => { store = devices[d]; };
const P = await import("../src/profiles.js");
const S = await import("../src/syncmeta.js");

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const tick = () => new Promise((r) => setTimeout(r, 3));   // a later millisecond
const file = () => JSON.parse(JSON.stringify(P.exportAll()));

// --- the merge rule itself ---------------------------------------------------
{
  const L = [{ at: "2026-09-01T07:00:00Z", profile: "bas", bed: "23:00", wake: "07:00", u: "2026-09-01T08:00:00Z" }];
  const newer = [{ ...L[0], wake: "06:30", u: "2026-09-01T09:00:00Z" }];
  const older = [{ ...L[0], wake: "08:00", u: "2026-09-01T07:30:00Z" }];
  ok(S.mergeRecords("sleep", L, newer).list[0].wake === "06:30", "a newer edit replaces");
  ok(S.mergeRecords("sleep", L, older).list[0].wake === "07:00", "an older copy does not");
  ok(S.mergeRecords("sleep", L, L.map((x) => ({ ...x }))).updated === 0, "a tie keeps local and counts nothing");
  const t = [{ k: "sleep", id: "bas|2026-09-01", at: "2026-09-01T08:30:00Z" }];
  ok(S.mergeRecords("sleep", L, [], t).list.length === 0, "a newer tombstone removes the local record");
  ok(S.mergeRecords("sleep", [], newer, t).list.length === 1, "a record written after the delete survives it");
  const legacy = [{ at: "2026-09-01T07:00:00Z", profile: "bas", bed: "1", wake: "2" }];
  ok(S.mergeRecords("sleep", legacy, [], t).list.length === 0, "a record from before stamps is older than any tombstone");
  ok(S.mergeTombs(t, [{ ...t[0], at: "2026-09-02T00:00:00Z" }])[0].at === "2026-09-02T00:00:00Z",
     "two tombstones for one record keep the later delete");
}

// --- A logs, B receives ------------------------------------------------------
on("A");
P.saveProfile({ name: "bas", heightM: 1.81 });
P.setSleep({ profile: "bas", at: "2026-09-09T07:00:00.000Z", bed: "23:00", wake: "07:00" });
const meal = P.addMeal({ profile: "bas", text: "oats", at: "2026-09-09T08:00:00.000Z" });
P.addWeight({ profile: "bas", kg: 83, at: "2026-09-09T07:05:00.000Z" });
P.newSession("bas", "2026-09-09T17:00:00.000Z");
P.addSet({ activity: "squat", reps: [1, 2, 3].map((rep) => ({ rep })) }, 30, { profile: "bas" });
P.archiveSession();
const fromA = file();
ok(Array.isArray(fromA.deleted), "the export carries deletions");
ok(fromA.meals[0].u && fromA.sleep[0].u && fromA.archive[0].u, "every record carries its last-write time");

on("B");
let r = P.importAll(fromA);
ok(r.mealsAdded === 1 && r.sleepAdded === 1 && r.sessionsAdded === 1 && r.profilesAdded === 1,
   "B takes everything A had", JSON.stringify(r));

// --- B edits and deletes, A receives ------------------------------------------
await tick();
P.setSleep({ profile: "bas", at: "2026-09-09T07:00:00.000Z", bed: "23:30", wake: "06:45" });
P.deleteMeal(meal.at, "bas");
P.saveProfile({ ...P.getProfile("bas"), heightM: 1.82 });
const fromB = file();

on("A");
r = P.importAll(fromB);
ok(P.listSleep()[0].wake === "06:45", "B's correction of the night reaches A");
ok(!P.listMeals().length, "B's deleted meal is deleted on A");
ok(P.getProfile("bas").heightM === 1.82, "B's profile edit reaches A");
ok(r.recordsUpdated >= 1 && r.recordsRemoved === 1, "the report says so", JSON.stringify(r));

on("B");
r = P.importAll(fromA);
ok(!P.listMeals().length, "A's older file does not bring the meal back to B");
ok(P.listSleep()[0].wake === "06:45", "nor revert the night");
ok(P.getProfile("bas").heightM === 1.82, "nor the profile");

// --- a session changed after it was shared ----------------------------------
on("A");
await tick();
const started = P.listArchive()[0].started;
// removing a rep needs a perRep entry with that rep number
const arch = P.listArchive();
ok(arch[0].sets[0].perRep.length === 3, "the set has three reps");
P.setRepRemoved(started, 1, 2, true);
const fromA2 = file();
on("B");
P.importAll(fromA2);
ok(P.listArchive()[0].sets[0].reps === 2, "a rep removed on A is removed on B");

// --- a profile deleted on one device --------------------------------------
on("B");
await tick();
P.saveProfile({ name: "guest" });
const fromB2 = file();
on("A"); P.importAll(fromB2);
ok(!!P.getProfile("guest"), "a new profile travels");
await tick();
P.deleteProfile("guest");
const fromA3 = file();
on("B"); P.importAll(fromA3);
ok(!P.getProfile("guest"), "and so does its deletion");

// --- drinks down to zero, cleared and re-logged ----------------------------
on("A");
P.setWater({ profile: "bas", at: "2026-09-09T12:00:00.000Z", glasses: 3 });
P.setWater({ profile: "bas", at: "2026-09-09T12:00:00.000Z", glasses: 0 });
P.setWater({ profile: "bas", at: "2026-09-09T12:00:00.000Z", glasses: 2 });   // same millisecond, likely
const fromA4 = file();
on("B"); P.importAll(fromA4);
ok(P.listWater().some((w) => w.glasses === 2), "cleared and re-logged at once: the new count is alive");

// --- cardio deleted stays deleted when the source is asked again ------------
on("A");
P.mergeCardio([{ id: "strava:1", at: "2026-09-08T06:00:00.000Z", profile: "bas", sport: "Run", seconds: 1800 }]);
P.deleteCardio("strava:1", "bas");
ok(P.mergeCardio([{ id: "strava:1", at: "2026-09-08T06:00:00.000Z", profile: "bas", sport: "Run", seconds: 1800 }]).added === 0,
   "a deleted Strava activity is not re-imported");

// --- an old export (no stamps, no deletions) still imports ------------------
on("B");
const old = { format: "bioscout-profile-export", version: 1,
  profiles: { profiles: [{ name: "old", heightM: 1.7 }], lastUsed: "old" },
  meals: [{ at: "2026-01-01T10:00:00.000Z", profile: "old", text: "rice" }] };
r = P.importAll(old);
ok(r.profilesAdded === 1 && r.mealsAdded === 1, "a file from before sync-readiness imports as before");
ok(P.importAll(old).mealsAdded === 0, "and a second time adds nothing");

if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed");
