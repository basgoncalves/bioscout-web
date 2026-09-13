/**
 * Energy expenditure, the effort answers, and the macronutrient targets.
 *
 * What is worth testing here is not the third digit of any estimate -- these
 * are equations fitted on other people and their error bars are wide. It is
 * the behaviour AROUND the numbers: that an answer nobody gave stays null
 * rather than becoming a zero, that the ladder falls back a rung when heart
 * rate cannot be priced, that a session left open overnight does not bill the
 * athlete for eight hours of recovery metabolism, and that the result always
 * says which rung it stood on.
 *
 *   node tests/test_energy.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const E = await import("../src/energy.js");
const P = await import("../src/profiles.js");
const m = await import("../src/i18n.js");

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---- what an unanswered question is ------------------------------------ */

ok(E.clampRpe("") === null && E.clampRpe(null) === null && E.clampRpe(undefined) === null,
   "no rating is null, not zero");
ok(E.clampRpe(0) === 0, "a rating of zero is a rating");
ok(E.clampRpe(14) === 10 && E.clampRpe(-3) === 0, "ratings are held inside 0-10");
ok(E.clampRpe(7.3) === 7.5, "ratings land on the half point");
ok(E.clampHr(7) === null && E.clampHr(400) === null, "7 bpm and 400 bpm are not heart rates");
ok(E.clampHr("152") === 152, "a typed heart rate is a number");
ok(E.cleanEffort({ rpe: null, hr: null }) === null, "an empty answer is no answer");
ok(E.cleanEffort({ rpe: 8, hr: "x" })?.hr === null, "half an answer keeps the half that is real");

/* ---- the published equations ------------------------------------------- */

{
  // Keytel: a 35-year-old 80 kg man at 150 bpm is around 12-14 kcal/min.
  const v = E.keytelKcalMin(150, 80, 35, "male");
  ok(v !== null && near(v, 13, 2.5), "Keytel puts a hard set near 13 kcal/min", v?.toFixed(2));
  ok(E.keytelKcalMin(70, 80, 35, "male") === null,
     "below 90 bpm the fit is refused rather than returning nonsense");
  ok(E.keytelKcalMin(150, 80, 35, "female") < v, "the two fits differ by sex");
  const both = E.keytelKcalMin(150, 80, 35, "unspecified");
  ok(both > E.keytelKcalMin(150, 80, 35, "female") && both < v,
     "with no sex given, the average of the two");
  ok(E.keytelKcalMin(150, null, 35, "male") === null, "no body mass, no figure");
}

{
  // Mifflin-St Jeor: 80 kg, 1.80 m, 35 y, male -> 1780 kcal/day.
  const v = E.bmrKcalDay({ massKg: 80, heightM: 1.80, ageY: 35, sex: "male" });
  ok(near(v, 1755, 5), "Mifflin-St Jeor lands where the textbook does", Math.round(v));
  ok(E.bmrKcalDay({ massKg: 80, heightM: null, ageY: 35 }) === null,
     "no height, no resting metabolism");
  ok(near(E.bmrKcalDay({ massKg: 80, heightM: 1.8, ageY: 35, sex: "male" })
          - E.bmrKcalDay({ massKg: 80, heightM: 1.8, ageY: 35, sex: "female" }), 166, 1),
     "the male and female fits are 166 kcal apart");
}

/* ---- one set ----------------------------------------------------------- */

const ctx = { massKg: 80, heightM: 1.80, ageY: 35, sex: "male" };
const squat = {
  index: 1, at: "2026-09-13T10:00:00.000Z", activity: "squat", reps: 10,
  massKg: 80, addedKg: 0, assistKg: 0,
  perRep: Array.from({ length: 10 }, (_, i) => ({ rep: i + 1, duration_s: 4 })),
};

{
  const plain = E.setEnergy(squat, ctx, null);
  ok(plain.method === "movement", "with nothing said, the movement's own MET");
  ok(plain.seconds === 40 && !plain.seconds_assumed, "the reps' own durations are the duration");

  const rpe = E.setEnergy(squat, ctx, { rpe: 9 });
  ok(rpe.method === "rpe", "a rating moves it up a rung");
  ok(rpe.kcal !== plain.kcal, "and changes the answer");

  const hr = E.setEnergy(squat, ctx, { rpe: 9, hr: 165 });
  ok(hr.method === "hr", "a heart rate outranks the rating");
  ok(hr.kcal > rpe.kcal, "and a hard set costs more than the RPE table allows");

  const low = E.setEnergy(squat, ctx, { rpe: 9, hr: 62 });
  ok(low.method === "rpe", "a heart rate the fit cannot price falls back to the rating");

  const noReps = E.setEnergy({ ...squat, perRep: [] }, ctx, null);
  ok(noReps.seconds === 30 && noReps.seconds_assumed,
     "with no rep durations, three seconds a rep -- and it says it guessed");
}

// The same movement with a bar on it: 60 kg the MET table knows nothing about.
const heavy = { ...squat, addedKg: 60 };

{
  const w = E.setWork(heavy, 1.80);
  ok(w && w.kg === 80 * 0.85 + 60, "the lifted mass is the body's share plus the bar");
  ok(w && near(w.drop_m, 0.47, 0.02), "a squat's bar travels about half a metre for 1.80 m");
  // 10 reps x 128 kg x 9.81 x 0.47 m = ~5.9 kJ of positive work -> ~7.6 kcal.
  ok(w && near(w.kcal, 7.6, 2), "which is single-digit kilocalories of real work", w?.kcal.toFixed(1));
  ok(E.setWork({ ...heavy, activity: "sidestep" }, 1.8) === null,
     "a movement with no displacement in the table is left out, not invented");
  // 10 x 128 kg is more than the compendium's "squat" knows about, so the
  // work floor is what a bare MET estimate would have under-reported.
  const bare = E.setEnergy(heavy, ctx, null);
  ok(bare.method === "work" && bare.kcal === E.setWork(heavy, 1.8).kcal,
     "a heavy set the MET table under-prices is lifted to the mechanical floor");
  ok(E.setEnergy(squat, ctx, null).method === "movement",
     "a bodyweight set stays on the MET estimate");
}

/* ---- a whole session --------------------------------------------------- */

const sessionOf = (n, gapMin = 3, effort = {}) => ({
  started: "2026-09-13T10:00:00.000Z",
  sets: Array.from({ length: n }, (_, i) => ({
    ...squat, index: i + 1,
    at: new Date(Date.UTC(2026, 8, 13, 10, i * gapMin)).toISOString(),
    ...(effort[i + 1] ? { effort: effort[i + 1] } : {}),
  })),
});

{
  const e = E.sessionEnergy(sessionOf(6), ctx);
  ok(e.counted === 6 && e.method === "movement", "six sets, all on the bottom rung");
  ok(e.gross > e.work_kcal, "the time between the sets is priced, not ignored");
  ok(e.net !== null && e.net < e.gross, "net takes resting metabolism off the gross figure");
  ok(near(e.seconds, 15 * 60 + 40, 1), "the session is first set to end of last", e.seconds);
  ok(e.gross > 60 && e.gross < 400, "a quarter hour of squats is tens of kilocalories", Math.round(e.gross));
  ok(!e.mixed, "one method throughout is not a mixture");
}

{
  const e = E.sessionEnergy(sessionOf(6, 3, { 1: { rpe: 9, hr: 160 } }), ctx);
  ok(e.method === "hr" && e.mixed,
     "one heart rate among six defaults is flagged as mixed, not sold as an HR session");
}

{
  const e = E.sessionEnergy(sessionOf(6), ctx, { sessionEffort: { rpe: 8 } });
  ok(e.perSet.every((x) => x.method === "rpe" && x.rpe === 8),
     "one answer at the end covers every set that has none of its own");
}

{
  // Left open overnight: 30 sets, an hour apart.
  const e = E.sessionEnergy(sessionOf(30, 60), ctx);
  ok(e.capped && e.seconds === E.SESSION_SPAN_MAX_S,
     "a session spanning a whole day is capped at three hours and says so");
  const uncapped = E.metKcal(E.RECOVERY_MET, 80, 29 * 60);
  ok(e.recovery_kcal < uncapped / 3, "so it is not billed for a day of recovery metabolism");
}

ok(E.sessionEnergy({ sets: [] }, ctx).gross === null, "no sets, no figure -- not zero");
ok(E.sessionEnergy({ sets: [{ ...squat, massKg: null, addedKg: 0 }] }, { massKg: null }).gross === null,
   "no body mass anywhere, no figure -- every equation here needs one");

/* ---- the day, and what to eat ------------------------------------------ */

{
  const d = E.dayEnergy({ ctx, trainingKcal: 400, activity: "light" });
  ok(near(d.bmr, 1755, 5) && d.total > d.base, "the day is resting x activity, plus the training");
  ok(near(d.total - d.base, 400, 0.001), "the training enters once and only once");
  ok(E.dayEnergy({ ctx: { massKg: 80 }, trainingKcal: 400 }) === null,
     "an incomplete profile gets no day figure rather than a made-up one");
}

{
  const m2 = E.macroTargets({ kcal: 3000, massKg: 80, goal: "maintain" });
  ok(m2.kcal === 3000 && m2.protein_g === 144, "maintaining: 1.8 g/kg of protein");
  ok(near(m2.protein_g * 4 + m2.carb_g * 4 + m2.fat_g * 9, 3000, 12),
     "and the three add back up to the target");
  const lose = E.macroTargets({ kcal: 3000, massKg: 80, goal: "lose" });
  ok(lose.kcal === 2550, "losing is 15 % off the target");
  ok(lose.protein_g > m2.protein_g, "and protein goes UP in a deficit, not down");
  ok(lose.carb_g < m2.carb_g, "the carbohydrate is what moves with the energy");
  ok(E.macroTargets({ kcal: 900, massKg: 95 }).fat_g >= 47,
     "a low target still respects the fat floor");
  ok(E.macroTargets({ kcal: null, massKg: 80 }) === null, "no target, no grams");
}

ok(E.fmtKcal(1234.6) === "1,230 kcal" || E.fmtKcal(1234.6) === "1230 kcal",
   "a calorie estimate is not written to the unit", E.fmtKcal(1234.6));
ok(E.fmtKcal(null) === "—", "and an unknown one is a dash, not a zero");

/* ---- the answers survive being stored ---------------------------------- */

{
  const sess = P.newSession("bas");
  const started = sess.started;
  sess.sets.push({ ...squat, index: 1 });
  localStorage.setItem("bioscout.session.v1", JSON.stringify(sess));
  ok(P.setSetEffort(started, 1, { rpe: 8, hr: 150 })?.effort.rpe === 8, "an answer is stored on the set");
  ok(P.setSetEffort(started, 1, { rpe: 8, hr: 900 })?.effort.hr === null,
     "an impossible heart rate is dropped, not stored");
  ok(P.setSetEffort(started, 1, null)?.effort === undefined, "clearing removes it entirely");
  ok(P.setSetEffort(started, 9, { rpe: 5 }) === null, "a set that is not there cannot be rated");
  ok(P.setSessionEffort(started, { rpe: 7 })?.effort.rpe === 7, "and the session can carry one answer");
  ok(P.setSessionEffort(started, { rpe: null, hr: null })?.effort === undefined,
     "which clears the same way");
}

/* ---- every label the module can ask for exists in all three languages --- */

{
  const keys = ["hr", "rpe", "movement"].map((k) => "energyFrom_" + k)
    .concat(Object.keys(E.ACTIVITY_FACTORS).map((k) => "activity_" + k))
    .concat(E.GOALS.map((k) => "goal_" + k));
  const missing = [];
  for (const lang of Object.keys(m.LANGUAGES)) {
    m.setLang(lang);
    for (const k of keys) if (!m.t(k) || m.t(k) === k) missing.push(`${lang}:${k}`);
  }
  m.setLang("en");
  ok(!missing.length, `all ${keys.length} runtime-built labels exist in every language`,
     missing.join(", "));
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
