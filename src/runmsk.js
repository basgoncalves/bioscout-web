// Biomechanics of running — a tiny 2D sagittal leg (pelvis, thigh, shank, foot; 8 muscles) that walks
// through the OpenSim pipeline: Scale -> Inverse kinematics -> Inverse dynamics -> Static optimisation.
// Each step feeds the next, so a bad scaling shows up in the IK, the moments and the muscle forces.
// Teaching model only: constant moment arms, no force-length-velocity, pelvis kept upright.

const BM = 70, G = 9.81, T = 0.25, N = 51, DT = T / (N - 1), D2R = Math.PI / 180;
export const GEN = { t: 0.43, s: 0.42, f: 0.22 };     // generic (unscaled) model, m
export const SUBJ = { t: 0.47, s: 0.40, f: 0.25 };    // the "real" runner the markers come from
export const MK = ["ASI", "PSI", "THI", "KNE", "TIB", "ANK", "HEE", "TOE"];
export const MUS = [                                   // moment arms (m): hip ext+, knee ext+, ankle plantarflexion+
  { n: "GMAX", r: [0.06, 0, 0], F: 1900 }, { n: "ILPS", r: [-0.05, 0, 0], F: 1800 },
  { n: "HAMS", r: [0.07, -0.03, 0], F: 2700 }, { n: "RF", r: [-0.04, 0.045, 0], F: 1200 },
  { n: "VAS", r: [0, 0.045, 0], F: 5000 }, { n: "GAS", r: [0, -0.02, 0.05], F: 2300 },
  { n: "SOL", r: [0, 0, 0.05], F: 3500 }, { n: "TA", r: [0, 0, -0.04], F: 1000 },
];
const MCOL = MUS.map((_, i) => `hsl(${i * 45}, 75%, 58%)`);

// ---------- small maths ----------
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
function solve(A, b) {                                 // Gaussian elimination, partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}
// Levenberg–Marquardt on a residual function (numeric Jacobian)
export function lm(res, x0, iters = 40) {
  let x = x0.slice(), r = res(x), f = r.reduce((s, v) => s + v * v, 0), mu = 1e-3;
  for (let it = 0; it < iters; it++) {
    const n = x.length, J = [];
    for (let j = 0; j < n; j++) { const xp = x.slice(), h = 1e-6 * Math.max(1, Math.abs(x[j])); xp[j] += h; J.push(res(xp).map((v, i) => (v - r[i]) / h)); }
    const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => { let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * J[b][i]; return s; }));
    const g = Array.from({ length: n }, (_, a) => { let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * r[i]; return s; });
    let ok = false;
    for (let k = 0; k < 8 && !ok; k++) {
      const dx = solve(A.map((row, a) => row.map((v, b) => v + (a === b ? mu * (v + 1e-9) + 1e-12 : 0))), g);
      const xn = x.map((v, i) => v - dx[i]), rn = res(xn), fn = rn.reduce((s, v) => s + v * v, 0);
      if (fn < f) { ok = true; const step = Math.hypot(...dx); x = xn; r = rn; f = fn; mu = Math.max(1e-9, mu / 4); if (step < 1e-9) return x; } else mu *= 5;
    }
    if (!ok) break;
  }
  return x;
}
const smooth = (u) => u * u * (3 - 2 * u);
function crs(keys, x) {                                // Catmull–Rom through [x, y] keys
  let i = 0; while (i < keys.length - 2 && x > keys[i + 1][0]) i++;
  const p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(keys.length - 1, i + 2)];
  const h = p2[0] - p1[0], u = (x - p1[0]) / h, m1 = (p2[1] - p0[1]) / (p2[0] - p0[0]) * h, m2 = (p3[1] - p1[1]) / (p3[0] - p1[0]) * h, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2;
}
function footAngle(s) {                                // absolute foot angle (deg): heel strike, flat, push-off
  if (s < 0.15) return 8 * (1 - s / 0.15) ** 2;           // heel strike: foot lowers with speed, no slap spike
  if (s < 0.55) return 0;
  return -38 * smooth((s - 0.55) / 0.45);
}

// ---------- the model ----------
// q = [hip x, hip y, hip flexion, knee flexion, ankle dorsiflexion] (rad); L = segment lengths
export function fk(q, L) {
  const ht = q[2], ts = ht - q[3], tf = ts + q[4];
  const dt = [Math.sin(ht), -Math.cos(ht)], pt = [Math.cos(ht), Math.sin(ht)];
  const ds = [Math.sin(ts), -Math.cos(ts)], ps = [Math.cos(ts), Math.sin(ts)];
  const df = [Math.cos(tf), Math.sin(tf)], nf = [-Math.sin(tf), Math.cos(tf)];
  const add = (a, u, k, v = [0, 0], m = 0) => [a[0] + k * u[0] + m * v[0], a[1] + k * u[1] + m * v[1]];
  const hip = [q[0], q[1]], knee = add(hip, dt, L.t), ank = add(knee, ds, L.s);
  const heel = add(ank, df, -0.23 * L.f, nf, -0.3 * L.f), toe = add(heel, df, L.f);
  const mk = {
    ASI: [hip[0] + 0.09, hip[1] + 0.07], PSI: [hip[0] - 0.08, hip[1] + 0.09],
    THI: add(hip, dt, 0.55 * L.t, pt, 0.04), KNE: knee.slice(), TIB: add(knee, ds, 0.5 * L.s, ps, 0.03),
    ANK: ank.slice(), HEE: heel.slice(), TOE: toe.slice(),
  };
  return { hip, knee, ank, heel, toe, dt, ds, df, nf, pt, ps, mk, ang: [ht, ts, tf] };
}
export function truth(L = SUBJ) {                      // stance-phase running kinematics, foot rolls heel -> toe
  const HIP = [[0, 28], [0.5, 8], [1, -14]], KNEE = [[0, 18], [0.4, 42], [1, 14]], out = [];
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1), h = crs(HIP, s) * D2R, k = crs(KNEE, s) * D2R, phi = footAngle(s) * D2R;
    const q = [0, 0, h, k, phi - (h - k)], J = fk(q, L);
    if (phi > 0) { q[0] = -J.heel[0]; q[1] = -J.heel[1]; } else { q[0] = L.f - J.toe[0]; q[1] = -J.toe[1]; }
    out.push(q);
  }
  return out;
}
export function grf(s, o = {}) {                       // force-plate data: N and m (COP x, ground y = 0)
  const { mag = 1, hx = 1, cop = 0 } = o, BW = BM * G;
  const fz = mag * BW * (2.5 * Math.sin(Math.PI * s) + 0.9 * Math.exp(-(((s - 0.1) / 0.04) ** 2)));
  const fx = mag * hx * BW * -0.35 * Math.sin(2 * Math.PI * s);
  const cx = SUBJ.f * (0.05 + 0.75 * smooth(Math.min(1, s / 0.6))) + cop;
  return { f: [fx, fz], p: [cx, 0] };
}

// 1. Scaling: fit pose + three segment scale factors to a static trial, weighted markers
export function doScale(o) {
  const r = rng(11), qs = [0, 0.9, 5 * D2R, 8 * D2R, 3 * D2R], J = fk(qs, SUBJ);
  const exp = {}; for (const m of MK) exp[m] = [J.mk[m][0] + gauss(r) * o.noise / 1000, J.mk[m][1] + gauss(r) * o.noise / 1000];
  const mm = o.misM || "KNE", dir = { ASI: [0, 1], PSI: [0, 1], THI: J.dt.map((v) => -v), KNE: J.dt.map((v) => -v), TIB: J.ds.map((v) => -v), ANK: J.ds.map((v) => -v), HEE: J.df, TOE: J.df }[mm];
  exp[mm] = [exp[mm][0] + dir[0] * o.mis / 100, exp[mm][1] + dir[1] * o.mis / 100];   // marker stuck off its landmark (proximal / up / forward +)
  const Lof = (x) => ({ t: GEN.t * x[5], s: GEN.s * x[6], f: GEN.f * x[7] });
  const res = (x) => { const F = fk(x, Lof(x)), out = []; for (const m of MK) { const w = Math.sqrt(o.w[m]); out.push(w * (F.mk[m][0] - exp[m][0]), w * (F.mk[m][1] - exp[m][1])); } return out.concat(x.slice(5).map((v) => 1e-3 * (v - 1))); };
  const x = lm(res, [0, 0.88, 0, 0, 0, 1, 1, 1], 60), L = Lof(x), F = fk(x, L);
  const err = MK.map((m) => Math.hypot(F.mk[m][0] - exp[m][0], F.mk[m][1] - exp[m][1]));
  return { x, L, F, exp, err, poseErr: [x[2] - qs[2], x[3] - qs[3], x[4] - qs[4]] };
}
// 2. IK: per frame, weighted least squares of markers on the scaled model
export function doIK(L, o) {
  const r = rng(23), Q = truth(SUBJ), exp = [], q = [];
  let x = Q[0].slice();
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1), J = fk(Q[i], SUBJ), e = {};
    for (const m of MK) e[m] = [J.mk[m][0] + gauss(r) * o.noise / 1000, J.mk[m][1] + gauss(r) * o.noise / 1000];
    const sta = (o.sta / 100) * Math.sin(2 * Math.PI * s);          // soft tissue slides the thigh marker
    e.THI = [e.THI[0] + J.dt[0] * sta, e.THI[1] + J.dt[1] * sta];
    const res = (y) => { const F = fk(y, L), out = []; for (const m of MK) { const w = Math.sqrt(o.w[m]); out.push(w * (F.mk[m][0] - e[m][0]), w * (F.mk[m][1] - e[m][1])); } return out; };
    x = lm(res, x, 25); q.push(x.slice()); exp.push(e);
  }
  const err = q.map((y, i) => { const F = fk(y, L); return MK.map((m) => Math.hypot(F.mk[m][0] - exp[i][m][0], F.mk[m][1] - exp[i][m][1])); });
  return { q, Q, exp, err };
}
// 3. ID: Newton–Euler bottom-up (foot, shank, thigh). Moments in N·m: [hip ext, knee ext, ankle PF]
export function doID(q, L, o = {}) {
  const k = [1, 4, 6, 4, 1].map((v) => v / 16);         // zero-lag smoothing, 3 binomial passes (~10 Hz): marker noise is differentiated twice
  const pass = (a) => a.map((_, i) => a[0].map((__, d) => { let s = 0; for (let j = -2; j <= 2; j++) s += k[j + 2] * a[Math.min(N - 1, Math.max(0, i + j))][d]; return s; }));
  let sq = q; for (let k2 = 0; k2 < (o.passes ?? 3); k2++) sq = pass(sq);
  const segs = sq.map((y) => fk(y, L));
  const seg = [ // [proximal pt, distal pt, COM, angle index, mass frac, rg]
    (F) => [F.ank, null, [(F.heel[0] + F.toe[0]) / 2, (F.heel[1] + F.toe[1]) / 2], 2, 0.0145, 0.475, L.f],
    (F) => [F.knee, F.ank, [F.knee[0] + 0.433 * L.s * F.ds[0], F.knee[1] + 0.433 * L.s * F.ds[1]], 1, 0.0465, 0.302, L.s],
    (F) => [F.hip, F.knee, [F.hip[0] + 0.433 * L.t * F.dt[0], F.hip[1] + 0.433 * L.t * F.dt[1]], 0, 0.1, 0.323, L.t],
  ];
  const acc = (f, i) => { const a = Math.max(3, Math.min(N - 4, i)); /* hold edge values: clip ends are not real data */ return (f(a + 1) - 2 * f(a) + f(a - 1)) / (DT * DT); };
  const cr = (r, F) => r[0] * F[1] - r[1] * F[0], out = [];
  for (let i = 0; i < N; i++) {
    const g = grf(i / (N - 1), o);
    let Fd = g.f, Md = 0, Pd = g.p; const M = [];
    for (let b = 0; b < 3; b++) {
      const [pp, , c, ai, mf, rg, len] = seg[b](segs[i]), m = mf * BM, I = m * (rg * len) ** 2;
      const ax = o.inert === 0 ? 0 : acc((j) => seg[b](segs[j])[2][0], i), ay = o.inert === 0 ? 0 : acc((j) => seg[b](segs[j])[2][1], i);
      const al = o.inert === 0 ? 0 : acc((j) => segs[j].ang[ai], i);
      const Fp = [m * ax - Fd[0], m * ay + m * G - Fd[1]];
      const Mp = I * al - Md - cr([Pd[0] - c[0], Pd[1] - c[1]], Fd) - cr([pp[0] - c[0], pp[1] - c[1]], Fp);
      M.push(Mp); Fd = [-Fp[0], -Fp[1]]; Md = -Mp; Pd = pp;
    }
    out.push([-M[2], M[1], -M[0]]);                    // hip ext (CW on thigh), knee ext (CCW on shank), ankle PF (CW on foot)
  }
  return out;
}
// 4. SO: min sum a^p + sum reserve^p subject to moment balance, 0<=a<=1. Solved on the Lagrange multipliers.
export function doSO(mom, o) {
  const p = o.p, qe = 1 / (p - 1), cols = MUS.map((m, i) => m.r.map((r) => r * m.F * o.str / 100 * (o.w[m.n] / 100)));
  const R = o.res, act = (lam) => {
    const a = cols.map((c) => { const g = c[0] * lam[0] + c[1] * lam[1] + c[2] * lam[2]; return g <= 0 ? 0 : Math.min(1, (g / p) ** qe); });
    const rs = lam.map((l) => { const g = R * l; return Math.sign(g) * (Math.abs(g) / p) ** qe; });
    return { a, rs };
  };
  const resid = (lam, Mj) => { const { a, rs } = act(lam); return [0, 1, 2].map((j) => a.reduce((s, v, i) => s + v * cols[i][j], 0) + R * rs[j] - Mj[j]); };
  let lam = [0.002, 0.002, 0.002]; const out = [];
  for (const Mj of mom) {
    let r = resid(lam, Mj), f = Math.hypot(...r);
    for (let it = 0; it < 60 && f > 1e-6; it++) {
      const J = [0, 1, 2].map(() => [0, 0, 0]);
      for (let k = 0; k < 3; k++) { const l2 = lam.slice(), h = 1e-7 + 1e-5 * Math.abs(lam[k]); l2[k] += h; const r2 = resid(l2, Mj); for (let j = 0; j < 3; j++) J[j][k] = (r2[j] - r[j]) / h; }
      for (let j = 0; j < 3; j++) J[j][j] += 1e-9;
      const d = solve(J, r); let t = 1, ok = false;
      for (let ls = 0; ls < 30; ls++) { const ln = lam.map((v, k) => v - t * d[k]), rn = resid(ln, Mj), fn = Math.hypot(...rn); if (fn < f) { lam = ln; r = rn; f = fn; ok = true; break; } t /= 2; }
      if (!ok) break;
    }
    const { a, rs } = act(lam);
    out.push({ a, F: a.map((v, i) => v * MUS[i].F * o.str / 100 * (o.w[MUS[i].n] / 100)), res: rs.map((v) => v * R), cost: a.reduce((s, v) => s + v ** p, 0) + rs.reduce((s, v) => s + Math.abs(v) ** p, 0) });
  }
  return out;
}

// ---------- UI ----------
export function initRunMsk({ host, tr }) {
  const W1 = () => Object.fromEntries(MK.map((m) => [m, m === "THI" || m === "TIB" ? 1 : 10]));
  const S = {
    tab: "scale", fr: 25, play: false,
    scale: { w: W1(), mis: 0, misM: "KNE", noise: 1 },
    ik: { w: W1(), sta: 0, noise: 2 },
    id: { mag: 100, cop: 0, hx: 100, inert: 1 },
    so: { p: 2, str: 100, w: Object.fromEntries(MUS.map((m) => [m.n, 100])), res: 10, kn: 0, kf: 3 },
  };
  let R = null, raf = 0, last = 0;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  const f = (x, n = 1) => (Number.isFinite(x) ? x.toFixed(n) : "–");
  const deg = (x) => x / D2R;

  function compute() {
    const sc = doScale(S.scale), ik = doIK(sc.L, S.ik);
    const idO = { mag: S.id.mag / 100, cop: S.id.cop / 100, hx: S.id.hx / 100, inert: S.id.inert };
    const id = doID(ik.q, sc.L, idO), id0 = doID(ik.q, sc.L, {});
    const r = rng(37), qn = ik.q.map((y) => y.map((v, d) => (d < 2 ? v + gauss(r) * S.so.kn / 1000 : v + gauss(r) * S.so.kn * D2R)));   // kn: deg on angles, mm on pelvis
    const so = doSO(doID(qn, sc.L, { ...idO, passes: S.so.kf }), S.so);
    R = { sc, ik, id, id0, so };
  }

  // ---- settings: four expandable sections on the left, each with its results and its sliders ----
  const TABS = ["scale", "ik", "id", "so"];
  const open = new Set(["so"]);
  const wSl = () => MK.map((m) => ["w." + m, 0, 20, 1, "", tr("rm_w") + " " + m]);
  const SL = {
    scale: () => [["#", tr("rm_secMis")], ["@misM"], ["mis", -4, 4, 0.5, "cm", tr("rm_knMis")], ["noise", 0, 10, 0.5, "mm", tr("rm_noise")], ["#", tr("rm_secW")], ...wSl()],
    ik: () => [["#", tr("rm_secErr")], ["sta", 0, 4, 0.25, "cm", tr("rm_sta")], ["noise", 0, 10, 0.5, "mm", tr("rm_noise")], ["#", tr("rm_secW")], ...wSl()],
    id: () => [["mag", 50, 150, 5, "%", tr("rm_grf")], ["hx", 0, 200, 10, "%", tr("rm_grfx")], ["cop", -6, 6, 0.5, "cm", tr("rm_cop")], ["inert", 0, 1, 1, "", tr("rm_inert")]],
    so: () => [["#", tr("rm_secKin")], ["kn", 0, 5, 0.25, "° / mm", tr("rm_kn")], ["kf", 0, 8, 1, "", tr("rm_kf")],
      ["#", tr("rm_secOpt")], ["p", 1.5, 4, 0.5, "", tr("rm_p")], ["res", 1, 100, 1, "N·m", tr("rm_res")],
      ["#", tr("rm_secStr")], ["str", 10, 500, 10, "%", tr("rm_str")], ...MUS.map((m) => ["w." + m.n, 10, 500, 10, "%", m.n])],
  };
  const get = (t, k) => (k.startsWith("w.") ? S[t].w[k.slice(2)] : S[t][k]);
  const set = (t, k, v) => { if (k.startsWith("w.")) S[t].w[k.slice(2)] = v; else S[t][k] = v; };

  function render() {
    const sec = (t) => `<details class="rmDet" data-sec="${t}"${open.has(t) ? " open" : ""}><summary>${tr("rm_s_" + t)}</summary>
      <div class="rmRes" id="rmOut_${t}"></div>
      ${SL[t]().map(([k, mn, mx, st, u, lab]) => k === "#" ? `<div class="rmSec">${mn}</div>${mn === tr("rm_secW") ? `<div class="rmAll"><input type="number" min="0" max="20" step="1" value="10" data-allv="${t}"><button type="button" class="ghost" data-all="${t}">${tr("rm_applyAll")}</button></div>` : ""}` :
        k === "@misM" ? `<label class="phSl">${tr("rm_misM")}<select data-rm>${MK.map((m) => `<option${S.scale.misM === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>` :
        `<div class="phSl"><span>${lab} <b data-rv="${t}:${k}">${get(t, k)}</b> ${u}</span><input type="range" min="${mn}" max="${mx}" step="${st}" value="${get(t, k)}" data-rk="${t}:${k}"></div>`).join("")}
      <p class="note">${tr("rm_n_" + t)}</p></details>`;
    host.innerHTML = `<div class="rmWrap rmRun"><div class="rmSide">${TABS.map(sec).join("")}</div>
      <div class="rmMain"><canvas class="phCv rmCv" id="rmCv"></canvas>
      <div class="rmLeg" id="rmLeg">${legend()}</div>
      <div class="row bfbRow"><button type="button" id="rmPlay">${tr(S.play ? "ph_pause" : "ph_play")}</button></div>
      <div class="phSl"><span>${tr("rm_frame")} <b data-rv="fr">${Math.round(S.fr)}</b></span><input type="range" min="0" max="${N - 1}" step="1" value="${Math.round(S.fr)}" data-rk="fr"></div>
      <p class="note">${tr("rm_legAll")}</p></div></div>`;
    draw();
  }
  const RES = ["Rh", "Rk", "Ra"], RCOL = ["#ff8a65", "#ffb74d", "#e57373"];
  const hide = new Set();
  const legend = () => MUS.map((m, i) => [m.n, MCOL[i]]).concat(RES.map((n, j) => [n, RCOL[j]])).map(([n, col]) =>
    `<button type="button" class="ghost${hide.has(n) ? " off" : ""}" data-mu="${n}"><i style="background:${col}"></i>${n}</button>`).join("") + `<span class="note">${tr("rm_legTap")}</span>`;
  function fit(cv) {
    const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1, w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext("2d"); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, r.width, r.height); return [c, r.width, r.height];
  }
  function plot(c, x0, y0, w, h, title, series, fr, unit) {
    const ink = css("--muted"), line = css("--line");
    let lo = Infinity, hi = -Infinity; for (const s of series) for (const v of s.v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo = Math.min(lo, 0); hi = Math.max(hi, 0); if (hi - lo < 1e-6) hi = lo + 1; const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const X = (i) => x0 + w * i / (N - 1), Y = (v) => y0 + h - h * (v - lo) / (hi - lo);
    c.strokeStyle = line; c.lineWidth = 1; c.strokeRect(x0, y0, w, h); c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x0 + w, Y(0)); c.stroke();
    for (const s of series) { c.setLineDash(s.dash ? [5, 4] : []); c.strokeStyle = s.col; c.lineWidth = s.lw || 2; c.beginPath(); s.v.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)))); c.stroke(); }
    c.setLineDash([]); c.strokeStyle = "#e76f51"; c.beginPath(); c.moveTo(X(fr), y0); c.lineTo(X(fr), y0 + h); c.stroke();
    c.fillStyle = ink; c.font = "11px system-ui"; c.fillText(`${title} (${unit})`, x0 + 4, y0 + 12);
    c.fillText(f(hi, 1), x0 + w - c.measureText(f(hi, 1)).width - 2, y0 + 12);
    c.fillText(f(lo, 1), x0 + w - c.measureText(f(lo, 1)).width - 2, y0 + h - 3);
  }
  function leg(c, F, X, Y, col, lw, dash) {
    c.setLineDash(dash ? [5, 4] : []); c.strokeStyle = col; c.lineWidth = lw; c.lineCap = "round"; c.lineJoin = "round";
    c.beginPath(); for (const [p, i] of [[F.hip, 0], [F.knee, 1], [F.ank, 1], [F.heel, 1], [F.toe, 1], [F.ank, 1]]) i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])); c.stroke();
    c.beginPath(); c.moveTo(X(F.mk.PSI[0]), Y(F.mk.PSI[1])); c.lineTo(X(F.hip[0]), Y(F.hip[1])); c.lineTo(X(F.mk.ASI[0]), Y(F.mk.ASI[1])); c.stroke(); c.setLineDash([]);
  }
  function marks(c, mk, X, Y, col, cross, names) {
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2;
    if (names) { c.font = "bold 11px system-ui"; for (const m of MK) { const x = X(mk[m][0]), y = Y(mk[m][1]), left = m === "PSI" || m === "HEE"; c.fillText(m, left ? x - 9 - c.measureText(m).width : x + 9, y - 6); } c.font = "11px system-ui"; }
    for (const m of MK) { const x = X(mk[m][0]), y = Y(mk[m][1]); if (cross) { c.beginPath(); c.moveTo(x - 4, y - 4); c.lineTo(x + 4, y + 4); c.moveTo(x + 4, y - 4); c.lineTo(x - 4, y + 4); c.stroke(); } else { c.beginPath(); c.arc(x, y, 3.5, 0, 7); c.fill(); } }
  }
  const gOpt = () => ({ mag: S.id.mag / 100, cop: S.id.cop / 100, hx: S.id.hx / 100 });

  // results shown inside each section (per-frame values update while playing)
  function results() {
    const fr = Math.round(S.fr), put = (t, rows) => { const o = host.querySelector("#rmOut_" + t); if (o) o.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join(""); };
    const { err, L } = R.sc, rms = Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length) * 1000;
    const pct = (a, b) => `${f(b * 100, 1)} → ${f(a * 100, 1)} cm (${(a > b ? "+" : "") + f((a / b - 1) * 100, 1)} %)`;
    put("scale", [[tr("rm_rms"), f(rms, 1) + " mm"], [tr("rm_markErr"), MK.map((m, i) => `${m} ${f(err[i] * 1000, 1)}`).join(" · ")],
      [tr("rm_lenT"), pct(L.t, SUBJ.t)], [tr("rm_lenS"), pct(L.s, SUBJ.s)], [tr("rm_lenF"), pct(L.f, SUBJ.f)],
      [tr("rm_poseErr"), R.sc.poseErr.map((v) => f(deg(v), 1) + "°").join(" · ")]]);
    const all = R.ik.err.flat(), irms = Math.sqrt(all.reduce((s, e) => s + e * e, 0) / all.length) * 1000;
    const ae = [2, 3, 4].map((d) => Math.sqrt(R.ik.q.reduce((s, y, i) => s + (y[d] - R.ik.Q[i][d]) ** 2, 0) / N) / D2R);
    const worst = MK[R.ik.err[0].map((_, m) => R.ik.err.reduce((s, e) => s + e[m] ** 2, 0)).reduce((b, v, i, a) => (v > a[b] ? i : b), 0)];
    put("ik", [[tr("rm_rms"), f(irms, 1) + " mm"], [tr("rm_worst"), worst], [tr("rm_angErr"), ae.map((v) => f(v, 1) + "°").join(" · ")]]);
    const g = grf(fr / (N - 1), gOpt()), Fm = fk(R.ik.q[fr], R.sc.L);
    const lev = (P) => { const n = Math.hypot(...g.f) || 1; return ((P[0] - g.p[0]) * g.f[1] - (P[1] - g.p[1]) * g.f[0]) / n; };
    const pk = [0, 1, 2].map((d) => R.id.reduce((b, m) => (Math.abs(m[d]) > Math.abs(b) ? m[d] : b), 0) / BM);
    put("id", [[tr("rm_mom"), pk.map((v) => f(v, 2)).join(" · ") + " N·m/kg"], [tr("rm_grfNow"), f(g.f[1] / (BM * G), 2) + " · " + f(g.f[0] / (BM * G), 2) + " BW"],
      [tr("rm_lever"), [Fm.hip, Fm.knee, Fm.ank].map((P) => f(lev(P) * 100, 1)).join(" · ") + " cm"]]);
    const so = R.so[fr], pkR = Math.max(...R.so.map((o) => Math.max(...o.res.map(Math.abs)))), mxA = Math.max(...R.so.map((o) => Math.max(...o.a)));
    const sumF = R.so.map((o) => o.F.reduce((s, v) => s + v, 0));
    put("so", [[tr("rm_maxAct"), f(mxA * 100, 0) + " %"], [tr("rm_resPk"), f(pkR, 1) + " N·m"], [tr("rm_sumF"), f(Math.max(...sumF) / (BM * G), 1) + " BW"], [tr("rm_cost"), f(so.cost, 3)]]);
  }

  // ---- one view: leg on the left; on the right, time-aligned from top: hip, knee, ankle (angle + moment, two axes), muscle forces + reserves, activation bars ----
  function axes(c, x0, y0, w, h, ser, side) {      // returns Y mapper for a set of series; draws its tick labels on one side
    let lo = Infinity, hi = -Infinity; for (const s of ser) for (const v of s.v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo = Math.min(lo, 0); hi = Math.max(hi, 0); if (hi - lo < 1e-6) hi = lo + 1; const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const Y = (v) => y0 + h - h * (v - lo) / (hi - lo);
    c.font = "11px system-ui"; c.fillStyle = ser[0].col;
    for (const v of [hi, (hi + lo) / 2, lo]) { const t = f(v, Math.abs(hi - lo) < 5 ? 1 : 0), tw = c.measureText(t).width; c.fillText(t, side < 0 ? x0 - tw - 4 : x0 + w + 4, Math.min(y0 + h, Math.max(y0 + 10, Y(v) + 4))); }
    return Y;
  }
  function panel(c, x0, y0, w, h, title, L, R, fr, stack) {
    const line = css("--line"), X = (i) => x0 + w * i / (N - 1);
    c.fillStyle = css("--card"); c.fillRect(x0, y0, w, h); c.strokeStyle = line; c.lineWidth = 1; c.strokeRect(x0, y0, w, h);
    for (let g = 1; g < 4; g++) { c.globalAlpha = 0.35; c.beginPath(); c.moveTo(x0 + w * g / 4, y0); c.lineTo(x0 + w * g / 4, y0 + h); c.stroke(); c.globalAlpha = 1; }
    const draw1 = (ser, Y) => { c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x0 + w, Y(0)); c.strokeStyle = line; c.stroke();
      for (const s of ser) { if (s.hide) continue; c.setLineDash(s.dash ? [6, 4] : []); c.strokeStyle = s.col; c.globalAlpha = s.dash ? 0.6 : 1; c.lineWidth = s.lw || 2.5; c.beginPath(); s.v.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)))); c.stroke(); }
      c.setLineDash([]); c.globalAlpha = 1; };
    if (L && L.s.length) draw1(L.s, axes(c, x0, y0, w, h, L.s, -1));
    if (R && R.s.length) {
      const Y = axes(c, x0, y0, w, h, R.s, 1);
      if (stack) {                                   // stacked contributions: positive parts up from 0, negative parts down
        const up = new Array(N).fill(0), dn = new Array(N).fill(0);
        for (const it of stack) for (const sign of [1, -1]) {
          const base = sign > 0 ? up : dn, top = it.v.map((v, i) => base[i] + (sign > 0 ? Math.max(v, 0) : Math.min(v, 0)));
          if (top.every((v, i) => Math.abs(v - base[i]) < 1e-9)) continue;
          c.fillStyle = it.col; c.globalAlpha = it.res ? 0.45 : 0.8; c.beginPath();
          top.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
          for (let i = N - 1; i >= 0; i--) c.lineTo(X(i), Y(base[i]));
          c.closePath(); c.fill(); c.globalAlpha = 1;
          for (let i = 0; i < N; i++) base[i] = top[i];
        }
      }
      draw1(R.s, Y);
    }
    c.strokeStyle = "#e76f51"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(fr), y0); c.lineTo(X(fr), y0 + h); c.stroke();
    c.font = "bold 12px system-ui"; c.fillStyle = css("--ink"); c.fillText(title, x0 + 6, y0 + 15);
    let tx = x0 + 12 + c.measureText(title).width; c.font = "11px system-ui";
    for (const a of [L, R]) if (a && a.lab) { c.fillStyle = a.s[0].col; c.fillText(a.lab, tx, y0 + 15); tx += c.measureText(a.lab).width + 10; }
  }
  function draw() {
    const cv = host.querySelector("#rmCv"); if (!cv || !R) return;
    const [c, W, H] = fit(cv), ink = css("--ink"), mut = css("--muted"), acc = css("--accent"), mom = "#f4a261", red = "#e76f51";
    const fr = Math.round(S.fr), narrow = true;   // one layout everywhere: leg on top, plots below (Bas prefers the phone view)
    const fw = narrow ? W : Math.min(250, W * 0.28), fh = narrow ? 300 : H;
    const px = narrow ? 44 : fw + 44, py = narrow ? fh + 8 : 6, pw = W - px - 44, ph = H - py - 4;
    // leg
    const sc = Math.min(fw / 1.25, (Math.min(fh, 520) - 20) / 1.15), X = (x) => fw * 0.55 + x * sc, Y = (y) => (narrow ? fh : Math.min(fh, 560)) - 10 - y * sc;
    c.strokeStyle = css("--line"); c.lineWidth = 1; c.beginPath(); c.moveTo(4, Y(0)); c.lineTo(fw - 4, Y(0)); c.stroke();
    const Fm = fk(R.ik.q[fr], R.sc.L), Ft = fk(R.ik.Q[fr], SUBJ), so = R.so[fr];
    const add = (a, u, k, v, m) => [a[0] + k * u[0] + m * v[0], a[1] + k * u[1] + m * v[1]], H0 = Fm.hip, Lt = R.sc.L.t, Ls = R.sc.L.s;
    const path = [
      [[H0[0] - 0.1, H0[1] + 0.02], add(H0, Fm.dt, 0.25 * Lt, Fm.pt, -0.04)], [[H0[0] + 0.06, H0[1] + 0.08], add(H0, Fm.dt, 0.12 * Lt, Fm.pt, 0.03)],
      [[H0[0] - 0.08, H0[1] - 0.02], add(Fm.knee, Fm.ds, 0.1 * Ls, Fm.ps, -0.03)], [[H0[0] + 0.07, H0[1] + 0.03], add(Fm.knee, Fm.ds, 0.06 * Ls, Fm.ps, 0.045)],
      [add(H0, Fm.dt, 0.4 * Lt, Fm.pt, 0.04), add(Fm.knee, Fm.ds, 0.06 * Ls, Fm.ps, 0.05)], [add(H0, Fm.dt, 0.95 * Lt, Fm.pt, -0.03), Fm.heel],
      [add(Fm.knee, Fm.ds, 0.4 * Ls, Fm.ps, -0.025), [Fm.heel[0] + 0.005, Fm.heel[1] + 0.01]], [add(Fm.knee, Fm.ds, 0.3 * Ls, Fm.ps, 0.025), add(Fm.ank, Fm.df, 0.3 * R.sc.L.f, Fm.nf, 0.01)],
    ];
    leg(c, Ft, X, Y, mut, 2, true); leg(c, Fm, X, Y, acc, 4);
    path.forEach(([a, b], i) => { if (hide.has(MUS[i].n)) return; c.strokeStyle = MCOL[i]; c.globalAlpha = 0.25 + 0.75 * so.a[i]; c.lineWidth = 2 + 7 * so.a[i]; c.beginPath(); c.moveTo(X(a[0]), Y(a[1])); c.lineTo(X(b[0]), Y(b[1])); c.stroke(); });
    c.globalAlpha = 1; marks(c, Fm.mk, X, Y, ink, false, true); marks(c, R.ik.exp[fr], X, Y, red, true);
    const g = grf(fr / (N - 1), gOpt()), k = 0.25 / (BM * G);
    c.strokeStyle = red; c.lineWidth = 3; c.beginPath(); c.moveTo(X(g.p[0]), Y(0)); c.lineTo(X(g.p[0] + g.f[0] * k), Y(g.f[1] * k)); c.stroke();
    c.fillStyle = red; c.beginPath(); c.arc(X(g.p[0]), Y(0), 4, 0, 7); c.fill();
    // right column, one shared time axis
    const gap = 8, jh = ph * 0.17, fhh = ph * 0.28, bh = ph - 3 * (jh + gap) - fhh - gap;
    const JN = [tr("rm_hip"), tr("rm_knee"), tr("rm_ankle")];
    // each muscle's moment = force x moment arm (+ the reserve), N·m/kg, stacked under the net moment
    const stk = [0, 1, 2].map((d) => {
      const items = MUS.map((m, i) => ({ n: m.n, col: MCOL[i], v: R.so.map((o) => o.F[i] * m.r[d] / BM) })).filter((it) => m0(it))
        .concat([{ n: RES[d], col: RCOL[d], res: true, v: R.so.map((o) => o.res[d] / BM) }]).filter((it) => !hide.has(it.n));
      return { items, pos: R.so.map((_, i) => items.reduce((s, it) => s + Math.max(0, it.v[i]), 0)), neg: R.so.map((_, i) => items.reduce((s, it) => s + Math.min(0, it.v[i]), 0)) };
    });
    function m0(it) { return it.v.some((v) => v !== 0); }
    for (let d = 0; d < 3; d++) {
      const y = py + d * (jh + gap);
      panel(c, px, y, pw, jh, JN[d],
        { lab: tr("rm_angAx"), s: [{ v: R.ik.q.map((q) => deg(q[d + 2])), col: acc }, { v: R.ik.Q.map((q) => deg(q[d + 2])), col: acc, dash: true }] },
        { lab: tr("rm_momAx"), s: [{ v: R.id.map((m) => m[d] / BM), col: mom, lw: 3 }, { v: R.id0.map((m) => m[d] / BM), col: mom, dash: true },
          { v: stk[d].pos, hide: true }, { v: stk[d].neg, hide: true }] }, fr, stk[d].items);
    }
    const fy = py + 3 * (jh + gap);
    const ms = MUS.map((m, i) => ({ n: m.n, v: R.so.map((o) => o.a[i] * 100), col: MCOL[i], lw: 2 })).filter((s) => !hide.has(s.n));
    panel(c, px, fy, pw, fhh, tr("rm_actLines"), ms.length ? { lab: "%", s: ms.concat([{ v: [100], hide: true }]) } : null, null, fr);
    // activation bars now
    const by = fy + fhh + gap, items = MUS.map((m, i) => [m.n, so.a[i] * 100, MCOL[i], "%"]).concat(RES.map((n, j) => [n, so.res[j], RCOL[j], "N·m"])).filter((it) => !hide.has(it[0]));
    c.fillStyle = css("--card"); c.fillRect(px, by, pw, bh); c.strokeStyle = css("--line"); c.strokeRect(px, by, pw, bh);
    c.font = "bold 12px system-ui"; c.fillStyle = ink; c.fillText(tr("rm_actTitle"), px + 6, by + 15);
    const bw = pw / Math.max(1, items.length), base = by + bh - 20, top = by + 34;
    items.forEach(([n, v, col, u], i) => {
      const x = px + i * bw + bw * 0.15, w = bw * 0.7, frac = u === "%" ? Math.min(1, v / 100) : Math.min(1, Math.abs(v) / 50), h = (base - top) * frac;
      c.fillStyle = col; c.globalAlpha = u === "%" ? 1 : 0.8; c.fillRect(x, base - h, w, h); c.globalAlpha = 1;
      c.font = "bold 11px system-ui"; c.fillStyle = ink; const lab = n, tw = c.measureText(lab).width; c.fillText(lab, x + w / 2 - tw / 2, by + bh - 6);
      c.font = "11px system-ui"; const vt = f(v, 0) + (u === "%" ? "" : ""), vw = c.measureText(vt).width; c.fillText(vt, x + w / 2 - vw / 2, base - h - 4);
    });
    results();
  }

  function loop(ts) {
    if (!S.play) { raf = 0; return; }
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
    S.fr = (S.fr + dt * (N - 1) / 2.5) % (N - 1);      // stance slowed 10x
    const sl = host.querySelector('[data-rk="fr"]'), o = host.querySelector('[data-rv="fr"]');
    if (sl) sl.value = Math.round(S.fr); if (o) o.textContent = Math.round(S.fr);
    draw(); raf = requestAnimationFrame(loop);
  }
  function play(on) { S.play = on; const b = host.querySelector("#rmPlay"); if (b) b.textContent = tr(on ? "ph_pause" : "ph_play"); if (on && !raf) { last = 0; raf = requestAnimationFrame(loop); } }

  host.addEventListener("click", (e) => {
    if (e.target.id === "rmPlay") { play(!S.play); return; }
    const mu = e.target.closest("[data-mu]"); if (mu) { const n = mu.dataset.mu; hide.has(n) ? hide.delete(n) : hide.add(n); mu.classList.toggle("off", hide.has(n)); draw(); return; }
    const all = e.target.closest("[data-all]"); if (all) {
      const t = all.dataset.all, v = Math.max(0, Math.min(20, +host.querySelector(`[data-allv="${t}"]`).value || 0));
      for (const m of MK) S[t].w[m] = v;
      for (const m of MK) { const sl = host.querySelector(`[data-rk="${t}:w.${m}"]`), o = host.querySelector(`[data-rv="${t}:w.${m}"]`); if (sl) sl.value = v; if (o) o.textContent = v; }
      compute(); draw();
    }
  });
  host.addEventListener("toggle", (e) => { const d = e.target.closest && e.target.closest("[data-sec]"); if (d) { d.open ? open.add(d.dataset.sec) : open.delete(d.dataset.sec); } }, true);
  host.addEventListener("input", (e) => {
    const key = e.target.dataset.rk; if (!key) return;
    const o = host.querySelector(`[data-rv="${key}"]`); if (o) o.textContent = e.target.value;
    if (key === "fr") { S.fr = +e.target.value; draw(); return; }
    const [t, k] = key.split(":"); set(t, k, +e.target.value); compute(); draw();
  });
  host.addEventListener("change", (e) => { if ("rm" in e.target.dataset) { S.scale.misM = e.target.value; compute(); draw(); } });

  return {
    show() { host.classList.remove("hidden"); if (!R) compute(); render(); },
    hide() { play(false); host.classList.add("hidden"); },
    draw,
  };
}
