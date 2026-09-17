/**
 * grf.js -- vertical reaction force under each foot and each hand.
 *
 * The whole-body force comes from Newton's second law, the same derivation as
 * dynamics.js: F = m_system * (a_com + g), with the centre of mass built from
 * Winter's segment table. What this adds is WHERE that force goes.
 *
 *   feet only        a squat, a jump, running on the spot. A foot carries load
 *                    only while it is on the floor (its lowest point within a
 *                    band of the local floor). With both down, the split is
 *                    the lever rule: the foot the centre of mass sits over
 *                    carries more. With one down, it carries everything.
 *   hands only       pull-up, dip. The hands hold the whole system.
 *   hands and feet   the push-up. The body is a lever between the feet and the
 *                    hands, the same static balance as the textbook incline
 *                    push-up: hands' share = (x_com - x_feet) / (x_hands - x_feet).
 *                    The acceleration term is kept, so the total is dynamic.
 *
 * Left/right within a pair uses the same lever rule when the two contacts are
 * apart in the picture (a front view, or a split stance), and 50/50 when they
 * overlap (side-on, where the camera cannot tell them apart).
 *
 * Vertical only. The horizontal component needs friction, which a camera
 * cannot see, and a 2D lever cannot split it.
 */
import { interpNan, smooth } from "./kinematics.js";

export const G = 9.80665;
export const HAND_TASKS = ["pullup", "dip", "pushup"];
export const NO_FEET = ["pullup", "dip", "neck", "kickback"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const avg = (...v) => { const f = v.filter(isNum); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; };
const P = (lm, k, c) => (lm && lm[k] ? lm[k][c] : NaN);

// Winter Table 4.1: mass fraction, COM fraction from the proximal end.
const SEG = [
  ["hat", 0.678, 0.626], ["thigh", 0.100, 0.433], ["shank", 0.0465, 0.433], ["foot", 0.0145, 0.5],
];

function comAt(lm) {
  if (!lm) return null;
  const pt = (k) => (lm[k] ? lm[k] : null);
  const mid = (a, b) => (a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a || b);
  const along = (a, b, f) => (a && b ? [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])] : null);
  const parts = [];
  const hip = mid(pt("left_hip"), pt("right_hip"));
  const sh = mid(pt("left_shoulder"), pt("right_shoulder"));
  parts.push([along(hip, sh, SEG[0][2]), SEG[0][1]]);
  for (const s of ["left", "right"]) {
    parts.push([along(pt(`${s}_hip`), pt(`${s}_knee`), SEG[1][2]), SEG[1][1]]);
    parts.push([along(pt(`${s}_knee`), pt(`${s}_ankle`), SEG[2][2]), SEG[2][1]]);
    parts.push([along(pt(`${s}_ankle`), pt(`${s}_foot_index`), SEG[3][2]), SEG[3][1]]);
  }
  let x = 0, y = 0, w = 0;
  for (const [c, m] of parts) if (c) { x += c[0] * m; y += c[1] * m; w += m; }
  // Without the trunk and at least most of the legs the average is not a body.
  return w >= 0.8 ? [x / w, y / w] : null;
}

function footLow(lm, s) {
  const ys = [P(lm, `${s}_ankle`, 1), P(lm, `${s}_heel`, 1), P(lm, `${s}_foot_index`, 1)].filter(isNum);
  return ys.length ? Math.max(...ys) : NaN;       // image y grows downward
}
const footX = (lm, s) => avg(P(lm, `${s}_heel`, 0), P(lm, `${s}_foot_index`, 0), P(lm, `${s}_ankle`, 0));
const handX = (lm, s) => avg(P(lm, `${s}_wrist`, 0), P(lm, `${s}_index`, 0));

function rollingMedian(a, half) {
  return a.map((_, i) => {
    const w = a.slice(Math.max(0, i - half), i + half + 1).filter(isNum).sort((p, q) => p - q);
    return w.length ? w[w.length >> 1] : NaN;
  });
}

function deriv(x, dt) {
  const n = x.length, d = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) d[i] = (x[i + 1] - x[i - 1]) / (2 * dt);
  if (n > 1) { d[0] = d[1]; d[n - 1] = d[n - 2]; }
  return d;
}

/** Split `total` between two contacts at x positions a (left) and b (right). */
function lever(total, xc, a, b, minSep) {
  if (!isNum(a) || !isNum(b) || Math.abs(b - a) < minSep || !isNum(xc)) return [total / 2, total / 2];
  const wr = clamp01((xc - a) / (b - a));
  return [total * (1 - wr), total * wr];
}

/**
 * Whole-clip vertical reaction forces, in newtons.
 * Returns { feet_l, feet_r, hands_l, hands_r, total, bw_n, lo } -- arrays are
 * indexed like the feature sets (frame - lo), absent sources are null.
 */
export function clipGrf(poses, activity, { pxPerM, heightM, systemKg, fps, travels = false } = {}) {
  const keys = Object.keys(poses).map(Number).sort((a, b) => a - b);
  if (!keys.length || !(pxPerM > 0) || !(fps > 0) || !(systemKg > 0)) return null;
  const hands = HAND_TASKS.includes(activity);
  const feet = !NO_FEET.includes(activity) && !travels;
  if (!hands && !feet) return null;

  const lo = keys[0], n = keys[keys.length - 1] - lo + 1;
  const at = (i) => poses[i + lo];
  const comX = new Array(n).fill(NaN), comY = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const c = comAt(at(i));
    if (c) { comX[i] = c[0]; comY[i] = c[1]; }
  }
  if (comY.filter(isNum).length < 5) return null;

  const dt = 1 / fps;
  let win = Math.max(3, Math.round(0.1 * fps)); if (win % 2 === 0) win++;
  const yUp = interpNan(comY).map((v) => -v / pxPerM);
  const ys = smooth(smooth(yUp, win), win);
  const ay = smooth(deriv(deriv(ys, dt), dt), win);
  const xc = smooth(interpNan(comX), win);
  const total = ay.map((a) => Math.max(0, systemKg * (a + G)));
  const bw = systemKg * G;
  const bodyPx = pxPerM * (heightM || 1.75);
  const minSep = 0.03 * bodyPx;

  const out = { feet_l: null, feet_r: null, hands_l: null, hands_r: null, total, bw_n: bw, lo };
  const lowL = [], lowR = [];
  for (let i = 0; i < n; i++) { lowL.push(footLow(at(i), "left")); lowR.push(footLow(at(i), "right")); }
  const lowest = lowL.map((l, i) => (isNum(l) || isNum(lowR[i]) ? Math.max(isNum(l) ? l : -Infinity, isNum(lowR[i]) ? lowR[i] : -Infinity) : NaN));
  const floor = rollingMedian(lowest, Math.max(3, Math.round(fps)));
  const band = 0.04 * bodyPx;

  if (hands) { out.hands_l = new Array(n).fill(NaN); out.hands_r = new Array(n).fill(NaN); }
  if (feet) { out.feet_l = new Array(n).fill(NaN); out.feet_r = new Array(n).fill(NaN); }

  for (let i = 0; i < n; i++) {
    const lm = at(i), T = total[i];
    if (!lm || !isNum(T)) continue;
    const hl = handX(lm, "left"), hr = handX(lm, "right");
    const fl = footX(lm, "left"), fr = footX(lm, "right");
    let handT = 0, footT = T;
    if (hands && !feet) { handT = T; footT = 0; }
    else if (hands && feet) {
      const xh = avg(hl, hr), xf = avg(fl, fr);
      if (!isNum(xh) || !isNum(xf) || Math.abs(xh - xf) < minSep) continue;
      handT = T * clamp01((xc[i] - xf) / (xh - xf));
      footT = T - handT;
    }
    if (hands) [out.hands_l[i], out.hands_r[i]] = lever(handT, xc[i], hl, hr, minSep);
    if (!feet) continue;
    if (hands) { [out.feet_l[i], out.feet_r[i]] = lever(footT, xc[i], fl, fr, minSep); continue; }
    const cl = isNum(lowL[i]) && floor[i] - lowL[i] < band;
    const cr = isNum(lowR[i]) && floor[i] - lowR[i] < band;
    if (cl && cr) [out.feet_l[i], out.feet_r[i]] = lever(footT, xc[i], fl, fr, minSep);
    else if (cl) { out.feet_l[i] = footT; out.feet_r[i] = 0; }
    else if (cr) { out.feet_l[i] = 0; out.feet_r[i] = footT; }
    else if (footT > 0.25 * bw && (isNum(lowL[i]) || isNum(lowR[i]))) {
      // Load but no foot within the band: the tracker lost the floor, not the
      // athlete. Give it to whichever foot is lower.
      const leftLower = (isNum(lowL[i]) ? lowL[i] : -Infinity) >= (isNum(lowR[i]) ? lowR[i] : -Infinity);
      out.feet_l[i] = leftLower ? footT : 0; out.feet_r[i] = leftLower ? 0 : footT;
    } else { out.feet_l[i] = 0; out.feet_r[i] = 0; }
  }
  return out;
}

/** The jm keys for one rep's window: feet_grf_l / _r, hands_grf_l / _r. */
export function grfForRep(clip, bounds) {
  if (!clip || !bounds) return {};
  const [b0, , b1] = bounds;
  const o = {};
  for (const src of ["feet", "hands"]) {
    for (const s of ["l", "r"]) {
      const a = clip[`${src}_${s}`];
      if (a) o[`${src}_grf_${s}`] = a.slice(b0, b1 + 1);
    }
  }
  return o;
}

/** Which sources a rep's jm can draw. */
export function grfSources(jm) {
  if (!jm) return [];
  return ["feet", "hands"].filter((s) => ["l", "r"].some((d) => Array.isArray(jm[`${s}_grf_${d}`])
    && jm[`${s}_grf_${d}`].some(isNum)));
}
