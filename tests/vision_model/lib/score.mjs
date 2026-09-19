/**
 * score.mjs -- agreement between an angle the app produced and the same angle
 * measured in the lab.
 *
 * RMSE alone hides the two errors that matter most clinically:
 *
 *   a CONSTANT offset (bias) is a calibration problem -- the waveform is right
 *   and every peak is wrong by the same amount, which a change of reference
 *   posture fixes and which does not stop the model being usable for change
 *   over time;
 *
 *   a ROM or PEAK error is a different failure: the movement itself is
 *   under- or over-read, and no offset fixes it.
 *
 * So both are reported, alongside Bland-Altman limits of agreement (the
 * comparison a biomechanics reviewer will ask for) and the RMSE after the bias
 * is removed, which says how much of the error is shape rather than offset.
 */

const finite = (a) => a.filter(Number.isFinite);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = (a) => {
  const v = finite(a);
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
};

export { mean, sd };

/** Pairs where both series are finite. */
function paired(a, b) {
  const x = [], y = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { x.push(a[i]); y.push(b[i]); }
  }
  return [x, y];
}

/**
 * @param est  the app's angle, per video frame
 * @param ref  the ground truth on the same frames (NaN where the lab trial
 *             did not cover the frame -- those frames are simply not scored)
 */
export function agreement(est, ref) {
  const [x, y] = paired(est, ref);
  if (x.length < 5) return { n: x.length, rmse: NaN, mae: NaN, bias: NaN,
                             rmseDetrended: NaN, r: NaN, loa: [NaN, NaN],
                             romEst: NaN, romRef: NaN, romErr: NaN,
                             peakEst: NaN, peakRef: NaN, peakErr: NaN };
  const d = x.map((v, i) => v - y[i]);
  const bias = mean(d);
  const sdd = sd(d);
  const rng = (a) => Math.max(...a) - Math.min(...a);
  const pk = (a) => Math.max(...a);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return {
    n: x.length,
    rmse: Math.sqrt(mean(d.map((v) => v * v))),
    mae: mean(d.map(Math.abs)),
    bias,
    // What is left once the constant offset is taken out: the shape error.
    rmseDetrended: Math.sqrt(mean(d.map((v) => (v - bias) * (v - bias)))),
    r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN,
    loa: [bias - 1.96 * sdd, bias + 1.96 * sdd],
    romEst: rng(x), romRef: rng(y), romErr: rng(x) - rng(y),
    peakEst: pk(x), peakRef: pk(y), peakErr: pk(x) - pk(y),
  };
}

/**
 * Count agreement for a discrete outcome (reps, steps, shots).
 * Reported as a signed difference AND as the absolute rate, because a detector
 * that misses one rep in five is a different animal from one that adds one.
 */
export function countScore(got, want) {
  if (!Number.isFinite(want)) return { got, want: null, diff: null, errPct: null };
  return { got, want, diff: got - want,
           errPct: want ? ((got - want) / want) * 100 : (got ? 100 : 0) };
}

/**
 * Event timing: each reference event matched to its nearest detected event,
 * unmatched beyond `tolS` counted as a miss. Returns mean absolute timing
 * error over the matches and how many events went unmatched either way.
 */
export function eventScore(gotS, wantS, tolS = 0.10) {
  if (!Array.isArray(wantS) || !wantS.length) return null;
  const used = new Set();
  const errs = [];
  let missed = 0;
  for (const w of wantS) {
    let best = -1, bd = Infinity;
    gotS.forEach((g, i) => {
      const d = Math.abs(g - w);
      if (!used.has(i) && d < bd) { bd = d; best = i; }
    });
    if (best >= 0 && bd <= tolS) { used.add(best); errs.push(gotS[best] - w); }
    else missed++;
  }
  return { matched: errs.length, missed, extra: gotS.length - errs.length,
           meanAbsS: errs.length ? mean(errs.map(Math.abs)) : NaN,
           biasS: errs.length ? mean(errs) : NaN, tolS };
}

/**
 * One number per model per clip, so the report can rank.
 *
 * Deliberately simple and stated rather than tuned: the median joint RMSE in
 * degrees, plus a penalty for every rep the detector got wrong and for every
 * clip where the task was misclassified. It is a SUMMARY of the table below
 * it, not evidence on its own -- the per-joint rows are what a decision should
 * be made on.
 */
export function summaryScore({ jointRmse = [], repDiff = null, activityOk = null,
                               repPenaltyDeg = 3, activityPenaltyDeg = 10 } = {}) {
  const v = finite(jointRmse);
  let s = v.length ? median(v) : NaN;
  if (!Number.isFinite(s)) return NaN;
  if (Number.isFinite(repDiff)) s += Math.abs(repDiff) * repPenaltyDeg;
  if (activityOk === false) s += activityPenaltyDeg;
  return s;
}

export function median(a) {
  const v = finite(a).slice().sort((x, y) => x - y);
  if (!v.length) return NaN;
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}
