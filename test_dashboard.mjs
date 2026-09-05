/**
 * The dashboard's arithmetic, with no DOM.
 *
 * What is worth testing here is not the markup, it is the bucketing: local
 * days out of UTC timestamps, month grids that have to stay rectangular across
 * leap years and Monday-start weeks, and a streak that must survive the fact
 * that today has usually not been trained yet at the time you look.
 *
 *   node test_dashboard.mjs
 *
 * TZ matters, so the timezone-sensitive checks run under an explicit one
 * rather than whatever the machine happens to be set to.
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
Object.defineProperty(globalThis, "navigator",
  { value: { languages: ["en"] }, configurable: true });

const { dayKey, allSessions, collectDays, streak, overall, monthMatrix, weeklyVolume } =
  await import("./dashboard.js");

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/* ---- local days, not string slices ------------------------------------ */

// Vienna is UTC+2 in August. 23:30Z is half past one the NEXT morning locally,
// and slicing the ISO string would file it a day early.
ok(dayKey("2026-08-14T23:30:00.000Z") === "2026-08-15",
   "late-evening UTC lands on the local day", dayKey("2026-08-14T23:30:00.000Z"));
ok(dayKey("2026-08-15T06:00:00.000Z") === "2026-08-15",
   "morning session lands on the same day");
ok(dayKey("nonsense") === null, "an unparseable timestamp is dropped, not guessed");

/* ---- sets, not sessions, decide the day ------------------------------- */

const session = (started, sets) => ({ started, profile: "A", sets });
const set = (i, at, activity, reps) => ({ index: i, at, activity, reps });

// One session that runs through local midnight is two days of training.
const overnight = [session("2026-08-14T21:00:00.000Z", [
  set(1, "2026-08-14T21:00:00.000Z", "squat", 5),      // 23:00 local, the 14th
  set(2, "2026-08-14T22:30:00.000Z", "squat", 5),      // 00:30 local, the 15th
])];
{
  const d = collectDays(overnight);
  ok(d.size === 2, "a session spanning midnight is two calendar days", `${d.size}`);
  ok(d.get("2026-08-14")?.reps === 5 && d.get("2026-08-15")?.reps === 5,
     "and its reps land on the day they were done");
}

/* ---- the open session is included ------------------------------------- */
{
  const archive = [session("2026-08-01T09:00:00.000Z", [set(1, "2026-08-01T09:00:00.000Z", "squat", 3)])];
  const open = session("2026-08-20T09:00:00.000Z", [set(1, "2026-08-20T09:00:00.000Z", "pullup", 4)]);
  ok(allSessions(archive, open).length === 2, "the session still open appears in history");
  ok(allSessions(archive, { started: "x", sets: [] }).length === 1,
     "an empty open session is not training that happened");
  ok(allSessions(archive, archive[0]).length === 1,
     "an open session already in the archive is not counted twice");
}

/* ---- totals ----------------------------------------------------------- */
{
  const s = [
    session("2026-08-01T09:00:00.000Z", [
      set(1, "2026-08-01T09:00:00.000Z", "squat", 5),
      set(2, "2026-08-01T09:20:00.000Z", "squat", 5)]),
    session("2026-08-03T09:00:00.000Z", [set(1, "2026-08-03T09:00:00.000Z", "cmj", 3)]),
  ];
  const o = overall(collectDays(s), new Date("2026-08-05T10:00:00.000Z"));
  ok(o.days === 2 && o.sessions === 2 && o.sets === 3 && o.reps === 13,
     "totals count days, sessions, sets and reps",
     `${o.days}d ${o.sessions}s ${o.sets}sets ${o.reps}reps`);
  ok(o.first === "2026-08-01" && o.last === "2026-08-03", "first and last day");
}

/* ---- streak ----------------------------------------------------------- */
{
  const mk = (...keys) => new Map(keys.map((k) => [k, { reps: 1, sets: [], sessions: new Set() }]));
  const today = new Date(2026, 7, 20, 10, 0);           // 20 Aug 2026, local

  ok(streak(mk("2026-08-18", "2026-08-19", "2026-08-20"), today) === 3,
     "three days up to and including today");
  // The common case: it is 10am and today's session has not happened yet.
  ok(streak(mk("2026-08-18", "2026-08-19"), today) === 2,
     "a streak ending yesterday still counts this morning");
  ok(streak(mk("2026-08-17"), today) === 0,
     "a gap of two days ends the streak");
  ok(streak(new Map(), today) === 0, "no training is no streak");
}

/* ---- month grid ------------------------------------------------------- */
{
  // September 2026 starts on a Tuesday, so the first row has one leading day.
  const w = monthMatrix(2026, 8);
  ok(w.every((row) => row.length === 7), "every week has seven days");
  ok(w[0][0].key === "2026-08-31", "the grid is Monday-first and pads from the previous month",
     w[0][0].key);
  ok(w.flat().filter((c) => c.inMonth).length === 30, "September has 30 days in the month");

  const feb = monthMatrix(2024, 1);                     // leap year
  ok(feb.flat().filter((c) => c.inMonth).length === 29, "February 2024 has 29");

  // A month that begins on a Monday and fills its rows exactly must not get a
  // trailing empty week.
  const jun = monthMatrix(2026, 5);                     // 1 June 2026 is a Monday
  ok(jun.length === 5 && jun[0][0].key === "2026-06-01",
     "a month starting on Monday gets no phantom leading week", `${jun.length} weeks`);
}

/* ---- weekly volume ---------------------------------------------------- */
{
  const days = new Map([
    ["2026-08-17", { reps: 10, sets: [1, 2], sessions: new Set(["a"]) }],   // Monday
    ["2026-08-23", { reps: 4, sets: [1], sessions: new Set(["b"]) }],       // the Sunday after
  ]);
  const v = weeklyVolume(days, 4, new Date(2026, 7, 26, 12, 0));            // Wed 26 Aug
  ok(v.length === 4, "one bucket per week requested");
  ok(v[v.length - 1].start === "2026-08-24", "the last bucket is the current week",
     v[v.length - 1].start);
  const prev = v[v.length - 2];
  ok(prev.reps === 14 && prev.sets === 3,
     "Monday and Sunday fall in the same ISO week", `${prev.reps} reps / ${prev.sets} sets`);
}

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
