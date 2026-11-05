/* A squat filmed side-on came out with the two legs alternating between 0 and
 * 1.4 BW (Bas, 2026-11-05). The far foot is behind the near one, so its
 * landmarks are the pose model's guess; the guess drifted out of the floor
 * band for a few frames at a time, that foot was called airborne, and the
 * whole body weight jumped to the other leg. Not a left-right difference --
 * noise with a side given to it. */
import { clipGrf } from "../src/grf.js";

const PX = 300, H = 1.80, M = 80, FPS = 30, BW = M * 9.80665;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/* Side-on: both feet at the same x. `jitter` is the far foot's landmark noise
 * in metres -- the thing that used to decide which leg carried the athlete. */
function sideOn(i, jitter) {
  const p = {}, y0 = 700, put = (k, x, y) => { p[k] = [x, y]; };
  const n = (jitter * PX) * Math.sin(i * 1.7);       // a few cm, frame to frame
  put("left_shoulder", 500, y0 - 1.45 * PX); put("right_shoulder", 500, y0 - 1.45 * PX);
  put("left_hip", 500, y0 - 0.95 * PX); put("right_hip", 500, y0 - 0.95 * PX);
  put("left_knee", 500, y0 - 0.5 * PX); put("right_knee", 502, y0 - 0.5 * PX);
  for (const [s, dy] of [["left", 0], ["right", n]]) {
    put(`${s}_ankle`, 500, y0 - 0.08 * PX - dy);
    put(`${s}_heel`, 490, y0 - 0.02 * PX - dy);
    put(`${s}_foot_index`, 560, y0 - dy);
  }
  return p;
}
const clip = (f, n = 60) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, f(i)]));
const opts = { pxPerM: PX, heightM: H, systemKg: M, fps: FPS };

const g = clipGrf(clip((i) => sideOn(i, 0.05)), "squat", opts);   // 5 cm of jitter
const L = g.feet_l.slice(10, 50), R = g.feet_r.slice(10, 50);

if (g.sidesSplit !== "even") throw new Error(`feet at one x should not be split by lever: ${g.sidesSplit}`);
// Neither leg may ever be handed the whole athlete.
const worst = Math.max(...L, ...R);
if (worst > 0.75 * BW) throw new Error(`a leg carried ${(worst / BW).toFixed(2)} BW on an overlapping-feet clip`);
// And the two sides must agree, because nothing measured says they differ.
const diff = Math.max(...L.map((v, i) => Math.abs(v - R[i])));
if (diff > 1) throw new Error(`left and right differ by ${diff.toFixed(0)} N with nothing measured to tell them apart`);
// The physics must survive the fix.
const tot = L.map((v, i) => v + R[i]);
if (Math.abs(mean(tot) - BW) > 2) throw new Error(`feet no longer sum to body weight: ${mean(tot).toFixed(0)} vs ${BW.toFixed(0)}`);

/* A deliberate lift must still be seen even when the feet overlap: a side-on
 * single-leg squat is one foot in the air, not noise. */
function lifted(i) {
  const p = sideOn(i, 0.01);
  for (const k of ["right_ankle", "right_heel", "right_foot_index", "right_knee"]) p[k] = [p[k][0], p[k][1] - 0.15 * PX];
  return p;
}
const s = clipGrf(clip(lifted), "slsquat", opts);
if (!(mean(s.feet_l.slice(10, 50)) > 0.9 * BW) || mean(s.feet_r.slice(10, 50)) !== 0) {
  throw new Error(`a lifted foot should carry nothing: L ${mean(s.feet_l.slice(10, 50)).toFixed(0)} R ${mean(s.feet_r.slice(10, 50)).toFixed(0)}`);
}

/* Feet genuinely apart (front view) keep the lever split. */
const f = clipGrf(clip(() => {
  const p = sideOn(0, 0);
  for (const k of ["left_ankle", "left_heel", "left_foot_index"]) p[k] = [p[k][0] - 150, p[k][1]];
  for (const k of ["right_ankle", "right_heel", "right_foot_index"]) p[k] = [p[k][0] + 150, p[k][1]];
  return p;
}), "squat", opts);
if (f.sidesSplit !== "lever") throw new Error("feet 1 m apart should still be split by the lever rule");

console.log("ok    side-on feet are not split into a fake left-right difference");
