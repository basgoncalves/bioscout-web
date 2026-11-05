/* squat_02.mp4, filmed face-on: the whole clip gave the LEFT leg 100% of body
 * weight and the right leg zero (Bas, 2026-11-05).
 *
 * Measured from that clip: the two feet sit a CONSTANT 33.7 px apart in image
 * y -- 11.1% of body height -- because the camera is not level with the floor,
 * while the contact band is 4%. The floor was one level taken from the lower
 * foot, so the higher foot was outside the band in every frame of the clip,
 * was called airborne throughout, and never carried anything. Nothing about
 * that was a left-right difference; it was the camera's angle. */
import { clipGrf } from "../src/grf.js";

const PX = 167.3, H = 1.81, M = 84.1, FPS = 29.7, BW = M * 9.80665;
const bodyPx = PX * H;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/* Front view, feet 22% of body height apart, the right foot drawn 11% of body
 * height higher in the picture than the left -- the real numbers. */
function frontOn(i, lift = 0) {
  const p = {}, y0 = 760, mid = 240;
  const dxL = 0.11 * bodyPx, dxR = 0.11 * bodyPx;     // 22% apart in total
  const off = 0.111 * bodyPx;                         // the perspective offset
  const put = (k, x, y) => { p[k] = [x, y]; };
  const squat = 0.12 * bodyPx * Math.sin(i / 10);     // something for the COM to do
  put("left_shoulder", mid + 30, y0 - 1.45 * PX + squat);
  put("right_shoulder", mid - 30, y0 - 1.45 * PX + squat);
  put("left_hip", mid + 20, y0 - 0.95 * PX + squat);
  put("right_hip", mid - 20, y0 - 0.95 * PX + squat);
  put("left_knee", mid + dxL, y0 - 0.5 * PX + squat);
  put("right_knee", mid - dxR, y0 - 0.5 * PX + squat - off);
  for (const [s, x, dy] of [["left", mid + dxL, 0], ["right", mid - dxR, off + lift]]) {
    put(`${s}_ankle`, x, y0 - 0.08 * PX - dy);
    put(`${s}_heel`, x - 8, y0 - 0.02 * PX - dy);
    put(`${s}_foot_index`, x + 8, y0 - dy);
  }
  return p;
}
const clip = (f, n = 90) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, f(i)]));
const opts = { pxPerM: PX, heightM: H, systemKg: M, fps: FPS };

const g = clipGrf(clip((i) => frontOn(i)), "squat", opts);
if (g.sidesSplit !== "lever") throw new Error("feet 22% apart are separable; the lever rule should apply");
const L = g.feet_l.slice(15, 75), R = g.feet_r.slice(15, 75);

// Neither leg may be written off for the whole clip by the camera's angle.
if (mean(R) < 0.25 * BW) throw new Error(`the higher foot carried ${(mean(R) / BW).toFixed(2)} BW: perspective was read as a lifted foot`);
if (mean(L) < 0.25 * BW) throw new Error(`the lower foot carried ${(mean(L) / BW).toFixed(2)} BW`);
if (R.every((v) => v === 0)) throw new Error("the right leg is zero for the whole clip, the original bug");
// Standing symmetric: close to half each.
const share = mean(L) / (mean(L) + mean(R));
if (share < 0.35 || share > 0.65) throw new Error(`a symmetric stance split ${(100 * share).toFixed(0)}/${(100 - 100 * share).toFixed(0)}`);
// And the physics is untouched.
const tot = L.map((v, i) => v + R[i]);
if (Math.abs(mean(tot) - BW) > 0.08 * BW) throw new Error(`total ${(mean(tot) / BW).toFixed(2)} BW, expected about 1`);

/* A foot genuinely lifted clear of the floor, on top of the perspective
 * offset, must still be seen -- the fix must not make every foot grounded. */
const s = clipGrf(clip((i) => frontOn(i, 0.18 * bodyPx)), "slsquat", opts);
const rl = mean(s.feet_r.slice(15, 75)), ll = mean(s.feet_l.slice(15, 75));
if (!(ll > 2 * rl)) throw new Error(`a lifted foot still took ${(rl / BW).toFixed(2)} BW against ${(ll / BW).toFixed(2)}`);

console.log("ok    a tilted camera is not read as one leg carrying everything");
