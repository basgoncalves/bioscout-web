/**
 * bodyfat.js -- body-fat percentage from two camera pictures.
 *
 * The US Navy circumference method (Hodgdon & Beckett 1984) needs height,
 * neck and waist (and hips for women). A camera cannot see a circumference,
 * but it can see a WIDTH (front view) and a DEPTH (side view) of the same
 * cross-section, and an ellipse with those axes has a perimeter
 * (Ramanujan). Height gives the metres-per-pixel scale.
 *
 * The pose model places landmarks at joint centres, not at the body's edge,
 * so the widths come from its segmentation mask: the landmarks only say
 * WHICH ROW to measure, the mask says how wide the body is on that row.
 *
 * Honest error: the Navy equation alone is about +/-3.5 % against DEXA, and
 * measuring from a picture adds a few percent on each circumference. The
 * result is therefore returned as a range, and a tape measurement entered
 * once gives a per-person correction that removes most of the camera part.
 *
 * Everything here is pure; the page feeds it masks and landmarks.
 */

// MediaPipe pose landmark indices.
export const LM = { nose: 0, mouthL: 9, mouthR: 10, shL: 11, shR: 12,
                    elL: 13, elR: 14, wrL: 15, wrR: 16, hipL: 23, hipR: 24,
                    anL: 27, anR: 28 };

export const NAVY_SEE = 3.5;        // % body fat, equation vs DEXA
export const CAMERA_CIRC_ERR = 0.03; // fractional error per circumference, uncalibrated
export const CALIBRATED_CIRC_ERR = 0.015;

/** Perimeter of an ellipse with full axes w and d (Ramanujan II). */
export function ellipseCircumference(w, d) {
  const a = w / 2, b = d / 2;
  if (!(a > 0 && b > 0)) return null;
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/**
 * Navy body fat, all lengths in cm. sex is "male" or "female".
 * Returns null when the inputs cannot give a number (e.g. waist <= neck).
 */
export function navyBodyFat({ sex, heightCm, neckCm, waistCm, hipCm = null }) {
  if (!(heightCm > 0 && neckCm > 0 && waistCm > 0)) return null;
  let bf;
  if (sex === "male") {
    if (waistCm - neckCm <= 0) return null;
    bf = 495 / (1.0324 - 0.19077 * Math.log10(waistCm - neckCm)
                + 0.15456 * Math.log10(heightCm)) - 450;
  } else if (sex === "female") {
    if (!(hipCm > 0) || waistCm + hipCm - neckCm <= 0) return null;
    bf = 495 / (1.29579 - 0.35004 * Math.log10(waistCm + hipCm - neckCm)
                + 0.22100 * Math.log10(heightCm)) - 450;
  } else return null;
  return Number.isFinite(bf) ? bf : null;
}

/**
 * The run of foreground pixels on `row` that contains (or is nearest to)
 * column `col`. mask is a Float32Array/Uint8Array of w*h, foreground > thr.
 * Returns [left, right] inclusive, or null.
 */
export function runAt(mask, w, h, row, col, thr = 0.5) {
  row = Math.round(row); col = Math.round(col);
  if (row < 0 || row >= h) return null;
  const on = (x) => mask[row * w + x] > thr;
  let c = Math.max(0, Math.min(w - 1, col));
  if (!on(c)) {
    const reach = Math.round(w * 0.05);
    let found = -1;
    for (let k = 1; k <= reach && found < 0; k++) {
      if (c - k >= 0 && on(c - k)) found = c - k;
      else if (c + k < w && on(c + k)) found = c + k;
    }
    if (found < 0) return null;
    c = found;
  }
  let l = c, r = c;
  while (l > 0 && on(l - 1)) l--;
  while (r < w - 1 && on(r + 1)) r++;
  return [l, r];
}

/** Width in px of the run at `row`, averaged over row-1..row+1. */
export function widthAt(mask, w, h, row, col, thr = 0.5) {
  const ws = [];
  for (const dr of [-1, 0, 1]) {
    const run = runAt(mask, w, h, row + dr, col, thr);
    if (run) ws.push(run[1] - run[0] + 1);
  }
  return ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null;
}

/** Top and bottom foreground rows in the column band around `col`. */
export function verticalExtent(mask, w, h, col, band = 0.15, thr = 0.5) {
  const half = Math.round(w * band);
  const x0 = Math.max(0, Math.round(col) - half), x1 = Math.min(w - 1, Math.round(col) + half);
  let top = -1, bottom = -1;
  for (let y = 0; y < h && top < 0; y++)
    for (let x = x0; x <= x1; x++) if (mask[y * w + x] > thr) { top = y; break; }
  for (let y = h - 1; y >= 0 && bottom < 0; y--)
    for (let x = x0; x <= x1; x++) if (mask[y * w + x] > thr) { bottom = y; break; }
  return top < 0 ? null : { top, bottom };
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Classify a pose as "front", "side" or null from landmark geometry
 * (normalised landmarks, image size w x h).
 */
export function viewOf(lms, w, h) {
  if (!lms) return null;
  const shW = Math.abs(lms[LM.shL].x - lms[LM.shR].x) * w;
  const sh = mid(lms[LM.shL], lms[LM.shR]), hip = mid(lms[LM.hipL], lms[LM.hipR]);
  const torso = Math.abs(hip.y - sh.y) * h;
  if (!(torso > 0)) return null;
  const r = shW / torso;
  if (r > 0.45) return "front";
  if (r < 0.2) return "side";
  return null;
}

/** Minimum (or maximum) width over rows y0..y1 at column-from-row fn. */
function extremeWidth(mask, w, h, y0, y1, colAt, pick) {
  let best = null, bestRow = null;
  const a = Math.round(Math.min(y0, y1)), b = Math.round(Math.max(y0, y1));
  for (let y = a; y <= b; y++) {
    const wd = widthAt(mask, w, h, y, colAt(y));
    if (wd === null) continue;
    if (best === null || (pick === "min" ? wd < best : wd > best)) { best = wd; bestRow = y; }
  }
  return best === null ? null : { px: best, row: bestRow };
}

/**
 * Measure one frame. Returns widths (front) or depths (side) in metres for
 * neck, waist, hip, plus warnings. heightM scales pixels to metres.
 */
export function measureFrame({ mask, w, h, lms, heightM, sex, view = null }) {
  const warn = [];
  const P = (i) => ({ x: lms[i].x * w, y: lms[i].y * h, v: lms[i].visibility ?? 1 });
  const sh = mid(P(LM.shL), P(LM.shR)), hip = mid(P(LM.hipL), P(LM.hipR));
  const mouth = mid(P(LM.mouthL), P(LM.mouthR));
  const ext = verticalExtent(mask, w, h, (sh.x + hip.x) / 2);
  if (!ext) return { ok: false, warn: ["noBody"] };
  if (ext.top <= 2 || ext.bottom >= h - 3) warn.push("notWhole");
  if (P(LM.anL).v < 0.5 && P(LM.anR).v < 0.5) warn.push("notWhole");
  const pxPerM = (ext.bottom - ext.top) / heightM;
  if (!(pxPerM > 0)) return { ok: false, warn: ["noBody"] };
  const torso = hip.y - sh.y;
  if (!(torso > 0)) return { ok: false, warn: ["noBody"] };

  // The centre line runs from mid-shoulder to mid-hip; follow it per row so a
  // slight lean does not push the probe off the body.
  const colAt = (y) => sh.x + (hip.x - sh.x) * ((y - sh.y) / torso);

  // Neck: the narrowest row between the nose and the shoulder line. The face
  // is wider than the neck from the front and deeper from the side, and the
  // trapezius widens below it, so the minimum lands on the neck.
  const nose = P(LM.nose);
  const neck = extremeWidth(mask, w, h, nose.y, sh.y,
                            (y) => nose.x + (sh.x - nose.x) * ((y - nose.y) / (sh.y - nose.y)), "min");
  // Waist: men at the navel (~38 % of the way up from hip joint to shoulder);
  // women at the narrowest point of that region.
  const waist = sex === "female"
    ? extremeWidth(mask, w, h, hip.y - 0.65 * torso, hip.y - 0.25 * torso, colAt, "min")
    : (() => { const y = hip.y - 0.38 * torso, px = widthAt(mask, w, h, y, colAt(y));
               return px === null ? null : { px, row: Math.round(y) }; })();
  // Hips: widest point from just above the hip joint to upper thigh.
  const hips = extremeWidth(mask, w, h, hip.y - 0.1 * torso, hip.y + 0.3 * torso, colAt, "max");

  // Arms merged into the torso make the waist run swallow them. From the
  // side, hanging arms sit inside the torso's depth, so only check the front.
  if (waist && view !== "side") {
    const run = runAt(mask, w, h, waist.row, colAt(waist.row));
    for (const i of [LM.wrL, LM.wrR, LM.elL, LM.elR]) {
      const p = P(i);
      if (run && p.v > 0.5 && Math.abs(p.y - waist.row) < 0.25 * torso &&
          p.x >= run[0] - 2 && p.x <= run[1] + 2) { warn.push("armsTouch"); break; }
    }
  }
  const m = (r) => (r ? r.px / pxPerM : null);
  return { ok: !!(neck && waist), neck: m(neck), waist: m(waist), hip: m(hips),
           rows: { neck: neck?.row, waist: waist?.row, hip: hips?.row }, pxPerM,
           warn: [...new Set(warn)] };
}

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const k = v.length >> 1;
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
}

/** Median of each site over several frames of one view. */
export function combineFrames(frames) {
  const ok = frames.filter((f) => f.ok);
  return {
    n: ok.length,
    neck: median(ok.map((f) => f.neck)), waist: median(ok.map((f) => f.waist)),
    hip: median(ok.map((f) => f.hip)),
    warn: [...new Set(frames.flatMap((f) => f.warn || []))],
  };
}

/**
 * Front widths + side depths -> circumferences (cm), with per-site
 * calibration factors (tape / camera) applied when given.
 */
export function circumferences(front, side, calib = {}) {
  const c = (k) => {
    const v = ellipseCircumference(front[k], side[k]);
    return v === null ? null : v * 100 * (calib[k] > 0 ? calib[k] : 1);
  };
  return { neck: c("neck"), waist: c("waist"), hip: c("hip") };
}

/**
 * Body fat with a range. The measurement part is the spread from moving the
 * waist and hip up and the neck down by the circumference error (and the
 * other way), combined in quadrature with the equation's own error.
 */
export function bodyFatEstimate({ sex, heightM, circ, calibrated = false }) {
  const heightCm = heightM * 100;
  const base = navyBodyFat({ sex, heightCm, neckCm: circ.neck, waistCm: circ.waist, hipCm: circ.hip });
  if (base === null) return null;
  const e = calibrated ? CALIBRATED_CIRC_ERR : CAMERA_CIRC_ERR;
  const hi = navyBodyFat({ sex, heightCm, neckCm: circ.neck * (1 - e),
                           waistCm: circ.waist * (1 + e), hipCm: circ.hip && circ.hip * (1 + e) });
  const lo = navyBodyFat({ sex, heightCm, neckCm: circ.neck * (1 + e),
                           waistCm: circ.waist * (1 - e), hipCm: circ.hip && circ.hip * (1 - e) });
  const meas = Math.max(Math.abs((hi ?? base) - base), Math.abs(base - (lo ?? base)));
  const half = Math.sqrt(meas ** 2 + NAVY_SEE ** 2);
  const clamp = (v) => Math.max(2, Math.min(70, v));
  return { bf: clamp(base), low: clamp(base - half), high: clamp(base + half), half, calibrated };
}

/** Circumferences (cm) outside adult human ranges -- a failed silhouette. */
export const PLAUSIBLE_CM = { neck: [25, 60], waist: [50, 170], hip: [60, 180] };
export function implausibleSites(circ) {
  return Object.entries(PLAUSIBLE_CM)
    .filter(([k, [lo, hi]]) => circ[k] != null && !(circ[k] >= lo && circ[k] <= hi))
    .map(([k]) => k);
}

/** Tape / camera ratio per site, rejecting absurd values. */
export function calibrationFrom(tape, camera) {
  const out = {};
  for (const k of ["neck", "waist", "hip"]) {
    const t = +tape?.[k], c = +camera?.[k];
    if (t > 0 && c > 0 && t / c > 0.7 && t / c < 1.3) out[k] = t / c;
  }
  return out;
}
