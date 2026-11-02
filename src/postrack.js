/**
 * Position tracking (Developer mode only): where on the floor the athlete was
 * during a set, and a volume / intensity report per lift for the session.
 *
 * WHERE ON THE FLOOR, FROM ONE FIXED PHONE
 * ---------------------------------------
 * A single camera has no depth, so depth is read from apparent size: the same
 * body seen twice as small is twice as far away (pinhole camera,
 * z = f * L / l). L is a body length that does not change while moving --
 * the sum of trunk, thigh and shank on each side, scaled to the athlete's
 * height -- and l is the same length in pixels. Lateral position is the feet
 * midpoint's offset from the image centre, converted at that depth.
 *
 * Why segment lengths and not head-to-toe height: a squat, a lunge or a bent
 * walk shrinks stature in the picture without the person moving away. Segment
 * lengths survive that; they shrink only by foreshortening, so the per-frame
 * value is the running MAXIMUM over a short window (a limb pointing at the
 * camera looks short, never long).
 *
 * In a small room this is what makes the path look like walking instead of a
 * cloud: a 2 s robust scale, a median filter to drop single-frame pose
 * glitches, a speed cap (nobody moves 6 m/s indoors), and a zero-phase
 * low-pass. Everything is an estimate -- typically +-10-20 cm laterally and
 * more in depth -- and the map says so. The field of view is assumed (a
 * typical phone main lens, ~63 deg vertical in portrait); a different lens
 * scales the map but does not change its shape.
 */

export const POS_KEY = "bioscout.postrack.v1";
export const LB_KEY = "bioscout.leaderboard.v1";
const DEFAULT_VFOV_DEG = 63;      // portrait phone main camera, approx.
const MAX_SPEED = 6;              // m/s; faster than this is a tracking jump
const SEG_FRAC = 0.78;            // shoulder->hip + thigh + shank ~ 0.78 x stature (Winter)

const P = (lm, k) => (lm && lm[k] ? lm[k] : null);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function chainPx(lm, side) {
  const s = P(lm, side + "_shoulder"), h = P(lm, side + "_hip"),
        k = P(lm, side + "_knee"), a = P(lm, side + "_ankle");
  if (!s || !h || !k || !a) return null;
  return dist(s, h) + dist(h, k) + dist(k, a);
}

function feetMid(lm) {
  const l = P(lm, "left_ankle"), r = P(lm, "right_ankle");
  if (l && r) return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2];
  const hl = P(lm, "left_hip"), hr = P(lm, "right_hip");
  return l || r || (hl && hr ? [(hl[0] + hr[0]) / 2, (hl[1] + hr[1]) / 2] : null);
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

function medianFilter(xs, half) {
  return xs.map((_, i) => median(xs.slice(Math.max(0, i - half), i + half + 1)));
}

// Second-order Butterworth-like smoothing, run forwards then backwards so the
// path is not shifted in time (zero phase).
function lowpass(xs, fs, fc) {
  if (xs.length < 3) return xs.slice();
  const a = Math.exp(-2 * Math.PI * fc / fs);
  const pass = (v) => { const o = v.slice(); for (let i = 1; i < o.length; i++) o[i] = a * o[i - 1] + (1 - a) * o[i]; return o; };
  let y = pass(pass(xs));
  y = pass(pass(y.reverse())).reverse();
  return y;
}

/**
 * frames: [{ t (ms), lm: { name: [xPx, yPx, z] } }]
 * opts: { heightM, frameW, frameH, vfovDeg }
 * Returns { t: [s], x: [m], z: [m], distance_m, area_m2, extent, speed_mean, ok }
 * x is lateral (right of camera +), z is distance from the camera.
 */
export function floorPath(frames, opts = {}) {
  const heightM = opts.heightM || 1.75;
  const L = SEG_FRAC * heightM;
  const raw = [];
  for (const f of frames || []) {
    const m = feetMid(f.lm);
    const c = Math.max(chainPx(f.lm, "left") || 0, chainPx(f.lm, "right") || 0);
    if (m && c > 0) raw.push({ t: f.t / 1000, u: m[0], v: m[1], c });
  }
  if (raw.length < 10) return { ok: false, t: [], x: [], z: [], distance_m: 0, area_m2: 0 };
  // Frame size: given, or the landmark extent as a floor (a body never
  // fills more than the picture).
  let W = opts.frameW, H = opts.frameH;
  if (!W || !H) {
    W = Math.max(...raw.map((r) => r.u)) * 1.1;
    H = Math.max(...raw.map((r) => r.v)) * 1.1;
  }
  const vf = (opts.vfovDeg || DEFAULT_VFOV_DEG) * Math.PI / 180;
  const fPx = (H / 2) / Math.tan(vf / 2);
  const dur = raw[raw.length - 1].t - raw[0].t;
  const fs = dur > 0 ? (raw.length - 1) / dur : 30;
  // Robust scale: running max of the chain over +-1 s.
  const win = Math.max(2, Math.round(fs));
  const cMax = raw.map((_, i) => {
    let m = 0; for (let j = Math.max(0, i - win); j <= Math.min(raw.length - 1, i + win); j++) m = Math.max(m, raw[j].c);
    return m;
  });
  let z = cMax.map((c) => fPx * L / c);
  let x = raw.map((r, i) => (r.u - W / 2) * z[i] / fPx);
  const half = Math.max(1, Math.round(fs * 0.1));
  x = medianFilter(x, half); z = medianFilter(z, half);
  // Speed cap: hold the last good point through a jump.
  const t = raw.map((r) => r.t);
  for (let i = 1; i < x.length; i++) {
    const dt = Math.max(1e-3, t[i] - t[i - 1]);
    if (Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]) / dt > MAX_SPEED) { x[i] = x[i - 1]; z[i] = z[i - 1]; }
  }
  x = lowpass(x, fs, 1.5); z = lowpass(z, fs, 1.0);
  let d = 0;
  for (let i = 1; i < x.length; i++) d += Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  // Sway in place is not distance: below ~2 cm per sample the motion is noise.
  const extent = { x0: Math.min(...x), x1: Math.max(...x), z0: Math.min(...z), z1: Math.max(...z) };
  const area = hullArea(x.map((v, i) => [v, z[i]]));
  // Downsample to ~10 Hz for storage.
  const step = Math.max(1, Math.round(fs / 10));
  const keep = (a) => a.filter((_, i) => i % step === 0).map((v) => +v.toFixed(3));
  return {
    ok: true, t: keep(t.map((v) => v - t[0])), x: keep(x), z: keep(z),
    distance_m: +d.toFixed(2), area_m2: +area.toFixed(2),
    extent: Object.fromEntries(Object.entries(extent).map(([k, v]) => [k, +v.toFixed(2)])),
    speed_mean: dur > 0 ? +(d / dur).toFixed(2) : 0,
  };
}

function hullArea(pts) {
  if (pts.length < 3) return 0;
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  let a = 0; for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i][0] * h[j][1] - h[j][0] * h[i][1]; }
  return Math.abs(a) / 2;
}

// --- storage: one path per set, keyed by session start ----------------------
function readAll(store) {
  try { return JSON.parse(store.getItem(POS_KEY) || "{}") || {}; } catch { return {}; }
}
export function savePath(sessionStarted, setIndex, path, store = globalThis.localStorage) {
  if (!store || !path?.ok) return;
  const all = readAll(store);
  const k = String(sessionStarted);
  (all[k] ||= {})[setIndex] = path;
  // Keep the last 20 sessions; paths are a dev tool, not the training log.
  const ks = Object.keys(all);
  if (ks.length > 20) ks.slice(0, ks.length - 20).forEach((q) => delete all[q]);
  try { store.setItem(POS_KEY, JSON.stringify(all)); } catch { /* full: skip */ }
}
export function sessionPaths(sessionStarted, store = globalThis.localStorage) {
  return store ? readAll(store)[String(sessionStarted)] || {} : {};
}

// --- the map ---------------------------------------------------------------
const SET_COLOURS = ["#2b7de9", "#e9572b", "#2bb673", "#b52be9", "#e9b82b", "#2bd1e9", "#e92b8a"];

export function pathMapSVG(paths, labels = {}) {
  const sets = Object.entries(paths).filter(([, p]) => p?.ok && p.x.length);
  if (!sets.length) return "";
  const xs = sets.flatMap(([, p]) => p.x), zs = sets.flatMap(([, p]) => p.z);
  let x0 = Math.min(0, ...xs) - 0.3, x1 = Math.max(0, ...xs) + 0.3;
  let z0 = 0, z1 = Math.max(...zs) + 0.3;
  const span = Math.max(x1 - x0, z1 - z0, 1);
  const cx = (x0 + x1) / 2; x0 = cx - span / 2; x1 = cx + span / 2; z1 = z0 + span;
  const S = 300, pad = 18, k = (S - 2 * pad) / span;
  const X = (x) => pad + (x - x0) * k, Y = (z) => pad + (z - z0) * k; // camera at top
  let grid = "";
  for (let g = Math.ceil(x0); g <= x1; g++) grid += `<line x1="${X(g)}" y1="${pad}" x2="${X(g)}" y2="${S - pad}" class="pt-grid"/>`;
  for (let g = Math.ceil(z0); g <= z1; g++) grid += `<line x1="${pad}" y1="${Y(g)}" x2="${S - pad}" y2="${Y(g)}" class="pt-grid"/>`;
  const lines = sets.map(([idx, p], n) => {
    const col = SET_COLOURS[n % SET_COLOURS.length];
    const d = p.x.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(p.z[i]).toFixed(1)}`).join("");
    const e = p.x.length - 1;
    return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>
      <circle cx="${X(p.x[0])}" cy="${Y(p.z[0])}" r="4" fill="${col}"/>
      <rect x="${X(p.x[e]) - 3.5}" y="${Y(p.z[e]) - 3.5}" width="7" height="7" fill="none" stroke="${col}" stroke-width="2"/>`;
  }).join("");
  const legend = sets.map(([idx], n) =>
    `<span style="color:${SET_COLOURS[n % SET_COLOURS.length]}">&#9632; ${labels[idx] || idx}</span>`).join(" &nbsp;");
  return `<svg viewBox="0 0 ${S} ${S}" style="width:100%;max-width:360px;display:block;margin:6px auto" role="img">
    <style>.pt-grid{stroke:var(--line,#8884);stroke-width:1}</style>
    <rect x="${pad}" y="${pad}" width="${S - 2 * pad}" height="${S - 2 * pad}" fill="none" stroke="var(--line,#8886)"/>
    ${grid}
    <polygon points="${X(0)},${pad - 2} ${X(0) - 7},${pad - 14} ${X(0) + 7},${pad - 14}" fill="var(--muted,#888)"/>
    ${lines}
  </svg><div class="note" style="text-align:center">${legend}</div>`;
}

// --- volume / intensity per lift --------------------------------------------
/* Share of body mass a bodyweight movement moves (literature-typical values;
 * the push-up fraction is the classic ~0.64-0.70 of body weight on the hands,
 * the squat ~0.85 because the shanks barely move). An external load counts in
 * full; assistance (a band, a machine) is subtracted. Movements not listed
 * count external load only, so a set with neither is reps without kg. */
export const BW_FRACTION = {
  pullup: 1.0, dip: 0.95, pushup: 0.66, squat: 0.85, slsquat: 0.85, lunge: 0.85,
  cmj: 1.0, sj: 1.0, heelraise: 1.0, bridge: 0.5, kickback: 0.15,
};

/** Epley 1RM estimate; null above 12 reps where it stops meaning much. */
export function e1rm(kg, reps) {
  if (!(kg > 0) || !(reps > 0) || reps > 12) return null;
  return reps === 1 ? kg : kg * (1 + reps / 30);
}

/**
 * sess: { started, sets: [{ activity, reps, massKg, addedKg, assistKg, at }] }
 * Returns rows per activity:
 *   sets, reps, volume_kg (sum reps x moved load), mean_load_kg (intensity,
 *   load per rep), rel_intensity (mean load / body mass), best_e1rm_kg,
 *   intensity_pct (mean load / best e1RM), density_kg_min.
 */
export function liftReport(sess) {
  const by = {};
  const t = (sess?.sets || []).map((s) => +new Date(s.at)).filter(Number.isFinite);
  const minutes = t.length > 1 ? Math.max(1, (Math.max(...t) - Math.min(...t)) / 60000) : null;
  for (const s of sess?.sets || []) {
    if (!s.reps) continue;
    const r = (by[s.activity] ||= { activity: s.activity, sets: 0, reps: 0, volume_kg: 0,
                                    _load: 0, _bm: [], best_e1rm_kg: null, top_kg: 0 });
    const bm = +s.massKg || 0;
    const load = Math.max(0, bm * (BW_FRACTION[s.activity] ?? 0) + (+s.addedKg || 0) - (+s.assistKg || 0));
    r.sets += 1; r.reps += s.reps;
    r.volume_kg += load * s.reps; r._load += load * s.reps;
    if (bm) r._bm.push(bm);
    r.top_kg = Math.max(r.top_kg, load);
    const e = e1rm(load, s.reps);
    if (e != null) r.best_e1rm_kg = Math.max(r.best_e1rm_kg || 0, e);
  }
  return Object.values(by).map((r) => {
    const mean = r.reps ? r._load / r.reps : 0;
    const bm = r._bm.length ? r._bm.reduce((a, b) => a + b, 0) / r._bm.length : null;
    const round = (v, n = 1) => (v == null ? null : +v.toFixed(n));
    return {
      activity: r.activity, sets: r.sets, reps: r.reps,
      volume_kg: round(r.volume_kg, 0), mean_load_kg: round(mean),
      top_load_kg: round(r.top_kg), rel_intensity: bm ? round(mean / bm, 2) : null,
      best_e1rm_kg: round(r.best_e1rm_kg),
      intensity_pct: r.best_e1rm_kg ? round(100 * mean / r.best_e1rm_kg, 0) : null,
      density_kg_min: minutes ? round(r.volume_kg / minutes, 0) : null,
    };
  });
}

/**
 * The record a leaderboard will read later: one per session, per lift, plus
 * the floor distance. Kept local for now (LB_KEY); syncing it is a later step.
 */
export function leaderboardEntry(sess, paths = {}) {
  const lifts = liftReport(sess);
  const dist = Object.values(paths).reduce((a, p) => a + (p?.distance_m || 0), 0);
  return {
    v: 1, session: sess?.started ?? null, profile: sess?.profile ?? null,
    lifts, distance_m: +dist.toFixed(1),
    total_volume_kg: lifts.reduce((a, l) => a + (l.volume_kg || 0), 0),
    total_reps: lifts.reduce((a, l) => a + l.reps, 0),
  };
}

export function saveLeaderboardEntry(entry, store = globalThis.localStorage) {
  if (!store || !entry?.session) return;
  let all = {};
  try { all = JSON.parse(store.getItem(LB_KEY) || "{}") || {}; } catch { all = {}; }
  all[String(entry.session)] = entry;
  try { store.setItem(LB_KEY, JSON.stringify(all)); } catch { /* full */ }
}
