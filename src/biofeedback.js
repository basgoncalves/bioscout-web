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

import { bodyMapHTML, REGIONS } from "./bodymap.js";

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
  valgus:    { label: "bfb_m_valgus",    unit: DEG, pair: ["valgusL", "valgusR"] },
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

/* Movement presets: which metrics make sense and a starting threshold. */
export const MOVES = {
  squat:  { label: "bfb_mv_squat",  metrics: ["kneeFlex", "valgus", "hipFlex", "ankleDF", "trunkLean"], def: "kneeFlex", thr: 70, dir: "above" },
  lunge:  { label: "bfb_mv_lunge",  metrics: ["kneeFlex", "valgus", "hipFlex", "trunkLean"], def: "kneeFlex", thr: 80, dir: "above" },
  cmj:    { label: "bfb_mv_cmj",    metrics: ["jumpHeight", "flightTime", "cmKnee", "cmHip", "cmAnkle", "landKnee", "kneeFlex", "trunkLean"], def: "jumpHeight", thr: 30, dir: "above" },
  shot:   { label: "bfb_mv_shot",   metrics: ["shotElbow", "shotShoulder", "shotKnee", "shotTrunk", "shotJump", "elbowFlex"], def: "shotElbow", thr: 20, dir: "below" },
  curl:   { label: "bfb_mv_curl",   metrics: ["elbowFlex"], def: "elbowFlex", thr: 110, dir: "above" },
  raise:  { label: "bfb_mv_raise",  metrics: ["shAbd"], def: "shAbd", thr: 90, dir: "above" },
  hinge:  { label: "bfb_mv_hinge",  metrics: ["trunkLean", "hipFlex", "kneeFlex"], def: "trunkLean", thr: 45, dir: "above" },
  pushup: { label: "bfb_mv_pushup", metrics: ["elbowFlex", "hipFlex"], def: "elbowFlex", thr: 90, dir: "above" },
  dip:    { label: "bfb_mv_dip",    metrics: ["elbowFlex", "trunkLean"], def: "elbowFlex", thr: 90, dir: "above" },
  ohpress:{ label: "bfb_mv_ohpress",metrics: ["shAbd", "elbowFlex", "trunkLean"], def: "shAbd", thr: 160, dir: "above" },
  pullup: { label: "bfb_mv_pullup", metrics: ["elbowFlex", "shAbd"], def: "elbowFlex", thr: 100, dir: "above" },
  row:    { label: "bfb_mv_row",    metrics: ["elbowFlex", "trunkLean", "hipFlex"], def: "elbowFlex", thr: 90, dir: "above" },
  deadlift:{ label: "bfb_mv_deadlift", metrics: ["trunkLean", "hipFlex", "kneeFlex"], def: "trunkLean", thr: 60, dir: "above" },
  bridge: { label: "bfb_mv_bridge", metrics: ["hipFlex", "kneeFlex"], def: "hipFlex", thr: 15, dir: "below" },
  plank:  { label: "bfb_mv_plank",  metrics: ["hipFlex", "neckFlex"], def: "hipFlex", thr: 15, dir: "above" },
  heelraise:{ label: "bfb_mv_heelraise", metrics: ["ankleDF", "kneeFlex"], def: "ankleDF", thr: -15, dir: "below" },
  neck:   { label: "bfb_mv_neck",   metrics: ["neckFlex", "headNod", "neckTilt", "headTurn", "trunkLean"], def: "neckFlex", thr: 20, dir: "above" },
  free:   { label: "bfb_mv_free",   metrics: Object.keys(METRICS), def: "kneeFlexL", thr: 70, dir: "above" },
};

const PULSE_MS = 1500;

/* Body map: muscle group -> the BioFeedback movements that load it. Sports
 * movements sit with every group they mainly drive (a jump shot is legs,
 * glutes, shoulders and triceps), so tapping calves offers it too. */
export const REGION_MOVES = {
  neck: ["neck"],
  shoulders: ["ohpress", "raise", "pushup", "dip", "shot"],
  chest: ["pushup", "dip"],
  back: ["row", "pullup", "deadlift", "hinge"],
  biceps: ["curl", "pullup", "row"],
  triceps: ["pushup", "dip", "ohpress", "shot"],
  core: ["plank", "deadlift", "bridge", "hinge"],
  glutes: ["squat", "lunge", "bridge", "deadlift", "hinge", "cmj", "shot"],
  quads: ["squat", "lunge", "cmj", "shot"],
  hamstrings: ["deadlift", "hinge", "bridge", "cmj"],
  calves: ["heelraise", "cmj", "shot"],
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
  let gnd = NaN, Lg = NaN, air = false, up = 0, t0 = 0, best = null;
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
    if (wy < img[0].y) {
      if (!best || wy < best.y) best = { y: wy, ts, elb: elbF(w, s), sh: shEl(w, s), tr: trunk(w) };
    }
    if (best && (wy > best.y + 0.08 * Lg || wy > img[0].y)) {
      const r = best; best = null;
      pend.push({ at: r.ts + 700, fn: () => {
        const j = jumps.filter((x) => x.t0 > r.ts - 1000 && x.t0 < r.ts + 300).pop();
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

/** Wire up #viewBiofeedback. deps: { $, tr, getLandmarker } */
export function initBiofeedback({ $, tr, getLandmarker }) {
  const st = {
    port: null, writer: null, reader: null, lm: null, stream: null, raf: 0,
    active: false, lit: null, value: NaN, lastTs: -1,
  };
  let cfg = { move: "squat", metric: "kneeFlexL", thr: 70, dir: "above", hyst: 3, baud: 9600, invert: false, zero: {}, sound: "beep" };
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(SKEY) || "{}") }; } catch { /* private */ }
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
    if (!mv.metrics.includes(cfg.metric)) cfg.metric = mv.def;
    $("bfbMetric").innerHTML = mv.metrics.map((k) => `<option value="${k}">${tr(METRICS[k].label)}</option>`).join("");
    $("bfbMetric").value = cfg.metric;
  }
  function syncInputs() {
    const m = METRICS[cfg.metric] || METRICS.kneeFlexL, mx = m.max || 180;
    const mn = m.unit === DEG ? -90 : 0;
    $("bfbThr").max = mx; $("bfbThrN").max = mx; $("bfbThr").min = mn; $("bfbThrN").min = mn;
    $("bfbUnit").textContent = m.unit;
    $("bfbHint").textContent = m.ev ? tr(cfg.metric.startsWith("shot") ? "bfb_hintShot" : "bfb_hintJump") : "";
    $("bfbHyst").disabled = !!m.ev; $("bfbZero").disabled = !!m.ev;
    const zk = m.pair ? m.pair[0] : cfg.metric, z = cfg.zero && cfg.zero[zk];
    $("bfbZeroNote").textContent = z ? tr("bfb_zeroed", { v: z.toFixed(0) }) : "";
    $("bfbValue").textContent = "–"; $("bfbResults").innerHTML = ""; ema = emaL = emaR = NaN; buildBars();
    $("bfbThr").value = cfg.thr; $("bfbThrN").value = cfg.thr;
    $("bfbDir").value = cfg.dir; $("bfbSound").value = cfg.sound || "beep"; $("bfbHyst").value = cfg.hyst; $("bfbBaud").value = String(cfg.baud);
  }
  $("bfbMove").onchange = () => pickMove($("bfbMove").value);
  $("bfbMetric").onchange = () => { cfg.metric = $("bfbMetric").value; syncInputs(); save(); };
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
    cfg.metric = mv.def; cfg.thr = mv.thr; cfg.dir = mv.dir;
    $("bfbMove").value = k; fillMetrics(); syncInputs(); save(); renderBody();
  }
  $("bfbBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bfbmove]"); if (b) { pickMove(b.dataset.bfbmove); return; }
    const g = e.target.closest("[data-region]"); if (g) { region = g.dataset.region === region ? null : g.dataset.region; renderBody(); }
  });
  $("bfbBody").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-region]")) { e.preventDefault(); e.target.closest("[data-region]").dispatchEvent(new MouseEvent("click", { bubbles: true })); }
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
      setTimeout(() => send(false, true), 1800);
    } catch (e) { st.port = null; status("bfb_portFail", { err: e.message }, true); }
    renderConn();
  }
  async function readLoop(port) {
    const dec = new TextDecoder(); let buf = "";
    try {
      st.reader = port.readable.getReader();
      for (;;) {
        const { value, done } = await st.reader.read(); if (done) break;
        buf += dec.decode(value); let i;
        while ((i = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln && ln !== st.lastRx) { st.lastRx = ln; log("← " + ln); } }
      }
    } catch { /* port closed or unplugged */ }
  }
  async function send(on, force = false) {
    if (cfg.invert) on = !on;
    if (!force && st.lit === on) return;
    st.lit = on;
    $("bfbLamp").classList.toggle("on", on);
    if (!st.writer) return;
    try { await st.writer.write(new TextEncoder().encode(on ? "1\n" : "0\n")); log("→ " + (on ? "1" : "0")); }
    catch (e) { status("bfb_portFail", { err: e.message }, true); }
  }
  function renderConn() {
    $("bfbDisconnect").disabled = !st.port;
    $("bfbTestOn").disabled = $("bfbTestOff").disabled = !st.port;
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
  $("bfbTestOn").onclick = () => send(true, true);
  $("bfbTestOff").onclick = () => send(false, true);
  if (hasSerial) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (e.target === st.port) { closePort(); st.port = null; status("bfb_portLost", null, true); renderConn(); }
      listPorts();
    });
    navigator.serial.addEventListener("connect", listPorts);
  }

  /* ---------- camera + pose ---------- */
  async function startCam() {
    if (st.stream) return true;
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = $("bfbVideo"); v.srcObject = st.stream; await v.play();
      return true;
    } catch (e) { $("bfbCamNote").textContent = tr("bfb_camFail", { err: e.message }); return false; }
  }
  function stopCam() {
    cancelAnimationFrame(st.raf); st.raf = 0;
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
  }
  let ema = NaN, emaL = NaN, emaR = NaN, on = false, pulseTo = 0;
  const unit = () => METRICS[cfg.metric].unit;
  const fmt = (v) => (unit() === "cm" ? v.toFixed(1) : v.toFixed(0)) + (unit() === DEG ? "°" : " " + unit());
  const meets = (v) => (cfg.dir === "above" ? v > cfg.thr : v < cfg.thr);
  const barMax = () => METRICS[cfg.metric].max || 180;
  const barMin = () => (unit() === DEG ? Math.min(0, cfg.thr - 10) : 0);
  const pct = (x) => Math.max(0, Math.min(100, ((x - barMin()) / (barMax() - barMin())) * 100));
  /* One bar per side (L, R) for paired metrics, one bar otherwise. */
  function buildBars() {
    const m = METRICS[cfg.metric], sides = m.pair ? ["L", "R"] : [""];
    $("bfbBars").innerHTML = sides.map((sd) => `<div class="bfbBarRow"><span class="bfbSide">${sd}</span>
      <div class="bfbBar"><div class="bfbBarFill" data-side="${sd}"></div><div class="bfbBarThr"></div></div>
      <span class="bfbBarVal" data-side="${sd}">–</span></div>`).join("");
    hist.length = 0;
  }
  function showBar(v, side = "") {
    const f = $("bfbBars").querySelector(`.bfbBarFill[data-side="${side}"]`); if (!f) return;
    const ok = Number.isFinite(v) && meets(v);
    f.style.width = Number.isFinite(v) ? pct(v) + "%" : "0"; f.classList.toggle("hit", ok);
    $("bfbBars").querySelector(`.bfbBarVal[data-side="${side}"]`).textContent = Number.isFinite(v) ? fmt(v) : "–";
    for (const t of $("bfbBars").querySelectorAll(".bfbBarThr")) t.style.left = pct(cfg.thr) + "%";
  }
  /* Live plot: last 10 s, one line per side, dashed threshold. */
  const hist = [], WIN = 10000;
  function plot(now) {
    const cv = $("bfbPlot"); if (!cv) return;
    const W = cv.clientWidth || 600, H = cv.clientHeight || 140, dpr = window.devicePixelRatio || 1;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    while (hist.length && hist[0].t < now - WIN) hist.shift();
    let lo = cfg.thr, hi = cfg.thr;
    for (const h of hist) for (const x of [h.a, h.b]) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    const pad = Math.max(5, (hi - lo) * 0.15); lo -= pad; hi += pad;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--muted").trim() || "#999", acc = css.getPropertyValue("--accent").trim() || "#4fb3a0";
    const X = (t) => 34 + ((t - (now - WIN)) / WIN) * (W - 40), Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 22);
    c.font = "11px system-ui, sans-serif"; c.fillStyle = ink; c.strokeStyle = ink; c.globalAlpha = 0.35; c.lineWidth = 1;
    for (const v of [lo + pad, (lo + hi) / 2, hi - pad]) { c.beginPath(); c.moveTo(34, Y(v)); c.lineTo(W - 6, Y(v)); c.stroke(); }
    c.globalAlpha = 1;
    for (const v of [lo + pad, hi - pad]) c.fillText(v.toFixed(0), 2, Y(v) + 4);
    c.fillText("-10 s", 34, H - 2); c.fillText("now", W - 28, H - 2);
    c.setLineDash([6, 4]); c.strokeStyle = "#ffd54a"; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(34, Y(cfg.thr)); c.lineTo(W - 6, Y(cfg.thr)); c.stroke(); c.setLineDash([]);
    const series = [["a", acc], ["b", "#e8823a"]];
    for (const [k, col] of series) {
      c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); let pen = false;
      for (const h of hist) { const v = h[k]; if (!Number.isFinite(v)) { pen = false; continue; }
        pen ? c.lineTo(X(h.t), Y(v)) : c.moveTo(X(h.t), Y(v)); pen = true; }
      c.stroke();
    }
    if (METRICS[cfg.metric].pair) {
      c.fillStyle = acc; c.fillText("L", W - 40, 14); c.fillStyle = "#e8823a"; c.fillText("R", W - 26, 14);
    }
  }
  /* An event (one jump / one shot) arrived: show it, log it, flash the lamp. */
  const detect = makeDetectors((vals) => {
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
      $("bfbLamp").classList.add("on");
      if (st.active) send(true, true);
      clearTimeout(pulseTo);
      pulseTo = setTimeout(() => { $("bfbLamp").classList.remove("on"); if (st.active) send(false, true); }, PULSE_MS);
    }
  });
  function frame() {
    st.raf = requestAnimationFrame(frame);
    const v = $("bfbVideo"); if (!st.lm || v.readyState < 2) return;
    let ts = performance.now(); if (ts <= st.lastTs) ts = st.lastTs + 1; st.lastTs = ts;
    const r = st.lm.detectForVideo(v, ts);
    const cv = $("bfbCanvas"), ctx = cv.getContext("2d");
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const img = r.landmarks && r.landmarks[0], w = r.worldLandmarks && r.worldLandmarks[0];
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
    if (m.face) {
      if (!st.face && !st.faceLoading) {
        st.faceLoading = true; $("bfbCamNote").textContent = tr("bfb_faceLoading");
        makeFace().then((f) => { st.face = f; $("bfbCamNote").textContent = ""; })
          .catch(() => { $("bfbCamNote").textContent = tr("bfb_faceFail"); });
      }
      if (st.face) {
        const fr = st.face.detectForVideo(v, ts);
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
    if (m.ev) return;                       // event metrics update on their own
    ASPECT = (v.videoWidth / v.videoHeight) || ASPECT;
    // "Zero" removes camera tilt / posture offset, per side for paired metrics.
    const val = (k) => METRICS[k].f(w, img, head) - ((cfg.zero && cfg.zero[k]) || 0);
    const sm = (prev, x) => (Number.isFinite(x) ? (Number.isFinite(prev) ? prev + 0.35 * (x - prev) : x) : NaN);
    let shown;
    if (m.pair) {
      emaL = sm(emaL, val(m.pair[0])); emaR = sm(emaR, val(m.pair[1]));
      showBar(emaL, "L"); showBar(emaR, "R");
      hist.push({ t: ts, a: emaL, b: emaR });
      const both = [emaL, emaR].filter(Number.isFinite); if (!both.length) { plot(ts); return; }
      ema = cfg.dir === "above" ? Math.max(...both) : Math.min(...both);   // either side crossing counts
      shown = `L ${Number.isFinite(emaL) ? fmt(emaL) : "–"}  R ${Number.isFinite(emaR) ? fmt(emaR) : "–"}`;
    } else {
      ema = sm(ema, val(cfg.metric));
      if (!Number.isFinite(ema)) { plot(ts); return; }
      showBar(ema); hist.push({ t: ts, a: ema, b: NaN });
      shown = fmt(ema);
    }
    plot(ts);
    st.value = ema; st.valL = emaL; st.valR = emaR;
    $("bfbValue").textContent = shown;
    // Hysteresis: switch on past thr, off only once back by `hyst`.
    const h = cfg.hyst;
    if (cfg.dir === "above") on = on ? ema > cfg.thr - h : ema > cfg.thr;
    else on = on ? ema < cfg.thr + h : ema < cfg.thr;
    $("bfbValue").classList.toggle("hit", on);
    $("bfbLamp").classList.toggle("on", on);
    if (on && !overSince && cfg.sound !== "off") tone(880, 140);
    overSince = on;
    if (st.active) send(on);
  }
  /* Belt and braces: while active, re-send the lamp state every 500 ms, so a
   * byte lost to a board reset or a busy port corrects itself. Not logged. */
  setInterval(() => {
    if (!st.active || !st.writer || st.lit == null) return;
    st.writer.write(new TextEncoder().encode(st.lit ? "1\n" : "0\n")).catch(() => {});
  }, 500);
  $("bfbCamBtn").onclick = async () => {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch { /* no audio */ }
    if (st.stream) { stopCam(); $("bfbCamBtn").textContent = tr("bfb_camStart"); return; }
    $("bfbCamNote").textContent = tr("bfb_loadingModel");
    if (!st.lm) { st.lm = await getLandmarker(); if (!st.lm) { $("bfbCamNote").textContent = tr("bfb_modelFail"); return; } }
    if (!(await startCam())) return;
    $("bfbCamNote").textContent = "";
    $("bfbCamBtn").textContent = tr("bfb_camStop");
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

  /* ---------- open / leave ---------- */
  function open() {
    $("bfbNoSerial").classList.toggle("hidden", hasSerial);
    if (!MOVES[cfg.move]) cfg.move = "squat";
    fillMoves(); fillMetrics(); syncInputs(); renderConn(); listPorts(); renderBody();
    if (!st.port) status("bfb_portNone");
  }
  async function leave() {
    if (st.active) $("bfbActivate").click();
    stopCam(); $("bfbCamBtn").textContent = tr("bfb_camStart");
  }
  return { open, leave, relabel: () => { fillMoves(); fillMetrics(); } };
}
