/**
 * armmuscles.js -- upper-body muscle forces for the arm tasks (pull-up, dip,
 * jump shot), from the Digital Athlete full-body model's major arm muscles.
 *
 * WHY THIS EXISTS. The FAIS surrogate (forces.js) predicts 80 LOWER-LIMB
 * muscles and was trained on running and single-leg squats. Run on a pull-up
 * it reported soleus and vasti -- muscles that are not doing the pull-up -- and
 * nothing for the arms that are. For these tasks the arm inverse dynamics
 * (dynamics.js armInverseDynamics, carried in rep.jm) already give the net
 * elbow and shoulder moments per arm; this module shares them out over the
 * major muscles of the Digital Athlete model (bioscout/models/Digital Athlete,
 * Full_Body_with_ball upper body) by static optimisation.
 *
 * THE SOLVE. Per frame: minimise sum (F_i / Fmax_i)^2 subject to
 *   sum r_elbow,i F_i = M_elbow,  sum r_shoulder,i F_i = M_shoulder,  F_i >= 0
 * with moments EXTENSION-POSITIVE (the rep.jm convention), so flexors carry
 * negative moment arms. Closed form F = W A' (A W A')^-1 M, W = diag(Fmax^2),
 * with an active set: a muscle the solution would push (it cannot push) is
 * dropped and the frame re-solved. Biarticular muscles (biceps, triceps long
 * head) couple the two joints exactly as they do in the body.
 *
 * WHAT IT IS NOT. Moment arms are constant (mid-range literature values), not
 * pose-dependent; Fmax is each muscle's summed bundles in the Digital Athlete
 * .osim (right arm). The model has no latissimus dorsi -- its LD_* are
 * longissimus -- so the pull-up's shoulder extension is shared by teres major,
 * sternal pectoralis major, posterior deltoid and the triceps long head; read
 * them as "the shoulder extensors", not as a lat estimate. Scapular muscles
 * (trapezius, rhomboids) balance no joint moment we compute and are not
 * reported. Face-on clips have no elbow moment (see armSideOn), so only the
 * shoulder is solved and the elbow-only muscles are left out.
 */

// name, Fmax (N, Digital Athlete right-arm bundles summed), moment arm (m)
// at the elbow and shoulder, extension-positive.
export const ARM_MUSCLES = [
  // elbow flexors
  { name: "bic",         label: "Biceps brachii",          fmax: 520,  elbow: -0.040, shoulder: -0.015 },
  { name: "brachialis",  label: "Brachialis",              fmax: 1039, elbow: -0.020, shoulder: 0 },
  { name: "brachiorad",  label: "Brachioradialis",         fmax: 164,  elbow: -0.050, shoulder: 0 },
  // elbow extensors
  { name: "tric_long",   label: "Triceps (long head)",     fmax: 1129, elbow: 0.020,  shoulder: 0.020 },
  { name: "tric_lat",    label: "Triceps (lateral head)",  fmax: 1144, elbow: 0.020,  shoulder: 0 },
  { name: "tric_med",    label: "Triceps (medial head)",   fmax: 1077, elbow: 0.020,  shoulder: 0 },
  // shoulder extensors / adductors
  { name: "ter_maj",     label: "Teres major",             fmax: 608,  elbow: 0,      shoulder: 0.030 },
  { name: "pect_maj_t",  label: "Pectoralis major (sternal)", fmax: 896, elbow: 0,    shoulder: 0.025 },
  { name: "delt_post",   label: "Deltoid (posterior)",     fmax: 1400, elbow: 0,      shoulder: 0.020 },
  // shoulder flexors
  { name: "delt_clav",   label: "Deltoid (anterior)",      fmax: 505,  elbow: 0,      shoulder: -0.020 },
  { name: "pect_maj_c",  label: "Pectoralis major (clavicular)", fmax: 292, elbow: 0, shoulder: -0.020 },
  { name: "coracobr",    label: "Coracobrachialis",        fmax: 463,  elbow: 0,      shoulder: -0.015 },
];

export const ARM_TASKS = new Set(["pullup", "dip", "jumpshot"]);

/** Which joint each arm muscle crosses -- for topMusclesForJoint. */
export const ARM_BY_JOINT = {
  elbow: ARM_MUSCLES.filter((m) => m.elbow).map((m) => m.name),
  shoulder: ARM_MUSCLES.filter((m) => m.shoulder).map((m) => m.name),
};

/** Solve one frame. rows: [{arms: Float64Array(n), M}] ; returns forces. */
function solveFrame(rows, fmax) {
  const n = fmax.length;
  const active = new Array(n).fill(true);
  // A muscle crossing no constrained joint can only add cost.
  for (let i = 0; i < n; i++) active[i] = rows.some((r) => r.arms[i] !== 0);
  const F = new Float64Array(n);
  for (let iter = 0; iter <= n; iter++) {
    const k = rows.length;
    // S = A W A' (k x k), k <= 2
    const S = [[0, 0], [0, 0]];
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) if (active[i]) s += rows[a].arms[i] * fmax[i] ** 2 * rows[b].arms[i];
      S[a][b] = s;
    }
    let lam;
    const eps = 1e-12;
    if (k === 1) lam = [rows[0].M / (S[0][0] + eps)];
    else {
      const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
      if (Math.abs(det) < 1e-18) {
        lam = [rows[0].M / (S[0][0] + eps), rows[1].M / (S[1][1] + eps)];
      } else {
        lam = [( S[1][1] * rows[0].M - S[0][1] * rows[1].M) / det,
               (-S[1][0] * rows[0].M + S[0][0] * rows[1].M) / det];
      }
    }
    let neg = -1, worst = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) { F[i] = 0; continue; }
      let s = 0;
      for (let a = 0; a < k; a++) s += rows[a].arms[i] * lam[a];
      F[i] = fmax[i] ** 2 * s;
      if (F[i] < worst) { worst = F[i]; neg = i; }
    }
    if (neg < 0) return F;
    active[neg] = false;
  }
  return F.map((v) => Math.max(0, v));
}

/**
 * Muscle forces (N, per arm) over one rep from its jm moments.
 * Returns null when the rep has no arm moments.
 */
export function armMuscleForces(jm) {
  if (!jm) return null;
  const el = Array.isArray(jm.elbow_moment) || ArrayBuffer.isView(jm.elbow_moment) ? jm.elbow_moment : null;
  const sh = Array.isArray(jm.shoulder_moment) || ArrayBuffer.isView(jm.shoulder_moment) ? jm.shoulder_moment : null;
  if (!el && !sh) return null;
  const nF = (el || sh).length;
  // Only muscles crossing a joint whose moment is known. Face-on there is no
  // elbow moment, so brachialis, brachioradialis and the short triceps heads
  // are not estimated at all rather than reported as zero.
  const keep = ARM_MUSCLES.filter((m) => (el && m.elbow) || (sh && m.shoulder));
  const fmax = keep.map((m) => m.fmax);
  const elA = Float64Array.from(keep, (m) => m.elbow);
  const shA = Float64Array.from(keep, (m) => m.shoulder);
  const forces = [];
  for (let t = 0; t < nF; t++) {
    const rows = [];
    if (el && Number.isFinite(el[t])) rows.push({ arms: elA, M: el[t] });
    if (sh && Number.isFinite(sh[t])) rows.push({ arms: shA, M: sh[t] });
    forces.push(rows.length ? solveFrame(rows, fmax) : new Float64Array(keep.length));
  }
  return { forces, muscleNames: keep.map((m) => m.name),
           labels: Object.fromEntries(keep.map((m) => [m.name, m.label])) };
}
