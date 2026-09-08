/**
 * The physical assessment: the protocol's keys, the two comparisons it makes,
 * and the score built from them.
 *
 *   node tests/test_assess.mjs
 */
import * as A from "../src/assess.js";
import * as i18n from "../src/i18n.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

/* Every key the assessment builds at runtime, in every language. These are
 * assembled from ids rather than written out, so nothing else checks them. */
for (const lang of ["en", "pt", "de"]) {
  i18n.setLang(lang);
  const missing = [];
  for (const t of A.ASSESS_TESTS) {
    for (const k of [`assessTest_${t.id}`, `assessHow_${t.id}`]) {
      if (i18n.t(k) === k) missing.push(`${lang}:${k}`);
    }
  }
  for (const b of ["strong", "typical", "below"]) {
    if (i18n.t(`assessBand_${b}`) === `assessBand_${b}`) missing.push(`${lang}:assessBand_${b}`);
  }
  for (const p of ["symmetry", "magnitude"]) {
    if (i18n.t(`assessPart_${p}`) === `assessPart_${p}`) missing.push(`${lang}:assessPart_${p}`);
  }
  ok(missing.length === 0, `${lang} has every protocol key`, missing.join(", "));
}
/* The framing warnings are keyed by which part of the body left the picture,
 * built at runtime, so nothing else checks they all exist. */
for (const lang of ["en", "pt", "de"]) {
  i18n.setLang(lang);
  const missing = ["feet", "head", "both"]
    .filter((k) => i18n.t(`hudFrame_${k}`) === `hudFrame_${k}`);
  ok(missing.length === 0, `${lang} has every framing warning`, missing.join(", "));
}
i18n.setLang("en");

/* Symmetry is relative to the mean of the two sides, so swapping the legs
 * cannot change the answer. */
ok(A.asymmetryPct(10, 10) === 0, "identical sides are 0%");
ok(Math.abs(A.asymmetryPct(11, 9) - 20) < 1e-9, "11 vs 9 is 20% of their mean");
ok(A.asymmetryPct(9, 11) === A.asymmetryPct(11, 9), "and it is symmetric");
ok(A.asymmetryPct(1, null) === null, "a missing side is not an asymmetry of zero");

ok(A.asymScore(3) === 100, "3% scores full");
ok(A.asymScore(25) === 0, "25% scores nothing");
ok(A.asymScore(12.5) === 50, "the midpoint of the band is half", String(A.asymScore(12.5)));

/* Reference bands are flat inside and taper outside, never a cliff. */
ok(A.bandScore(110, [100, 130], 30) === 100, "inside the band is full marks");
ok(A.bandScore(85, [100, 130], 30) === 50, "half a band-width below scores 50",
   String(A.bandScore(85, [100, 130], 30)));
ok(A.bandScore(60, [100, 130], 30) === 0, "a whole band-width out scores 0");
ok(A.bandScore(null, [100, 130], 30) === null, "no value is no score");

/* A whole report from a plausible protocol. */
const gaitReps = [];
for (let i = 0; i < 20; i++) {          // ten strides per leg, the recommendation
  const left = i % 2 === 0;
  gaitReps.push({
    stance_side: left ? "l" : "r",
    contact_s: left ? 0.70 : 0.71, stride_s: 1.10, swing_s: 0.42,
    cadence_spm: 110, duty_factor: 0.60, knee_asymmetry_deg: 2,
  });
}
const tiptoeReps = [...Array(26)].map(() => ({ stance_side: "l", heel_lift: 0.5 }))
  .concat([...Array(25)].map(() => ({ stance_side: "r", heel_lift: 0.5 })));
const neckReps = [...Array(6)].map(() => ({
  flex_ext_deg: 62, bend_deg: 41, rotation_deg: 71 }));
const tests = {
  neck: { activity: "neck", perRep: neckReps },
  tiptoe: { activity: "heelraise", perRep: tiptoeReps },
  gait: { activity: "run", perRep: gaitReps },
  squat: { activity: "squat", perRep: [
    { knee_flex_max_deg: 115 }, { knee_flex_max_deg: 118 }, { knee_flex_max_deg: 112 }] },
  cmj: { activity: "cmj", perRep: [
    { height_flight_m: 0.32 }, { height_flight_m: 0.34 }] },
};
const rep = A.assessReport(tests);
ok(rep.complete, "three tests at their targets make a complete assessment");
ok(rep.missing.length === 0, "with nothing missing");
ok(rep.short.length === 0, "and nothing short");
ok(rep.score >= 85 && rep.score <= 100, "a symmetric, in-band athlete scores high", String(rep.score));
ok(rep.band === "strong" || rep.band === "typical", "and lands in a good band", rep.band);
ok(rep.sides.some((s) => s.key === "contact_s"), "contact time is compared side to side");
ok(rep.marks.some((m) => m.key === "cadence_spm" && m.within), "cadence is inside its band");

/* Short of the target, the assessment is still produced -- an athlete who
 * managed three strides a side is better served by three and a warning than
 * by nothing. Below the floor there is nothing to average and it is not. */
const short = A.assessReport({ ...tests, gait: { activity: "walk", perRep: gaitReps.slice(0, 6) } });
ok(!short.complete, "three strides a side does not meet the target");
ok(short.missing.length === 0, "but the test is not thrown away");
ok(short.short.some((x) => x.id === "gait" && x.count.counted === 3 && x.target === 10),
   "it is reported as short, with the count and the target");
ok(short.sides.length > 0, "and the side comparison is still drawn from it");
ok(short.score != null, "a short assessment still scores");

const floor = A.assessReport({ ...tests, gait: { activity: "walk", perRep: gaitReps.slice(0, 2) } });
ok(floor.missing.some((m) => m.id === "gait" && m.have === 1),
   "one stride a side is below the floor and counts as not recorded");
ok(floor.sides.length === 0, "with no side comparison drawn from it");

/* Per leg means the smaller side: nine left and one right is not five of
 * anything, and averaging it would hide exactly the asymmetry being looked for. */
const lopsided = gaitReps.slice(0, 18).map((r, i) => ({ ...r, stance_side: i < 16 ? "l" : "r" }));
const lop = A.countReps(A.ASSESS_TESTS[0], { perRep: lopsided });
ok(lop.total === 18 && lop.l === 16 && lop.r === 2 && lop.counted === 2,
   "the counted total is the weaker leg", JSON.stringify(lop));

/* The athlete can move the target; the recommendation is the default. */
ok(A.targetFor(A.ASSESS_TESTS[0], {}) === 10, "10 a leg is the recommendation");
ok(A.targetFor(A.ASSESS_TESTS[0], { gait: 4 }) === 4, "and it can be set lower");
ok(A.targetFor(A.ASSESS_TESTS[0], { gait: 0 }) === 10, "a nonsense target falls back");
const relaxed = A.assessReport({ ...tests, gait: { activity: "walk", perRep: gaitReps.slice(0, 8) } },
                               { gait: 4 });
ok(relaxed.short.length === 0 && relaxed.complete,
   "four strides a side against a target of four is complete");

/* A limping gait is caught and flagged. */
const limp = gaitReps.map((r) => r.stance_side === "l"
  ? { ...r, contact_s: 0.60 } : { ...r, contact_s: 0.80 });
const lrep = A.assessReport({ ...tests, gait: { activity: "run", perRep: limp } });
const ct = lrep.sides.find((s) => s.key === "contact_s");
ok(Math.abs(ct.pct - 28.57) < 0.1, "a 0.60/0.80 contact split is ~29%", ct.pct.toFixed(2));
ok(ct.flag, "which is flagged");
ok(lrep.score < rep.score, "and it costs the overall score",
   `${lrep.score} < ${rep.score}`);

/* Nothing recorded reports nothing, rather than a flattering default. */
const empty = A.assessReport({});
ok(empty.score === null, "an empty assessment has no score");
ok(empty.missing.length === A.ASSESS_TESTS.length, "and lists every test as missing");

/* The rendered report survives every state it can be in. */
for (const [name, r] of [["full", rep], ["short", short], ["empty", empty]]) {
  const html = A.assessReportHTML(r);
  ok(typeof html === "string" && html.length > 0 && !html.includes("undefined"),
     `${name} report renders without holes`);
}

/* --- the tip-toe test ---------------------------------------------------
 * The review it comes from concluded that no validated threshold exists, so
 * the app's job is to report the count and keep the grading attached, never to
 * turn it into a verdict. */
ok(rep.tiptoe.left === 26 && rep.tiptoe.right === 25, "both legs are counted separately");
ok(rep.tiptoe.weaker === 25, "the weaker leg is the one reported against the thresholds");
ok(Math.abs(rep.tiptoe.lsi - 96.15) < 0.1, "symmetry is weaker over stronger",
   rep.tiptoe.lsi.toFixed(2));
ok(rep.tiptoe.byDistance.length === 3, "with a row per distance");
ok(rep.tiptoe.byDistance[0].reps.meets, "25 a side meets the 5 km consensus value");
ok(!rep.tiptoe.byDistance[2].reps.comfortably,
   "but not comfortably the 20 km one");

/* The tip-toe result must not reach the score: every threshold behind it is
 * graded very low, and a score is read as a verdict. */
const withTT = A.assessReport(tests).score;
const noTT = A.assessReport({ ...tests, tiptoe: undefined }).score;
ok(withTT === noTT, "tip-toe capacity does not move the overall score",
   `${withTT} vs ${noTT}`);

const ttHtml = A.assessReportHTML(rep);
ok(/VERY LOW/i.test(ttHtml), "the rendered report carries the evidence grading");
ok(ttHtml.includes("not a gate"), "and says the values are not a gate");

/* The neck test is reported and, like the tip-toe test, kept out of the score:
 * there is no population norm for neck range here to score against. */
ok(rep.neck.flex_ext_deg === 62 && rep.neck.rotation_deg === 71,
   "the neck test reports its three ranges");
ok(A.assessReport(tests).score === A.assessReport({ ...tests, neck: undefined }).score,
   "and does not move the overall score");

/* --- filing an assessment ------------------------------------------------ */
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

A.clearAssess();
A.startAssess("Ada");
const attendance = A.finishAssess("Ada");
ok(attendance.attendanceOnly, "an assessment with nothing recorded still files");
ok(attendance.missing.length === A.ASSESS_TESTS.length, "with every test marked not recorded");
ok(attendance.score === null, "and no score invented for it");
ok(A.listAssessments("Ada").length === 1, "it lands in the history");
ok(A.getAssess("Ada") === null, "and the working assessment is cleared");

A.startAssess("Ada");
A.putAssessTest("squat", tests.squat, "Ada");
const partial = A.finishAssess("Ada");
ok(partial.recorded.includes("squat"), "a partial assessment files what it has");
ok(!partial.attendanceOnly, "and is not attendance-only");
ok(partial.missing.includes("gait") && partial.missing.includes("cmj"),
   "naming the gaps so a later visit can fill them",
   partial.missing.join(","));
ok(A.listAssessments("Ada").length === 2, "history keeps both");
ok(A.listAssessments("Bob").length === 0, "and is per athlete");

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
