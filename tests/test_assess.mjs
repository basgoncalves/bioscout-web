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
for (let i = 0; i < 12; i++) {
  const left = i % 2 === 0;
  gaitReps.push({
    stance_side: left ? "l" : "r",
    contact_s: left ? 0.70 : 0.71, stride_s: 1.10, swing_s: 0.42,
    cadence_spm: 110, duty_factor: 0.60, knee_asymmetry_deg: 2,
  });
}
const tests = {
  gait: { activity: "run", perRep: gaitReps },
  squat: { activity: "squat", perRep: [
    { knee_flex_max_deg: 115 }, { knee_flex_max_deg: 118 }, { knee_flex_max_deg: 112 }] },
  cmj: { activity: "cmj", perRep: [
    { height_flight_m: 0.32 }, { height_flight_m: 0.34 }] },
};
const rep = A.assessReport(tests);
ok(rep.complete, "three complete tests make a complete assessment");
ok(rep.missing.length === 0, "with nothing missing");
ok(rep.score >= 85 && rep.score <= 100, "a symmetric, in-band athlete scores high", String(rep.score));
ok(rep.band === "strong" || rep.band === "typical", "and lands in a good band", rep.band);
ok(rep.sides.some((s) => s.key === "contact_s"), "contact time is compared side to side");
ok(rep.marks.some((m) => m.key === "cadence_spm" && m.within), "cadence is inside its band");

/* A short walk is not a short assessment -- it is not an assessment. */
const short = A.assessReport({ ...tests, gait: { activity: "run", perRep: gaitReps.slice(0, 4) } });
ok(!short.complete, "four strides does not satisfy the walk");
ok(short.missing.some((m) => m.id === "gait" && m.have === 4), "and the report says how many it had");
ok(short.sides.length === 0, "with no side comparison drawn from it");

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
ok(empty.missing.length === 3, "and lists all three tests as missing");

/* The rendered report survives every state it can be in. */
for (const [name, r] of [["full", rep], ["short", short], ["empty", empty]]) {
  const html = A.assessReportHTML(r);
  ok(typeof html === "string" && html.length > 0 && !html.includes("undefined"),
     `${name} report renders without holes`);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
