/**
 * repquality.js -- is this rep clean, acceptable or poor?
 *
 * Every task gets a few checks, each read off what the rep actually did --
 * its joint angles at the ends and the middle, and how far the body (COM
 * proxy: the hip) travelled -- with two bars: CLEAN and ACCEPTABLE. A rep's
 * grade is its worst check. The checks that failed come back as codes with the
 * value that failed them, so the page can say WHY ("arms not straight at the
 * bottom, 38 deg") rather than just colour the row.
 *
 * Two kinds of bar, on purpose:
 *
 *   absolute   what the movement standard asks: a pull-up starts from straight
 *              arms, a squat reaches depth, a heel raise keeps the knee
 *              straight. These are coaching conventions, not physiology, and
 *              the numbers below say which convention.
 *   relative   against the athlete's own best rep in the set (range, height)
 *              or their own median (stride time, shot release). A short rep
 *              in a set of long ones is the classic sign of fatigue or a
 *              half-rep, and "short" only means something against the person
 *              doing it -- a 5 cm rise is a full pull-up for no one and a
 *              45 cm jump is a poor one for a volleyball player.
 *
 * Pure: takes the analysed reps, returns grades. No DOM, no imports, so it can
 * be run on a restored set as easily as on a fresh one.
 */

export const GRADES = ["clean", "acceptable", "poor"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const arr = (a) => (Array.isArray(a) || ArrayBuffer.isView(a) ? Array.from(a).filter(isNum) : []);
const absArr = (a) => arr(a).map(Math.abs);

/** The joint at rest before and after the rep, as analyse() measured it from
 *  the stretch outside the cropped window; failing that (a set restored from
 *  before those were recorded), the lowest value in the first and last third
 *  of the rep's own curve. */
function restEnds(r, a) {
  if (isNum(r.rest_before_deg) && isNum(r.rest_after_deg)) return [r.rest_before_deg, r.rest_after_deg];
  return endsMin(a);
}

function endsMin(a) {
  const v = arr(a);
  if (v.length < 3) return null;
  const k = Math.max(1, Math.floor(v.length / 3));
  return [Math.min(...v.slice(0, k)), Math.min(...v.slice(v.length - k))];
}
const range = (a) => { const v = arr(a); return v.length ? Math.max(...v) - Math.min(...v) : null; };
const median = (v) => {
  const s = v.filter(isNum).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** One check: level 0 clean, 1 acceptable, 2 poor. `higherIsBetter` picks the
 *  direction of the two bars. */
function bar(code, v, clean, ok, higherIsBetter = true, shown = v) {
  if (!isNum(v)) return null;
  const good = (x) => (higherIsBetter ? v >= x : v <= x);
  const level = good(clean) ? 0 : good(ok) ? 1 : 2;
  return { code, v: Math.round(shown), level };
}

/** Fraction of the set's best, as a check on "higher is better". */
function vsBest(code, v, best, clean = 0.9, ok = 0.75) {
  if (!isNum(v) || !isNum(best) || best <= 0) return null;
  const f = v / best;
  return bar(code, f, clean, ok, true, 100 * f);
}

/** Relative distance from the set median, as a check on "lower is better". */
function vsMedian(code, v, med, clean, ok, percent = true) {
  if (!isNum(v) || !isNum(med) || (percent && med === 0)) return null;
  const d = percent ? Math.abs(v - med) / Math.abs(med) : Math.abs(v - med);
  return bar(code, d, clean, ok, false, percent ? 100 * d : d);
}

const best = (reps, get) => {
  const v = reps.map(get).filter(isNum);
  return v.length ? Math.max(...v) : null;
};

/* The rules, per task. Each returns a list of checks for one rep. */
const RULES = {
  /* Pull-up. Dead hang to chin at the bar (the elbow folds past ~110 deg when
   * the chin clears the bar with a shoulder-width grip); body rise against the
   * set's best; and the body swinging -- a kip -- measured as sideways hip
   * travel against the rise. */
  pullup(r, ctx) {
    const ends = restEnds(r, r.coords && r.coords.elbow_flex_r);
    const swing = range(r.coords && r.coords.pelvis_tz);
    const rise = r.pelvis_travel_m;
    return [
      ends && bar("lockout", Math.max(...ends), 25, 45, false),
      bar("top", r.elbow_flex_max_deg, 110, 90),
      vsBest("travel", rise, ctx.best((q) => q.pelvis_travel_m)),
      isNum(swing) && isNum(rise) && rise > 0.05
        ? bar("swing", swing / rise, 0.35, 0.6, false, 100 * swing / rise) : null,
    ];
  },
  /* Dip. Down to a right angle at the elbow (the common standard; deeper is
   * fine), lockout at the top, depth against the set's best. */
  dip(r, ctx) {
    const ends = restEnds(r, r.coords && r.coords.elbow_flex_r);
    return [
      bar("depthArm", r.elbow_flex_max_deg, 90, 75),
      ends && bar("lockout", Math.max(...ends), 25, 45, false),
      vsBest("travel", r.pelvis_travel_m, ctx.best((q) => q.pelvis_travel_m)),
    ];
  },
  /* Squat. 90 deg of knee flexion is roughly thighs parallel; standing tall
   * between reps; depth against the set's best. */
  squat(r, ctx) {
    const ends = restEnds(r, absArr(r.coords && r.coords.knee_angle_r));
    return [
      bar("depthKnee", r.knee_flex_max_deg, 90, 70),
      ends && bar("standUp", Math.max(...ends), 20, 35, false),
      vsBest("travel", r.depth_m, ctx.best((q) => q.depth_m)),
    ];
  },
  /* Single-leg squat: the working leg, to 60 deg (a typical clinical
   * single-leg squat depth), and back up. */
  slsquat(r, ctx) {
    const st = r.stance_side === "l" ? "l" : "r";
    const ends = restEnds(r, absArr(r.coords && r.coords["knee_angle_" + st]));
    return [
      bar("depthKnee", r.stance_knee_flex_max_deg, 60, 45),
      ends && bar("standUp", Math.max(...ends), 20, 35, false),
      vsBest("travel", r.depth_m, ctx.best((q) => q.depth_m)),
    ];
  },
  /* Jumps: height against the set's best, the jump the athlete was asked for,
   * and the measurement agreeing with itself. */
  cmj: (r, ctx) => jumpChecks(r, ctx),
  sj: (r, ctx) => jumpChecks(r, ctx),
  /* Heel raise: as high as your best on that side, knee straight -- a bent
   * knee turns it into a different exercise. */
  heelraise(r, ctx) {
    const sd = r.stance_side === "l" ? "l" : "r";
    return [
      vsBest("travel", r.heel_lift, ctx.best((q) => (q.stance_side === r.stance_side ? q.heel_lift : null))),
      bar("kneeBent", Math.max(0, ...absArr(r.coords && r.coords["knee_angle_" + sd])), 15, 25, false),
    ];
  },
  /* Gait: a stride that is not like the others. Against the median of the
   * same foot, since the two feet may legitimately differ. */
  walk: (r, ctx) => strideChecks(r, ctx),
  run: (r, ctx) => strideChecks(r, ctx),
  /* Glute kick back: range of the hip against your best on that leg, and the
   * trunk holding still -- the usual way a kick back cheats is the lower back
   * arching or the pelvis rolling, which moves the thigh without the hip
   * extending. 10 deg of trunk pitch over a rep is within what a pose model
   * wobbles; 20 is a visible compensation. */
  kickback(r, ctx) {
    return [
      vsBest("travel", r.hip_range_deg,
             ctx.best((q) => (q.stance_side === r.stance_side ? q.hip_range_deg : null))),
      bar("trunk", r.trunk_motion_deg, 10, 20, false),
    ];
  },
  sidestep(r, ctx) {
    return [vsBest("travel", r.excursion_m, ctx.best((q) => q.excursion_m))];
  },
  /* The jump shot is graded on repeatability, which is what shooting
   * mechanics are judged on: the same release height, the same elbow, the
   * same rhythm. Whether it went in is the athlete's tap, not this. */
  jumpshot(r, ctx) {
    return [
      vsMedian("release", r.release_height_m, ctx.median((q) => q.release_height_m), 0.05, 0.10),
      vsMedian("releaseElbow", r.release_elbow_deg, ctx.median((q) => q.release_elbow_deg), 8, 15, false),
      vsMedian("load", r.load_s, ctx.median((q) => q.load_s), 0.15, 0.30),
    ];
  },
  neck(r, ctx) {
    const rng = (q) => Math.max(q.flexion_extension_range_deg || 0,
                                q.lateral_bend_range_deg || 0, q.rotation_range_deg || 0);
    return [vsBest("travel", rng(r), ctx.best(rng))];
  },
};

function jumpChecks(r, ctx) {
  return [
    vsBest("height", r.height_flight_m, ctx.best((q) => q.height_flight_m), 0.9, 0.8),
    r.mismatch ? { code: "wrongJump", v: 0, level: 1 } : null,
    r.implausible ? { code: "implausible", v: 0, level: 2 } : null,
  ];
}

function strideChecks(r, ctx) {
  const same = (q) => (q.stance_side === r.stance_side ? q.duration_s : null);
  return [vsMedian("tempo", r.duration_s, ctx.median(same), 0.10, 0.20)];
}

/**
 * Grade every rep of an analysed set in place: `rep.quality` is the grade,
 * `rep.qualityNotes` the checks that kept it from clean, worst first, as
 * [{code, v, level}]. Returns {clean, acceptable, poor} counts.
 */
export function gradeReps(res) {
  const reps = (res && res.reps) || [];
  const rule = RULES[res && res.activity];
  const counts = { clean: 0, acceptable: 0, poor: 0 };
  if (!rule) return counts;
  const ctx = {
    best: (get) => best(reps, get),
    median: (get) => median(reps.map(get)),
  };
  for (const r of reps) {
    const checks = rule(r, ctx).filter(Boolean);
    const worst = checks.reduce((m, c) => Math.max(m, c.level), 0);
    r.quality = GRADES[worst];
    r.qualityNotes = checks.filter((c) => c.level > 0).sort((a, b) => b.level - a.level);
    counts[r.quality]++;
  }
  return counts;
}

/** Every note code the rules can produce -- for the translation test. */
export const NOTE_CODES = ["lockout", "top", "travel", "swing", "depthArm", "depthKnee",
  "standUp", "height", "wrongJump", "implausible", "kneeBent", "tempo", "release",
  "releaseElbow", "load", "trunk"];
