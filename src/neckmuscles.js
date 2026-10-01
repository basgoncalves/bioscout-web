/**
 * neckmuscles.js -- neck moments and muscle forces for an isometric neck hold
 * against a known external load (a head-harness strap pulled by a cable, a
 * hanging weight on a head harness).
 *
 * WHAT IS MODELLED
 * The HYOID 1.2 cervical model (Mortensen, Vasavada & Merryweather 2018, PLOS
 * ONE 13:e0199912; 72 muscles), reduced offline by tools/export_neck_muscles.py
 * to data/neck_muscles.json: every muscle's moment arms about the six
 * independent cervical coordinates at the neutral posture, its maximum
 * isometric force, the Jacobian of the head's centre of mass (where the load is
 * taken to act) and the generalised forces of the head and neck weights.
 *
 * The hold is then static equilibrium about those six coordinates,
 *
 *     sum_i r_ik F_i  +  J_k . F_load  +  Q_gravity,k  =  0      k = 1..6,
 *
 * and the muscle forces are the ones that satisfy it with the least summed
 * squared activation (a_i = F_i / Fmax_i, 0 <= a_i <= 1) -- the usual static
 * optimisation criterion. All six coordinates are balanced, not just the side
 * bend: a sternocleidomastoid that bends the neck also flexes and turns it, and
 * something else has to hold that.
 *
 * WHAT THIS IS NOT
 *  * Not this athlete's neck. It is one generic adult-male model, unscaled. The
 *    load and the posture are the athlete's; the muscle strengths are not.
 *  * Not measured. The load is what was typed in; the camera only checks that
 *    the head held still. Muscle force from kinematics is non-identifiable in
 *    principle -- this is the model's answer to "what could hold this", one of
 *    many, chosen by a criterion.
 *  * Neutral posture only, no force-length-velocity, no passive tissue, no
 *    co-contraction beyond what equilibrium needs. A trained neck co-contracts
 *    and is stronger than this model, so a load past the model's capacity is
 *    said as that -- "more than this generic neck can hold" -- and never as a
 *    measurement of the athlete.
 *
 * Pure: no DOM, no fetch except loadNeckModel(). Tested in
 * tests/test_neckmuscles.mjs.
 */
import { normLoadDir, G } from "./loaddir.js";

let cached = null;
export async function loadNeckModel(url = "data/neck_muscles.json") {
  if (cached) return cached;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`neck model: HTTP ${r.status}`);
  cached = await r.json();
  return cached;
}

/** Unit vector of the force the LOAD puts on the head, in the model frame
 *  (x anterior, y up, z right). Directions are named for the way the athlete
 *  pushes (loaddir.js), so the load points the other way. "down" is a weight
 *  hanging from a head harness. */
export function loadVector(dir) {
  switch (normLoadDir(dir)) {
    case "left": return [0, 0, 1];      // pushes left, pulled to the right
    case "right": return [0, 0, -1];
    case "forward": return [-1, 0, 0];  // pushes forward, pulled back
    case "back": return [1, 0, 0];
    default: return [0, -1, 0];
  }
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Solve a small dense system (n <= 6) by Gaussian elimination with pivoting. */
function solve(M, v) {
  const n = v.length, A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / (row[i] || 1e-12));
}

/**
 * min sum a_i^2  s.t.  A a = b,  0 <= a <= 1.
 *
 * Solved on its dual: for a multiplier vector lam the minimiser over the box
 * is a = clip(A' lam / 2, 0, 1), and the equality residual b - A a(lam) is
 * driven to zero by semismooth Newton (6 unknowns, so each step is a 6x6
 * solve). Started from the unconstrained least-norm solution it converges in a
 * handful of steps; checked against scipy's trust-constr to the printed digit.
 * If the residual will not go to zero the load is beyond what the muscles can
 * hold, and `ok` is false.
 */
export function minActivation(A, b, { iters = 60, tol = 1e-6 } = {}) {
  const m = A.length, n = A[0].length;
  const AAt = A.map((ri) => A.map((rj) => ri.reduce((s, x, k) => s + x * rj[k], 0)));
  const trace = AAt.reduce((s, r, i) => s + r[i], 0);
  const aOf = (lam) => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let k = 0; k < m; k++) z += A[k][i] * lam[k];
      a[i] = Math.min(1, Math.max(0, z / 2));
    }
    return a;
  };
  const resid = (a) => b.map((bk, k) => bk - A[k].reduce((s, x, i) => s + x * a[i], 0));
  const norm = (v) => Math.hypot(...v);
  let lam = solve(AAt, b).map((x) => 2 * x);
  let a = aOf(lam), r = resid(a), it = 0;
  for (; it < iters && norm(r) > tol; it++) {
    const z = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += A[k][i] * lam[k];
      z[i] = s / 2;
    }
    const H = Array.from({ length: m }, (_, p) => Array.from({ length: m }, (_, q) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (z[i] > 0 && z[i] < 1) s += A[p][i] * A[q][i];
      return s / 2 + (p === q ? 1e-8 * trace / m : 0);
    }));
    const step = solve(H, r);
    let t = 1, n0 = norm(r), lam2 = lam, a2 = a, r2 = r;
    while (t > 1e-8) {
      lam2 = lam.map((x, k) => x + t * step[k]);
      a2 = aOf(lam2); r2 = resid(a2);
      if (norm(r2) < (1 - 1e-4 * t) * n0) break;
      t /= 2;
    }
    if (t <= 1e-8) break;               // no descent: infeasible
    lam = lam2; a = a2; r = r2;
  }
  return { a, ok: norm(r) <= Math.max(tol, 1e-4 * norm(b)), residual: norm(r), iters: it };
}

/** Muscle name -> [group key, side]. "_L" is the model's left; the rest are
 *  the right. Compartments of one muscle are summed for display. */
export function muscleGroup(name) {
  const side = /_L$/.test(name) ? "L" : "R";
  const base = name.replace(/_L$/, "");
  const rules = [
    [/^stern_mast/, "scm"], [/^cleid_(mast|occ)/, "scm"],
    [/^trap/, "trapezius"], [/^levator_scap/, "levator"],
    [/^scalenus/, "scalenes"], [/^splen_cap/, "splenius_cap"],
    [/^splen_cerv/, "splenius_cerv"], [/^semi_cap/, "semispinalis_cap"],
    [/^semi_cerv/, "semispinalis_cerv"], [/^longissi/, "longissimus"],
    [/^iliocost/, "iliocostalis"], [/^long_c(ol|ap)/, "longus"],
    [/^(rectcap|obl_cap)/, "suboccipital"],
    [/^(digastric|Mylohyoid|Geniohyoid|Stylohyoid)/i, "suprahyoid"],
    [/^(Omo_hyoid|Sterno_hyoid|SternoThyroid)/i, "infrahyoid"],
  ];
  const hit = rules.find(([re]) => re.test(base));
  return [hit ? hit[1] : base, side];
}

/**
 * Everything the results page shows for one hold.
 *
 *   kg, dir     the load and the way the athlete pushed (loaddir.js)
 *
 * Returns { forceN, moment: {lateral, flexion, axial} at C7/T1 in N·m (signs:
 * lateral + = bends to the right, flexion + = chin down, axial + = turns to
 * the left), muscles: [{name, group, side, F, a}], groups: summed per group
 * and side, ok (the model can hold it), capacityKg (the most it can hold in
 * this direction), pct (load as % of that), saturated (muscles at >= 98 %). }
 */
export function neckHold(model, { kg, dir }) {
  const forceN = Math.max(0, Number(kg) || 0) * G;
  const u = loadVector(dir);
  const Fv = u.map((x) => x * forceN);
  const dofs = model.dofs.length;
  const Jt = (F) => Array.from({ length: dofs }, (_, k) =>
    model.J.reduce((s, row, c) => s + row[k] * F[c], 0));
  const A = Array.from({ length: dofs }, (_, k) => model.muscles.map((m) => m.r[k] * m.fmax));
  const bFor = (s) => {
    const Qe = Jt(Fv.map((x) => x * s));
    return Qe.map((q, k) => -(q + model.Qgravity[k]));
  };
  // Moment of the load about C7/T1 (head weight excluded: it is the same
  // whatever the test, and the page is about the test).
  const M = cross(model.loadPoint.fromT1, Fv);
  const moment = { lateral: M[0], flexion: -M[2], axial: M[1] };

  let sol = minActivation(A, bFor(1));
  // Capacity: the largest multiple of this load the model can hold, found by
  // bisection. Reported either way -- "you used 60 % of it" is as useful as
  // "this is 140 % of it".
  let lo = 0, hi = 1;
  if (sol.ok) { while (minActivation(A, bFor(hi * 2)).ok && hi < 64) hi *= 2; lo = hi; hi *= 2; }
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (minActivation(A, bFor(mid)).ok) lo = mid; else hi = mid;
  }
  const capacityKg = forceN > 0 ? lo * forceN / G : null;
  // Past capacity, show the muscles at the capacity solution -- what the model
  // does at its limit -- rather than a non-converged guess.
  if (!sol.ok && lo > 0) sol = { ...minActivation(A, bFor(lo)), ok: false };

  const muscles = model.muscles.map((m, i) => {
    const [group, side] = muscleGroup(m.name);
    return { name: m.name, group, side, F: sol.a[i] * m.fmax, a: sol.a[i] };
  });
  const gmap = new Map();
  for (const m of muscles) {
    const key = m.group + "|" + m.side;
    const g = gmap.get(key) || { group: m.group, side: m.side, F: 0, fmax: 0, aMax: 0 };
    g.F += m.F; g.fmax += model.muscles.find((x) => x.name === m.name).fmax;
    g.aMax = Math.max(g.aMax, m.a);
    gmap.set(key, g);
  }
  const groups = [...gmap.values()].filter((g) => g.F > 0.5).sort((x, y) => y.F - x.F);
  return {
    forceN, moment, muscles, groups, ok: sol.ok,
    capacityKg, pct: capacityKg ? (100 * (Number(kg) || 0)) / capacityKg : null,
    saturated: muscles.filter((m) => m.a >= 0.98).length,
    totalF: muscles.reduce((s, m) => s + m.F, 0),
    leverM: Math.hypot(...model.loadPoint.fromT1),
  };
}
