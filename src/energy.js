/**
 * energy.js -- what a training session cost, in kilocalories, and what that
 * implies for the day's macronutrients.
 *
 * The honest summary first, because everything below depends on it: this is an
 * ESTIMATE, and a wide one. Energy expenditure is measured with indirect
 * calorimetry -- a mask, expired gas analysis, a laboratory. Nothing in a
 * phone camera measures oxygen uptake. What the app has is how long you
 * trained, what you lifted, how many times, and -- if you tell it -- how hard
 * it felt and what your heart was doing. Each of those narrows the estimate.
 * None of them turns it into a measurement.
 *
 * So the module is built around a ladder, and always reports which rung it
 * stood on:
 *
 *   movement   the set's duration at a compendium MET value for that kind of
 *              work. Nothing about YOUR effort enters it. Widest.
 *   rpe        the same, with the MET moved by the rating of perceived
 *              exertion you gave that set. RPE tracks %VO2max and %HRmax well
 *              enough (r ~ 0.6-0.9 in the review literature) to separate an
 *              easy set from a maximal one, which the movement default cannot.
 *   hr         Keytel et al. (2005) -- kcal/min from heart rate, body mass,
 *              age and sex, fitted on 115 adults against indirect calorimetry.
 *              It was fitted on steady-state aerobic exercise, so applying it
 *              to a 30-second set of squats is already a stretch; it is still
 *              the best of the three because it is the only one that responds
 *              to the athlete rather than to the exercise.
 *
 * A fourth number is computed alongside: the MECHANICAL work actually done
 * against gravity, converted to a metabolic cost by muscle efficiency. It
 * rests on completely different assumptions, and it is a FLOOR -- a body
 * cannot have spent less than the work it did. That matters more than it
 * sounds, because none of the three rungs above knows what is on the bar: the
 * MET for "squat" is the same for an empty bar and for double body weight, and
 * on a heavy low-rep set the floor is the higher number. When it binds, the
 * result says so (`method: "work"`) rather than quietly reporting a figure
 * that cannot be true.
 *
 * Everything here is pure arithmetic on a stored session; the page draws it.
 */

/** Gravity, and the thermal equivalent of a kilocalorie. */
const G = 9.80665;
const J_PER_KCAL = 4184;

/**
 * Metabolic cost of a joule of positive mechanical work over a full rep.
 *
 * Concentric muscle efficiency is about 0.22 (so 4.5 J burned per J lifted)
 * and the eccentric half is far cheaper -- negative work at an efficiency
 * around 1.2 in absolute terms, so roughly 0.8 J more. The sum, ~5.4, is the
 * factor used here. A rep lowered slowly under control costs more than this
 * and a rep dropped costs less; the point of the number is its order, not its
 * third digit.
 */
const WORK_COST = 5.4;

/**
 * MET by movement, from the 2011 Compendium of Physical Activities' resistance
 * and calisthenics entries (3.5 light, 5.0 moderate, 6.0 vigorous) and its
 * locomotion entries. These are values for the WORKING time only -- the
 * compendium's "weight lifting, 3.5 METs" is an average over a whole session
 * including the standing around, and using it that way here would double-count
 * the rest, which this module prices separately.
 */
export const MOVEMENT_MET = {
  squat: 6.0, slsquat: 6.0, pullup: 8.0, dip: 8.0, pushup: 8.0,
  kickback: 4.0, heelraise: 4.0, neck: 2.5,
  cmj: 8.0, sj: 7.0, jumpshot: 7.0, sidestep: 8.0,
  run: 9.8, walk: 3.5,
};
/** Anything the table has not heard of: moderate resistance work. */
export const DEFAULT_MET = 5.0;

/** Between the sets: standing, racking plates, breathing hard. Not rest. */
export const RECOVERY_MET = 2.3;

/**
 * Fraction of body mass that is actually lifted, per movement, and how far it
 * travels in one rep as a fraction of standing height. Both are coarse
 * population figures -- a push-up moves roughly 65 % of body mass through
 * about a fifth of your height -- and they exist only to make the mechanical
 * cross-check possible. A movement that is not in the table is left out of the
 * mechanical estimate rather than given a made-up displacement.
 */
export const MOVEMENT_MECH = {
  squat:     { massFrac: 0.85, dropFrac: 0.26 },
  slsquat:   { massFrac: 0.85, dropFrac: 0.22 },
  pullup:    { massFrac: 1.00, dropFrac: 0.30 },
  dip:       { massFrac: 0.95, dropFrac: 0.24 },
  pushup:    { massFrac: 0.65, dropFrac: 0.20 },
  heelraise: { massFrac: 0.90, dropFrac: 0.07 },
  cmj:       { massFrac: 1.00, dropFrac: 0.22 },
  sj:        { massFrac: 1.00, dropFrac: 0.20 },
  jumpshot:  { massFrac: 1.00, dropFrac: 0.18 },
};

/** How effort may be asked for. "off" asks nothing and the ladder stops at
 *  the movement default. */
export const EFFORT_MODES = ["off", "set", "session"];
export const EFFORT_DEFAULT = "off";

/** Borg CR10: 0 nothing at all, 10 maximal. The 6-20 scale is not offered --
 *  two scales on one screen is how a 7 gets written where a 17 was meant. */
export const RPE_MIN = 0;
export const RPE_MAX = 10;
export const HR_MIN = 30;
export const HR_MAX = 230;

export const SEXES = ["unspecified", "female", "male"];
export const GOALS = ["lose", "maintain", "gain"];

/** A number in range, or null. Null means "not said", which is not zero. */
export function clampRpe(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(+v * 2) / 2;                    // half points allowed
  if (!Number.isFinite(n)) return null;
  return Math.max(RPE_MIN, Math.min(RPE_MAX, n));
}
export function clampHr(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(+v);
  if (!Number.isFinite(n)) return null;
  return n < HR_MIN || n > HR_MAX ? null : n;
}

/** An {rpe, hr} pair with both fields cleaned, or null when neither survives. */
export function cleanEffort(e) {
  if (!e) return null;
  const rpe = clampRpe(e.rpe), hr = clampHr(e.hr);
  if (rpe === null && hr === null) return null;
  return { rpe, hr };
}

/**
 * Keytel et al. (2005), J Sports Sci 23(3):289-97 -- kcal per minute from
 * heart rate. Published in kJ/min, converted here.
 *
 * Sex matters to the equation by more than a rounding: the two fits differ in
 * the sign of the mass term. With no sex given the two are averaged, which is
 * not what the paper offers and is stated as such wherever the number is
 * shown. Below about 90 bpm the fit runs into and below resting metabolism and
 * returns nonsense (negative kcal for a man at rest); it is refused there
 * instead, and the ladder falls back a rung.
 */
export function keytelKcalMin(hr, massKg, ageY, sex = "unspecified") {
  const h = clampHr(hr), m = Number(massKg), a = Number(ageY);
  if (h === null || !(m > 20 && m < 400) || !(a > 5 && a < 110)) return null;
  if (h < 90) return null;
  const male = (-55.0969 + 0.6309 * h + 0.1988 * m + 0.2017 * a) / 4.184;
  const female = (-20.4022 + 0.4472 * h - 0.1263 * m + 0.0740 * a) / 4.184;
  const v = sex === "male" ? male : sex === "female" ? female : (male + female) / 2;
  return v > 0 ? v : null;
}

/**
 * RPE to MET for resistance work.
 *
 * A straight line from 3.0 MET at RPE 0 to 6.5 at RPE 10 -- the compendium's
 * own light-to-vigorous span for weight lifting, laid over the scale the
 * athlete actually used. It is deliberately not steeper: an RPE 10 set of five
 * is not eight times the metabolic rate of an RPE 2 set of five, it is a set
 * of five taken closer to failure, and most of what that costs is in the
 * seconds afterwards rather than in the set.
 */
export function rpeMet(rpe) {
  const r = clampRpe(rpe);
  return r === null ? null : 3.0 + 0.35 * r;
}

/** kcal for `minutes` at `met` for a body of `massKg`, the compendium's own
 *  arithmetic: 1 MET = 3.5 mL O2/kg/min, 5 kcal per litre of O2. */
export const metKcal = (met, massKg, minutes) =>
  (met * 3.5 * Number(massKg) / 200) * minutes;

/** How long the set took: the reps' own durations when the analysis kept
 *  them, otherwise three seconds a rep, which is a plain guess and says so by
 *  coming back with `assumed: true`. */
export function setSeconds(set) {
  const per = (set.perRep || []).map((r) => Number(r.duration_s)).filter((v) => v > 0);
  if (per.length) return { s: per.reduce((a, b) => a + b, 0), assumed: per.length < (set.reps || 0) };
  const n = Number(set.reps) || 0;
  return { s: n * 3, assumed: true };
}

/** The mass that moved, in kg: the share of the body the movement lifts, plus
 *  what was added, minus what assisted. Null when the movement has no entry
 *  in MOVEMENT_MECH or the set has no body mass. */
export function liftedKg(set) {
  const spec = MOVEMENT_MECH[set.activity];
  const m = Number(set.massKg);
  if (!spec || !(m > 0)) return null;
  const v = m * spec.massFrac + (Number(set.addedKg) || 0) - (Number(set.assistKg) || 0);
  return v > 0 ? v : null;
}

/**
 * The mechanical cross-check for one set: positive work against gravity, and
 * what that work costs metabolically. Needs a height to turn the movement's
 * displacement fraction into metres.
 */
export function setWork(set, heightM) {
  const spec = MOVEMENT_MECH[set.activity];
  const kg = liftedKg(set);
  const h = Number(heightM);
  const reps = Number(set.reps) || 0;
  if (!spec || kg === null || !(h > 0.5 && h < 2.6) || !reps) return null;
  const joules = reps * kg * G * spec.dropFrac * h;
  return { joules, kcal: (joules * WORK_COST) / J_PER_KCAL, drop_m: spec.dropFrac * h, kg };
}

/**
 * One set's energy.
 *
 * `ctx` carries the athlete: massKg, heightM, ageY, sex. `effort` is the
 * {rpe, hr} for this set, or for the session when only a session answer was
 * given -- either way the method it produces is named in the result, so a
 * session rating spread over twelve sets is not passed off as twelve
 * measurements.
 */
export function setEnergy(set, ctx = {}, effort = null) {
  const mass = Number(ctx.massKg) || Number(set.massKg) || null;
  const { s, assumed } = setSeconds(set);
  const minutes = s / 60;
  const e = cleanEffort(effort);

  let kcal = null, method = "movement", met = null;
  const hrKcalMin = e && e.hr !== null
    ? keytelKcalMin(e.hr, mass, ctx.ageY, ctx.sex) : null;
  if (hrKcalMin !== null) {
    kcal = hrKcalMin * minutes;
    method = "hr";
  } else if (e && e.rpe !== null && mass) {
    met = rpeMet(e.rpe);
    kcal = metKcal(met, mass, minutes);
    method = "rpe";
  } else if (mass) {
    met = MOVEMENT_MET[set.activity] ?? DEFAULT_MET;
    kcal = metKcal(met, mass, minutes);
    method = "movement";
  }

  /* The mechanical floor. A set can cost more than the work it did -- most
   * of what a hard set costs is not lifting the bar -- but never less. */
  const work = setWork({ ...set, massKg: mass }, ctx.heightM);
  if (work && (kcal === null || work.kcal > kcal)) { kcal = work.kcal; method = "work"; }
  return {
    index: set.index ?? null,
    activity: set.activity ?? null,
    seconds: s, seconds_assumed: assumed,
    met, method, kcal,
    work_kcal: work ? work.kcal : null,
    work_J: work ? work.joules : null,
    rpe: e ? e.rpe : null, hr: e ? e.hr : null,
  };
}

/**
 * How long the session ran: first set to the end of the last one. A session
 * whose sets are hours apart is two sessions the athlete did not close, so the
 * span is capped -- charging four hours of recovery metabolism to a session
 * that was really two would be the single largest error this module could
 * make.
 */
export const SESSION_SPAN_MAX_S = 3 * 3600;

export function sessionSpan(sess) {
  const sets = (sess?.sets || []).filter((s) => s.at);
  if (!sets.length) return { seconds: 0, work_seconds: 0, capped: false };
  const times = sets.map((s) => new Date(s.at).getTime()).filter((t) => !Number.isNaN(t));
  if (!times.length) return { seconds: 0, work_seconds: 0, capped: false };
  const work = sets.reduce((a, s) => a + setSeconds(s).s, 0);
  const last = setSeconds(sets[sets.length - 1]).s;
  const raw = (Math.max(...times) - Math.min(...times)) / 1000 + last;
  const seconds = Math.min(Math.max(raw, work), SESSION_SPAN_MAX_S);
  return { seconds, work_seconds: work, capped: raw > SESSION_SPAN_MAX_S };
}

/**
 * The whole session.
 *
 * Working time is priced set by set up the ladder above. The time BETWEEN the
 * sets is priced separately at a recovery MET, because it is most of a
 * strength session by the clock and pretending it is either training or
 * lying down are both wrong by a similar margin in opposite directions.
 *
 * Two totals come out. `gross` is everything the body spent during the
 * session, which is the number to compare with a food label. `net` takes off
 * what resting metabolism would have cost over the same minutes anyway --
 * the number to use when asking what the TRAINING added. They are 100-300 kcal
 * apart for an hour's session, which is exactly the size of the mistake people
 * make when they eat back a gross figure.
 *
 * `effortBySet` maps set index -> {rpe, hr}; `sessionEffort` is the one answer
 * given for the whole session, used for any set without its own.
 */
export function sessionEnergy(sess, ctx = {}, { effortBySet = {}, sessionEffort = null } = {}) {
  const sets = sess?.sets || [];
  /* A set's own stored answer counts without the caller having to collect it:
   * `effortBySet` is for answers that are not on the sets yet. */
  const effortFor = (s) => effortBySet[s.index] ?? s.effort ?? sessionEffort ?? null;
  const span = sessionSpan(sess);
  const mass = Number(ctx.massKg) || Number(sets.find((s) => s.massKg)?.massKg) || null;

  const perSet = sets.map((s) => setEnergy(s, ctx, effortFor(s)));
  const work = perSet.reduce((a, x) => a + (x.kcal || 0), 0);
  const counted = perSet.filter((x) => x.kcal !== null).length;

  const recoveryS = Math.max(0, span.seconds - span.work_seconds);
  const recovery = mass ? metKcal(RECOVERY_MET, mass, recoveryS / 60) : 0;

  const rmrMin = restingKcalMin(ctx);
  const rest = rmrMin === null ? null : rmrMin * (span.seconds / 60);

  const gross = counted ? work + recovery : null;
  const methods = new Set(perSet.filter((x) => x.kcal !== null).map((x) => x.method));
  return {
    sets: sets.length, counted,
    seconds: span.seconds, work_seconds: span.work_seconds, capped: span.capped,
    work_kcal: work, recovery_kcal: recovery,
    gross, net: gross === null || rest === null ? null : Math.max(0, gross - rest),
    resting_kcal: rest,
    mechanical_kcal: perSet.reduce((a, x) => a + (x.work_kcal || 0), 0) || null,
    /* The best rung any set stood on, and whether they all stood on it: a
     * session with one heart rate and eleven defaults is not an "HR" session. */
    method: methods.has("hr") ? "hr" : methods.has("rpe") ? "rpe"
            : methods.has("movement") ? "movement" : counted ? "work" : null,
    mixed: methods.size > 1,
    perSet,
  };
}

/**
 * Mifflin-St Jeor resting metabolic rate, kcal/day. The 1990 equation, still
 * the one that validates best in ordinary adults (within 10 % for about 80 %
 * of people, which is the honest way to put "best").
 *
 * With no sex given, the two fits differ by a constant 166 kcal, so the
 * average is used and carries the same caveat as Keytel above.
 */
export function bmrKcalDay({ massKg, heightM, ageY, sex = "unspecified" } = {}) {
  const m = Number(massKg), h = Number(heightM) * 100, a = Number(ageY);
  if (!(m > 20 && m < 400) || !(h > 50 && h < 260) || !(a > 5 && a < 110)) return null;
  const base = 10 * m + 6.25 * h - 5 * a;
  const male = base + 5, female = base - 161;
  return sex === "male" ? male : sex === "female" ? female : (male + female) / 2;
}

/** Resting metabolism per minute, for taking off a session's gross figure. */
export function restingKcalMin(ctx) {
  const d = bmrKcalDay(ctx);
  return d === null ? null : d / 1440;
}

/**
 * What the day looks like around the training.
 *
 * Non-training activity is a multiplier on resting metabolism, the usual
 * sedentary-to-active ladder, MINUS the training itself -- which is counted
 * from the session rather than assumed, which is the whole point of the
 * module. Using 1.725 "very active" AND adding a measured session is the
 * classic double count, and it is worth a few hundred kilocalories a day.
 */
export const ACTIVITY_FACTORS = { sedentary: 1.2, light: 1.35, moderate: 1.5, active: 1.65 };
export const ACTIVITY_DEFAULT = "light";

export function dayEnergy({ ctx = {}, trainingKcal = 0, activity = ACTIVITY_DEFAULT } = {}) {
  const bmr = bmrKcalDay(ctx);
  if (bmr === null) return null;
  const base = bmr * (ACTIVITY_FACTORS[activity] ?? ACTIVITY_FACTORS[ACTIVITY_DEFAULT]);
  return { bmr, base, training: trainingKcal || 0, total: base + (trainingKcal || 0) };
}

/**
 * Macronutrients in grams for a day's intake.
 *
 * Protein first and per kilogram of body mass, because that is how the
 * evidence is expressed and it does not move with the calorie target: the
 * meta-analytic plateau for resistance-trained people sits around 1.6 g/kg
 * with little further gain past ~2.2, and a deficit raises the requirement
 * rather than lowering it. Fat next, as a share of energy with a floor around
 * 0.5 g/kg for hormonal function. Carbohydrate takes what is left -- it is the
 * fuel, so it is the part that should move with training, and it does here
 * because the total does.
 *
 * `goal` shifts the target: -15 % to lose, +10 % to gain. Those are rates, not
 * opinions about the athlete, and the page says so.
 */
export const GOAL_SHIFT = { lose: -0.15, maintain: 0, gain: 0.10 };
export const PROTEIN_G_KG = { lose: 2.0, maintain: 1.8, gain: 1.8 };
export const FAT_ENERGY_SHARE = 0.27;

export function macroTargets({ kcal, massKg, goal = "maintain" } = {}) {
  const k = Number(kcal), m = Number(massKg);
  if (!(k > 0) || !(m > 20 && m < 400)) return null;
  const shift = GOAL_SHIFT[goal] ?? 0;
  const target = k * (1 + shift);
  const protein = m * (PROTEIN_G_KG[goal] ?? PROTEIN_G_KG.maintain);
  const fat = Math.max(m * 0.5, (target * FAT_ENERGY_SHARE) / 9);
  const carb = Math.max(0, (target - protein * 4 - fat * 9) / 4);
  return {
    goal, kcal: Math.round(target), from_kcal: Math.round(k),
    protein_g: Math.round(protein), fat_g: Math.round(fat), carb_g: Math.round(carb),
    /* Where the energy actually ended up, after the floors above: a light
     * athlete on a deficit can hit the fat floor, and then the three do not
     * add back to the target unless carbohydrate goes to zero. Showing the
     * shares lets the page notice. */
    share: (() => {
      const p = protein * 4, f = fat * 9, c = carb * 4, t = p + f + c;
      return t > 0 ? { protein: p / t, fat: f / t, carb: c / t } : null;
    })(),
  };
}

/** "1,240 kcal", "310 kcal" -- rounded to 10 above 100, because a calorie
 *  estimate written to the unit is a claim about precision it does not have. */
export function fmtKcal(v) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return "—";
  const n = +v;
  const r = n >= 100 ? Math.round(n / 10) * 10 : Math.round(n);
  return r.toLocaleString() + " kcal";
}
