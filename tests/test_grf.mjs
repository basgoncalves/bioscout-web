/**
 * Reaction force per foot and per hand (src/grf.js), on poses whose answer is
 * known without the app: standing still carries body weight; standing on one
 * leg puts all of it on that foot; a plank's hands carry the lever share; a
 * hang puts the whole system on the hands.
 *
 *   node tests/test_grf.mjs
 */
const { clipGrf, grfForRep, grfSources } = await import("../src/grf.js");

let bad = 0;
const check = (ok, msg, detail = "") => {
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${msg}${detail ? "  " + detail : ""}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const G = 9.80665, M = 80, BW = M * G, PX = 400, H = 1.8, FPS = 30;

// Standing, side view, y down, feet on y=700. liftR raises the right foot.
function standing(liftR = 0, lx = 480, rx = 520, toe = 60) {
  const p = {};
  const put = (k, x, y) => { p[k] = [x, y]; };
  put("left_shoulder", 500, 700 - 1.45 * PX); put("right_shoulder", 500, 700 - 1.45 * PX);
  put("left_hip", 500, 700 - 0.95 * PX); put("right_hip", 500, 700 - 0.95 * PX);
  put("left_knee", lx, 700 - 0.5 * PX); put("right_knee", rx, 700 - 0.5 * PX - liftR);
  for (const [s, x, dy] of [["left", lx, 0], ["right", rx, liftR]]) {
    put(`${s}_ankle`, x, 700 - 0.08 * PX - dy); put(`${s}_heel`, x - (toe ? 10 : 0), 700 - 0.02 * PX - dy);
    put(`${s}_foot_index`, x + toe, 700 - dy);
    put(`${s}_wrist`, 500, 700 - 0.8 * PX);
  }
  return p;
}
const clip = (f, n = 60) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, f(i)]));
const opts = { pxPerM: PX, heightM: H, systemKg: M, fps: FPS };

console.log("standing still, both feet");
let g = clipGrf(clip(() => standing()), "squat", opts);
const tot = g.feet_l.map((v, i) => v + g.feet_r[i]).slice(10, 50);
check(near(mean(tot), BW, 1), "feet sum to body weight", mean(tot).toFixed(1));
check(g.hands_l === null, "no hand source for a squat");

console.log("front view, feet apart, centre of mass between them");
g = clipGrf(clip(() => standing(0, 400, 600, 0)), "squat", opts);
check(near(mean(g.feet_l.slice(10, 50)), BW / 2, 5), "left ~ half", mean(g.feet_l.slice(10, 50)).toFixed(0));

console.log("right foot lifted");
g = clipGrf(clip(() => standing(0.15 * PX)), "slsquat", opts);
check(near(mean(g.feet_l.slice(10, 50)), BW, 1) && mean(g.feet_r.slice(10, 50)) === 0,
      "all load on the standing foot");

console.log("plank: feet at x=0, hands at x=1.3 m, body straight");
function plank() {
  const p = {}, y = (x) => 700 - 0.35 * x;             // gently inclined body
  const at = (x) => [100 + x * PX, y(x * PX)];
  for (const s of ["left", "right"]) {
    p[`${s}_foot_index`] = at(0); p[`${s}_heel`] = at(0.05); p[`${s}_ankle`] = at(0.07);
    p[`${s}_knee`] = at(0.5); p[`${s}_hip`] = at(0.95); p[`${s}_shoulder`] = at(1.4);
    p[`${s}_wrist`] = [100 + 1.3 * PX, 700];
  }
  return p;
}
g = clipGrf(clip(plank), "pushup", opts);
const hands = mean(g.hands_l.slice(10, 50).map((v, i) => v + g.hands_r[i + 10]));
const feet = mean(g.feet_l.slice(10, 50).map((v, i) => v + g.feet_r[i + 10]));
check(near(hands + feet, BW, 1), "hands + feet = body weight");
check(hands / BW > 0.55 && hands / BW < 0.8, "hands carry a push-up's usual share", (hands / BW).toFixed(2));

console.log("hang");
g = clipGrf(clip(() => standing(0, 500, 500)), "pullup", opts);
check(g.feet_l === null, "no feet source for a pull-up");
check(near(mean(g.hands_l.slice(10, 50)), BW / 2, 1), "each hand half the system");

console.log("rep slicing and sources");
const jm = grfForRep(g, [5, 10, 20]);
check(jm.hands_grf_l.length === 16, "slice spans the rep bounds");
check(JSON.stringify(grfSources(jm)) === '["hands"]', "sources listed");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
