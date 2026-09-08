/**
 * Neck training load, and the neck capacity it sits beside.
 *
 * The point of these checks is mostly what the module REFUSES to do. The
 * project has a cervical-spine model (neck_gload.js) that says what the neck
 * must resist at 1-6 g, and a neck test that measures range of motion, and the
 * temptation is to multiply them into a readiness number. They measure
 * different things -- an isometric hold against a lateral force, and a slow
 * unloaded range task -- and nothing in this project has tested one against
 * the other, so the module keeps them apart and these tests hold it there.
 *
 *   node tests/test_neck_load.mjs
 */
import * as N from "../src/neck_load.js";
import * as i18n from "../src/i18n.js";
import { NECK_GLOAD } from "../src/neck_gload.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

const NOW = new Date("2026-09-08T12:00:00Z");
const ago = (d) => new Date(+NOW - d * 86400000).toISOString();
const neckSet = (d, reps, rom = {}) => ({
  started: ago(d),
  sets: [{ activity: "neck", at: ago(d), reps,
           perRep: [{ flex_ext_deg: 60, bend_deg: 40, rotation_deg: 70, ...rom }] }],
});

/* Only neck work counts as neck load. */
const mixed = [
  neckSet(2, 12),
  { started: ago(2), sets: [{ activity: "squat", at: ago(2), reps: 30, perRep: [] }] },
];
ok(N.neckSets(mixed).length === 1, "a squat is not neck load");
ok(N.neckLoadSeries(mixed, 42, NOW).reduce((a, b) => a + b.reps, 0) === 12,
   "and the series counts only the neck reps");

const series = N.neckLoadSeries([neckSet(0, 10), neckSet(5, 20)], 42, NOW);
ok(series.length === 42, "six weeks of days, one entry each");
ok(series[series.length - 1].reps === 10, "today is last");
ok(series.filter((d) => d.reps === 0).length === 40, "and quiet days are zeros, not gaps");

/* Acute:chronic, with both its inputs kept beside it. */
// Five sessions, one per week: the acute week plus the four chronic weeks
// behind it. Four would leave the oldest chronic week empty and the "steady"
// fixture would not be steady.
const steady = [];
for (let w = 0; w < 5; w++) steady.push(neckSet(7 * w + 1, 20));
const ac = N.neckAcuteChronic(steady, NOW);
ok(ac.acute === 20 && ac.chronic === 20, "steady training is acute equal to chronic",
   `${ac.acute} vs ${ac.chronic}`);
ok(ac.ratio === 1, "a ratio of one");

const spike = [...steady, neckSet(0, 60)];
const acS = N.neckAcuteChronic(spike, NOW);
ok(acS.ratio > 3, "a spike week shows as a high ratio", String(acS.ratio));
ok(Array.isArray(acS.weeks) && acS.weeks.length === 4,
   "with the four weeks behind it reported too, so the ratio can be checked");

/* A first week has no history, and 1.0 would be a lie about that. */
const fresh = N.neckAcuteChronic([neckSet(1, 30)], NOW);
ok(fresh.ratio === null, "no chronic history means no ratio, not a ratio of one");

/* Capacity is the athlete against themselves: there is no norm here. */
const declining = [neckSet(30, 10, { flex_ext_deg: 70 }), neckSet(1, 10, { flex_ext_deg: 50 })];
const cap = N.neckCapacity(declining);
ok(cap.best.flex_ext_deg === 70 && cap.latest.flex_ext_deg === 50,
   "best and latest are both kept");
ok(cap.down.includes("flex_ext_deg"), "a drop of more than 10% is flagged");
ok(!cap.down.includes("rotation_deg"), "an unchanged measure is not");
ok(N.neckCapacity([]) === null, "no neck work at all is null, not a zero range");

/* The refusals. */
i18n.setLang("en");
N.setNeckLoadTr(i18n.t);
const html = N.neckLoadHTML(spike, NOW);
ok(html.includes("<svg"), "the panel draws the six weeks");
ok(/contested/i.test(html), "and says the ratio's injury claims are contested");
ok(!/\bg\b.*readiness|ready for \d\s*g/i.test(html),
   "the panel makes no claim about g tolerance");
for (const g of NECK_GLOAD.lateral) {
  ok(!html.includes(String(g.rollNm)), `no roll moment from the model leaks in (${g.g} g)`);
}
ok(N.neckLoadHTML([], NOW) === "", "no neck work, no panel");

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
