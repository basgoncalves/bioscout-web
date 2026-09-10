/**
 * Water and blood pressure: the two add-ons to the day view.
 *
 * Water is a per-day glass count, saved on every tap, that does not carry
 * forward and removes itself at zero. Blood pressure is a pair or nothing,
 * stored with the day's other vitals, and a half-typed pair must not wipe the
 * steps and heart rate saved beside it.
 *
 *   node tests/test_water.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const P = await import("../src/profiles.js");
const { collectWater, clampGlasses, GLASSES, GLASS_L } = await import("../src/water.js");
const { collectVitals } = await import("../src/vitals.js");

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/* ---- water ------------------------------------------------------------- */

ok(GLASSES === 10 && GLASS_L === 0.5, "ten glasses of half a litre");
ok(clampGlasses(12) === 10 && clampGlasses(-2) === 0 && clampGlasses("") === null,
   "counts clamp to 0..10 and a blank is not zero");

{
  const at = "2026-09-10T10:00:00.000Z";
  P.setWater({ profile: "bas", at, glasses: 1 });
  P.setWater({ profile: "bas", at, glasses: 2 });
  P.setWater({ profile: "bas", at, glasses: 3 });
  P.setWater({ profile: "other", at, glasses: 7 });
  const mine = collectWater(P.listWater(), "bas");
  ok(P.listWater().filter((w) => w.profile === "bas").length === 1,
     "one stored row per athlete per day, however many taps");
  ok(mine.get("2026-09-10").glasses === 3 && mine.get("2026-09-10").litres === 1.5,
     "the last tap is the count: 3 glasses = 1.5 L");
  ok(collectWater(P.listWater(), "other").get("2026-09-10").glasses === 7,
     "another athlete's glasses are their own");
  ok(!mine.has("2026-09-09") && !mine.has("2026-09-11"), "a day's water does not carry forward");

  P.setWater({ profile: "bas", at, glasses: 99 });
  ok(collectWater(P.listWater(), "bas").get("2026-09-10").glasses === 10, "capped at ten glasses");

  P.setWater({ profile: "bas", at, glasses: 0 });
  ok(!collectWater(P.listWater(), "bas").has("2026-09-10"), "back to zero removes the day");
  ok(P.listWater().some((w) => w.profile === "other"), "and leaves everyone else's alone");

  P.setWater({ profile: "bas", at, glasses: 4 });
  const file = JSON.parse(JSON.stringify(P.exportAll()));
  ok(Array.isArray(file.water) && file.water.length === 2, "the export carries water");
  const again = P.importAll(file);
  ok(again.waterAdded === 0, "re-importing the same file adds nothing", String(again.waterAdded));
  P.setWater({ profile: "bas", at, glasses: 0 });
  const back = P.importAll(file);
  ok(back.waterAdded === 1 && collectWater(P.listWater(), "bas").get("2026-09-10").glasses === 4,
     "an import restores a day this device does not have");
}

/* ---- blood pressure --------------------------------------------------- */

ok(P.bpPair("", "") === null, "no pressure typed is no pressure, not an error");
ok(P.bpPair("120", "") === false, "a systolic without its diastolic is refused");
ok(P.bpPair("80", "120") === false, "the lower number first is refused, not stored upside down");
ok(P.bpPair("1200", "80") === false, "a typo past any real pressure is refused");
ok(JSON.stringify(P.bpPair("121", "79")) === '{"sys":121,"dia":79}', "a real pair is kept");

{
  const at = "2026-09-10T10:00:00.000Z";
  P.setVitals({ profile: "bas", at, steps: 8000, restingHr: 58, sys: 121, dia: 79 });
  let d = collectVitals(P.listVitals(), "bas").get("2026-09-10");
  ok(d.sys === 121 && d.dia === 79 && d.steps === 8000 && d.restingHr === 58,
     "pressure stored alongside the day's other vitals");

  ok(P.setVitals({ profile: "bas", at, steps: 8000, restingHr: 58, sys: 121, dia: "" }) === null,
     "a half pair refuses the whole save");
  d = collectVitals(P.listVitals(), "bas").get("2026-09-10");
  ok(d.steps === 8000 && d.sys === 121, "and the refused save did not wipe what was there");

  P.setVitals({ profile: "bas", at: "2026-09-11T10:00:00.000Z", sys: 130, dia: 85 });
  d = collectVitals(P.listVitals(), "bas").get("2026-09-11");
  ok(d && d.sys === 130 && d.steps === null && d.restingHr === null,
     "pressure alone is a valid day");
}

ok(collectVitals([{ at: "2026-09-10T10:00:00.000Z", sys: 120 }]).size === 0,
   "a stored half pair (old or hand-edited file) is not a day of vitals");

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
