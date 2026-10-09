/**
 * The ten strength / rehab movements added 2026-10-09: plank, side plank,
 * wall sit (holds) and deadlift, lunge, glute bridge, overhead press, biceps
 * curl, bent-over row, lateral / front raise (reps).
 *
 * Fixtures are geometry, not footage: a side-on figure whose joint angles are
 * driven by known values, so the count and the angles reported can be checked
 * against what was put in. Each rep task also gets a still clip, which must
 * count nothing.
 *
 *   node tests/test_more_exercises.mjs
 */
import { ACTIVITIES, analyse } from "../src/kinematics.js";
import { gradeReps } from "../src/repquality.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const D = Math.PI / 180;
const add = (p, len, deg) => [p[0] + len * Math.sin(deg * D), p[1] + len * Math.cos(deg * D)];  // 0 deg = straight down, +x forward
/** Knee from hip and ankle (two-link IK), bending toward +x when fwd > 0. */
function knee(hip, ank, L = 200, fwd = 1) {
  const dx = ank[0] - hip[0], dy = ank[1] - hip[1], d = Math.min(Math.hypot(dx, dy), 2 * L - 1e-3);
  const a = Math.acos(d / (2 * L)), base = Math.atan2(dy, dx);
  const t = base - fwd * a;
  return [hip[0] + L * Math.cos(t), hip[1] + L * Math.sin(t)];
}
function frame({ sh, hp, kn, an, el, wr, knL, anL, shift = 4 }) {
  const P = (p, s) => [p[0] + s, p[1], 0, 0.99];
  const lm = {};
  const put = (nm, p, pl) => { lm["left_" + nm] = P(pl || p, -shift); lm["right_" + nm] = P(p, shift); };
  put("shoulder", sh); put("hip", hp); put("knee", kn, knL); put("ankle", an, anL);
  put("foot_index", [an[0] + 60, an[1] + 10], anL ? [anL[0] + 60, anL[1] + 10] : null);
  put("heel", [an[0] - 20, an[1] + 10], anL ? [anL[0] - 20, anL[1] + 10] : null);
  put("elbow", el); put("wrist", wr);
  lm.nose = [sh[0] + 20, sh[1] - 60, 0, 0.99];
  return lm;
}
/** Standing figure; trunk lean `trunk` deg forward about the hip, arm elevation, elbow flexion. */
function stand({ trunk = 0, elev = 0, flex = 0, hipY = 550 } = {}) {
  const hp = [640, hipY], an = [640, 950], kn = knee(hp, an);
  const sh = add(hp, 250, 180 - trunk);       // up and forward
  const el = add(sh, 150, elev), wr = add(el, 140, elev + flex);
  return frame({ sh, hp, kn, an, el, wr });
}
const reps = (n, per, fn, rest = 15) => {
  const out = [];
  for (let i = 0; i < 20; i++) out.push(fn(0));
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < per; i++) out.push(fn(Math.sin(Math.PI * i / per), r));
    for (let i = 0; i < rest; i++) out.push(fn(0, r));
  }
  return Object.fromEntries(out.map((p, i) => [i, p]));
};
const run = (activity, poses) => analyse(poses, 30, { activity, heightM: 1.8 });

console.log("rep tasks");
const cases = [
  ["curl", (s) => stand({ flex: 10 + 120 * s }), 5, "elbow_range_deg", 120],
  ["ohpress", (s) => stand({ elev: 40 + 130 * s, flex: 110 - 105 * s }), 5, null],
  ["raise", (s) => stand({ elev: 10 + 80 * s, flex: 10 }), 5, "shoulder_range_deg", 80],
  ["row", (s) => stand({ trunk: 50, elev: -50 + 0 * s, flex: 10 + 90 * s }), 4, "elbow_range_deg", 90],
  ["deadlift", (s) => stand({ trunk: 75 * s, elev: 75 * s }), 4, "hip_range_deg", 75],
];
for (const [act, fn, n, key, want] of cases) {
  const res = run(act, reps(n, 40, fn));
  ok(res.reps.length === n, `${act}: ${n} reps`, `got ${res.reps.length}`);
  if (key) ok(Math.abs(res.reps[0][key] - want) < 12, `${act}: ${key} ~ ${want}`, `got ${res.reps[0] && res.reps[0][key]}`);
  const still = run(act, reps(0, 40, fn, 120));
  ok(still.reps.length === 0, `${act}: still clip counts nothing`, `got ${still.reps.length}`);
  gradeReps(res);
  ok(res.reps.every((r) => r.quality), `${act}: every rep graded`);
}

console.log("glute bridge (lying)");
{
  const fn = (s) => {
    const sh = [300, 900], kn = [800, 750], an = [950, 900];
    const hp = [550, 920 - 95 * s];
    return frame({ sh, hp, kn, an, el: [300, 960], wr: [420, 960] });
  };
  const res = run("bridge", reps(4, 40, fn));
  ok(res.reps.length === 4, "bridge: 4 reps", `got ${res.reps.length}`);
  ok(res.reps[0].hip_flex_top_deg < 8, "bridge: straight line at the top", `got ${res.reps[0].hip_flex_top_deg}`);
}

console.log("lunge (alternating legs)");
{
  const fn = (s, r = 0) => {
    const leftFront = r % 2 === 0;
    const hp = [640, 600 + 120 * s];
    const front = [820, 950], back = [460, 950];
    const knF = knee(hp, front, 200, 1), knB = knee(hp, back, 200, -1);
    const sh = add(hp, 250, 180);
    return frame({ sh, hp, el: add(sh, 150, 0), wr: add(sh, 290, 0),
                   kn: leftFront ? knB : knF, an: leftFront ? back : front,
                   knL: leftFront ? knF : knB, anL: leftFront ? front : back });
  };
  const res = run("lunge", reps(4, 40, fn));
  ok(res.reps.length === 4, "lunge: 4 reps", `got ${res.reps.length}`);
  ok(res.reps.map((r) => r.stance_side).join("") === "lrlr", "lunge: front leg per rep", res.reps.map((r) => r.stance_side).join(""));
}

console.log("holds");
{
  const plank = () => frame({ sh: [950, 780], hp: [650, 790], kn: [480, 795], an: [300, 800],
                              el: [950, 880], wr: [1080, 880] });
  const poses = {};
  for (let i = 0; i < 30; i++) poses[i] = stand();
  for (let i = 30; i < 30 + 150; i++) poses[i] = plank();
  for (let i = 180; i < 210; i++) poses[i] = stand();
  for (const act of ["plank", "sideplank"]) {
    const res = run(act, poses);
    ok(res.reps.length === 1, `${act}: one hold`, `got ${res.reps.length}`);
    ok(Math.abs(res.reps[0].hold_s - 5) < 0.5, `${act}: ~5 s`, `got ${res.reps[0] && res.reps[0].hold_s}`);
  }
  const wall = () => frame({ sh: [640, 450], hp: [640, 700], kn: [840, 700], an: [840, 950],
                             el: [640, 600], wr: [700, 650] });
  const w = {};
  for (let i = 0; i < 120; i++) w[i] = wall();
  const res = run("wallsit", w);
  ok(res.reps.length === 1 && Math.abs(res.reps[0].knee_flex_mean_deg - 90) < 5, "wall sit: one hold at ~90 deg",
     `got ${res.reps.length} ${res.reps[0] && res.reps[0].knee_flex_mean_deg}`);
  const short = {};
  for (let i = 0; i < 40; i++) short[i] = plank();
  ok(run("plank", short).reps.length === 0, "plank: under 2 s is not a hold");
}

for (const a of ["plank", "sideplank", "wallsit", "deadlift", "lunge", "bridge", "ohpress", "curl", "row", "raise"]) {
  ok(ACTIVITIES[a] && ACTIVITIES[a].openChain, `${a}: registered, angles and timing only`);
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
