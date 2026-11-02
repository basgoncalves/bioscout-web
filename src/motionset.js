/**
 * Motion-only training set (Developer mode): the phone rides on the body and
 * the camera stays off. Reps, tempo and effort come from the accelerometer.
 *
 * The sensor and its permissions are phonemotion.js's job (the same one
 * BioFeedback uses); this file is the lifting half: a rep counter for slow,
 * repeated movements rather than a step counter for running.
 *
 * WHY NOT THE STEP DETECTOR
 * A step is a sharp impact every ~300-600 ms. A rep is a smooth there-and-back
 * lasting 1-6 s with no impact at all, so an impact threshold finds nothing on
 * a squat and fires twice on a dropped barbell. What a rep does leave in |a| is
 * a pair of sign changes: the load is accelerated out of the bottom and braked
 * at the top. So the detector works on the gravity-removed signal, counts a rep
 * on each full cycle above a noise floor, and enforces a minimum rep time.
 *
 * WHAT THE NUMBERS MEAN
 *   reps        complete cycles found
 *   tempo_s     mean seconds per rep
 *   peak_g      largest |a - 1g| in a rep, mean over reps -- how hard the
 *               load was accelerated. A proxy for effort, NOT a force: it
 *               depends on where the phone sits and on the movement.
 *   rom_index   integral of acceleration twice per rep, normalised. Tracks
 *               whether later reps got shorter; comparable within a set only.
 *   smoothness  mean absolute jerk, lower is smoother. Rises with fatigue.
 * None of these are lab values. They are repeatable within one set with the
 * phone in one place, which is what makes rep-to-rep decay readable.
 */

export const MOTION_KEY = "bioscout.motionsets.v1";

/**
 * Rep counter for lifting. Feed push(t_ms, a_g) with |acceleration incl.
 * gravity| in g, exactly what phonemotion.startMotion delivers.
 *
 * minRep / maxRep bound a plausible rep in ms; floor is the noise band around
 * 1 g that counts as "not moving" (a phone in a pocket idles around 0.02 g).
 */
export function makeRepDetector({ minRep = 700, maxRep = 8000, floor = 0.08 } = {}) {
  let lp = NaN, prevT = 0, t0 = NaN;
  let phase = 0;            // 0 waiting, 1 above the band, -1 below it
  let repStart = NaN, peak = 0, area = 0, jerk = 0, prevDev = 0, n = 0;
  const crossings = [];   // times gravity was crossed, last 2 s
  const reps = [];
  return {
    push(t, a) {
      if (!Number.isFinite(t0)) { t0 = t; prevT = t; }
      const dt = Math.max(1, t - prevT);
      // ~5 Hz low-pass: keeps the rep, drops hand tremor and sensor hash.
      lp = Number.isFinite(lp) ? lp + Math.min(1, dt / 200) * (a - lp) : a;
      const dev = lp - 1;                       // gravity removed
      peak = Math.max(peak, Math.abs(dev));
      area += Math.abs(dev) * dt / 1000;
      jerk += Math.abs(dev - prevDev) / (dt / 1000);
      n++;
      let rep = null;
      if (dev * prevDev < 0) crossings.push(t);
      while (crossings.length && t - crossings[0] > 2000) crossings.shift();
      if (phase === 0 && dev > floor) { phase = 1; repStart = t; peak = Math.abs(dev); area = 0; jerk = 0; n = 0; }
      else if (phase === 1 && dev < -floor) { phase = -1; }
      else if (phase === -1 && dev > -floor * 0.5) {
        // Back through the band: one full out-and-back cycle.
        const dur = t - repStart;
        phase = 0;
        /* A rep crosses gravity about twice, up and back. Running, bouncing
         * or a phone jostling in a pocket crosses it many times a second, and
         * keeps doing so while the signal settles afterwards -- which is where
         * a per-cycle count is fooled and a rate over the last 2 s is not. */
        if (dur >= minRep && dur <= maxRep && crossings.length <= 6) {
          rep = { rep: reps.length + 1, t: repStart - t0, duration_s: +(dur / 1000).toFixed(2),
                  peak_g: +peak.toFixed(3), area: +area.toFixed(3),
                  jerk: n ? +(jerk / n).toFixed(2) : 0 };
          reps.push(rep);
        }
      }
      // A movement that stalled above the band for too long is not a rep.
      if (phase !== 0 && t - repStart > maxRep) phase = 0;
      prevDev = dev; prevT = t;
      return rep;
    },
    level() { return Number.isFinite(lp) ? lp - 1 : 0; },
    reps() { return reps.slice(); },
    count() { return reps.length; },
    reset() { lp = NaN; phase = 0; reps.length = 0; crossings.length = 0; peak = area = jerk = 0; t0 = NaN; },
  };
}

/** Per-set summary from the reps a detector collected. */
export function motionSummary(reps, duration_s) {
  if (!reps || !reps.length) return { reps: 0, ok: false };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const areas = reps.map((r) => r.area);
  const amax = Math.max(...areas) || 1;
  const first = reps.slice(0, Math.ceil(reps.length / 3)), last = reps.slice(-Math.ceil(reps.length / 3));
  return {
    ok: true, reps: reps.length,
    duration_s: +(duration_s || 0).toFixed(1),
    tempo_s: +mean(reps.map((r) => r.duration_s)).toFixed(2),
    peak_g: +mean(reps.map((r) => r.peak_g)).toFixed(3),
    rom_index: +mean(areas.map((a) => a / amax)).toFixed(2),
    smoothness: +mean(reps.map((r) => r.jerk)).toFixed(2),
    // Did the set decay? Last third vs first third, as a percentage.
    peak_drop_pct: +(100 * (1 - mean(last.map((r) => r.peak_g)) / (mean(first.map((r) => r.peak_g)) || 1))).toFixed(0),
    tempo_rise_pct: +(100 * (mean(last.map((r) => r.duration_s)) / (mean(first.map((r) => r.duration_s)) || 1) - 1)).toFixed(0),
    perRep: reps,
  };
}

// --- storage, same shape as the position paths ------------------------------
function readAll(store) {
  try { return JSON.parse(store.getItem(MOTION_KEY) || "{}") || {}; } catch { return {}; }
}
export function saveMotionSet(sessionStarted, setIndex, summary, store = globalThis.localStorage) {
  if (!store || !summary?.ok) return;
  const all = readAll(store);
  (all[String(sessionStarted)] ||= {})[setIndex] = summary;
  const ks = Object.keys(all);
  if (ks.length > 20) ks.slice(0, ks.length - 20).forEach((q) => delete all[q]);
  try { store.setItem(MOTION_KEY, JSON.stringify(all)); } catch { /* full */ }
}
export function sessionMotionSets(sessionStarted, store = globalThis.localStorage) {
  return store ? readAll(store)[String(sessionStarted)] || {} : {};
}

/** Small per-rep bar chart of peak acceleration, to see a set decay. */
export function motionRepSVG(summary) {
  const reps = summary?.perRep || [];
  if (!reps.length) return "";
  const W = 300, H = 90, pad = 14, max = Math.max(...reps.map((r) => r.peak_g)) || 1;
  const bw = (W - 2 * pad) / reps.length;
  const bars = reps.map((r, i) => {
    const h = (H - 2 * pad) * (r.peak_g / max);
    return `<rect x="${(pad + i * bw + bw * 0.15).toFixed(1)}" y="${(H - pad - h).toFixed(1)}"
      width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="#2b7de9" opacity=".85"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:340px;display:block;margin:4px auto" role="img">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="var(--line,#8886)"/>
    ${bars}</svg>`;
}

/* ---------------------------------------------------------------------------
 * SESSION EFFORT TRACE
 *
 * The accelerometer runs from the moment the session starts, not only during a
 * set. Nothing is integrated: double integration of a phone accelerometer
 * drifts quadratically (a 0.1 m/s^2 residual is ~5 m after 10 s and ~180 m
 * after a minute), and removing gravity needs an orientation that drifts too,
 * so an inertial position over a whole session is not a measurement. What the
 * raw signal does support, with no integration at all, is how hard and how
 * continuously the athlete worked.
 *
 * One bin per second: mean and peak |a - 1g|, and whether that second was
 * active. From the bins come work time, rest time, the work:rest ratio and a
 * session effort index -- all drift-free, because each bin stands alone.
 * ------------------------------------------------------------------------- */

export const EFFORT_KEY = "bioscout.effort.v1";
const BIN_MS = 1000;
const ACTIVE_G = 0.06;        // above this a second counts as working

export function makeEffortTrace({ activeG = ACTIVE_G } = {}) {
  const bins = [];
  let t0 = NaN, cur = null, lp = NaN, prevT = 0;
  return {
    push(t, a) {
      if (!Number.isFinite(t0)) { t0 = t; prevT = t; }
      const dt = Math.max(1, t - prevT); prevT = t;
      lp = Number.isFinite(lp) ? lp + Math.min(1, dt / 200) * (a - lp) : a;
      const dev = Math.abs(lp - 1);
      const k = Math.floor((t - t0) / BIN_MS);
      if (!cur || cur.k !== k) { cur = { k, sum: 0, n: 0, peak: 0 }; bins.push(cur); }
      cur.sum += dev; cur.n++; cur.peak = Math.max(cur.peak, dev);
    },
    /** Bins as { t_s, mean_g, peak_g, active }, one per second. */
    bins() {
      return bins.map((b) => ({ t_s: b.k, mean_g: +(b.sum / Math.max(1, b.n)).toFixed(3),
                                peak_g: +b.peak.toFixed(3), active: b.sum / Math.max(1, b.n) >= activeG }));
    },
    reset() { bins.length = 0; cur = null; lp = NaN; t0 = NaN; },
  };
}

/** Session-level numbers from the per-second bins. No integration anywhere. */
export function effortSummary(bins) {
  if (!bins || !bins.length) return { ok: false };
  const work = bins.filter((b) => b.active);
  const dur = bins.length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    ok: true,
    duration_s: dur,
    work_s: work.length,
    rest_s: dur - work.length,
    work_pct: +(100 * work.length / dur).toFixed(0),
    work_rest: work.length && dur > work.length ? +((work.length) / (dur - work.length)).toFixed(2) : null,
    mean_active_g: +mean(work.map((b) => b.mean_g)).toFixed(3),
    peak_g: +Math.max(...bins.map((b) => b.peak_g)).toFixed(3),
    /* Effort index: mean active acceleration x working minutes. Comparable
     * between this athlete's own sessions with the phone in the same place;
     * not between people and not a physiological load. */
    effort_index: +(mean(work.map((b) => b.mean_g)) * work.length / 60).toFixed(1),
    bins,
  };
}

export function saveEffort(sessionStarted, summary, store = globalThis.localStorage) {
  if (!store || !summary?.ok) return;
  let all = {};
  try { all = JSON.parse(store.getItem(EFFORT_KEY) || "{}") || {}; } catch { all = {}; }
  all[String(sessionStarted)] = summary;
  const ks = Object.keys(all);
  if (ks.length > 20) ks.slice(0, ks.length - 20).forEach((q) => delete all[q]);
  try { store.setItem(EFFORT_KEY, JSON.stringify(all)); } catch { /* full */ }
}
export function sessionEffort(sessionStarted, store = globalThis.localStorage) {
  if (!store) return null;
  try { return (JSON.parse(store.getItem(EFFORT_KEY) || "{}") || {})[String(sessionStarted)] || null; } catch { return null; }
}

/** Effort over the session: one bar per second, working seconds darker. */
export function effortTraceSVG(summary) {
  const bins = summary?.bins || [];
  if (!bins.length) return "";
  const W = 320, H = 70, pad = 10;
  const max = Math.max(...bins.map((b) => b.peak_g)) || 1;
  const bw = (W - 2 * pad) / bins.length;
  const bars = bins.map((b, i) => {
    const h = (H - 2 * pad) * (b.mean_g / max);
    return `<rect x="${(pad + i * bw).toFixed(2)}" y="${(H - pad - h).toFixed(2)}"
      width="${Math.max(0.6, bw).toFixed(2)}" height="${Math.max(0.4, h).toFixed(2)}"
      fill="${b.active ? "#2b7de9" : "#8aa"}" opacity="${b.active ? ".9" : ".45"}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:340px;display:block;margin:4px auto" role="img">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="var(--line,#8886)"/>
    ${bars}</svg>`;
}
