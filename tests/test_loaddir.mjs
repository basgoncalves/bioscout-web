/**
 * Added-load direction (src/loaddir.js).
 *
 * A horizontal load -- a neck strap pulled sideways -- is a force on the head,
 * not weight. These checks hold the line that it never reaches a model built
 * on gravity (system weight, lifted mass, relative intensity), while old sets
 * with no direction keep meaning exactly what they meant.
 *
 *   node tests/test_loaddir.mjs
 */
import * as L from "../src/loaddir.js";
import { liftedKg } from "../src/energy.js";
import { intensity } from "../src/trainsummary.js";
import * as i18n from "../src/i18n.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log("direction defaults");
ok(L.normLoadDir(undefined) === "down", "a set stored before directions existed is down");
ok(L.normLoadDir("sideways") === "down", "an unknown direction falls back to down");
ok(L.LOAD_DIRS.every((d) => L.normLoadDir(d) === d), "every listed direction survives normalising");
ok(!L.isHorizontal("down") && L.isHorizontal("left") && L.isHorizontal("back"), "only down is vertical");

console.log("weight vs force");
ok(L.verticalKg({ addedKg: 10 }) === 10, "no direction: the load is weight");
ok(L.verticalKg({ addedKg: 10, loadDir: "down" }) === 10, "down: the load is weight");
ok(L.verticalKg({ addedKg: 10, loadDir: "left" }) === 0, "left: none of it is weight");
ok(L.netVerticalKg({ addedKg: 10, assistKg: 4 }) === 6, "vertical net is added minus assistance");
ok(L.netVerticalKg({ addedKg: 10, assistKg: 4, loadDir: "right" }) === -4,
   "a sideways load leaves the assistance, which still acts along gravity");

console.log("consumers ignore a sideways load");
const base = { activity: "squat", massKg: 80, addedKg: 20, assistKg: 0 };
const vDown = liftedKg(base), vSide = liftedKg({ ...base, loadDir: "left" }),
      vNone = liftedKg({ ...base, addedKg: 0 });
ok(vDown != null && near(vDown - vNone, 20), "energy: a hanging 20 kg is lifted", `${vDown} vs ${vNone}`);
ok(vSide != null && near(vSide, vNone), "energy: a sideways 20 kg is not", `${vSide} vs ${vNone}`);
const day = (s) => [{ sets: [s] }];
const iDown = intensity(day({ massKg: 80, addedKg: 40 }));
const iSide = intensity(day({ massKg: 80, addedKg: 40, loadDir: "forward" }));
ok(JSON.stringify(iDown) !== JSON.stringify(iSide), "intensity: direction changes the relative load");
ok(JSON.stringify(iSide) === JSON.stringify(intensity(day({ massKg: 80, addedKg: 0 }))),
   "intensity: a sideways load counts as bodyweight only");

console.log("labels");
const tr = (k) => i18n.t(k);
ok(L.loadText({ addedKg: 10 }, tr) === "+10 kg", "down reads as before", L.loadText({ addedKg: 10 }, tr));
const lt = L.loadText({ addedKg: 10, loadDir: "left" }, tr);
ok(/\+10 kg/.test(lt) && /left/i.test(lt), "a sideways load says which way", lt);
ok(L.loadText({ addedKg: 0, loadDir: "left" }, tr) === "", "no load, no label");
for (const d of L.LOAD_DIRS) {
  ok(i18n.EN_KEYS["loadDir_" + d] && i18n.EN_KEYS["loadDirShort_" + d], `strings exist for ${d}`);
}

console.log("neck push");
ok(L.neckPush({ addedKg: 10 }, { massKg: 75 }) === null, "no neck push for a hanging load");
ok(L.neckPush({ addedKg: 0, loadDir: "left" }, { massKg: 75 }) === null, "no neck push without load");
const p = L.neckPush({ addedKg: 10, loadDir: "left" }, { massKg: 75, sex: "male" });
ok(p && near(p.forceN, 98.0665), "10 kg is 98 N", p && p.forceN);
ok(p && near(p.headKg, 75 * 0.0694), "head mass is 6.94 % of a man's body mass (de Leva)", p && p.headKg);
ok(p && near(p.gEquiv, 10 / (75 * 0.0694)), "g equivalent is load over head mass", p && p.gEquiv.toFixed(2));
const q = L.neckPush({ addedKg: 10, loadDir: "right" }, {});
ok(q && q.forceN > 0 && q.gEquiv === null, "without body mass there is a force and no g");

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log("\nall passed");
process.exit(0);
