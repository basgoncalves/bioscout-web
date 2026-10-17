/* BioFeedback (testing) -- camera pose -> one joint metric -> threshold ->
 * an Arduino lamp over Web Serial.
 *
 * The Arduino side is assets/arduino/biofeedback_lamp.ino: it reads '1'/'0'
 * at the chosen baud and switches pin 13 (and a relay on pin 7).
 *
 * Web Serial exists only in Chromium desktop browsers (Chrome, Edge, Opera)
 * over https or localhost; elsewhere the screen still runs and shows the
 * light on screen, it just cannot reach a board.
 *
 * Angles come from MediaPipe WORLD landmarks (metres, 3D, hip-centred), so
 * they do not depend on how the person stands relative to the camera the way
 * 2D image angles do. They are camera estimates, not motion capture.
 */

import { flashUno } from "./stk500.js";
import { makeStepDetector, startMotion } from "./phonemotion.js";
import { measure as measureSegs, summarise as summariseSegs, constrain as constrainSegs, fromOsim, SEGS } from "./bodyscale.js";
import { bodyMapHTML, REGIONS } from "./bodymap.js";
import { loadForceModel, predictForces } from "./forces.js";
import { makeZip } from "./zip.js";
import { jointLoadSVG } from "./jointload.js";

const L = { sh: [11, 12], el: [13, 14], wr: [15, 16], hip: [23, 24], kn: [25, 26], an: [27, 28] };
const side = (s) => (s === "R" ? 1 : 0);
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
function ang(a, b, c) {           // angle at b, degrees, 3D
  const u = sub(a, b), v = sub(c, b);
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const m = Math.hypot(...u) * Math.hypot(...v);
  return m < 1e-9 ? NaN : (Math.acos(Math.max(-1, Math.min(1, d / m))) * 180) / Math.PI;
}
const midp = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/* Each metric: i18n label key, unit, and either
 *   f(world, img)  -> a LIVE value every frame (angles), or
 *   ev: true       -> an EVENT value, produced once per jump / shot by the
 *                     detectors below; the lamp then flashes for PULSE_MS.
 * Flexion is 180 - included angle so standing straight reads ~0. */
const knee = (w, s) => 180 - ang(w[L.hip[s]], w[L.kn[s]], w[L.an[s]]);
const hipF = (w, s) => 180 - ang(w[L.sh[s]], w[L.hip[s]], w[L.kn[s]]);
const elbF = (w, s) => 180 - ang(w[L.sh[s]], w[L.el[s]], w[L.wr[s]]);
const shEl = (w, s) => ang(w[L.hip[s]], w[L.sh[s]], w[L.el[s]]);
const ankD = (w, s) => 90 - ang(w[L.kn[s]], w[L.an[s]], w[31 + s]);   // knee-ankle-toe; ~0 standing
function trunk(w) {               // vs vertical; world y points down
  const s = midp(w[11], w[12]), h = midp(w[23], w[24]);
  const v = sub(s, h), m = Math.hypot(...v);
  return m < 1e-9 ? NaN : (Math.acos(Math.max(-1, Math.min(1, -v[1] / m))) * 180) / Math.PI;
}
const DEG = "°";
/* Knee frontal-plane projection angle (FPPA), 2D on the IMAGE, front camera:
 * 180 - the hip-knee-ankle angle drawn on the screen, positive when the knee
 * sits inside (towards the midline of) the hip-ankle line = valgus, negative
 * = varus. Deliberately NOT the 3D estimate: MediaPipe's 3D frontal knee
 * carries a ~-19 deg bias (McDonnell 2026, see the MSK review). The 2D FPPA
 * is the clinical video measure; it still depends on the camera facing the
 * person square-on, so it is shown as a testing metric. */
let ASPECT = 16 / 9;
function fppa(img, s) {
  if (!img) return NaN;
  const H = img[23 + s], K = img[25 + s], A = img[27 + s];
  const X = (p) => p.x * ASPECT;
  const u = [X(H) - X(K), H.y - K.y], v = [X(A) - X(K), A.y - K.y];
  const m = Math.hypot(...u) * Math.hypot(...v); if (m < 1e-9) return NaN;
  const a = 180 - (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / m))) * 180) / Math.PI;
  // which side of the hip->ankle line is the knee, relative to the pelvis centre?
  const t = (K.y - H.y) / ((A.y - H.y) || 1e-9), xl = X(H) + t * (X(A) - X(H));
  const mid = (X(img[23]) + X(img[24])) / 2;
  return Math.abs(X(K) - mid) < Math.abs(xl - mid) ? a : -a;
}
/* Hand-held / bar load per side (kg) and body mass, set by the page. Used for
 * the static arm moments below and to scale the per-side model loads. */
export const EXT = { L: 0, R: 0, body: 75, t: NaN };   // t: frame time (s), set by the page
const G0 = 9.80665;
/* Arm moments with the movement's speed in them: each mass (upper arm,
 * forearm+hand, the load in the hand) needs a force m*(a - g) to move as it
 * does, and the joint moment is the sum of r x m*(a - g) about the joint
 * (Newton-Euler with point masses; segment spin inertia left out). Standing
 * still (a = 0) gives the old gravity-only lever-arm value. MediaPipe world
 * axes: metres, y pointing DOWN, so gravity is +y. Accelerations come from
 * smoothed landmark positions over ~0.1 s and are capped, because camera
 * landmarks are noisy. */
const ACC = new Map();
function accel(key, p) {
  const t = EXT.t; if (!Number.isFinite(t)) return { x: 0, y: 0, z: 0 };
  let h = ACC.get(key); if (!h) ACC.set(key, (h = []));
  const last = h[h.length - 1];
  if (!last || last.t !== t) {
    if (last && t - last.t > 0.5) h.length = 0;                 // a pause: start again
    const prev = h[h.length - 1], a = 0.25;                     // position smoothing (camera jitter)
    h.push(prev ? { t, x: prev.x + a * (p.x - prev.x), y: prev.y + a * (p.y - prev.y), z: prev.z + a * (p.z - prev.z) } : { t, x: p.x, y: p.y, z: p.z });
    while (h.length > 2 && h[0].t < t - 0.4) h.shift();
  }
  const p0 = h[h.length - 1];
  const p1 = [...h].reverse().find((q) => p0.t - q.t >= 0.09);
  const p2 = p1 && [...h].reverse().find((q) => p1.t - q.t >= 0.09);
  if (!p2) return { x: 0, y: 0, z: 0 };
  const raw = {};
  for (const c of ["x", "y", "z"]) {
    const v1 = (p0[c] - p1[c]) / (p0.t - p1.t), v2 = (p1[c] - p2[c]) / (p1.t - p2.t);
    let a = (v1 - v2) / ((p0.t - p2.t) / 2);
    a = Math.abs(a) < 0.8 ? 0 : a;                              // below ~0.8 m/s2 it is jitter, not movement
    raw[c] = Math.max(-20, Math.min(20, a));
  }
  // the acceleration itself is smoothed too, once per frame
  const sk = key + ":a", sp = ACC.get(sk);
  if (sp && sp.t === t) return sp.v;
  const v = sp ? { x: sp.v.x + 0.3 * (raw.x - sp.v.x), y: sp.v.y + 0.3 * (raw.y - sp.v.y), z: sp.v.z + 0.3 * (raw.z - sp.v.z) } : raw;
  ACC.set(sk, { t, v }); return v;
}
const lerp = (A, B, f) => ({ x: A.x + f * (B.x - A.x), y: A.y + f * (B.y - A.y), z: A.z + f * (B.z - A.z) });
/* |sum r x m(a - g)| about joint J for masses [{p, m, key}] */
function jointMoment(J, masses) {
  let Mx = 0, My = 0, Mz = 0;
  for (const { p, m, key } of masses) {
    if (!(m > 0)) continue;
    const a = accel(key, p), r = { x: p.x - J.x, y: p.y - J.y, z: p.z - J.z };
    const F = { x: m * a.x, y: m * (a.y - G0), z: m * a.z };
    Mx += r.y * F.z - r.z * F.y; My += r.z * F.x - r.x * F.z; Mz += r.x * F.y - r.y * F.x;
  }
  return Math.hypot(Mx, My, Mz);
}
function elbMom(w, s) {
  const E = w[L.el[s]], W = w[L.wr[s]];
  return jointMoment(E, [{ p: lerp(E, W, 0.682), m: 0.022 * EXT.body, key: "fa" + s }, { p: W, m: EXT["LR"[s]], key: "wr" + s }]);
}
function shMom(w, s) {
  const S = w[L.sh[s]], E = w[L.el[s]], W = w[L.wr[s]];
  return jointMoment(S, [{ p: lerp(S, E, 0.436), m: 0.028 * EXT.body, key: "ua" + s },
    { p: lerp(E, W, 0.682), m: 0.022 * EXT.body, key: "fa" + s }, { p: W, m: EXT["LR"[s]], key: "wr" + s }]);
}
export const METRICS = {
  kneeFlexL: { label: "bfb_m_kneeFlexL", unit: DEG, f: (w) => knee(w, 0) },
  kneeFlexR: { label: "bfb_m_kneeFlexR", unit: DEG, f: (w) => knee(w, 1) },
  hipFlexL:  { label: "bfb_m_hipFlexL",  unit: DEG, f: (w) => hipF(w, 0) },
  hipFlexR:  { label: "bfb_m_hipFlexR",  unit: DEG, f: (w) => hipF(w, 1) },
  valgusL:   { label: "bfb_m_valgusL",   unit: DEG, f: (w, img) => fppa(img, 0) },
  valgusR:   { label: "bfb_m_valgusR",   unit: DEG, f: (w, img) => fppa(img, 1) },
  ankleDFL:  { label: "bfb_m_ankleDFL",  unit: DEG, f: (w) => ankD(w, 0) },
  ankleDFR:  { label: "bfb_m_ankleDFR",  unit: DEG, f: (w) => ankD(w, 1) },
  elbowFlexL:{ label: "bfb_m_elbowFlexL",unit: DEG, f: (w) => elbF(w, 0) },
  elbowFlexR:{ label: "bfb_m_elbowFlexR",unit: DEG, f: (w) => elbF(w, 1) },
  shAbdL:    { label: "bfb_m_shAbdL",    unit: DEG, f: (w) => shEl(w, 0) },
  shAbdR:    { label: "bfb_m_shAbdR",    unit: DEG, f: (w) => shEl(w, 1) },
  trunkLean: { label: "bfb_m_trunkLean", unit: DEG, f: (w) => trunk(w) },
  /* Neck: from the shoulders up only, so it works seated at a desk with the
   * hips out of view. Forward head = ears ahead of / below the shoulder line,
   * as the angle of shoulder-centre -> ear-centre from vertical (press Zero
   * in your neutral posture; the camera's tilt adds to it). */
  neckFlex:  { label: "bfb_m_neckFlex",  unit: DEG, f: (w) => {
    const sh = midp(w[11], w[12]), ear = midp(w[7], w[8]);
    const v = sub(ear, sh), m = Math.hypot(...v);
    return m < 1e-9 ? NaN : (Math.acos(Math.max(-1, Math.min(1, -v[1] / m))) * 180) / Math.PI;
  } },
  /* Head orientation. With the Face Landmarker running (478 face points,
   * facial transformation matrix) these are true 3D head angles; without it
   * they fall back to the pose model's ears and nose. */
  headNod:   { label: "bfb_m_headNod",   unit: DEG, face: true, f: (w, img, hd) =>   // looking down = positive
    hd ? hd.pitch : 90 - ang(midp(w[11], w[12]), midp(w[7], w[8]), w[0]) },
  neckTilt:  { label: "bfb_m_neckTilt",  unit: DEG, face: true, f: (w, img, hd) => {
    if (hd) return Math.abs(hd.roll);
    const e = sub(w[8], w[7]), s2 = sub(w[12], w[11]);
    return Math.abs((Math.atan2(e[1], Math.hypot(e[0], e[2])) - Math.atan2(s2[1], Math.hypot(s2[0], s2[2]))) * 180 / Math.PI);
  } },
  headTurn:  { label: "bfb_m_headTurn",  unit: DEG, face: true, f: (w, img, hd) => (hd ? Math.abs(hd.yaw) : NaN) },
  // left + right together: two bars, two plot lines, lamp when EITHER side crosses
  kneeFlex:  { label: "bfb_m_kneeFlex",  unit: DEG, pair: ["kneeFlexL", "kneeFlexR"] },
  hipFlex:   { label: "bfb_m_hipFlex",   unit: DEG, pair: ["hipFlexL", "hipFlexR"] },
  ankleDF:   { label: "bfb_m_ankleDF",   unit: DEG, pair: ["ankleDFL", "ankleDFR"] },
  elbowFlex: { label: "bfb_m_elbowFlex", unit: DEG, pair: ["elbowFlexL", "elbowFlexR"] },
  shAbd:     { label: "bfb_m_shAbd",     unit: DEG, pair: ["shAbdL", "shAbdR"] },
  elbMomL:   { label: "bfb_m_elbMomL", unit: "Nm", max: 120, f: (w) => elbMom(w, 0) },
  elbMomR:   { label: "bfb_m_elbMomR", unit: "Nm", max: 120, f: (w) => elbMom(w, 1) },
  shMomL:    { label: "bfb_m_shMomL",  unit: "Nm", max: 200, f: (w) => shMom(w, 0) },
  shMomR:    { label: "bfb_m_shMomR",  unit: "Nm", max: 200, f: (w) => shMom(w, 1) },
  elbMom:    { label: "bfb_m_elbMom",  unit: "Nm", max: 120, pair: ["elbMomL", "elbMomR"] },
  shMom:     { label: "bfb_m_shMom",   unit: "Nm", max: 200, pair: ["shMomL", "shMomR"] },
  valgus:    { label: "bfb_m_valgus",    unit: DEG, pair: ["valgusL", "valgusR"] },
  /* Model estimates (data/force_model_v2.json, the app's static-optimisation
   * surrogate) from the live sagittal angles, in body weights. 4th argument
   * `ld` is the latest prediction; see liveLoads(). Testing: inputs are
   * camera angles only, and the surrogate was trained on a gait cohort. */
  hipJCF:    { label: "bfb_m_hipJCF",    unit: "BW", max: 8, load: true, pair: ["hipJCFL", "hipJCFR"] },
  kneeJCF:   { label: "bfb_m_kneeJCF",   unit: "BW", max: 8, load: true, pair: ["kneeJCFL", "kneeJCFR"] },
  ankleJCF:  { label: "bfb_m_ankleJCF",  unit: "BW", max: 8, load: true, pair: ["ankleJCFL", "ankleJCFR"] },
  quadsF:    { label: "bfb_m_quadsF",    unit: "BW", max: 8, load: true, pair: ["quadsFL", "quadsFR"] },
  glutesF:   { label: "bfb_m_glutesF",   unit: "BW", max: 8, load: true, pair: ["glutesFL", "glutesFR"] },
  hamsF:     { label: "bfb_m_hamsF",     unit: "BW", max: 8, load: true, pair: ["hamsFL", "hamsFR"] },
  calvesF:   { label: "bfb_m_calvesF",   unit: "BW", max: 8, load: true, pair: ["calvesFL", "calvesFR"] },
  /* Bar path (squat: bar on the shoulders; deadlift: bar in the hands),
   * from the image, scaled to metres by the athlete's height. 5th argument
   * `bb` = { y: height above the ankles (cm), x: ahead of mid-foot (cm),
   * v: vertical velocity (m/s), p: bar power (W) }. */
  barY:      { label: "bfb_m_barY",      unit: "cm", max: 250, bar: true, f: (w, img, hd, ld, bb) => (bb ? bb.y : NaN) },
  barX:      { label: "bfb_m_barX",      unit: "cm", max: 40, bar: true, f: (w, img, hd, ld, bb) => (bb ? bb.x : NaN) },
  barVel:    { label: "bfb_m_barVel",    unit: "m/s", max: 3, bar: true, f: (w, img, hd, ld, bb) => (bb ? bb.v : NaN) },
  barPow:    { label: "bfb_m_barPow",    unit: "W", max: 3000, bar: true, f: (w, img, hd, ld, bb) => (bb ? bb.p : NaN) },
  // countermovement jump -- one value per jump
  jumpHeight:{ label: "bfb_m_jumpHeight",unit: "cm", ev: true, max: 80 },
  flightTime:{ label: "bfb_m_flightTime",unit: "ms", ev: true, max: 1000 },
  cmKnee:    { label: "bfb_m_cmKnee",    unit: DEG, ev: true },
  cmHip:     { label: "bfb_m_cmHip",     unit: DEG, ev: true },
  cmAnkle:   { label: "bfb_m_cmAnkle",   unit: DEG, ev: true },
  landKnee:  { label: "bfb_m_landKnee",  unit: DEG, ev: true },
  // jump shot -- one value per shot, taken at release (shooting hand highest)
  shotElbow: { label: "bfb_m_shotElbow", unit: DEG, ev: true },
  shotShoulder:{ label: "bfb_m_shotShoulder", unit: DEG, ev: true },
  shotKnee:  { label: "bfb_m_shotKnee",  unit: DEG, ev: true },
  shotTrunk: { label: "bfb_m_shotTrunk", unit: DEG, ev: true },
  shotJump:  { label: "bfb_m_shotJump",  unit: "cm", ev: true, max: 80 },
};

for (const [k, lab] of [["hipJCF"], ["kneeJCF"], ["ankleJCF"], ["quadsF"], ["glutesF"], ["hamsF"], ["calvesF"]]) {
  for (const sd of ["L", "R"]) {
    METRICS[k + sd] = { label: METRICS[k].label, unit: "BW", max: 8, load: true, side: true,
                        f: (w, img, hd, ld) => (ld ? ld[k + sd] : NaN) };
  }
}
/* Arduino analog inputs A0-A5 as metrics (0-1023, "raw"), so a threshold can
 * watch a sensor. AN_LIVE is filled from the board's "AN ..." / "F ..." lines. */
export const AN_LIVE = [NaN, NaN, NaN, NaN, NaN, NaN];
export const AN_KEYS = [0, 1, 2, 3, 4, 5].map((i) => "an" + i);
for (let i = 0; i < 6; i++) METRICS["an" + i] = { label: "bfb_mAn" + i, unit: "raw", max: 1023, an: i, f: () => AN_LIVE[i] };
/* Running from the phone's accelerometer (src/phonemotion.js): cadence,
 * impact peak and step time, filled by the motion loop into PH_LIVE. */
export const PH_LIVE = { cadence: NaN, impact: NaN, stepTime: NaN, acc: NaN };
METRICS.runCadence = { label: "bfb_m_runCad", unit: "spm", max: 220, phone: true, f: () => PH_LIVE.cadence };
METRICS.runImpact = { label: "bfb_m_runImp", unit: "g", max: 6, phone: true, f: () => PH_LIVE.impact };
METRICS.runStepTime = { label: "bfb_m_runStep", unit: "ms", max: 800, phone: true, f: () => PH_LIVE.stepTime };
METRICS.accMag = { label: "bfb_m_acc", unit: "g", max: 4, phone: true, f: () => PH_LIVE.acc };
/* With "Use phone accelerometer" these are the metrics, whatever the movement. */
export const PHONE_KEYS = ["runCadence", "runImpact", "runStepTime", "accMag"];
export const LOAD_KEYS = ["hipJCF", "kneeJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"];

/* Movement presets: which metrics make sense and a starting threshold. */
export const MOVES = {
  squat:  { label: "bfb_mv_squat",  bar: "shoulders", wt: true, metrics: ["kneeFlex", "valgus", "hipFlex", "ankleDF", "trunkLean", "barY", "barX", "barVel", "barPow", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "kneeFlex", thr: 70, dir: "above" },
  deadlift:{ label: "bfb_mv_deadlift", bar: "hands", wt: true, metrics: ["trunkLean", "hipFlex", "kneeFlex", "shMom", "barY", "barX", "barVel", "barPow", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "trunkLean", thr: 60, dir: "above" },
  pullup: { label: "bfb_mv_pullup", metrics: ["elbowFlex", "shAbd"], def: "elbowFlex", thr: 100, dir: "above" },
  slsquat:{ label: "bfb_mv_slsquat", wt: true, metrics: ["kneeFlex", "valgus", "hipFlex", "ankleDF", "trunkLean", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "kneeFlex", thr: 60, dir: "above" },
  sj:     { label: "bfb_mv_sj",     metrics: ["jumpHeight", "flightTime", "cmKnee", "cmHip", "cmAnkle", "landKnee", "kneeFlex", "hipFlex", "ankleDF", "trunkLean", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "kneeFlex", thr: 90, dir: "above" },
  cmj:    { label: "bfb_mv_cmj",    metrics: ["jumpHeight", "flightTime", "cmKnee", "cmHip", "cmAnkle", "landKnee", "kneeFlex", "hipFlex", "ankleDF", "trunkLean", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "kneeFlex", thr: 90, dir: "above" },
  shot:   { label: "bfb_mv_shot",   metrics: ["shotElbow", "shotShoulder", "shotKnee", "shotTrunk", "shotJump", "elbowFlex", "shAbd", "kneeFlex", "trunkLean"], def: "elbowFlex", thr: 20, dir: "below" },
  kick:   { label: "bfb_mv_kick",   metrics: ["hipFlex", "kneeFlex", "trunkLean", "ankleDF", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "hipFlex", thr: 60, dir: "above" },
  stroke: { label: "bfb_mv_stroke", metrics: ["shAbd", "elbowFlex", "trunkLean", "kneeFlex", "hipFlex"], def: "shAbd", thr: 90, dir: "above" },
  lunge:  { label: "bfb_mv_lunge", wt: true, metrics: ["kneeFlex", "valgus", "hipFlex", "trunkLean", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "kneeFlex", thr: 80, dir: "above" },
  hinge:  { label: "bfb_mv_hinge", wt: true, metrics: ["trunkLean", "hipFlex", "kneeFlex", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "trunkLean", thr: 45, dir: "above" },
  pushup: { label: "bfb_mv_pushup", metrics: ["elbowFlex", "hipFlex"], def: "elbowFlex", thr: 90, dir: "above" },
  dip:    { label: "bfb_mv_dip",    metrics: ["elbowFlex", "trunkLean"], def: "elbowFlex", thr: 90, dir: "above" },
  ohpress:{ label: "bfb_mv_ohpress", wt: true, metrics: ["shAbd", "elbowFlex", "shMom", "elbMom", "trunkLean"], def: "shAbd", thr: 160, dir: "above" },
  curl:   { label: "bfb_mv_curl", wt: true, metrics: ["elbowFlex", "elbMom", "shMom"], def: "elbowFlex", thr: 110, dir: "above" },
  row:    { label: "bfb_mv_row", wt: true, metrics: ["elbowFlex", "elbMom", "shMom", "trunkLean", "hipFlex"], def: "elbowFlex", thr: 90, dir: "above" },
  raise:  { label: "bfb_mv_raise", wt: true, metrics: ["shAbd", "shMom", "elbMom"], def: "shAbd", thr: 90, dir: "above" },
  bridge: { label: "bfb_mv_bridge", wt: true, metrics: ["hipFlex", "kneeFlex", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "hipFlex", thr: 15, dir: "below" },
  plank:  { label: "bfb_mv_plank",  metrics: ["hipFlex", "neckFlex"], def: "hipFlex", thr: 15, dir: "above" },
  heelraise:{ label: "bfb_mv_heelraise", wt: true, metrics: ["ankleDF", "kneeFlex", "kneeJCF", "hipJCF", "ankleJCF", "quadsF", "glutesF", "hamsF", "calvesF"], def: "ankleDF", thr: -15, dir: "below" },
  neck:   { label: "bfb_mv_neck",   metrics: ["neckFlex", "headNod", "neckTilt", "headTurn", "trunkLean"], def: "neckFlex", thr: 20, dir: "above" },
  free:   { label: "bfb_mv_free",   metrics: [], def: "kneeFlex", thr: 70, dir: "above" },
};
/* Free = every live metric once: a left/right pair is ONE entry (both bars),
 * never its single-side halves again. */
{
  const halves = new Set(Object.values(METRICS).flatMap((m) => m.pair || []));
  MOVES.free.metrics = Object.keys(METRICS).filter((k) => !METRICS[k].ev && !METRICS[k].side && !halves.has(k) && !METRICS[k].bar && !METRICS[k].phone);
}
/* Movements scored per event (jump / shot): their table rows come from the
 * event detectors only, not from the cycle finder as well. */
const EVENT_MOVES = new Set(["cmj", "sj", "shot"]);
/* Hysteresis default per unit: 3 deg is sensible, 3 body weights is not. */
const HYST = { spm: 3, g: 0.15, raw: 10, "°": 3, BW: 0.3, cm: 2, ms: 30, "m/s": 0.05, W: 50, Nm: 3 };

/* Bar tracker. Scale: nose-to-ankle is ~0.89 of standing height, learnt
 * only while standing tall (knees nearly straight) so a squat does not
 * shrink the ruler. Position from the image, velocity from a short
 * least-squares slope (less jittery than frame differences). */
export function makeBarTracker() {
  let pxPerM = NaN; const hist = [];
  return {
    reset() { pxPerM = NaN; hist.length = 0; },
    step(ts, img, W, H, where, heightM, kneeFlexDeg, loadKg) {
      const P = (p) => [p.x * W, p.y * H];
      const [, ny] = P(img[0]), ank = [P(img[27]), P(img[28])], toe = [P(img[31]), P(img[32])];
      const ay = (ank[0][1] + ank[1][1]) / 2;
      if (kneeFlexDeg < 15 && ay > ny) {
        const s = (ay - ny) / (0.89 * heightM);
        pxPerM = Number.isFinite(pxPerM) ? pxPerM + 0.05 * (s - pxPerM) : s;
      }
      if (!Number.isFinite(pxPerM)) return null;
      const pt = where === "hands" ? [(img[15].x + img[16].x) / 2 * W, (img[15].y + img[16].y) / 2 * H]
                                   : [(img[11].x + img[12].x) / 2 * W, (img[11].y + img[12].y) / 2 * H];
      const midX = (ank[0][0] + ank[1][0] + toe[0][0] + toe[1][0]) / 4;
      const fwd = Math.sign((toe[0][0] + toe[1][0]) - (ank[0][0] + ank[1][0])) || 1;   // which way the feet point
      const y = (ay - pt[1]) / pxPerM, x = fwd * (pt[0] - midX) / pxPerM;
      hist.push([ts / 1000, y]); while (hist.length && hist[0][0] < ts / 1000 - 0.2) hist.shift();
      let v = NaN;
      if (hist.length >= 3) {
        const n = hist.length, mt = hist.reduce((a, h) => a + h[0], 0) / n, my = hist.reduce((a, h) => a + h[1], 0) / n;
        let num = 0, den = 0; for (const [t, yy] of hist) { num += (t - mt) * (yy - my); den += (t - mt) ** 2; }
        v = den > 0 ? num / den : NaN;
      }
      return { y: y * 100, x: x * 100, v, p: loadKg > 0 && Number.isFinite(v) ? loadKg * 9.80665 * v : NaN, raw: pt };
    },
  };
}


const PULSE_MS = 1500;

/* Body map: muscle group -> the BioFeedback movements that load it. Sports
 * movements sit with every group they mainly drive (a jump shot is legs,
 * glutes, shoulders and triceps), so tapping calves offers it too. */
export const REGION_MOVES = {
  neck: ["neck"],
  shoulders: ["ohpress", "raise", "pushup", "dip", "shot", "stroke"],
  chest: ["pushup", "dip"],
  back: ["deadlift", "pullup", "row", "hinge", "stroke"],
  biceps: ["curl", "pullup", "row"],
  triceps: ["pushup", "dip", "ohpress", "shot"],
  core: ["plank", "deadlift", "bridge", "hinge", "stroke", "kick"],
  glutes: ["squat", "deadlift", "slsquat", "sj", "cmj", "shot", "kick", "lunge", "bridge", "hinge"],
  quads: ["squat", "slsquat", "sj", "cmj", "shot", "kick", "lunge"],
  hamstrings: ["deadlift", "hinge", "bridge", "cmj", "sj", "kick"],
  calves: ["heelraise", "sj", "cmj", "shot"],
};
export const regionsOfMove = (mv) => REGIONS.filter((r) => (REGION_MOVES[r] || []).includes(mv));

/* Jump + shot detectors on the IMAGE landmarks (normalised, y down).
 * Take-off = ankles rise more than 7% of leg length above the learnt floor
 * for 2 frames; landing = back within 3%. Height from flight time,
 * h = g t^2 / 8 -- the same flight-time estimate the recorder's jump table
 * uses, and with the same caveat: it overestimates if the knees tuck.
 * Shot release = shooting wrist at its highest while above the nose. */
export function makeDetectors(emit) {
  const buf = [];                       // {ts, knee, hip, ank}
  const jumps = [];                     // finished jumps {t0, t1, h}
  const pend = [];                      // {at, fn} finalisers due later
  let gnd = NaN, Lg = NaN, air = false, up = 0, t0 = 0, best = null, lastShot = -1e9, lastLow = -1e9;
  const avg = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(a) ? a : b);
  const peak = (k, a, b) => buf.reduce((m, f) => (f.ts >= a && f.ts <= b && f[k] > m ? f[k] : m), -Infinity);
  return function step(ts, img, w) {
    const kn = avg(knee(w, 0), knee(w, 1)), hp = avg(hipF(w, 0), hipF(w, 1)), ak = avg(ankD(w, 0), ankD(w, 1));
    buf.push({ ts, knee: kn, hip: hp, ank: ak });
    while (buf.length && buf[0].ts < ts - 4000) buf.shift();
    const ay = (img[27].y + img[28].y) / 2, hy = (img[23].y + img[24].y) / 2;
    // ---- jump ----
    if (!air) {
      const leg = Math.abs(ay - hy);
      Lg = Number.isFinite(Lg) ? Lg + 0.05 * (leg - Lg) : leg;
      if (!Number.isFinite(gnd) || ay > gnd) gnd = ay;                    // floor can only be lower...
      else if (Math.abs(ay - gnd) < 0.03 * Lg) gnd += 0.05 * (ay - gnd);  // ...or drift slowly
      if (ay < gnd - 0.07 * Lg) { if (++up === 1) t0 = ts; if (up >= 2) air = true; } else up = 0;
    } else if (ay > gnd - 0.03 * Lg || ts - t0 > 1500) {
      air = false; up = 0;
      const t1 = ts, fl = (t1 - t0) / 1000;
      if (fl > 0.12 && fl < 1.0) {
        const h = (9.81 * fl * fl / 8) * 100;
        jumps.push({ t0, t1, h }); if (jumps.length > 10) jumps.shift();
        const j0 = t0;
        pend.push({ at: t1 + 500, fn: () => emit({
          jumpHeight: h, flightTime: fl * 1000,
          cmKnee: peak("knee", j0 - 1500, j0), cmHip: peak("hip", j0 - 1500, j0),
          cmAnkle: peak("ank", j0 - 1500, j0), landKnee: peak("knee", t1, t1 + 500),
        }) });
      }
    }
    // ---- shot ----
    const s = img[15].y < img[16].y ? 0 : 1, wy = img[15 + s].y;
    /* One shot = the hand came up from below the shoulder within 2.5 s and
     * at least 1.5 s after the previous shot. Without these, a hand hovering
     * above the head (or video jitter) was counted as several shots a second. */
    if (Math.min(img[15].y, img[16].y) > Math.min(img[11].y, img[12].y)) lastLow = ts;
    if (wy < img[0].y && ts - lastLow < 2500 && ts - lastShot > 1500) {
      if (!best || wy < best.y) best = { y: wy, ts, elb: elbF(w, s), sh: shEl(w, s), tr: trunk(w) };
    }
    if (best && (wy > best.y + 0.08 * Lg || wy > img[0].y)) {
      const r = best; best = null; lastShot = r.ts;
      pend.push({ at: r.ts + 700, fn: () => {
        const j = jumps.filter((x) => x.t0 > r.ts - 1000 && x.t0 < r.ts + 300).pop();
        const dip = peak("knee", r.ts - 1500, r.ts);
        if (!j && !(dip > 20)) return;      // a shot has a leg drive: a dip or a jump, not just a raised hand
        emit({ shotElbow: r.elb, shotShoulder: r.sh, shotTrunk: r.tr,
               shotKnee: peak("knee", r.ts - 1500, r.ts), shotJump: j ? j.h : 0 });
      } });
    }
    for (let i = pend.length - 1; i >= 0; i--) if (ts >= pend[i].at) { pend[i].fn(); pend.splice(i, 1); }
  };
}

const SKEL = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const SKEY = "bioscout.biofeedback.v1";

/* Face Landmarker for head pose. The model is served from the repo if
 * assets/face_landmarker.task exists, otherwise fetched once from Google's
 * model bucket (testing feature). */
const FACE_LOCAL = "assets/face_landmarker.task";
const FACE_REMOTE = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
async function makeFace() {
  const mp = await import("../assets/vendor/vision_bundle.mjs");
  const fs = await mp.FilesetResolver.forVisionTasks("./assets/vendor/wasm");
  let path = FACE_REMOTE;
  try { const r = await fetch(FACE_LOCAL, { method: "HEAD" }); if (r.ok) path = FACE_LOCAL; } catch { /* use remote */ }
  const opts = (delegate) => ({ baseOptions: { modelAssetPath: path, delegate }, runningMode: "VIDEO", numFaces: 1,
    outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
  try { return await mp.FaceLandmarker.createFromOptions(fs, opts("GPU")); }
  catch { return mp.FaceLandmarker.createFromOptions(fs, opts("CPU")); }
}
/* Rotation of the face's 4x4 transform (column-major) -> pitch / yaw / roll
 * in degrees. Pitch is positive looking down. */
export function headPose(m) {
  const r00 = m[0], r10 = m[1], r20 = m[2], r21 = m[6], r22 = m[10];
  const d = 180 / Math.PI;
  return { pitch: Math.atan2(r21, r22) * d, yaw: Math.asin(Math.max(-1, Math.min(1, -r20))) * d, roll: Math.atan2(r10, r00) * d };
}

/* Live loads: a rolling window of sagittal angles in the surrogate's
 * coordinates (Rajagopal signs, degrees; pelvis height in metres), the model
 * run on the last few frames ~15 times a second, the last frame read out.
 * Mirrors squatRepCoordinates() in kinematics.js; coordinates the camera
 * cannot give are held at the training mean by buildFeatures(). */
const GROUPS = { quadsF: ["recfem", "vasint", "vaslat", "vasmed"], glutesF: ["glmax", "glmed"],
                 hamsF: ["bflh", "bfsh", "semimem", "semiten"], calvesF: ["gaslat", "gasmed", "soleus"] };
export function liveCoords(w) {
  const c = {};
  for (const [s, i] of [["l", 0], ["r", 1]]) {
    c["hip_flexion_" + s] = Math.max(-20, Math.min(130, hipF(w, i)));
    c["knee_angle_" + s] = Math.max(0, Math.min(145, knee(w, i)));
    c["ankle_angle_" + s] = Math.max(-40, Math.min(40, ankD(w, i)));
  }
  c.lumbar_extension = Math.max(-60, Math.min(30, -trunk(w)));
  const hy = (w[23].y + w[24].y) / 2, ay = (w[27].y + w[28].y) / 2;
  c.pelvis_ty = Math.max(0.3, Math.min(1.3, ay - hy + 0.07));
  return c;
}
export function makeLoadEstimator() {
  let model = null, loading = null, last = 0, out = null;
  const buf = [];
  return {
    ready: () => !!model,
    async load() { if (!model) model = await (loading || (loading = loadForceModel())); return model; },
    push(ts, w, bodyKg = 75, loadKg = 0, heightM = 1.75, side = null) {
      const c = liveCoords(w); if (Object.values(c).some((x) => !Number.isFinite(x))) return out;
      buf.push({ t: ts / 1000, c }); while (buf.length > 9) buf.shift();
      if (!model || buf.length < 5 || ts - last < 66) return out;
      last = ts;
      const coords = {}; for (const k of Object.keys(buf[0].c)) coords[k] = buf.map((b) => b.c[k]);
      /* An external bar is folded in as extra system mass (the surrogate has
       * no separate load input), then everything is expressed in the
       * athlete's OWN body weights. Crude, and said so on the page. */
      const tot = bodyKg + Math.max(0, loadKg), k = tot / bodyKg;
      const r = predictForces(model, coords, buf.length, { massKg: tot, heightM, times: buf.map((b) => b.t) });
      const n = buf.length - 1, bw = bodyKg * 9.80665, o = {};
      r.jrfNames.forEach((nm, i) => {           // hip_r_mag -> hipJCFR
        const [j, sd] = nm.split("_"); o[j + "JCF" + sd.toUpperCase()] = r.jrf[n][i] * k;
      });
      /* Uneven loads (dumbbell in one hand, offset bar): each leg is scaled as
       * if the athlete carried twice THAT side's load, instead of the mean. */
      const ks = { L: k, R: k };
      if (side && loadKg > 0) for (const sd of ["L", "R"]) ks[sd] = (bodyKg + 2 * Math.max(0, side[sd] || 0)) / bodyKg;
      for (const [g, pre] of Object.entries(GROUPS)) for (const sd of ["l", "r"]) {
        let f = 0; r.muscleNames.forEach((nm, i) => { if (nm.endsWith("_" + sd) && pre.some((p) => nm.startsWith(p))) f += r.forces[n][i]; });
        o[g + sd.toUpperCase()] = Math.max(0, f / bw);
      }
      if (side && loadKg > 0) for (const key of Object.keys(o)) {
        o[key] *= ks[key.slice(-1)] / k;
      }
      out = o; return out;
    },
  };
}

/** Wire up #viewBiofeedback. deps: { $, tr, getLandmarker } */
export function initBiofeedback({ $, tr, getLandmarker }) {
  const st = {
    port: null, writer: null, reader: null, lm: null, stream: null, raf: 0,
    active: false, lit: null, value: NaN, lastTs: -1,
  };
  let cfg = { move: "squat", metric: "kneeFlexL", thr: 70, dir: "above", hyst: 3, baud: 9600, invert: false, zero: {}, green: "flash", sound: "beep", src: "camera", facing: "user", extra: [], mass: 75, height: 1.75, load: 0, thr2: null, thr3: null, pins: [13, 12, 11, 8, 7] };
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(SKEY) || "{}") }; } catch { /* private */ }
  /* Load per movement and side: cfg.wt[move] = { L, R } kg. Only movements
   * marked wt take one; a kick or a jump shot never does. */
  if (!cfg.wt) { cfg.wt = {}; if (cfg.load > 0) for (const mv of ["squat", "deadlift"]) cfg.wt[mv] = { L: cfg.load / 2, R: cfg.load / 2 }; }
  const wtOf = (move) => (MOVES[move] && MOVES[move].wt ? { L: 0, R: 0, ...(cfg.wt[move] || {}) } : { L: 0, R: 0 });
  const loadOf = (move) => { const x = wtOf(move); return (+x.L || 0) + (+x.R || 0); };
  const syncExt = () => { const x = wtOf(cfg.move); EXT.L = +x.L || 0; EXT.R = +x.R || 0; EXT.body = cfg.mass || 75; };
  const metOf = (i) => (i > 1 && (cfg.tm || [])[i - 2] && METRICS[cfg.tm[i - 2]] ? cfg.tm[i - 2] : cfg.metric);
  function limOf(k) {                                   // slider range for metric k: default, or what the user set
    const m = METRICS[k] || METRICS.kneeFlexL, d = [m.unit === DEG ? -90 : 0, m.unit === "BW" ? 1000 : m.max || 180];
    const u = (cfg.lim || {})[k]; return u && Number.isFinite(u.min) && Number.isFinite(u.max) && u.max > u.min ? [u.min, u.max] : d;
  }
  const save = () => { try { localStorage.setItem(SKEY, JSON.stringify(cfg)); } catch { /* full */ } };

  const hasSerial = "serial" in navigator;
  const status = (k, vars, bad) => { const e = $("bfbPortStatus"); e.textContent = tr(k, vars); e.classList.toggle("bad", !!bad); };
  const log = (s) => { const e = $("bfbLog"); e.textContent = (s + "\n" + e.textContent).slice(0, 2000); };

  /* ---------- selects ---------- */
  function fillMoves() {
    $("bfbMove").innerHTML = Object.entries(MOVES).map(([k, m]) => `<option value="${k}">${tr(m.label)}</option>`).join("");
    $("bfbMove").value = cfg.move;
  }
  function fillMetrics() {
    const mv = MOVES[cfg.move] || MOVES.free;
    // Only time-varying metrics drive the lamp and the plot; per-jump / per-shot
    // values (jump height, release angles...) go to the table, one row each.
    const live = cfg.src === "phone" ? PHONE_KEYS : mv.metrics.filter((k) => !METRICS[k].ev);
    if (!live.includes(cfg.metric)) cfg.metric = cfg.src === "phone" ? "runCadence" : live.includes(mv.def) ? mv.def : live[0];
    $("bfbMetric").innerHTML = live.map((k) => `<option value="${k}">${tr(METRICS[k].label)}</option>`).join("");
    $("bfbMetric").value = cfg.metric;
  }
  function syncInputs() {
    const m = METRICS[cfg.metric] || METRICS.kneeFlexL;
    for (const i of [1, 2, 3]) {                     // each threshold row: its metric's limits (editable)
      const k = metOf(i), [mn, mx] = limOf(k), mm = METRICS[k], sfx = i === 1 ? "" : i;
      for (const id of ["bfbThr" + sfx, "bfbThrN" + sfx]) { $(id).max = mx; $(id).min = mn; $(id).step = mm.unit === "BW" || mm.unit === "m/s" ? "0.1" : "1"; }
      const box = document.querySelector(`.bfbLim[data-row="${i}"]`);
      if (box) box.innerHTML = `<input type="number" data-lim="min" value="${mn}" title="${esc(tr("bfb_limMin"))}">–<input type="number" data-lim="max" value="${mx}" title="${esc(tr("bfb_limMax"))}"> ${esc(mm.unit)}`;
      if (i > 1) {
        const sel = $("bfbThrMet" + i), live = liveKeys(MOVES[cfg.move] || MOVES.free);
        const opts = [...new Set([...live, ...AN_KEYS])].filter((x) => x !== cfg.metric);
        sel.innerHTML = `<option value="">${esc(tr("bfb_sameMetric"))}</option>` + opts.map((x) => `<option value="${x}">${esc(tr(METRICS[x].label))}</option>`).join("");
        sel.value = (cfg.tm || [])[i - 2] && opts.includes(cfg.tm[i - 2]) ? cfg.tm[i - 2] : "";
      }
    }
    $("bfbUnit").textContent = m.unit;
    $("bfbHint").textContent = [cfg.move === "shot" ? tr("bfb_hintShot") : cfg.move === "cmj" || cfg.move === "sj" ? tr("bfb_hintJump") : "",
      m.load ? tr("bfb_hintLoad") : ""].filter(Boolean).join(" ");
    $("bfbHystUnit").textContent = m.unit;
    $("bfbHyst").step = m.unit === "BW" ? "0.1" : "1";
    $("bfbHyst").disabled = !!m.ev; $("bfbZero").disabled = !!m.ev;
    const zk = m.pair ? m.pair[0] : cfg.metric, z = cfg.zero && cfg.zero[zk];
    $("bfbZeroNote").textContent = z ? tr("bfb_zeroed", { v: z.toFixed(0) }) : "";
    $("bfbValue").textContent = "–"; $("bfbResults").innerHTML = ""; ema = emaL = emaR = NaN; buildBars();
    $("bfbThr").value = cfg.thr; $("bfbThrN").value = cfg.thr;
    for (const i of [2, 3]) {
      const t = cfg["thr" + i], on = Number.isFinite(t);
      $("bfbThrOn" + i).checked = on; $("bfbThr" + i).disabled = $("bfbThrN" + i).disabled = !on;
      $("bfbThr" + i).value = on ? t : cfg.thr; $("bfbThrN" + i).value = on ? t : "";
    }
    renderPick();
    $("bfbMass").value = cfg.mass ?? 75; $("bfbHeight").value = cfg.height ?? 1.75; const wx = wtOf(cfg.move);
    for (const sd of ["L", "R"]) if (document.activeElement !== $("bfbLoad" + sd)) $("bfbLoad" + sd).value = wx[sd];
    syncExt();
    $("bfbLoadWrap").classList.toggle("hidden", !(MOVES[cfg.move] && MOVES[cfg.move].wt));
    $("bfbLoadNote").textContent = MOVES[cfg.move] && MOVES[cfg.move].bar ? tr("bfb_loadBarHint") : "";
    $("bfbDir").value = cfg.dir; $("bfbSound").value = cfg.sound || "beep"; $("bfbHyst").value = cfg.hyst; $("bfbBaud").value = String(cfg.baud);
  }
  $("bfbMove").onchange = () => pickMove($("bfbMove").value);
  for (const [id, key, lo, hi] of [["bfbMass", "mass", 20, 250], ["bfbHeight", "height", 1, 2.4]]) {
    $(id).onchange = () => { cfg[key] = Math.max(lo, Math.min(hi, +$(id).value || 0)); $(id).value = cfg[key]; syncExt(); save(); if (key === "height") barT.reset(); };
  }
  for (const sd of ["L", "R"]) $("bfbLoad" + sd).oninput = () => {        // live while typing; no rewrite of the box
    const v = +$("bfbLoad" + sd).value; if (!Number.isFinite(v) || v < 0 || v > 300) return;
    cfg.wt = { ...cfg.wt, [cfg.move]: { ...wtOf(cfg.move), [sd]: v } }; syncExt(); save();
  };
  for (const sd of ["L", "R"]) $("bfbLoad" + sd).onchange = () => {
    const v = Math.max(0, Math.min(300, +$("bfbLoad" + sd).value || 0)); $("bfbLoad" + sd).value = v;
    cfg.wt = { ...cfg.wt, [cfg.move]: { ...wtOf(cfg.move), [sd]: v } }; syncExt(); save();
  };
  $("bfbMetric").onchange = () => {
    const before = METRICS[cfg.metric] && METRICS[cfg.metric].unit;
    cfg.metric = $("bfbMetric").value;
    const u = METRICS[cfg.metric].unit;   // a 30 deg threshold means nothing in body weights
    if (u !== before) { cfg.thr = { BW: 3, cm: 30, ms: 500, "m/s": 0.5, W: 500, Nm: 30 }[u] ?? 30; cfg.hyst = HYST[u] ?? 3; cfg.thr2 = cfg.thr3 = null; }
    syncInputs(); save();
  };
  /* Slider limits per metric (the bars and plot follow them) and an own
   * metric for thresholds 2 and 3, so one lamp can watch e.g. elbow moment
   * and another trunk lean. */
  $("viewBiofeedback").addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches && el.matches(".bfbLim input")) {
      const i = +el.closest(".bfbLim").dataset.row, k = metOf(i), [mn, mx] = limOf(k);
      const v = +el.value; if (!Number.isFinite(v)) return;
      const lim = { min: mn, max: mx, [el.dataset.lim]: v };
      if (lim.max <= lim.min) return syncInputs();
      cfg.lim = { ...(cfg.lim || {}), [k]: lim }; save(); syncInputs();
    } else if (el.matches && el.matches(".bfbThrMet")) {
      const i = +el.id.slice(-1); cfg.tm = [...(cfg.tm || [null, null])]; cfg.tm[i - 2] = el.value || null;
      const [mn, mx] = limOf(metOf(i)); cfg["thr" + i] = Number.isFinite(cfg["thr" + i]) ? Math.max(mn, Math.min(mx, cfg["thr" + i])) : cfg["thr" + i];
      if (el.value && !Number.isFinite(cfg["thr" + i])) cfg["thr" + i] = +(mn + (mx - mn) * 0.5).toFixed(1);
      lampEma[i - 1] = NaN; save(); syncInputs();
      const an = METRICS[el.value] && METRICS[el.value].an;
      if (an != null && !(cfg.an || []).includes(an)) { cfg.an = [...(cfg.an || []), an]; save(); renderAnPick(); if (st.ver >= 5) writeLine("A"); }
      anPlot();
    }
  });
  /* Orange (2) and red (3) thresholds: optional, off = null. Turning one on
   * starts it a step beyond the one before, in the "light when" direction. */
  for (const i of [2, 3]) {
    const clamp = (v) => Math.max(+$("bfbThr" + i).min, Math.min(+$("bfbThr" + i).max, v));
    $("bfbThrOn" + i).onchange = () => {
      if ($("bfbThrOn" + i).checked) {
        const own = metOf(i) !== cfg.metric, [mn, mx] = limOf(metOf(i));
        const prev = own ? mn + (mx - mn) * 0.4 : Number.isFinite(cfg["thr" + (i - 1)]) ? cfg["thr" + (i - 1)] : cfg.thr;
        const d = Math.max(+$("bfbThr" + i).step || 1, (mx - mn) * 0.1) * (cfg.dir === "above" ? 1 : -1);
        cfg["thr" + i] = +clamp(prev + d).toFixed(2);
      } else cfg["thr" + i] = null;
      save(); syncInputs();
    };
    $("bfbThr" + i).oninput = () => { cfg["thr" + i] = +$("bfbThr" + i).value; $("bfbThrN" + i).value = cfg["thr" + i]; save(); };
    $("bfbThrN" + i).onchange = () => { cfg["thr" + i] = clamp(+$("bfbThrN" + i).value || 0); $("bfbThr" + i).value = cfg["thr" + i]; save(); };
  }
  $("bfbThr").oninput = () => { cfg.thr = +$("bfbThr").value; $("bfbThrN").value = cfg.thr; save(); };
  $("bfbThrN").onchange = () => { cfg.thr = Math.max(+$("bfbThr").min || 0, Math.min(+$("bfbThr").max || 180, +$("bfbThrN").value || 0)); $("bfbThr").value = cfg.thr; save(); };
  $("bfbDir").onchange = () => { cfg.dir = $("bfbDir").value; save(); };
  $("bfbHyst").onchange = () => { cfg.hyst = Math.max(0, +$("bfbHyst").value || 0); save(); };
  $("bfbBaud").onchange = async () => { cfg.baud = +$("bfbBaud").value; save(); if (st.port) await openPort(st.port); };

  /* ---------- sound (Web Audio, no Arduino needed) ----------
   * off | beep: one beep when the threshold is crossed | repeat: beeps every
   * 0.4 s while over it. Events (jump/shot) get a high double beep on a hit
   * and a low one on a miss. Created on the Activate click: browsers only
   * allow audio after a user gesture. */
  let actx = null, overSince = false;
  function tone(f = 880, ms = 120, when = 0) {
    if (cfg.sound === "off") return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state !== "running") actx.resume();
      const t = actx.currentTime + when, o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
    } catch { /* no audio */ }
  }
  setInterval(() => { if (st.stream && overSince && cfg.sound === "repeat") tone(880, 90); }, 400);
  $("bfbSound").onchange = () => { cfg.sound = $("bfbSound").value; save(); tone(880, 120); };

  /* ---------- body map ---------- */
  let region = null;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function renderBody() {
    const host = $("bfbBody"); if (!host) return;
    const mv = region ? (REGION_MOVES[region] || []) : [];
    host.innerHTML = bodyMapHTML(tr, { selected: region, trained: regionsOfMove(cfg.move), regions: Object.keys(REGION_MOVES), list: false })
      + (region
        ? `<div class="bfbChips"><b>${esc(tr("bm_" + region))}</b> ${mv.map((k) =>
            `<button type="button" class="ghost bmEx${k === cfg.move ? " on" : ""}" data-bfbmove="${k}">${esc(tr(MOVES[k].label))}</button>`).join("")}</div>`
        : `<p class="note" style="margin:6px 0 0">${esc(tr("bfb_bodyHint"))}</p>`);
  }
  function pickMove(k) {
    cfg.move = k; const mv = MOVES[k];
    cfg.metric = mv.def; cfg.thr = mv.thr; cfg.dir = mv.dir; cfg.hyst = HYST[METRICS[mv.def].unit] ?? 3; cfg.thr2 = cfg.thr3 = null; cfg.tm = [null, null];
    $("bfbMove").value = k; fillMetrics(); syncInputs(); save(); renderBody(); renderQuick();
  }
  $("bfbBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bfbmove]"); if (b) { pickMove(b.dataset.bfbmove); return; }
    const g = e.target.closest("[data-region]"); if (g) { region = g.dataset.region === region ? null : g.dataset.region; renderBody(); }
  });
  $("bfbBody").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-region]")) { e.preventDefault(); e.target.closest("[data-region]").dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }
  });

  /* ---------- serial ---------- */
  async function listPorts() {
    const sel = $("bfbPortSel");
    if (!hasSerial) { sel.innerHTML = ""; return; }
    const ports = await navigator.serial.getPorts();
    sel.innerHTML = `<option value="">${tr("bfb_portPick")}</option>` + ports.map((p, i) => {
      const inf = p.getInfo(); const id = inf.usbVendorId ? `USB ${inf.usbVendorId.toString(16)}:${(inf.usbProductId || 0).toString(16)}` : tr("bfb_portN", { n: i + 1 });
      return `<option value="${i}">${id}${p === st.port ? " ✓" : ""}</option>`;
    }).join("");
    sel._ports = ports;
    if (st.port) sel.value = String(ports.indexOf(st.port));
  }
  async function closePort() {
    try { if (st.reader) { await st.reader.cancel(); st.reader.releaseLock(); } } catch { /* gone */ }
    try { if (st.writer) { st.writer.releaseLock(); } } catch { /* gone */ }
    try { if (st.port) await st.port.close(); } catch { /* already closed */ }
    st.reader = st.writer = null; st.lit = null;
  }
  async function openPort(port) {
    await closePort();
    try {
      await port.open({ baudRate: cfg.baud });
      st.port = port; st.writer = port.writable.getWriter();
      status("bfb_portOpen", { baud: cfg.baud });
      readLoop(port);
      await listPorts();
      // Uno-style boards reset when the port opens; give the bootloader a moment.
      st.v3 = false; st.ver = 0; st.boardPins = null; renderPins();
      setTimeout(() => { writeLine("V"); writeLine("?"); send(false, true); }, 1800);
    } catch (e) { st.port = null; status("bfb_portFail", { err: e.message }, true); }
    renderConn();
  }
  /* Live analog inputs A0-A5 (sketch v5 "A"/"a" -> "AN v0,...,v5" at 25 Hz). */
  const AN_COL = ["#4fb3a0", "#7aa2f7", "#e8823a", "#c678dd", "#e5c07b", "#f7768e"], anHist = [];
  /* Scaling factor per input (Arduino window): value shown/used = raw 0-1023 x factor. */
  const anScale = (i) => { const f = +((cfg.anScale || [])[i]); return Number.isFinite(f) && f !== 0 ? f : 1; };
  function applyAnScale() {
    for (let i = 0; i < 6; i++) { const m = METRICS["an" + i]; m.max = Math.round(1023 * Math.abs(anScale(i)) * 100) / 100; m.unit = anScale(i) === 1 ? "raw" : "×" + anScale(i); }
  }
  applyAnScale();
  function renderAnPick() {
    const sel = cfg.an || [];
    for (const [hostId, withScale] of [["bfbAnPick", true], ["bfbAnPick2", false]]) {
      const host = $(hostId); if (!host) continue;
      host.innerHTML = [0, 1, 2, 3, 4, 5].map((i) => `<label><input type="checkbox" data-an="${i}"${sel.includes(i) ? " checked" : ""}${st.port ? "" : " disabled"}>
        <span class="bfbSw" style="background:${AN_COL[i]}"></span>A${i}${withScale ? ` <span class="note">×</span><input type="number" class="bfbAnScale" data-anscale="${i}" step="any" value="${anScale(i)}" title="${esc(tr("bfb_anScale"))}">` : ""} <span class="note" data-anv="${i}"></span></label>`).join("");
      for (const inp of host.querySelectorAll("[data-anscale]")) inp.onchange = () => {
        const i = +inp.dataset.anscale, f = +inp.value;
        cfg.anScale = [...(cfg.anScale || [1, 1, 1, 1, 1, 1])]; cfg.anScale[i] = Number.isFinite(f) && f !== 0 ? f : 1; save();
        applyAnScale(); renderAnPick(); syncInputs(); anPlot();
      };
    }
    $("bfbAnWrap") && $("bfbAnWrap").classList.toggle("hidden", !st.port && !sel.length);
    for (const cb of document.querySelectorAll("#bfbAnPick [data-an], #bfbAnPick2 [data-an]")) cb.onchange = () => {
      const i = +cb.dataset.an; cfg.an = cb.checked ? [...new Set([...(cfg.an || []), i])] : (cfg.an || []).filter((x) => x !== i); save();
      anHist.length = 0;
      if (st.ver >= 5) writeLine(cfg.an.length ? "A" : "a");
      else { flashHint(); writeLine(cfg.an.includes(0) ? "S" : "s"); }   // old board: only A0 can be previewed
      renderAnPick(); anPlot();
    };
  }
  /* Drawn twice: in the Arduino window and under the main plot on the page
   * (the page one only while some input is ticked). Thresholds of lamps that
   * watch an analog input are drawn as dashed lines in the lamp colour. */
  /* Without the camera running, lamps that watch an analog input still work:
   * evaluated here on every reading (the camera loop does it when it runs). */
  function anLamps() {
    if (st.stream) return;
    if (![1, 2, 3].some((r) => METRICS[metOf(r)] && METRICS[metOf(r)].an != null)) return;
    const sts = lampStates(NaN, (k) => (METRICS[k] && METRICS[k].an != null ? AN_LIVE[METRICS[k].an] : NaN));
    showLamps(sts); if (st.active) sendLamps(sts);
  }
  function anPlot() {
    const box = $("bfbAnWrap"); if (box) box.classList.toggle("hidden", !st.port && !(cfg.an || []).length);
    anPlotOn("bfbAnCv"); anPlotOn("bfbAnCv2");
  }
  function anPlotOn(id) {
    const cv = $(id); if (!cv || !cv.isConnected || !cv.offsetParent) return;
    const W = cv.clientWidth || 400, H = cv.clientHeight || 110, dpr = window.devicePixelRatio || 1;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const now = performance.now(); while (anHist.length && anHist[0].t < now - 10000) anHist.shift();
    const ends = (cfg.an || []).length ? cfg.an.map((i) => 1023 * anScale(i)) : [1023];
    const hi = Math.max(0, ...ends), lo = Math.min(0, ...ends), span = hi - lo || 1;
    const X = (t) => 30 + ((t - (now - 10000)) / 10000) * (W - 34), Y = (v) => 6 + (1 - (v - lo) / span) * (H - 16);
    const lab = (x) => String(Math.round(x * 100) / 100);
    c.font = "10px system-ui, sans-serif"; c.fillStyle = "#888"; c.fillText(lab(hi), 0, 12); c.fillText(lab(lo), 0, H - 8);
    if ((cfg.an || []).length && !anHist.length) {
      c.fillStyle = "#aaa"; c.font = "12px system-ui, sans-serif";
      c.fillText(st.port ? (st.ver >= 5 ? tr("bfb_anWait") : tr("bfb_anOld")) : tr("bfb_flashConnect"), 40, H / 2);
    }
    c.setLineDash([5, 4]); c.lineWidth = 1.4;
    for (const r of [1, 2, 3]) {
      const k = metOf(r), t = r === 1 ? cfg.thr : cfg["thr" + r];
      if (!METRICS[k] || METRICS[k].an == null || !Number.isFinite(t)) continue;
      c.strokeStyle = LVCOL[r - 1]; c.beginPath(); c.moveTo(30, Y(t)); c.lineTo(W - 4, Y(t)); c.stroke();
    }
    c.setLineDash([]);
    for (const i of cfg.an || []) {
      c.strokeStyle = AN_COL[i]; c.lineWidth = 1.8; c.beginPath();
      anHist.forEach((h, j) => (j ? c.lineTo(X(h.t), Y(h.v[i])) : c.moveTo(X(h.t), Y(h.v[i])))); c.stroke();
    }
  }
  function onLine(ln) {
    const fm = /^F (\d+)$/.exec(ln);
    if (fm) {                                        // v4 board: A0 only, via its "S" stream
      const v = [+fm[1] * anScale(0), NaN, NaN, NaN, NaN, NaN]; AN_LIVE[0] = v[0]; anHist.push({ t: performance.now(), v }); anPlot(); anLamps();
      for (const el of document.querySelectorAll('[data-anv="0"]')) el.textContent = Math.round(v[0] * 100) / 100;
      return true;
    }
    if (/^(STREAM_ON|STREAM_OFF|AN_ON|AN_OFF)$/.test(ln)) return true;
    if (ln.startsWith("AN ")) {
      const v = ln.slice(3).split(",").map(Number); if (v.length !== 6) return true;
      v.forEach((x, i) => { v[i] = x * anScale(i); AN_LIVE[i] = v[i]; }); anHist.push({ t: performance.now(), v }); anPlot(); anLamps();
      for (const i of cfg.an || []) for (const el of document.querySelectorAll(`[data-anv="${i}"]`)) el.textContent = Math.round(v[i] * 100) / 100;
      return true;                                   // not logged: 25 lines a second
    }
    if (ln.startsWith("BIOSCOUT_LAMP_READY")) { st.ver = +((/v(\d+)/.exec(ln) || [])[1] || 2); st.v3 = st.ver >= 3; renderPins(); if (st.ver < 5) flashHint(); lcdRetry(); }
    const vm = /^VERSION (\d+)/.exec(ln) || (/^PIN \d+ [01]/.test(ln) ? [0, 5] : null);
    if (vm && +vm[1] > (st.ver || 0)) { st.ver = +vm[1]; st.v3 = true; renderPins(); lcdRetry(); $("bfbFlashNote").textContent = ""; $("bfbFlash").classList.remove("pulse"); if ((cfg.an || []).length && st.ver >= 5) writeLine("A"); }
    const m = /^PINS ([\d,]+)/.exec(ln);
    if (m) {
      st.v3 = true; st.boardPins = m[1].split(",").map(Number);
      if (importPins) {
        importPins = false;
        const P = [...(cfg.pins || [13, 12, 11, 8, 7])]; for (let i = 0; i < 3; i++) P[i] = st.boardPins[i] || 0;
        cfg.pins = P; save();
        $("bfbFlashNote").textContent = tr("bfb_pinsImported", { pins: P.slice(0, 3).map((n) => n || "–").join(", ") });
      }
      renderPins();
    }
  }
  async function readLoop(port) {
    const dec = new TextDecoder(); let buf = "";
    try {
      st.reader = port.readable.getReader();
      for (;;) {
        const { value, done } = await st.reader.read(); if (done) break;
        buf += dec.decode(value); let i;
        while ((i = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln && onLine(ln)) continue; if (ln && ln !== st.lastRx) { st.lastRx = ln; log("← " + ln); } }
      }
    } catch { /* port closed or unplugged */ }
  }
  /* Lamp level 0-3 on the wire: "L<n>" for a v3 sketch, plain 1/0 (yellow
   * only) for an older one, which ignores the L. */
  const lvMsg = (lv) => (st.v3 ? "L" + lv : lv ? "1" : "0");
  async function sendLevel(lv, force = false) {
    if (cfg.invert) lv = lv ? 0 : 1;
    if (!force && st.lit === lv) return;
    st.lit = lv;
    showDots(lv);
    if (!st.writer) return;
    try { await st.writer.write(new TextEncoder().encode(lvMsg(lv) + "\n")); log("→ " + lvMsg(lv)); }
    catch (e) { status("bfb_portFail", { err: e.message }, true); }
  }
  /* Text per lamp (sketch v8): while lamp n is the highest one lit, the LCD
   * shows its text ("Move up", "Stop"...). Sent with lowercase w1:/w2:, which
   * the board shows WITHOUT saving -- a flashing lamp would otherwise wear out
   * the EEPROM. Level 0 shows the "no lamp" text, or the saved screen text. */
  /* Called whenever the lamps change (camera, events, pressure). The text of
   * the highest lamp lit shows when its line is crossed and STAYS until another
   * line is crossed: going back below every line keeps it, unless a "No lamp
   * lit" text is set. On the video always; on the LCD while Activate is on. */
  function lampMsg(sts) {
    const top = sts.lastIndexOf(true);
    if (top === st.msgTop) return;
    st.msgTop = top;
    if (top >= 0 && +(cfg.motor || {}).lamp === top + 1) motorPulse();   // crossed into the motor's lamp
    const T = cfg.lampTxt || [], txt = top >= 0 ? (T[top + 1] || "") : (T[0] || "");
    if (!txt) return;                                // nothing set for this lamp: keep what is shown
    const msg = $("bfbLampMsg");
    if (msg) { msg.textContent = txt; msg.style.color = top >= 0 ? LVCOL[top] : "#fff"; }
    lcdLampText(txt);                                // the LCD follows as soon as a board is connected
  }
  /* Motor (through a transistor on a free pin, default 9): on for N seconds
   * when the chosen lamp's line is crossed. Uses the pin tester command
   * T<pin>:1 / :0 (firmware v5+), so no new upload is needed. */
  cfg.motor = { lamp: 0, pin: 9, secs: 2, ...(cfg.motor || {}) };
  let motorTo = 0;
  async function motorPulse() {
    const M = cfg.motor; if (!st.writer || !(st.ver >= 5) || !M.pin) return;
    clearTimeout(motorTo);
    await writeLine(`T${M.pin}:1`, true);
    motorTo = setTimeout(() => writeLine(`T${M.pin}:0`, true), Math.max(0.1, +M.secs || 2) * 1000);
  }
  $("bfbMotPin").innerHTML = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => `<option>${n}</option>`).join("");
  $("bfbMotLamp").value = String(cfg.motor.lamp); $("bfbMotPin").value = String(cfg.motor.pin); $("bfbMotSecs").value = cfg.motor.secs;
  $("bfbMotLamp").onchange = () => { cfg.motor.lamp = +$("bfbMotLamp").value; save(); };
  $("bfbMotPin").onchange = () => { writeLine(`T${cfg.motor.pin}:0`, true); cfg.motor.pin = +$("bfbMotPin").value; save(); };
  $("bfbMotSecs").onchange = () => { const s = +$("bfbMotSecs").value; cfg.motor.secs = Number.isFinite(s) && s > 0 ? Math.min(30, s) : 2; $("bfbMotSecs").value = cfg.motor.secs; save(); };
  $("bfbMotTest").onclick = () => { if (!st.port) { $("bfbLcdNote").textContent = tr("bfb_lcdConnect"); return; } motorPulse(); };
  async function lcdLampText(txt) {
    if (!st.writer) return;
    if (!(st.ver >= 8)) { $("bfbLcdNote").textContent = tr("bfb_lcdOld"); $("bfbLcdFlash").classList.remove("hidden"); flashHint(); return; }
    await writeLine("w1:" + lcdAscii(txt), true); await writeLine("w2:", true);
  }
  const send = (on, force = false) => sendLevel(on ? 1 : 0, force);
  const writeLine = async (txt, quiet = false) => {
    if (!st.writer) return;
    try { await st.writer.write(new TextEncoder().encode(txt + "\n")); if (!quiet) log("→ " + txt); } catch { /* port gone */ }
  };
  /* "Connect external device": a small button opens a window listing the
   * devices (only the Arduino for now); the dot next to it is green while a
   * board is connected. */
  $("bfbDevBtn").onclick = () => { $("bfbDevDlg").showModal(); listPorts(); };
  $("bfbDevClose").onclick = () => $("bfbDevDlg").close();
  $("bfbDevArduino").onclick = () => {
    const p = $("bfbArduinoPanel"); p.classList.toggle("hidden");
    $("bfbDevArduino").classList.toggle("on", !p.classList.contains("hidden"));
  };
  function renderConn() {
    $("bfbDevDot").classList.toggle("on", !!st.port);
    $("bfbDisconnect").disabled = !st.port;
    $("bfbTestOn").disabled = $("bfbTestOff").disabled = !st.port;
    for (const b of document.querySelectorAll("#bfbArduinoPanel [data-testlv]")) b.disabled = !st.port;
    renderPins();
  }
  $("bfbChoosePort").onclick = async () => {
    if (!hasSerial) return;
    try { const p = await navigator.serial.requestPort(); await openPort(p); }
    catch { /* user cancelled the picker */ }
  };
  $("bfbPortSel").onchange = async () => {
    const p = ($("bfbPortSel")._ports || [])[+$("bfbPortSel").value];
    if (p && p !== st.port) await openPort(p);
  };
  $("bfbDisconnect").onclick = async () => { await send(false, true); await closePort(); st.port = null; status("bfb_portNone"); renderConn(); listPorts(); };
  /* Pin tester: switch any digital pin 2-13 on or off, to find which
   * socket a cable is in or check an LED. Needs sketch v4+ ("T<pin>:<0|1>"). */
  const pinOn = new Set();
  function renderPinTest() {
    const host = $("bfbPinTest"); if (!host) return;
    const P = cfg.pins || [13, 12, 11, 8, 7], role = {}; for (const i of [2, 1, 0]) if (P[i]) role[P[i]] = LVCOL[i];
    host.innerHTML = Array.from({ length: 12 }, (_, j) => j + 2).map((n) =>
      `<button type="button" class="ghost bfbPinBtn${pinOn.has(n) ? " on" : ""}" data-tpin="${n}"${st.port || assignLamp != null ? "" : " disabled"}
        style="${role[n] ? `box-shadow:inset 0 -3px 0 ${role[n]}` : ""}">${n}</button>`).join("")
      + `<button type="button" class="ghost bfbPinOff" id="bfbPinAllOff"${st.port ? "" : " disabled"}>${esc(tr("bfb_testOff"))}</button>`;
    /* Pulse > 0: a tap lights the pin for that long; 0: tap on, tap off. */
    for (const b of host.querySelectorAll("[data-tpin]")) b.onclick = () => {
      if (assignLamp != null) { setLampPin(assignLamp, +b.dataset.tpin); return; }
      if (!(st.ver >= 5)) { flashHint(); return; }               // older sketches read "T6:1" as "lamp on"
      const n = +b.dataset.tpin, ms = +cfg.pulse || 0, on = !pinOn.has(n);
      on ? pinOn.add(n) : pinOn.delete(n); writeLine(`T${n}:${on ? 1 : 0}`); renderPinTest();
      if (on && ms > 0) setTimeout(() => { if (pinOn.delete(n)) { writeLine(`T${n}:0`); renderPinTest(); } }, ms);
    };
    $("bfbPinAllOff").onclick = async () => { for (const n of [...pinOn]) await writeLine(`T${n}:0`); pinOn.clear(); await sendLevel(0, true); renderPinTest(); };
  }
  if (cfg.pulse == null) cfg.pulse = 1000;
  $("bfbPulse").value = cfg.pulse;
  $("bfbPulse").onchange = () => { cfg.pulse = Math.max(0, Math.min(10000, +$("bfbPulse").value || 0)); $("bfbPulse").value = cfg.pulse; save(); };
  /* Update board firmware: writes the bundled sketch (.hex, built from the
   * .ino in the repo) through this same port. Fixes "old sketch" for good. */
  /* Flash progress / result, shown at the top AND next to the screen-text button (the user may be scrolled down there). */
  const flashMsg = (m) => { $("bfbFlashNote").textContent = m; if (!$("bfbLcdFlash").classList.contains("hidden")) $("bfbLcdNote").textContent = m; };
  /* The text inside an Intel HEX image (to read the firmware version it carries). */
  const hexText = (hex) => { let o = ""; for (const l of hex.split(/\r?\n/)) if (l.slice(7, 9) === "00") for (let i = 9; i < l.length - 2; i += 2) o += String.fromCharCode(parseInt(l.slice(i, i + 2), 16)); return o; };
  function flashHint() { $("bfbFlashNote").textContent = tr("bfb_flashNeed"); $("bfbFlash").classList.add("pulse"); }
  /* LCD 1602 text (sketch v7): "W1:<text>" / "W2:<text>", 16 characters a
   * line, ASCII only (the LCD has no accents: "Übung" -> "Ubung"). The board
   * keeps the last text in EEPROM, so it is still there after a power-off. */
  const lcdAscii = (s) => String(s || "").replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "?").slice(0, 16);
  cfg.lcd = Array.isArray(cfg.lcd) ? cfg.lcd : ["BioScout", "ready"];
  let lcdPending = null;
  /* After a firmware update the board answers "VERSION 7": send the waiting text then. */
  const lcdRetry = () => { if (lcdPending && st.ver >= 7) lcdSend(lcdPending); };
  $("bfbLcd1").value = cfg.lcd[0] || ""; $("bfbLcd2").value = cfg.lcd[1] || "";
  async function lcdSend(lines) {
    if (!st.port) { $("bfbLcdNote").textContent = tr("bfb_lcdConnect"); return; }
    if (!(st.ver >= 7)) {                         // old firmware: offer the update right here, send once it is on
      $("bfbLcdNote").textContent = tr("bfb_lcdOld"); flashHint();
      $("bfbLcdFlash").classList.remove("hidden"); lcdPending = lines; return;
    }
    lcdPending = null; $("bfbLcdFlash").classList.add("hidden");
    const L = lines.map(lcdAscii);
    await writeLine("W1:" + L[0]); await writeLine("W2:" + L[1]);
    $("bfbLcdNote").textContent = tr("bfb_lcdSent");
  }
  const lcdApply = () => {
    cfg.lcd = [$("bfbLcd1").value, $("bfbLcd2").value]; save();
    $("bfbLcd1").value = lcdAscii(cfg.lcd[0]); $("bfbLcd2").value = lcdAscii(cfg.lcd[1]);
    lcdSend(cfg.lcd);
  };
  $("bfbLcdClear").onclick = () => lcdSend(["", ""]);
  cfg.lampTxt = Array.isArray(cfg.lampTxt) ? cfg.lampTxt : ["", "", "", ""];
  for (const el of document.querySelectorAll("[data-lamptxt]")) {
    const i = +el.dataset.lamptxt; el.value = cfg.lampTxt[i] || "";
    el.oninput = () => { cfg.lampTxt[i] = el.value; save(); };
    el.onchange = () => {
      el.value = lcdAscii(el.value); cfg.lampTxt[i] = el.value; save();
      if (st.port && !(st.ver >= 8)) { $("bfbLcdNote").textContent = tr("bfb_lcdOld"); $("bfbLcdFlash").classList.remove("hidden"); flashHint(); }
    };
  }
  $("bfbLcdFlash").onclick = () => { $("bfbLcdNote").textContent = ""; $("bfbFlash").click(); };
  /* No button: the text goes to the board when a box is left or Enter is pressed. */
  for (const id of ["bfbLcd1", "bfbLcd2"]) { $(id).onchange = lcdApply; $(id).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); lcdApply(); } }; }
  $("bfbFlash").onclick = async () => {
    const port = st.port; if (!port) { $("bfbFlashNote").textContent = tr("bfb_flashConnect"); return; }
    $("bfbFlash").disabled = true; $("bfbFlash").classList.remove("pulse");
    try {
      // "?check" makes the service worker go to the network: a cached older .hex would flash the old firmware again
      const hex = await (await fetch(new URL("../assets/arduino/biofeedback_lamp/biofeedback_lamp.hex?check=" + Date.now(), import.meta.url), { cache: "no-store" })).text();
      const hv = (/BIOSCOUT_LAMP_READY v(\d+)/.exec(hexText(hex)) || [])[1];
      flashMsg(tr("bfb_flashing", { p: 0 }) + (hv ? ` (v${hv})` : ""));
      await closePort();
      const r = await flashUno(port, hex, { onProgress: (f) => flashMsg(tr("bfb_flashing", { p: Math.round(f * 100) })) });
      flashMsg(tr("bfb_flashDone", { kb: (r.bytes / 1024).toFixed(1) }));
      await openPort(port);
      setTimeout(async () => { const P = cfg.pins || [13, 12, 11, 8, 7]; for (let i = 0; i < 3; i++) await writeLine(`P${i}:${P[i]}`); }, 2600);
    } catch (e) {
      flashMsg(tr("bfb_flashFail", { err: e.message }));
      try { await openPort(port); } catch { /* leave it */ }
    }
    $("bfbFlash").disabled = false;
  };
  $("bfbTestOn").onclick = () => sendLevel(3, true);
  $("bfbTestOff").onclick = () => { lampsOff(); sendLevel(0, true); };
  /* Lamp 1/2/3 buttons: each switches only its own lamp, on and off.
   * Sketch v5 drives the lamp's pin directly (T<pin>); older sketches only
   * know levels, so there the button shows that level. */
  const lampOn = [false, false, false];
  const lampTest = async (b) => {
    const i = +b.dataset.testlv - 1, P = cfg.pins || [13, 12, 11, 8, 7];
    lampOn[i] = !lampOn[i];
    for (const x of document.querySelectorAll("#bfbArduinoPanel [data-testlv]")) x.classList.toggle("on", lampOn[+x.dataset.testlv - 1]);
    if (!P[i]) { lampOn[i] = false; b.classList.remove("on"); return; }
    if (st.ver >= 5) await writeLine(`T${P[i]}:${lampOn[i] ? 1 : 0}`);
    else { lampOn[i] = false; b.classList.remove("on"); flashHint(); }
  };
  const bindLampTests = () => { for (const b of document.querySelectorAll("#bfbArduinoPanel [data-testlv]")) b.onclick = () => lampTest(b); };
  const lampsOff = () => { lampOn.fill(false); for (const x of document.querySelectorAll("#bfbArduinoPanel [data-testlv]")) x.classList.remove("on"); };
  /* Pins: which Arduino pin drives each lamp. A v3 sketch takes "P<i>:<pin>"
   * and keeps it in EEPROM, so trying another pin or cable needs no upload. */
  const PIN_KEYS = ["bfb_pinY", "bfb_pinO", "bfb_pinR"];   // slots 3-4 (green, old relay) not shown
  let assignLamp = null;
  function setLampPin(i, pin) {
    const P = [...(cfg.pins || [13, 12, 11, 8, 7])];
    if (pin) for (let j = 0; j < 3; j++) if (j !== i && P[j] === pin) { P[j] = 0; if (st.v3) writeLine(`P${j}:0`); }   // one lamp per pin
    P[i] = pin; cfg.pins = P; save(); assignLamp = null;
    if (st.v3) writeLine(`P${i}:${pin}`);
    renderPins();
  }
  function renderPins() {
    const host = $("bfbPins"); if (!host) return;
    const P = cfg.pins || [13, 12, 11, 8, 7];
    /* Each lamp: colour + name + its pin. Tap the pin chip, then a number in
     * "Test each pin" (or None) -- no dropdowns. */
    host.innerHTML = PIN_KEYS.map((k, i) => `<div class="bfbLampChip${assignLamp === i ? " on" : ""}">
        <input type="color" class="bfbCol" data-col="${i}" value="${LVCOL[i]}" aria-label="${esc(tr(k))}">
        <button type="button" class="ghost bfbPinPick bfbLvBtn${lampOn[i] ? " on" : ""}" data-testlv="${i + 1}" title="${esc(tr("bfb_lampTest"))}">${esc(tr(k))}</button>
        <button type="button" class="ghost bfbPinPick" data-assign="${i}" title="${esc(tr("bfb_lampPin"))}">${P[i] ? "pin " + P[i] : esc(tr("bfb_none"))}</button>
      </div>`).join("")
      + (assignLamp != null ? `<span class="note">${esc(tr("bfb_assignHint", { lamp: tr(PIN_KEYS[assignLamp]) }))}</span>
        <button type="button" class="ghost bfbPinPick" data-none="1">${esc(tr("bfb_none"))}</button>` : "");
    bindLampTests();
    for (const b of host.querySelectorAll("[data-assign]")) b.onclick = () => { assignLamp = assignLamp === +b.dataset.assign ? null : +b.dataset.assign; renderPins(); };
    const none = host.querySelector("[data-none]"); if (none) none.onclick = () => setLampPin(assignLamp, 0);
    const B = st.boardPins, same = B && B.every((n, i) => n === P[i]);
    const used = [0, 1, 2].map((i) => P[i]).filter(Boolean), dup = used.find((n, i) => used.indexOf(n) !== i);
    $("bfbPinsNote").textContent = [dup ? tr("bfb_pinsClash", { pin: dup }) : "", !st.port ? "" : !st.v3 ? tr("bfb_oldSketch")
      : same || !(st.ver >= 5) ? "" : tr("bfb_pinsDiff", { pins: (B || []).slice(0, 3).map((n) => n || "–").join(", ") })].filter(Boolean).join(" ");
    paintColors(); renderAnPick();
    $("bfbFlash").parentElement.classList.toggle("hidden", !!st.port && st.ver >= 8);   // one button, only while the board is behind the bundled firmware (v8)
    renderPinTest();
  }
  $("bfbDevDone").onclick = () => $("bfbDevDlg").close();
  /* Keep what is already on the board: ask it for its pins ("?" -> "PINS a,b,c,...")
   * and take them as the lamps' pins, instead of updating the firmware. */
  let importPins = false;
  $("bfbPinsImport").onclick = () => {
    if (!st.port) { $("bfbFlashNote").textContent = tr("bfb_flashConnect"); return; }
    importPins = true; writeLine("?");
    setTimeout(() => { if (importPins) { importPins = false; $("bfbFlashNote").textContent = tr("bfb_pinsNoReply"); } }, 1500);
  };
  /* Sketch editor: the .ino in a window, editable, kept in this browser.
   * The browser cannot compile for the Arduino, so it is downloaded and
   * uploaded with the Arduino IDE; the bundled .hex goes on with Update board firmware. */
  const SK_KEY = "bioscout.bfb.sketch.v1";
  const withPins = (txt) => txt.replace(/const byte DEF\[5\] = \{[^}]*\};/, `const byte DEF[5] = {${(cfg.pins || [13, 12, 11, 8, 7]).join(", ")}};`);
  async function defaultSketch() {
    const r = await fetch(new URL("../assets/arduino/biofeedback_lamp/biofeedback_lamp.ino", import.meta.url), { cache: "no-cache" }); return r.ok ? r.text() : "";
  }
  $("bfbSketchEdit").onclick = async () => {
    let txt = null; try { txt = localStorage.getItem(SK_KEY); } catch { /* private */ }
    $("bfbSketchTxt").value = txt || withPins(await defaultSketch());
    $("bfbSketchDlg").showModal();
  };
  $("bfbSketchTxt").oninput = () => { try { localStorage.setItem(SK_KEY, $("bfbSketchTxt").value); } catch { /* full */ } };
  $("bfbSketchPins").onclick = () => { $("bfbSketchTxt").value = withPins($("bfbSketchTxt").value); $("bfbSketchTxt").oninput(); };
  $("bfbSketchReset").onclick = async () => { $("bfbSketchTxt").value = withPins(await defaultSketch()); try { localStorage.removeItem(SK_KEY); } catch { /* private */ } };
  $("bfbSketchCopy").onclick = () => navigator.clipboard && navigator.clipboard.writeText($("bfbSketchTxt").value);
  $("bfbSketchDl").onclick = () => {
    const url = URL.createObjectURL(new Blob([$("bfbSketchTxt").value], { type: "text/plain" })), a = document.createElement("a");
    a.href = url; a.download = "biofeedback_lamp.ino"; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
  };
  $("bfbSketchClose").onclick = () => $("bfbSketchDlg").close();
  if (hasSerial) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (e.target === st.port) { closePort(); st.port = null; status("bfb_portLost", null, true); renderConn(); }
      listPorts();
    });
    navigator.serial.addEventListener("connect", listPorts);
  }

  /* ---------- camera + pose ---------- */
  /* Source: the camera, or a shared screen / window / tab (getDisplayMedia)
   * -- a YouTube video or a Zoom call. On a screen, "Select area" drags a
   * rectangle around the person; only that crop goes to the model, which
   * both speeds it up and stops it locking on to someone else on screen. */
  const isScreen = () => cfg.src === "screen";
  async function startCam() {
    if (st.stream) return true;
    try {
      st.stream = isScreen()
        ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false })
        : await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: cfg.facing || "user" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = $("bfbVideo"); v.srcObject = st.stream; await v.play();
      // Sharing stopped from the browser's own bar: stop here too.
      st.stream.getVideoTracks()[0].addEventListener("ended", () => { stopCam(); $("bfbCamBtn").textContent = camLabel(); });
      // Mirror only the selfie camera (it is what people expect); a screen or
      // the back camera is shown as it is.
      $("bfbStage").classList.toggle("noMirror", isScreen() || cfg.facing === "environment");
      st.crop = null; st.picking = false; renderSrc();
      return true;
    } catch (e) { $("bfbCamNote").textContent = tr("bfb_camFail", { err: e.message }); return false; }
  }
  const isPhone = () => cfg.src === "phone";
  const camLabel = () => (isPhone() ? tr(st.motionStop ? "bfb_motStop" : "bfb_motStart")
    : tr(st.stream ? (isScreen() ? "bfb_scrStop" : "bfb_camStop") : (isScreen() ? "bfb_scrStart" : "bfb_camStart")));
  /* Phone motion (running): no camera, the accelerometer drives the value,
   * bars, plot and lamps 10 times a second. */
  const stepDet = makeStepDetector();
  async function startPhone() {
    stepDet.reset(); ema = NaN;
    try { st.motionStop = await startMotion((t, a) => stepDet.push(t, a)); }
    catch (e) { st.motionStop = null; $("bfbCamNote").textContent = tr("bfb_motFail", { err: e.message }); renderSrc(); return; }
    $("bfbCamNote").textContent = tr("bfb_motHint");
    st.phT = setInterval(phoneTick, 100); renderSrc();
  }
  function stopPhone() {
    if (st.motionStop) st.motionStop(); st.motionStop = null;
    clearInterval(st.phT); st.phT = 0; Object.assign(PH_LIVE, { cadence: NaN, impact: NaN, stepTime: NaN, acc: NaN });
  }
  function phoneTick() {
    const ts = performance.now(), v = stepDet.values(ts);
    Object.assign(PH_LIVE, { cadence: v.cadence, impact: v.impact, stepTime: v.stepTime, acc: stepDet.level() });
    const val = (k) => METRICS[k].f() - ((cfg.zero && cfg.zero[k]) || 0);
    const x = val(cfg.metric);
    ema = Number.isFinite(x) ? (Number.isFinite(ema) ? ema + 0.35 * (x - ema) : x) : NaN;
    if (!Number.isFinite(ema)) { $("bfbValue").textContent = tr("bfb_motWait", { n: v.steps }); plot(ts); return; }
    showBar(ema); hist.push({ t: ts, a: ema, b: NaN, o: {} }); plot(ts);
    st.value = ema; $("bfbValue").textContent = fmt(ema);
    const sts = lampStates(ema, val), lv = sts.filter(Boolean).length, top = sts.lastIndexOf(true);
    if (lv > lastLv && cfg.sound !== "off") tone([880, 1047, 1319][lv - 1], 140);
    lastLv = lv; on = lv > 0;
    $("bfbValue").classList.toggle("hit", on); $("bfbValue").style.color = on ? LVCOL[top] : "";
    showLamps(sts); if (st.active) sendLamps(sts);
  }
  /* Phones and tablets have no screen capture at all (no getDisplayMedia):
   * the Screen source is not offered there instead of failing on press. */
  if (!MOVES[cfg.move]) cfg.move = "squat";              // e.g. the short-lived "run" movement
  const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!canScreen) {
    const o = $("bfbSrc").querySelector('option[value="screen"]'); if (o) o.remove();
    if (cfg.src === "screen") cfg.src = "camera";
  }
  $("bfbFlip").onclick = async () => {
    cfg.facing = cfg.facing === "environment" ? "user" : "environment"; save();
    if (st.stream && !isScreen()) { stopCam(); if (await startCam()) frame(); }
    renderSrc();
  };
  function renderSrc() {
    $("bfbFlip").classList.toggle("hidden", isScreen() || isPhone());
    $("bfbUseCam").classList.toggle("on", !isPhone()); $("bfbUsePhone").classList.toggle("on", isPhone());
    $("bfbSrcRow").classList.toggle("hidden", isPhone());
    $("bfbSrc").value = cfg.src;
    $("bfbArea").classList.toggle("hidden", !isScreen() || !st.stream);
    $("bfbAreaClear").classList.toggle("hidden", !isScreen() || !st.stream || !st.crop);
    $("bfbArea").textContent = tr(st.picking ? "bfb_areaDone" : "bfb_area");
    $("bfbCamBtn").textContent = camLabel();
    $("bfbSrcCv").classList.toggle("hidden", !(st.crop && !st.picking));
    $("bfbVideo").style.visibility = st.crop && !st.picking ? "hidden" : "";
  }
  /* Use camera / Use phone accelerometer: chosen before starting, for any task.
   * The phone gives its own metrics (cadence, impact, step time, acceleration). */
  function useSource(src) {
    if (st.stream) stopCam();
    stopPhone();
    cfg.src = src; save(); fillMetrics(); syncInputs(); renderSrc();
  }
  $("bfbUseCam").onclick = () => useSource(isScreen() ? "screen" : "camera");
  $("bfbUsePhone").onclick = () => useSource("phone");
  $("bfbSrc").onchange = () => {
    if (st.stream) stopCam();
    stopPhone();
    cfg.src = $("bfbSrc").value; save(); renderSrc();
  };
  /* Area picking: drag on the stage; coordinates mapped from the element to
   * video pixels through object-fit: contain (screen is never mirrored). */
  function stagePt(e) {
    const v = $("bfbVideo"), r = $("bfbStage").getBoundingClientRect();
    const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const ox = (r.width - v.videoWidth * k) / 2, oy = (r.height - v.videoHeight * k) / 2;
    return [Math.max(0, Math.min(v.videoWidth, (e.clientX - r.left - ox) / k)),
            Math.max(0, Math.min(v.videoHeight, (e.clientY - r.top - oy) / k))];
  }
  let drag = null;
  $("bfbStage").addEventListener("pointerdown", (e) => {
    if (!st.picking) return; e.preventDefault();
    drag = { a: stagePt(e), b: stagePt(e) }; $("bfbStage").setPointerCapture(e.pointerId);
  });
  $("bfbStage").addEventListener("pointermove", (e) => { if (drag) drag.b = stagePt(e); });
  $("bfbStage").addEventListener("pointerup", () => {
    if (!drag) return;
    const [x0, y0] = drag.a, [x1, y1] = drag.b; drag = null;
    if (Math.abs(x1 - x0) > 40 && Math.abs(y1 - y0) > 40) {
      st.crop = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      st.picking = false; ema = emaL = emaR = NaN; renderSrc();
    }
  });
  $("bfbArea").onclick = () => { st.picking = !st.picking; renderSrc(); };
  $("bfbAreaClear").onclick = () => { st.crop = null; st.picking = false; ema = emaL = emaR = NaN; renderSrc(); };
  /** What the model looks at this frame: the crop (drawn, and shown) or the video. */
  function source(v) {
    if (!st.crop || st.picking) return { el: v, w: v.videoWidth, h: v.videoHeight };
    const c = st.crop, cv = $("bfbSrcCv");
    if (cv.width !== Math.round(c.w) || cv.height !== Math.round(c.h)) { cv.width = Math.round(c.w); cv.height = Math.round(c.h); }
    cv.getContext("2d").drawImage(v, c.x, c.y, c.w, c.h, 0, 0, cv.width, cv.height);
    return { el: cv, w: cv.width, h: cv.height };
  }
  function stopCam() {
    window.cancelAnimationFrame(st.raf); st.raf = 0;
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
  }
  let ema = NaN, emaL = NaN, emaR = NaN, on = false, pulseTo = 0, lastLv = 0;
  const loadEst = makeLoadEstimator();
  const barT = makeBarTracker(), barTrail = [];
  const unit = () => METRICS[cfg.metric].unit;
  const fmt = (v) => (unit() === "m/s" ? v.toFixed(2) : unit() === "cm" || unit() === "BW" ? v.toFixed(1) : v.toFixed(0)) + (unit() === DEG ? "°" : " " + unit());
  const meets = (v) => (cfg.dir === "above" ? v > cfg.thr : v < cfg.thr);
  /* Three thresholds -> yellow, orange, red. Level = how many are crossed
   * (each with its own hysteresis), so the lamps light cumulatively. */
  /* Lamp colours, editable; default green, yellow, red. LVCOL is cfg.colors
   * itself, so a change shows everywhere at once. */
  const LVDEF = ["#4caf50", "#ffd54a", "#ff4d4d"];
  if (!Array.isArray(cfg.colors) || cfg.colors.length !== 3) cfg.colors = [...LVDEF];
  const LVCOL = cfg.colors;
  const thrs = () => [cfg.thr, cfg.thr2, cfg.thr3].map((t, i) => (Number.isFinite(t) && metOf(i + 1) === cfg.metric ? t : NaN));
  /* Each lamp i: its own metric's value against its own threshold, with
   * hysteresis in that metric's unit. Lamps are independent now. */
  const lampEma = [NaN, NaN, NaN], lampOnSt = [false, false, false];
  function lampStates(mainV, val) {
    return [1, 2, 3].map((i) => {
      const t = i === 1 ? cfg.thr : cfg["thr" + i], k = metOf(i);
      if (!Number.isFinite(t)) return (lampOnSt[i - 1] = false);
      let v = mainV;
      if (k !== cfg.metric) {
        const mm = METRICS[k]; let x;
        if (mm.pair) { const a = [val(mm.pair[0]), val(mm.pair[1])].filter(Number.isFinite); x = a.length ? (cfg.dir === "above" ? Math.max(...a) : Math.min(...a)) : NaN; }
        else x = val(k);
        const p = lampEma[i - 1]; v = lampEma[i - 1] = Number.isFinite(x) ? (Number.isFinite(p) ? p + 0.35 * (x - p) : x) : NaN;
      }
      if (!Number.isFinite(v)) return (lampOnSt[i - 1] = false);
      const h = k === cfg.metric ? cfg.hyst : HYST[METRICS[k].unit] ?? 3, was = lampOnSt[i - 1];
      return (lampOnSt[i - 1] = cfg.dir === "above" ? (was ? v > t - h : v > t) : (was ? v < t + h : v < t));
    });
  }
  function showLamps(sts) {
    lampMsg(sts);
    ["bfbLamp", "bfbLamp2", "bfbLamp3"].forEach((id, i) => {
      const el = $(id), on = !!sts[i], c = LVCOL[i];
      el.classList.toggle("on", on);
      el.style.background = on ? c : ""; el.style.borderColor = on ? c : ""; el.style.boxShadow = on ? `0 0 14px 5px ${c}b3` : "";
    });
  }
  /* To the board: each lamp on its own pin (sketch v5 T<pin>); older sketches
   * only have cumulative levels, so they get the count. */
  async function sendLamps(sts, force = false) {
    if (cfg.invert) sts = sts.map((x) => !x);
    const key = sts.map(Number).join("");
    if (!force && st.litKey === key) return;
    st.litKey = key; st.lamps = sts;
    if (!st.writer) return;
    if (st.ver >= 5) { const P = cfg.pins || [13, 12, 11]; for (let i = 0; i < 3; i++) if (P[i]) await writeLine(`T${P[i]}:${sts[i] ? 1 : 0}`, true); log("→ lamps " + key); }
    else await sendLevel(sts.filter(Boolean).length, true);
  }
  const levelNow = (v) => thrs().filter((t) => Number.isFinite(t) && (cfg.dir === "above" ? v > t : v < t)).length;
  const cross = [false, false, false];
  function levelOf(v) {
    const h = cfg.hyst; let n = 0;
    thrs().forEach((t, i) => {
      if (!Number.isFinite(t) || !Number.isFinite(v)) { cross[i] = false; return; }
      cross[i] = cfg.dir === "above" ? (cross[i] ? v > t - h : v > t) : (cross[i] ? v < t + h : v < t);
      if (cross[i]) n++;
    });
    return n;
  }
  function showDots(lv) {
    lampMsg([lv > 0, lv > 1, lv > 2]);
    ["bfbLamp", "bfbLamp2", "bfbLamp3"].forEach((id, i) => {
      const el = $(id), on = lv > i, c = LVCOL[i];
      el.classList.toggle("on", on);
      el.style.background = on ? c : ""; el.style.borderColor = on ? c : ""; el.style.boxShadow = on ? `0 0 14px 5px ${c}b3` : "";
    });
  }
  function paintColors() {
    for (const el of document.querySelectorAll("#viewBiofeedback [data-sw], #bfbDevDlg [data-sw]")) el.style.background = LVCOL[+el.dataset.sw];
    for (const el of document.querySelectorAll("#viewBiofeedback input[data-col]")) if (el !== document.activeElement) el.value = LVCOL[+el.dataset.col];
  }
  $("viewBiofeedback").addEventListener("input", (e) => {
    const el = e.target; if (!el.matches || !el.matches("input[data-col]")) return;
    LVCOL[+el.dataset.col] = el.value; save(); paintColors(); buildBars(); renderPinTest();
  });
  for (const el of document.querySelectorAll("#viewBiofeedback [data-colreset]")) el.onclick = () => {
    LVCOL.splice(0, 3, ...LVDEF); save(); paintColors(); buildBars(); renderPinTest();
  };
  const barMax = () => ((cfg.lim || {})[cfg.metric] ? limOf(cfg.metric)[1] : METRICS[cfg.metric].max || 180);
  const barMin = () => ((cfg.lim || {})[cfg.metric] ? limOf(cfg.metric)[0] : unit() === DEG ? Math.min(0, cfg.thr - 10) : 0);
  const pct = (x) => Math.max(0, Math.min(100, ((x - barMin()) / (barMax() - barMin())) * 100));
  /* One bar per side (L, R) for paired metrics, one bar otherwise. */
  function buildBars() {
    const m = METRICS[cfg.metric], sides = m.pair ? ["L", "R"] : [""];
    $("bfbBars").innerHTML = sides.map((sd) => `<div class="bfbBarRow"><span class="bfbSide">${sd}</span>
      <div class="bfbBar"><div class="bfbBarFill" data-side="${sd}"></div>${[0, 1, 2].map((i) => `<div class="bfbBarThr" data-lv="${i}" style="background:${LVCOL[i]}"></div>`).join("")}</div>
      <span class="bfbBarVal" data-side="${sd}">–</span></div>`).join("");
    hist.length = 0;
  }
  function showBar(v, side = "") {
    const f = $("bfbBars").querySelector(`.bfbBarFill[data-side="${side}"]`); if (!f) return;
    const ok = Number.isFinite(v) && meets(v);
    const lv = Number.isFinite(v) ? levelNow(v) : 0;
    f.style.width = Number.isFinite(v) ? pct(v) + "%" : "0"; f.classList.toggle("hit", ok);
    f.style.background = lv ? LVCOL[lv - 1] : "";
    $("bfbBars").querySelector(`.bfbBarVal[data-side="${side}"]`).textContent = Number.isFinite(v) ? fmt(v) : "–";
    const T = thrs();
    for (const t of $("bfbBars").querySelectorAll(".bfbBarThr")) {
      const x = T[+t.dataset.lv]; t.style.display = Number.isFinite(x) ? "" : "none"; if (Number.isFinite(x)) t.style.left = pct(x) + "%";
    }
  }
  /* Live plot: last 10 s, one line per side, dashed threshold, plus up to
   * 5 lines in all from the chips under it. */
  const hist = [], WIN = 10000, MAXLINES = 5;
  const XCOL = ["#7aa2f7", "#c678dd", "#56b6c2", "#f7768e", "#9ece6a"];
  const nMain = () => (METRICS[cfg.metric].pair ? 2 : 1);
  function extraCols() {
    const live = liveKeys(MOVES[cfg.move] || MOVES.free);
    const out = [];
    for (const k of cfg.extra || []) {
      if (k === cfg.metric || !METRICS[k] || METRICS[k].ev || !(MOVES[cfg.move] || MOVES.free).metrics.includes(k)) continue;
      if (METRICS[k].pair) out.push([k + "_L", k, "L"], [k + "_R", k, "R"]); else out.push([k, k, ""]);
    }
    return out.slice(0, MAXLINES - nMain());
  }
  function renderPick() {
    const host = $("bfbPlotPick"); if (!host) return;
    const mv = MOVES[cfg.move] || MOVES.free;
    const keys = mv.metrics.filter((k) => !METRICS[k].ev && k !== cfg.metric);
    host.innerHTML = `<span class="note">${esc(tr("bfb_plotAlso"))}</span> ` + keys.map((k) =>
      `<button type="button" class="ghost bmEx${(cfg.extra || []).includes(k) ? " on" : ""}" data-extra="${k}">${esc(short(k))}</button>`).join("");
  }
  function plot(now) {
    const cv = $("bfbPlot"); if (!cv) return;
    const W = cv.clientWidth || 600, H = cv.clientHeight || 140, dpr = window.devicePixelRatio || 1;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    while (hist.length && hist[0].t < now - WIN) hist.shift();
    const TT = thrs().filter(Number.isFinite);
    let lo = Math.min(...TT), hi = Math.max(...TT);
    const sameCols = extraCols().filter(([, k]) => METRICS[k].unit === unit()).map(([col]) => col);
    for (const h of hist) for (const x of [h.a, h.b, ...sameCols.map((c) => (h.o ? h.o[c] : NaN))]) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    const pad = Math.max(unit() === "BW" ? 0.3 : 5, (hi - lo) * 0.15); lo -= pad; hi += pad;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--muted").trim() || "#999", acc = css.getPropertyValue("--accent").trim() || "#4fb3a0";
    const X = (t) => 34 + ((t - (now - WIN)) / WIN) * (W - 40), Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 22);
    c.font = "11px system-ui, sans-serif"; c.fillStyle = ink; c.strokeStyle = ink; c.globalAlpha = 0.35; c.lineWidth = 1;
    for (const v of [lo + pad, (lo + hi) / 2, hi - pad]) { c.beginPath(); c.moveTo(34, Y(v)); c.lineTo(W - 6, Y(v)); c.stroke(); }
    c.globalAlpha = 1;
    for (const v of [lo + pad, hi - pad]) c.fillText(v.toFixed(unit() === "BW" ? 1 : 0), 2, Y(v) + 4);
    c.fillText("-10 s", 34, H - 2); c.fillText("now", W - 28, H - 2);
    c.setLineDash([6, 4]); c.lineWidth = 1.5;
    thrs().forEach((t, i) => { if (!Number.isFinite(t)) return; c.strokeStyle = LVCOL[i]; c.beginPath(); c.moveTo(34, Y(t)); c.lineTo(W - 6, Y(t)); c.stroke(); });
    c.setLineDash([]);
    const line = (get, col, dash) => {
      c.strokeStyle = col; c.lineWidth = 2; c.setLineDash(dash || []); c.beginPath(); let pen = false;
      for (const h of hist) { const v = get(h); if (!Number.isFinite(v)) { pen = false; continue; }
        pen ? c.lineTo(X(h.t), Y(v)) : c.moveTo(X(h.t), Y(v)); pen = true; }
      c.stroke(); c.setLineDash([]);
    };
    line((h) => h.a, acc); line((h) => h.b, "#e8823a");
    /* Extra lines: same unit -> drawn on this axis; other unit -> scaled to fit
     * (its own min..max over the window), marked "~" in the legend. */
    const legend = METRICS[cfg.metric].pair ? [["L", acc], ["R", "#e8823a"]] : [[short(cfg.metric), acc]];
    extraCols().forEach(([col, k, sd], i) => {
      const color = XCOL[i % XCOL.length], same = METRICS[k].unit === unit();
      let get = (h) => (h.o ? h.o[col] : NaN);
      if (!same) {
        const v = hist.map(get).filter(Number.isFinite); if (!v.length) return;
        const a = Math.min(...v), b = Math.max(...v), r = b - a || 1;
        const g0 = get; get = (h) => lo + pad + ((g0(h) - a) / r) * (hi - lo - 2 * pad);
      }
      line(get, color, [4, 2]);
      legend.push([(same ? "" : "~") + short(k) + (sd ? " " + sd : ""), color]);
    });
    c.textAlign = "right"; let lx = W - 6;
    for (const [txt, col] of legend.reverse()) { c.fillStyle = col; c.fillText(txt, lx, 14); lx -= c.measureText(txt).width + 10; }
    c.textAlign = "left";
  }
  /* An event (one jump / one shot) arrived: show it, log it, flash the lamp. */
  const detect = makeDetectors((vals) => {
    recordEvent(vals);
    const m = METRICS[cfg.metric]; if (!m.ev || !(cfg.metric in vals)) return;
    const v = vals[cfg.metric]; if (!Number.isFinite(v)) return;
    const ok = meets(v);
    $("bfbValue").textContent = fmt(v); $("bfbValue").classList.toggle("hit", ok); showBar(v);
    { const t = performance.now(); hist.push({ t, a: v, b: NaN }); plot(t); }
    const li = document.createElement("li"); li.textContent = (ok ? "✓ " : "✗ ") + fmt(v);
    li.className = ok ? "ok" : ""; $("bfbResults").prepend(li);
    while ($("bfbResults").children.length > 8) $("bfbResults").lastChild.remove();
    if (ok) { tone(988, 110); tone(1319, 160, 0.13); } else tone(330, 220);
    if (ok) {
      const lv = levelNow(v);
      showDots(lv);
      if (st.active) sendLevel(lv, true);
      clearTimeout(pulseTo);
      pulseTo = setTimeout(() => { showDots(0); if (st.active) sendLevel(0, true); }, PULSE_MS);
    }
  });
  /* "Scale to me": a guided capture -> personal segment lengths (bodyscale.js).
   * Bones keep the camera's direction, take the person's length, so angles
   * stay as they were and lever arms (moments) become the person's own. */
  let scaleRun = null;
  const STEPS = [["bfb_sc1", 4], ["bfb_sc2", 4], ["bfb_sc3", 4], ["bfb_sc4", 8]];
  function renderScale() {
    const p = cfg.scale;
    $("bfbScaleSt").textContent = p ? tr(p.source === "osim" ? "bfb_scaleOsimOn" : "bfb_scaleOn", { date: (p.made || "").slice(0, 10) }) : tr("bfb_scaleOff");
    $("bfbScaleUse").checked = !!(p && cfg.useScale); $("bfbScaleUse").disabled = !p; $("bfbScaleClear").disabled = !p;
    $("bfbScaleTbl").innerHTML = p ? `<table><tr>${Object.keys(SEGS).map((k) => `<td>${esc(tr("bfb_seg_" + k))}</td>`).join("")}</tr><tr>${Object.keys(SEGS).map((k) =>
      `<td><b>${(p.seg[k] * 100).toFixed(1)}</b> cm${p.from && p.from[k] === "height" ? "*" : p.spread && Number.isFinite(p.spread[k]) ? ` <small>±${(p.spread[k] * (p.sizeFactor || 1) * 50).toFixed(1)}</small>` : ""}</td>`).join("")}</tr></table>`
      + (p.from ? `<small>${esc(tr("bfb_scaleStar"))}</small>` : "") : "";
  }
  $("bfbScaleUse").onchange = () => { cfg.useScale = $("bfbScaleUse").checked; save(); renderScale(); };
  $("bfbScaleClear").onclick = () => { cfg.scale = null; cfg.useScale = false; save(); renderScale(); };
  $("bfbScaleOsim").onchange = async () => {
    const f = $("bfbScaleOsim").files[0]; if (!f) return;
    try {
      const p = fromOsim(await f.text(), cfg.height || 1.75);
      cfg.scale = p; cfg.useScale = true;
      if (Number.isFinite(p.massKg) && p.massKg > 20) { cfg.mass = +p.massKg.toFixed(1); $("bfbMass").value = cfg.mass; syncExt(); }
      save(); renderScale();
    } catch (e) { $("bfbScaleSt").textContent = tr("bfb_scaleFail", { err: e.message }); }
    $("bfbScaleOsim").value = "";
  };
  $("bfbScaleGo").onclick = () => {
    if (!st.stream) { $("bfbScaleSt").textContent = tr("bfb_scaleCam"); return; }
    if (scaleRun) return;
    scaleRun = { frames: [] };
    const total = STEPS.reduce((a, [, s]) => a + s, 0), t0 = performance.now();
    $("bfbGuide").classList.remove("hidden");
    const tick = () => {
      const el = (performance.now() - t0) / 1000;
      let acc = 0, step = STEPS.length - 1;
      for (let i = 0; i < STEPS.length; i++) { if (el < acc + STEPS[i][1]) { step = i; break; } acc += STEPS[i][1]; }
      $("bfbGuideTxt").textContent = `${step + 1}/${STEPS.length} · ${tr(STEPS[step][0])}`;
      $("bfbGuideFill").style.width = Math.min(100, (el / total) * 100) + "%";
      if (el < total && st.stream) { requestAnimationFrame(tick); return; }
      $("bfbGuide").classList.add("hidden");
      const fr = scaleRun.frames; scaleRun = null;
      if (fr.length < 30) { $("bfbScaleSt").textContent = tr("bfb_scaleFew"); return; }
      cfg.scale = summariseSegs(fr, cfg.height || 1.75); cfg.useScale = true; save(); renderScale();
      tone(1047, 120); tone(1319, 160, 0.13);
    };
    tick();
  };
  function frame() {
    st.raf = requestAnimationFrame(frame);
    const v = $("bfbVideo"); if (!st.lm || v.readyState < 2) return;
    let ts = performance.now(); if (ts <= st.lastTs) ts = st.lastTs + 1; st.lastTs = ts;
    const cv = $("bfbCanvas"), ctx = cv.getContext("2d");
    if (st.picking) {               // choosing the area: show the drag rectangle, no tracking
      cv.width = v.videoWidth; cv.height = v.videoHeight; ctx.clearRect(0, 0, cv.width, cv.height);
      if (drag) {
        const [x0, y0] = drag.a, [x1, y1] = drag.b;
        ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.clearRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        ctx.strokeStyle = "#ffd54a"; ctx.lineWidth = 4; ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      return;
    }
    const S = source(v);
    const r = st.lm.detectForVideo(S.el, ts);
    cv.width = S.w; cv.height = S.h;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const img = r.landmarks && r.landmarks[0], w0 = r.worldLandmarks && r.worldLandmarks[0];
    if (w0 && scaleRun) scaleRun.frames.push(measureSegs(w0));
    const w = w0 && cfg.useScale && cfg.scale ? constrainSegs(w0, cfg.scale) : w0;   // personal bone lengths
    const m = METRICS[cfg.metric];
    if (!img || !w) { if (!m.ev) { $("bfbValue").textContent = "–"; if (st.active) send(false); } return; }
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(80,200,170,.9)";
    for (const [a, b] of SKEL) { ctx.beginPath(); ctx.moveTo(img[a].x * cv.width, img[a].y * cv.height); ctx.lineTo(img[b].x * cv.width, img[b].y * cv.height); ctx.stroke(); }
    /* Head and neck: shoulder centre -> neck -> ear centre (what "head
     * forward" measures), ear centre -> nose (what "head nod" measures),
     * plus ear-ear, eye-eye and mouth so the head's tilt is visible. */
    const P = (p) => [p.x * cv.width, p.y * cv.height];
    const line = (p, q) => { ctx.beginPath(); ctx.moveTo(...P(p)); ctx.lineTo(...P(q)); ctx.stroke(); };
    const shM = midp(img[11], img[12]), earM = midp(img[7], img[8]), mouthM = midp(img[9], img[10]);
    const neckM = { x: (shM.x * 2 + earM.x) / 3, y: (shM.y * 2 + earM.y) / 3, z: 0 };
    line(shM, neckM); line(neckM, earM); line(earM, img[0]);
    line(img[7], img[8]); line(img[2], img[5]); line(img[9], img[10]); line(img[0], mouthM);
    ctx.fillStyle = "rgba(255,213,74,.95)";
    for (const p of [shM, neckM, earM, img[0], img[7], img[8]]) { const [x, y] = P(p); ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill(); }
    // Head pose from the face model, only while a head metric is chosen.
    let head = null;
    if (m.face || cfg.move === "neck") {
      if (!st.face && !st.faceLoading) {
        st.faceLoading = true; $("bfbCamNote").textContent = tr("bfb_faceLoading");
        makeFace().then((f) => { st.face = f; $("bfbCamNote").textContent = ""; })
          .catch(() => { $("bfbCamNote").textContent = tr("bfb_faceFail"); });
      }
      if (st.face) {
        const fr = st.face.detectForVideo(S.el, ts);
        const fm = fr.facialTransformationMatrixes && fr.facialTransformationMatrixes[0];
        const fl = fr.faceLandmarks && fr.faceLandmarks[0];
        if (fm) head = headPose(fm.data);
        if (fl) {   // head axes: forehead-chin and cheek-cheek
          ctx.strokeStyle = "rgba(255,213,74,.95)"; ctx.lineWidth = 3;
          line(fl[10], fl[152]); line(fl[234], fl[454]); line(fl[168], fl[1]);
          ctx.strokeStyle = "rgba(80,200,170,.9)"; ctx.lineWidth = 4;
        }
      }
    }
    detect(ts, img, w);
    ASPECT = (S.w / S.h) || ASPECT;
    // "Zero" removes camera tilt / posture offset, per side for paired metrics.
    let ld = null;
    const mv = MOVES[cfg.move] || MOVES.free;
    if (m.load || (cfg.move !== "free" && mv.metrics.some((k) => METRICS[k].load))) {
      if (!loadEst.ready()) loadEst.load().then(() => { $("bfbCamNote").textContent = ""; })
        .catch(() => { $("bfbCamNote").textContent = tr("bfb_loadFail"); });
      ld = loadEst.push(ts, w, cfg.mass || 75, loadOf(cfg.move), cfg.height || 1.75, wtOf(cfg.move));
      if (!ld) $("bfbCamNote").textContent = tr("bfb_loadLoading");
    }
    let bb = null;
    if (mv.bar) {
      bb = barT.step(ts, img, S.w, S.h, mv.bar, cfg.height || 1.75, Math.max(knee(w, 0), knee(w, 1)), loadOf(cfg.move));
      if (bb) {   // the bar on the video: a dot, and its path over the last 3 s
        barTrail.push([ts, bb.raw]); while (barTrail.length && barTrail[0][0] < ts - 3000) barTrail.shift();
        ctx.strokeStyle = "rgba(255,213,74,.9)"; ctx.lineWidth = 3; ctx.beginPath();
        barTrail.forEach(([, p], i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
        ctx.fillStyle = "#ffd54a"; ctx.beginPath(); ctx.arc(bb.raw[0], bb.raw[1], 9, 0, 7); ctx.fill();
      } else $("bfbCamNote").textContent = tr("bfb_barScale");
    }
    EXT.t = ts / 1000;                      // arm moments use the movement's accelerations
    const val = (k) => METRICS[k].f(w, img, head, ld, bb) - ((cfg.zero && cfg.zero[k]) || 0);
    const o = recordFrame(ts, val, mv, w) || {};
    if (m.ev) return;                       // event metrics update on their own
    const sm = (prev, x) => (Number.isFinite(x) ? (Number.isFinite(prev) ? prev + 0.35 * (x - prev) : x) : NaN);
    let shown;
    if (m.pair) {
      emaL = sm(emaL, val(m.pair[0])); emaR = sm(emaR, val(m.pair[1]));
      showBar(emaL, "L"); showBar(emaR, "R");
      hist.push({ t: ts, a: emaL, b: emaR, o });
      const both = [emaL, emaR].filter(Number.isFinite); if (!both.length) { plot(ts); return; }
      ema = cfg.dir === "above" ? Math.max(...both) : Math.min(...both);   // either side crossing counts
      shown = `L ${Number.isFinite(emaL) ? fmt(emaL) : "–"}  R ${Number.isFinite(emaR) ? fmt(emaR) : "–"}`;
    } else {
      ema = sm(ema, val(cfg.metric));
      if (!Number.isFinite(ema)) { plot(ts); return; }
      showBar(ema); hist.push({ t: ts, a: ema, b: NaN, o });
      shown = fmt(ema);
    }
    plot(ts);
    st.value = ema; st.valL = emaL; st.valR = emaR;
    $("bfbValue").textContent = shown;
    // Hysteresis: switch on past thr, off only once back by `hyst`.
    const sts = lampStates(ema, val), lv = sts.filter(Boolean).length, top = sts.lastIndexOf(true);
    if (lv > lastLv && cfg.sound !== "off") tone([880, 1047, 1319][lv - 1], 140);   // higher pitch per lamp
    lastLv = lv; on = lv > 0;
    $("bfbValue").classList.toggle("hit", on);
    $("bfbValue").style.color = on ? LVCOL[top] : "";
    showLamps(sts);
    overSince = on;
    if (st.active) sendLamps(sts);
  }
  /* Belt and braces: while active, re-send the lamp state every 500 ms, so a
   * byte lost to a board reset or a busy port corrects itself. Not logged. */
  setInterval(() => {
    if (!st.active || !st.writer) return;
    if (st.ver >= 5 && st.lamps) { const P = cfg.pins || [13, 12, 11]; for (let i = 0; i < 3; i++) if (P[i]) writeLine(`T${P[i]}:${st.lamps[i] ? 1 : 0}`, true); return; }
    if (st.lit == null) return;
    st.writer.write(new TextEncoder().encode(lvMsg(st.lit) + "\n")).catch(() => {});
  }, 500);
  $("bfbCamBtn").onclick = async () => {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch { /* no audio */ }
    if (isPhone()) { if (st.motionStop) { stopPhone(); renderSrc(); } else await startPhone(); return; }
    if (st.stream) { stopCam(); renderSrc(); return; }
    $("bfbCamNote").textContent = tr("bfb_loadingModel");
    if (!st.lm) { st.lm = await getLandmarker(); if (!st.lm) { $("bfbCamNote").textContent = tr("bfb_modelFail"); return; } }
    if (!(await startCam())) return;
    $("bfbCamNote").textContent = isScreen() ? tr("bfb_scrHint") : "";
    renderSrc();
    frame();
  };
  /* Zero: the current reading becomes 0 for this metric. The camera's own
   * tilt shows up directly in trunk lean (a webcam on a monitor looks down
   * ~10-20 deg), so stand in your neutral posture and press it once. */
  $("bfbZero").onclick = () => {
    const m = METRICS[cfg.metric]; if (m.ev || !Number.isFinite(st.value)) return;
    const z = { ...(cfg.zero || {}) };
    const add = (k, v) => { if (Number.isFinite(v)) z[k] = (z[k] || 0) + v; };
    if (m.pair) { add(m.pair[0], st.valL); add(m.pair[1], st.valR); } else add(cfg.metric, st.value);
    cfg.zero = z; ema = emaL = emaR = NaN; save();
    $("bfbZeroNote").textContent = tr("bfb_zeroed", { v: (z[m.pair ? m.pair[0] : cfg.metric] || 0).toFixed(0) });
  };
  $("bfbZeroReset").onclick = () => {
    const m = METRICS[cfg.metric];
    if (cfg.zero) for (const k of m.pair || [cfg.metric]) delete cfg.zero[k];
    ema = emaL = emaR = NaN; save(); $("bfbZeroNote").textContent = "";
  };
  $("bfbActivate").onclick = () => {
    st.active = !st.active;
    if (st.active) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch { /* no audio */ } overSince = false; }
    if (st.active && !METRICS[cfg.metric].ev) send(on, true);   // tell the board the state right now
    $("bfbActivate").textContent = tr(st.active ? "bfb_deactivate" : "bfb_activate");
    $("bfbActivate").classList.toggle("danger", st.active);
    if (!st.active) send(false, true);
  };

  $("bfbPlotPick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-extra]"); if (!b) return;
    const k = b.dataset.extra, cur = cfg.extra || [];
    if (cur.includes(k)) cfg.extra = cur.filter((x) => x !== k);
    else {
      const lines = nMain() + extraCols().length + (METRICS[k].pair ? 2 : 1);
      if (lines > MAXLINES) { $("bfbCamNote").textContent = tr("bfb_plotMax", { n: MAXLINES }); return; }
      cfg.extra = [...cur, k];
    }
    save(); renderPick();
  });

  /* ---------- session: cycles, tables, export ----------
   * Every frame the live metrics of the chosen movement are recorded
   * (rec.samples). A CYCLE is found on the movement's main metric: it starts
   * when the value leaves its resting baseline by more than `exc` and ends
   * when it is back within 30% of the excursion; each cycle adds one row to
   * that movement's table with the peak of every metric (left / right).
   * Jumps and shots add one row per event from the event detectors. One table
   * per movement, rows keep adding, like the recorder's session. */
  const rec = { t0: null, samples: [], rows: {}, cyc: null };
    const EXC = { "°": 15, BW: 0.5, cm: 5, ms: 100, "m/s": 0.3, W: 200 };
  const mainKey = (mv) => (cfg.move === "free" ? cfg.metric : mv.def);
  const liveKeys = (mv) => (cfg.src === "phone" ? PHONE_KEYS : cfg.move === "free" ? [cfg.metric, ...(cfg.extra || []).filter((k) => MOVES.free.metrics.includes(k))] : mv.metrics).filter((k) => METRICS[k] && !METRICS[k].ev);
  function readAll(val, keys) {
    const o = {};
    for (const k of keys) {
      const mm = METRICS[k];
      if (mm.pair) { o[k + "_L"] = val(mm.pair[0]); o[k + "_R"] = val(mm.pair[1]); } else o[k] = val(k);
    }
    return o;
  }
  function recordFrame(ts, val, mv, w) {
    if (rec.t0 == null) rec.t0 = ts;
    const keys = liveKeys(mv); if (!keys.length) return {};
    const o = readAll(val, keys);
    // _c: the frame's model coordinates (liveCoords), for the rep report's
    // stick figures and contact-force dials. Not exported as columns.
    if (rec.samples.length < 200000) rec.samples.push({ t: (ts - rec.t0) / 1000, move: cfg.move, ...o, _c: w ? liveCoords(w) : null });
    // main signal: the side further from rest (either side counts)
    const mk = mainKey(mv), mm = METRICS[mk]; if (!mm || mm.ev || EVENT_MOVES.has(cfg.move)) return o;
    const xs = mm.pair ? [o[mk + "_L"], o[mk + "_R"]].filter(Number.isFinite) : [o[mk]].filter(Number.isFinite);
    if (!xs.length) return o;
    let c = rec.cyc;
    if (!c || c.move !== cfg.move || c.key !== mk) c = rec.cyc = { move: cfg.move, key: mk, b: NaN, inC: false, frames: [], quiet: 0 };
    const x = Number.isFinite(c.b) ? xs.reduce((a, v) => (Math.abs(v - c.b) > Math.abs(a - c.b) ? v : a), xs[0]) : xs[0];
    const E = EXC[mm.unit] ?? 15;
    if (!c.inC) {
      c.b = Number.isFinite(c.b) ? c.b + 0.05 * (x - c.b) : x;
      if (Math.abs(x - c.b) > E) { c.inC = true; c.start = ts; c.peak = 0; c.frames = []; c.i0 = Math.max(0, rec.samples.length - 6); }
    }
    if (c.inC) {
      c.frames.push(o); c.peak = Math.max(c.peak, Math.abs(x - c.b));
      if (Math.abs(x - c.b) < 0.3 * c.peak) c.quiet++; else c.quiet = 0;
      if (c.quiet >= 3 || ts - c.start > 15000) {
        const dur = (ts - c.start) / 1000; c.inC = false;
        if (dur > 0.4 && dur < 15) addCycleRow(mv, c, dur, (c.start - rec.t0) / 1000);
      }
    }
    return o;
  }
  /* Extreme of a column over the cycle: whichever of max/min lies further from the first frame. */
  function extreme(frames, col) {
    const v = frames.map((f) => f[col]).filter(Number.isFinite); if (!v.length) return NaN;
    const a = Math.max(...v), b = Math.min(...v);
    return Math.abs(a - v[0]) >= Math.abs(b - v[0]) ? a : b;
  }
  function addCycleRow(mv, c, dur, t) {
    const row = { t, dur, i0: c.i0, i1: rec.samples.length };
    for (const k of liveKeys(mv)) {
      const mm = METRICS[k];
      if (mm.pair) { row[k + "_L"] = extreme(c.frames, k + "_L"); row[k + "_R"] = extreme(c.frames, k + "_R"); }
      else row[k] = extreme(c.frames, k);
    }
    /* Bar per rep: vertical range, largest drift from mid-foot, peak and mean
     * concentric (upward) velocity, peak power; and the path itself for the report. */
    if (MOVES[cfg.move] && MOVES[cfg.move].bar) {
      const ys = c.frames.map((f) => f.barY).filter(Number.isFinite), xs = c.frames.map((f) => f.barX).filter(Number.isFinite);
      const up = c.frames.map((f) => f.barVel).filter((v) => Number.isFinite(v) && v > 0.05);
      if (ys.length) row.barRange = Math.max(...ys) - Math.min(...ys);
      if (xs.length) row.barDrift = xs.reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
      if (up.length) { row.barVpk = Math.max(...up); row.barVmean = up.reduce((a, v) => a + v, 0) / up.length; }
      const pw = c.frames.map((f) => f.barPow).filter(Number.isFinite); if (pw.length) row.barPpk = Math.max(...pw);
      row.load = loadOf(c.move || cfg.move);
      delete row.barY; delete row.barX; delete row.barVel; delete row.barPow;
    }
    const p = METRICS[c.key];
    const main = p.pair ? [row[c.key + "_L"], row[c.key + "_R"]].filter(Number.isFinite) : [row[c.key]];
    row.hit = main.some((v) => meets(v));
    pushRow(cfg.move, row);
  }
  function recordEvent(vals) {
    const mv = MOVES[cfg.move]; if (!mv) return;
    const keys = mv.metrics.filter((k) => METRICS[k].ev && k in vals); if (!keys.length) return;
    const row = { t: rec.t0 == null ? 0 : (performance.now() - rec.t0) / 1000, ev: true };
    for (const k of keys) row[k] = vals[k];
    row.hit = null;
    pushRow(cfg.move, row);
  }
  /* Rep report: everything recorded for one row, in a window, while the
   * session keeps recording underneath. Cycle rows have their sample range;
   * a jump / shot shows the 2.5 s before and 1 s after it. */
  /* Rep report, in the recorder's format: the joint-load figure (stick
   * figures at the rep's key instants, vertical GRF, polar contact-force
   * dials; jointload.js, sagittal / frontal, left / right), then one line
   * plot with a menu of every variable, over 0-100 % of the rep. Above it,
   * the rep's values with left and right side by side; a pair whose sides
   * differ by more than 15 % is marked orange. Recording carries on. */
  const SIDE_L = "#2f9e5f", SIDE_R = "#d1493f", ASYM = 0.15;
  const RECORDER_ACT = { squat: "squat", slsquat: "slsquat", cmj: "cmj", sj: "sj", shot: "jumpshot" };
  async function openRep(move, idx) {
    const row = rec.rows[move][idx]; if (!row) return;
    const smp = (row.i0 != null ? rec.samples.slice(row.i0, row.i1 + 1)
      : rec.samples.filter((x) => x.t > row.t - 2.5 && x.t < row.t + 1 && x.move === move)).filter((x) => x._c);
    const cols = columns(move), u = (k) => METRICS[k].unit;
    const asym = (l, r) => Number.isFinite(l) && Number.isFinite(r) && Math.max(Math.abs(l), Math.abs(r)) > 1e-6
      && Math.abs(l - r) / Math.max(Math.abs(l), Math.abs(r)) > ASYM;
    const valRows = cols.map((k) => {
      const m = METRICS[k];
      if (!m.pair) return `<tr><td>${esc(short(k))}</td><td colspan="3" class="num">${cell(row[k], u(k))} ${esc(u(k))}</td></tr>`;
      const l = row[k + "_L"], r = row[k + "_R"], bad = asym(l, r);
      const d = Number.isFinite(l) && Number.isFinite(r) && Math.max(Math.abs(l), Math.abs(r)) > 1e-6
        ? ((l - r) / Math.max(Math.abs(l), Math.abs(r)) * 100).toFixed(0) + " %" : "–";
      return `<tr class="${bad ? "asym" : ""}"><td>${esc(short(k))} <small>(${esc(u(k))})</small></td>
        <td class="num">${cell(l, u(k))}</td><td class="num">${cell(r, u(k))}</td><td class="num">${d}</td></tr>`;
    }).join("");
    const repVals = Object.keys(REPCOLS).filter((k) => k in row).map((k) =>
      `<tr><td>${esc(tr(REPCOLS[k][0]))} <small>(${REPCOLS[k][1]})</small></td><td colspan="3" class="num">${repCell(k, row[k])}</td></tr>`).join("");
    const evVals = Object.keys(row).filter((k) => METRICS[k] && METRICS[k].ev).map((k) =>
      `<tr><td>${esc(short(k))} <small>(${esc(u(k))})</small></td><td colspan="3" class="num">${cell(row[k], u(k))}</td></tr>`).join("");
    // every variable recorded in this rep, for the line plot's menu
    const vars = [...new Set(Object.keys(smp[0] || {}).filter((c) => !["t", "move", "_c"].includes(c)).map((c) => c.replace(/_[LR]$/, "")))]
      .filter((k) => METRICS[k]);
    const dlg = document.createElement("dialog"); dlg.className = "bfbRep";
    dlg.innerHTML = `<div class="lmHead"><b>${esc(tr(MOVES[move].label))} · ${esc(tr("bfb_rep"))} ${idx + 1}</b>
        <button type="button" class="ghost lmX" aria-label="Close">✕</button></div>
      <p class="note">t = ${row.t.toFixed(1)} s${row.dur != null ? ` · ${esc(tr("bfb_dur"))} ${row.dur.toFixed(1)}` : ""}${row.hit ? " · ✓" : ""}</p>
      <table class="bfbRepVals"><thead><tr><th></th><th class="num"><i class="swatch" style="background:${SIDE_L}"></i>${esc(tr("leftShort"))}</th>
        <th class="num"><i class="swatch" style="background:${SIDE_R}"></i>${esc(tr("rightShort"))}</th><th class="num">L−R</th></tr></thead>
        <tbody>${repVals}${evVals}${valRows}</tbody></table>
      <p class="note">${esc(tr("bfb_asymNote"))}</p>
      <div class="bfbJL"></div>
      ${smp.some((x) => Number.isFinite(x.barY)) ? `<div class="note">${esc(tr("bfb_barPath"))}</div><canvas class="bfbPath" width="300" height="300"></canvas>` : ""}
      <div class="row bfbRow"><label><span data-i18n="bfb_repVar">${esc(tr("bfb_repVar"))}</span><select class="bfbRepSel">${vars.map((k) =>
        `<option value="${k}"${k === (vars.includes(cfg.metric) ? cfg.metric : vars[0]) ? " selected" : ""}>${esc(short(k))} (${esc(u(k))})</option>`).join("")}</select></label></div>
      <canvas class="bfbRepPlot" height="220"></canvas>`;
    document.body.appendChild(dlg);
    dlg.querySelector(".lmX").onclick = () => dlg.close();
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--muted").trim() || "#999";

    /* line plot, % of the rep */
    const drawLine = () => {
      const k = dlg.querySelector(".bfbRepSel").value, cv = dlg.querySelector(".bfbRepPlot");
      const W = cv.clientWidth || 600, H = 220, dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ser = METRICS[k].pair ? [[k + "_L", SIDE_L, tr("leftShort")], [k + "_R", SIDE_R, tr("rightShort")]] : [[k, SIDE_R, ""]];
      const all = smp.flatMap((x) => ser.map(([col]) => x[col])).filter(Number.isFinite);
      if (!all.length || smp.length < 2) return;
      let lo = Math.min(...all), hi = Math.max(...all);
      if (k === cfg.metric) { lo = Math.min(lo, cfg.thr); hi = Math.max(hi, cfg.thr); }
      const pd = (hi - lo) * 0.1 || 1; lo -= pd; hi += pd;
      const t0 = smp[0].t, t1 = smp[smp.length - 1].t;
      const X = (t) => 40 + ((t - t0) / (t1 - t0 || 1)) * (W - 50), Y = (v) => 10 + (1 - (v - lo) / (hi - lo)) * (H - 34);
      c.font = "11px system-ui, sans-serif"; c.fillStyle = ink; c.strokeStyle = ink; c.globalAlpha = 0.3;
      for (const f of [0, 0.25, 0.5, 0.75, 1]) { const y = 10 + f * (H - 34); c.beginPath(); c.moveTo(40, y); c.lineTo(W - 10, y); c.stroke(); }
      c.globalAlpha = 1;
      for (const f of [0, 0.5, 1]) { const v = hi - f * (hi - lo); c.fillText(v.toFixed(u(k) === "BW" || u(k) === "m/s" ? 1 : 0), 2, 14 + f * (H - 34)); }
      for (const p of [0, 25, 50, 75, 100]) c.fillText(p + " %", 40 + (p / 100) * (W - 50) - (p === 100 ? 26 : 0), H - 4);
      if (k === cfg.metric) { c.setLineDash([6, 4]); c.strokeStyle = "#ffd54a"; c.beginPath(); c.moveTo(40, Y(cfg.thr)); c.lineTo(W - 10, Y(cfg.thr)); c.stroke(); c.setLineDash([]); }
      for (const [col, color] of ser) {
        c.strokeStyle = color; c.lineWidth = 2.2; c.beginPath(); let pen = false;
        for (const x of smp) { const v = x[col]; if (!Number.isFinite(v)) { pen = false; continue; } pen ? c.lineTo(X(x.t), Y(v)) : c.moveTo(X(x.t), Y(v)); pen = true; }
        c.stroke();
      }
      c.textAlign = "right"; let lx = W - 10;
      for (const [, color, name] of ser.slice().reverse()) if (name) { c.fillStyle = color; c.fillText(name, lx, 12); lx -= c.measureText(name).width + 10; }
      c.textAlign = "left";
    };
    dlg.querySelector(".bfbRepSel").onchange = drawLine;
    drawLine();

    /* bar path */
    const pc = dlg.querySelector("canvas.bfbPath");
    if (pc) {
      const pts = smp.filter((x) => Number.isFinite(x.barY) && Number.isFinite(x.barX)), c = pc.getContext("2d");
      if (pts.length) {
        const ys = pts.map((q) => q.barY), xs = pts.map((q) => q.barX);
        const span = Math.max(20, Math.max(...ys) - Math.min(...ys), 2 * Math.max(10, ...xs.map(Math.abs))) * 1.15;
        const cy = (Math.max(...ys) + Math.min(...ys)) / 2, S = 280 / span, X = (x) => 150 + x * S, Y = (y) => 150 - (y - cy) * S;
        c.strokeStyle = ink; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(150, 4); c.lineTo(150, 296); c.stroke(); c.setLineDash([]);
        c.fillStyle = ink; c.font = "10px system-ui, sans-serif"; c.fillText(tr("bfb_midfoot"), 154, 292);
        c.strokeStyle = "#ffd54a"; c.lineWidth = 3; c.beginPath();
        pts.forEach((q, i) => (i ? c.lineTo(X(q.barX), Y(q.barY)) : c.moveTo(X(q.barX), Y(q.barY)))); c.stroke();
        c.fillStyle = SIDE_L; c.beginPath(); c.arc(X(pts[0].barX), Y(pts[0].barY), 5, 0, 7); c.fill();
      }
    }

    /* joint-load figure: the surrogate re-run over the whole rep (loads,
     * vectors and magnitudes), drawn by the recorder's jointLoadSVG. */
    const box = dlg.querySelector(".bfbJL");
    if (smp.length < 6) { box.innerHTML = ""; return; }
    box.innerHTML = `<p class="note">${esc(tr("bfb_loadLoading"))}</p>`;
    let model;
    try { model = await loadEst.load(); } catch { box.innerHTML = `<p class="note">${esc(tr("bfb_loadFail"))}</p>`; return; }
    const coords = {}; for (const key of Object.keys(smp[0]._c)) coords[key] = smp.map((x) => x._c[key]);
    const times = smp.map((x) => x.t - smp[0].t);
    const body = cfg.mass || 75, ext = loadOf(move);
    const out = predictForces(model, coords, smp.length, { massKg: body + ext, heightM: cfg.height || 1.75, times });
    const repObj = { coords, times, loads: out.loads, loadNames: out.loadNames, jrf: out.jrf, jrfNames: out.jrfNames };
    let plane = "sagittal", side = "r";
    const act = RECORDER_ACT[move] || "squat";
    const paint = () => {
      const fig = repObj.loads ? jointLoadSVG(repObj, { plane, side, activity: act,
        spec: move === "cmj" || move === "sj" ? { jump: true } : move === "shot" ? { shot: true } : {},
        massKg: body, externalKg: ext, heightM: cfg.height || 1.75, colors: { l: SIDE_L, r: SIDE_R }, tr }) : null;
      if (!fig) { box.innerHTML = ""; return; }
      const b = (grp, v, label, col) => `<label class="${(grp === "plane" ? plane : side) === v ? "on" : ""}"><input type="radio" name="bjl_${grp}" value="${v}"${
        (grp === "plane" ? plane : side) === v ? " checked" : ""}>${col ? `<i class="swatch" style="background:${col};margin:0"></i>` : ""}${esc(label)}</label>`;
      const pk = Object.entries(fig.peaks).map(([j, v]) => `${tr("jl_" + j)} ${v.toFixed(1)}`).join(" · ");
      box.innerHTML = `<h3 style="margin:10px 0 4px">${esc(tr("jlTitle"))}</h3>
        <div class="jmpick">${b("plane", "sagittal", tr("jlViewSagittal"))}${b("plane", "frontal", tr("jlViewFrontal"))}
          <span style="flex:0 0 8px"></span>${b("side", "l", tr("leftShort"), SIDE_L)}${b("side", "r", tr("rightShort"), SIDE_R)}</div>
        ${fig.svg}<p class="jmpeaks">${esc(tr("jlPeaks", { peaks: pk }))}</p>
        <p class="note">${esc(tr("jlNote"))} ${esc(tr("jlNoteGrfModel"))}${plane === "frontal" ? " " + esc(tr("jlNoteFrontal")) : ""}${ext ? " " + esc(tr("bfb_loadNote")) : ""}</p>`;
      for (const inp of box.querySelectorAll("input[type=radio]")) inp.onchange = () => {
        if (inp.name === "bjl_plane") plane = inp.value; else side = inp.value; paint();
      };
    };
    paint();
  }
  $("bfbTables").addEventListener("click", (e) => {
    const tr_ = e.target.closest("tr[data-row]"); if (!tr_) return;
    openRep(tr_.dataset.move, +tr_.dataset.row);
  });
  function pushRow(move, row) { (rec.rows[move] ||= []).push(row); renderTables(); }
  /* Short column titles: the metric label without its qualifiers. */
  const short = (k) => tr(METRICS[k].label).replace(/\s*\((?:per |peak|por |pro |Spitze|pico|model|modelo|Modell)[^)]*\)/gi, "").replace(/, (model|modelo|Modell)\b/i, "");
  const cell = (v, u) => (Number.isFinite(v) ? (u === "m/s" ? v.toFixed(2) : u === "BW" || u === "cm" ? v.toFixed(1) : v.toFixed(0)) : "–");
  function columns(move) {
    const mv = MOVES[move]; const cols = [];
    const keys = move === "free" ? Object.keys(Object.assign({}, ...rec.rows[move])).filter((k) => METRICS[k.replace(/_[LR]$/, "")]) : mv.metrics;
    const seen = new Set();
    for (const kk of keys) {
      const k = kk.replace(/_[LR]$/, ""); if (seen.has(k)) continue; seen.add(k);
      if (METRICS[k] && METRICS[k].bar) continue;
      if (!rec.rows[move].some((r) => (k in r) || ((k + "_L") in r))) continue;
      cols.push(k);
    }
    return cols;
  }
  /* Per-rep bar columns (not live metrics, so declared here). */
  const REPCOLS = { load: ["bfb_c_load", "kg"], barRange: ["bfb_c_barRange", "cm"], barDrift: ["bfb_c_barDrift", "cm"],
                    barVpk: ["bfb_c_barVpk", "m/s"], barVmean: ["bfb_c_barVmean", "m/s"], barPpk: ["bfb_c_barPpk", "W"] };
  const repCell = (k, v) => (Number.isFinite(v) ? (REPCOLS[k][1] === "m/s" ? v.toFixed(2) : v.toFixed(0)) : "–");
  function renderTables() {
    const host = $("bfbTables"); if (!host) return;
    host.innerHTML = Object.keys(rec.rows).map((move) => {
      const rows = rec.rows[move], cols = columns(move);
      const rc = Object.keys(REPCOLS).filter((k) => rows.some((r) => k in r));
      const head = `<tr><th>#</th><th>t (s)</th>${rows[0].dur != null ? `<th>${esc(tr("bfb_dur"))}</th>` : ""}${rc.map((k) =>
        `<th>${esc(tr(REPCOLS[k][0]))} <small>(${REPCOLS[k][1]})</small></th>`).join("")}${cols.map((k) =>
        `<th>${esc(short(k))}${METRICS[k].pair ? " <small>L / R</small>" : ""} <small>(${esc(METRICS[k].unit)})</small></th>`).join("")}<th>✓</th></tr>`;
      const body = rows.map((r, i) => `<tr data-move="${move}" data-row="${i}" class="${r.hit ? "hit" : ""}" title="${esc(tr("bfb_repOpen"))}"><td>${i + 1}</td><td>${r.t.toFixed(1)}</td>${r.dur != null ? `<td>${r.dur.toFixed(1)}</td>` : ""}${rc.map((k) => `<td>${repCell(k, r[k])}</td>`).join("")}${cols.map((k) => {
        const u = METRICS[k].unit;
        return `<td>${METRICS[k].pair ? `${cell(r[k + "_L"], u)} / ${cell(r[k + "_R"], u)}` : cell(r[k], u)}</td>`;
      }).join("")}<td>${r.hit ? "✓" : r.hit === false ? "✗" : ""}</td></tr>`).join("");
      return `<div class="bfbTbl"><b>${esc(tr(MOVES[move].label))}</b> <span class="note">${esc(tr("bfb_nCycles", { n: rows.length }))}</span>
        <div class="tableScroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
    }).join("");
    $("bfbSave").disabled = !rec.samples.length && !Object.keys(rec.rows).length;
    renderQuick();
  }
  /* Quick view next to the camera: trial count + one value of choice for the
     current movement (newest first). Clicking a row opens the full rep report. */
  function renderQuick() {
    const host = $("bfbQuick"); if (!host) return;
    const move = rec.rows[cfg.move] ? cfg.move : Object.keys(rec.rows).pop();
    const rows = move ? rec.rows[move] : [];
    if (!rows || !rows.length) {
      host.innerHTML = `<div class="qh"><span>${esc(tr("bfb_quickTitle"))}</span><b>0</b></div><p class="note">${esc(tr("bfb_quickEmpty"))}</p>`;
      return;
    }
    const opts = [...Object.keys(REPCOLS).filter((k) => rows.some((r) => k in r)).map((k) => ["r:" + k, tr(REPCOLS[k][0])]),
                  ...columns(move).map((k) => ["m:" + k, short(k)])];
    if (rows[0].dur != null) opts.unshift(["dur", tr("bfb_dur")]);
    let pick = (cfg.quick || {})[move];
    if (!opts.some((o) => o[0] === pick)) pick = (opts.find((o) => o[0] === "m:" + cfg.metric.replace(/[LR]$/, "")) || opts.find((o) => o[0].startsWith("m:")) || opts[0] || [""])[0];
    const val = (r) => {
      if (pick === "dur") return r.dur != null ? r.dur.toFixed(1) + " s" : "–";
      const k = pick.slice(2);
      if (pick.startsWith("r:")) return repCell(k, r[k]) + " " + REPCOLS[k][1];
      const u = METRICS[k].unit;
      return METRICS[k].pair ? `${cell(r[k + "_L"], u)} / ${cell(r[k + "_R"], u)}` : cell(r[k], u) + " " + u;
    };
    const body = rows.map((r, i) => [r, i]).reverse().map(([r, i]) =>
      `<tr data-move="${move}" data-row="${i}" class="${r.hit ? "hit" : ""}" title="${esc(tr("bfb_repOpen"))}"><td>${i + 1}</td><td>${val(r)}</td></tr>`).join("");
    host.innerHTML = `<div class="qh"><span>${esc(tr(MOVES[move].label))}</span><b>${rows.length}</b></div>
      <select aria-label="${esc(tr("bfb_quickCol"))}">${opts.map(([v, l]) => `<option value="${v}"${v === pick ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <div class="qs"><table><tbody>${body}</tbody></table></div>`;
    host.querySelector("select").onchange = (e) => { cfg.quick = { ...(cfg.quick || {}), [move]: e.target.value }; save(); renderQuick(); };
  }
  $("bfbQuick").addEventListener("click", (e) => {
    const tr_ = e.target.closest("tr[data-row]"); if (!tr_) return;
    openRep(tr_.dataset.move, +tr_.dataset.row);
  });
  const csv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => {
    const v = r[c]; return v == null ? "" : typeof v === "number" ? (Number.isFinite(v) ? +v.toFixed(4) : "") : String(v).includes(",") ? `"${v}"` : v;
  }).join(","))].join("\n");
  $("bfbSave").onclick = () => {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const files = [];
    for (const [move, rows] of Object.entries(rec.rows)) {
      const cols = ["t", ...(rows[0].dur != null ? ["dur"] : []), ...[...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !["t", "dur", "hit", "i0", "i1", "ev"].includes(c)), "hit"];
      files.push({ name: `summary_${move}.csv`, data: csv(rows, cols) });
    }
    if (rec.samples.length) {
      const cols = ["t", "move", ...[...new Set(rec.samples.flatMap((r) => Object.keys(r)))].filter((c) => c !== "t" && c !== "move" && c !== "_c")];
      files.push({ name: "timeseries.csv", data: csv(rec.samples, cols) });
    }
    files.push({ name: "settings.json", data: JSON.stringify({ saved: new Date().toISOString(), source: cfg.src, movement: cfg.move,
      metric: cfg.metric, bodyMassKg: cfg.mass, heightM: cfg.height, loadKg: wtOf(cfg.move), threshold: cfg.thr, thresholds: { yellow: cfg.thr, orange: cfg.thr2, red: cfg.thr3 }, unit: METRICS[cfg.metric].unit, lightWhen: cfg.dir, hysteresis: cfg.hyst, zero: cfg.zero }, null, 2) });
    files.push({ name: "README.txt", data: tr("bfb_readme") });
    const blob = makeZip(files), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `bioscout_biofeedback_${stamp}.zip`; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  };
  $("bfbClear").onclick = () => { rec.t0 = null; rec.samples = []; rec.rows = {}; rec.cyc = null; renderTables(); };

  /* ---------- open / leave ---------- */
  function open() {
    $("bfbNoSerial").classList.toggle("hidden", hasSerial);
    if (!MOVES[cfg.move]) cfg.move = "squat";
    fillMoves(); fillMetrics(); syncInputs(); renderScale(); renderConn(); listPorts(); renderBody(); renderSrc(); renderTables();
    if (!st.port) status("bfb_portNone");
  }
  async function leave() {
    if (st.active) $("bfbActivate").click();
    stopCam(); renderSrc();
  }
  return { open, leave, relabel: () => { fillMoves(); fillMetrics(); } };
}
