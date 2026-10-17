/* Physics playground: four small interactive simulations that show basic
 * mechanics concepts used across BioScout (projectiles = jumps and throws,
 * spring-mass-damper = tendon / leg stiffness, pendulum = swinging limbs,
 * collisions = momentum and energy in impacts).
 *
 * Plain canvas, fixed-step integration (semi-implicit Euler, 1 ms), sliders
 * for the parameters, live numbers next to the analytical value where one
 * exists, so the user can see when the simple formula holds and when not.
 * initPhysics({ $, tr }) -> { open(), leave() }. */

import { butter, filtfilt, lfilter, lfilterZi, movingAverage } from "./proc_dsp.js";

const G_OPTS = { earth: 9.81, moon: 1.62, mars: 3.71 };

export const SIMS = ["proj", "spring", "pend", "multi", "coll", "filt", "robot"];

/** Projectile without drag: range, peak and flight time for v (m/s), angle (deg), g. */
export function projectile(v, deg, g, h0 = 0) {
  const a = deg * Math.PI / 180, vx = v * Math.cos(a), vy = v * Math.sin(a);
  const tf = (vy + Math.sqrt(vy * vy + 2 * g * h0)) / g;
  return { tf, range: vx * tf, peak: h0 + vy * vy / (2 * g), vx, vy };
}
/** Spring-mass-damper: natural frequency (Hz) and damping ratio. */
export function springInfo(m, k, b) {
  const wn = Math.sqrt(k / m);
  return { fn: wn / (2 * Math.PI), zeta: b / (2 * Math.sqrt(k * m)), T: 2 * Math.PI / wn };
}
/** N-link pendulum (equal point masses m, links l), angles from vertical: th'' from M th'' = f.
 *  M_ij = (n - max(i,j)) cos(th_i - th_j); f_i = -sum_j (n - max(i,j)) sin(th_i - th_j) w_j^2 - (n - i) (g/l) sin th_i. */
export function multiAcc(th, w, gl, damp = 0) {
  const n = th.length, M = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let i = 0; i < n; i++) {
    let f = -(n - i) * gl * Math.sin(th[i]) - damp * w[i];
    for (let j = 0; j < n; j++) { const c = n - Math.max(i, j), d = th[i] - th[j]; M[i][j] = c * Math.cos(d); f -= c * Math.sin(d) * w[j] * w[j]; }
    M[i][n] = f;
  }
  for (let k = 0; k < n; k++) {                    // Gaussian elimination with partial pivoting
    let p = k; for (let r = k + 1; r < n; r++) if (Math.abs(M[r][k]) > Math.abs(M[p][k])) p = r;
    [M[k], M[p]] = [M[p], M[k]];
    for (let r = k + 1; r < n; r++) { const q = M[r][k] / M[k][k]; for (let c = k; c <= n; c++) M[r][c] -= q * M[k][c]; }
  }
  const a = new Float64Array(n);
  for (let k = n - 1; k >= 0; k--) { let v = M[k][n]; for (let c = k + 1; c < n; c++) v -= M[k][c] * a[c]; a[k] = v / M[k][k]; }
  return a;
}
function multiRK4(st, dt, gl, damp) {
  const n = st.th.length, add = (x, k, h) => x.map((v, i) => v + h * k[i]);
  const k1t = st.w, k1w = multiAcc(st.th, st.w, gl, damp);
  const k2t = add(st.w, k1w, dt / 2), k2w = multiAcc(add(st.th, k1t, dt / 2), k2t, gl, damp);
  const k3t = add(st.w, k2w, dt / 2), k3w = multiAcc(add(st.th, k2t, dt / 2), k3t, gl, damp);
  const k4t = add(st.w, k3w, dt), k4w = multiAcc(add(st.th, k3t, dt), k4t, gl, damp);
  for (let i = 0; i < n; i++) {
    st.th[i] += dt / 6 * (k1t[i] + 2 * k2t[i] + 2 * k3t[i] + k4t[i]);
    st.w[i] += dt / 6 * (k1w[i] + 2 * k2w[i] + 2 * k3w[i] + k4w[i]);
  }
}
/** Total energy per unit (m l^2): kinetic + potential (zero at the pivot height). */
export function multiEnergy(th, w, gl) {
  const n = th.length; let T = 0, V = 0;
  for (let i = 0; i < n; i++) { V -= (n - i) * gl * Math.cos(th[i]); for (let j = 0; j < n; j++) T += 0.5 * (n - Math.max(i, j)) * Math.cos(th[i] - th[j]) * w[i] * w[j]; }
  return T + V;
}
/** Two-link planar arm (point masses at the link ends, angles from the +x axis, q2 relative). */
export function armIK(x, y, l1, l2, elbowUp = true) {
  const c2 = Math.max(-1, Math.min(1, (x * x + y * y - l1 * l1 - l2 * l2) / (2 * l1 * l2)));
  const q2 = (elbowUp ? 1 : -1) * Math.acos(c2);
  return [Math.atan2(y, x) - Math.atan2(l2 * Math.sin(q2), l1 + l2 * Math.cos(q2)), q2];
}
export function armFK(q, l1, l2) {
  const e = [l1 * Math.cos(q[0]), l1 * Math.sin(q[0])];
  return [e, [e[0] + l2 * Math.cos(q[0] + q[1]), e[1] + l2 * Math.sin(q[0] + q[1])]];
}
function armDyn(q, w, tau, m1, m2, l1, l2, g) {
  const c2 = Math.cos(q[1]), s2 = Math.sin(q[1]), h = m2 * l1 * l2 * s2;
  const M11 = (m1 + m2) * l1 * l1 + m2 * l2 * l2 + 2 * m2 * l1 * l2 * c2, M12 = m2 * l2 * l2 + m2 * l1 * l2 * c2, M22 = m2 * l2 * l2;
  const G1 = (m1 + m2) * g * l1 * Math.cos(q[0]) + m2 * g * l2 * Math.cos(q[0] + q[1]), G2 = m2 * g * l2 * Math.cos(q[0] + q[1]);
  const r1 = tau[0] + h * (2 * w[0] * w[1] + w[1] * w[1]) - G1, r2 = tau[1] - h * w[0] * w[0] - G2, det = M11 * M22 - M12 * M12;
  return [(M22 * r1 - M12 * r2) / det, (M11 * r2 - M12 * r1) / det, G1, G2];
}
/** 1D collision with restitution e: velocities after. */
export function collide(m1, v1, m2, v2, e) {
  const p = m1 * v1 + m2 * v2, M = m1 + m2;
  return { u1: (p + m2 * e * (v2 - v1)) / M, u2: (p + m1 * e * (v1 - v2)) / M };
}

export function initPhysics({ $, tr }) {
  const host = $("phHost"), tabs = $("phTabs");
  let sim = "proj", raf = 0, st = null, last = 0, running = false;
  const P = {
    proj: { v: 8, ang: 45, g: "earth", drag: 0, h0: 0, lock: { v: true, drag: true, h0: true, ang: false }, goal: "range" },
    spring: { m: 1, k: 40, b: 1, x0: 0.3 },
    pend: { L: 1, amp: 30, g: "earth" },
    coll: { m1: 2, v1: 3, m2: 1, v2: -1, e: 1 },
    multi: { n: 3, amp: 120, damp: 0, ghost: 0.001, L: 2 },
    robot: { kp: 60, kd: 10, grav: 1, comp: 1, mass: 1, tmax: 60, tx: 1.2, ty: 0.8 },
    filt: { f: 1, noise: 0.3, hf: 0.3, fc: 6, ord: 2, type: "zero" },
  };
  const SL = {
    proj: [["v", 1, 30, 0.5, "m/s", "ph_speed"], ["ang", 5, 85, 1, "°", "ph_angle"], ["drag", 0, 0.1, 0.005, "", "ph_drag"], ["h0", 0, 3, 0.1, "m", "ph_h0"]],
    spring: [["m", 0.2, 5, 0.1, "kg", "ph_mass"], ["k", 5, 200, 1, "N/m", "ph_stiff"], ["b", 0, 20, 0.1, "N·s/m", "ph_damp"], ["x0", 0.05, 0.5, 0.01, "m", "ph_x0"]],
    pend: [["L", 0.2, 3, 0.05, "m", "ph_len"], ["amp", 5, 170, 1, "°", "ph_amp"]],
    multi: [["n", 1, 15, 1, "", "ph_links"], ["amp", 0, 180, 1, "°", "ph_amp"], ["L", 0.5, 4, 0.1, "m", "ph_totLen"], ["damp", 0, 0.5, 0.01, "", "ph_damp"], ["ghost", 0, 1, 0.001, "°", "ph_ghost"]],
    robot: [["kp", 0, 200, 1, "N·m/rad", "ph_kp"], ["kd", 0, 40, 0.5, "N·m·s/rad", "ph_kd"], ["mass", 0.2, 5, 0.1, "kg", "ph_load"],
            ["grav", 0, 1, 1, "", "ph_gravOn"], ["comp", 0, 1, 1, "", "ph_comp"], ["tmax", 5, 200, 5, "N·m", "ph_tmax"]],
    filt: [["f", 0.5, 5, 0.1, "Hz", "ph_sigF"], ["noise", 0, 1, 0.05, "", "ph_noise"], ["hf", 0, 1, 0.05, "", "ph_hf"], ["fc", 0.5, 45, 0.5, "Hz", "ph_fc"], ["ord", 1, 4, 1, "", "ph_ord"]],
    coll: [["m1", 0.5, 10, 0.5, "kg", "ph_m1"], ["v1", -5, 5, 0.5, "m/s", "ph_v1"], ["m2", 0.5, 10, 0.5, "kg", "ph_m2"], ["v2", -5, 5, 0.5, "m/s", "ph_v2"], ["e", 0, 1, 0.05, "", "ph_e"]],
  };
  const gOf = (k) => G_OPTS[k] || 9.81;

  function renderTabs() {
    tabs.innerHTML = SIMS.map((s) => `<button type="button" class="ghost${s === sim ? " on" : ""}" data-sim="${s}">${tr("ph_t_" + s)}</button>`).join("");
  }
  function renderControls() {
    const p = P[sim];
    const gSel = "g" in p ? `<label>${tr("ph_g")}<select data-pg="g">${Object.keys(G_OPTS).map((k) => `<option value="${k}"${p.g === k ? " selected" : ""}>${tr("ph_g_" + k)} (${G_OPTS[k]} m/s²)</option>`).join("")}</select></label>` : "";
    const lockBox = (k) => (p.lock ? ` <label class="phLock" title="${tr("ph_lockT")}"><input type="checkbox" data-lock="${k}"${p.lock[k] ? " checked" : ""}> 🔒</label>` : "");
    const opt = p.lock ? `<div class="phOpt"><label>${tr("ph_goal")}<select data-goal>${["range", "peak", "tf"].map((g) => `<option value="${g}"${p.goal === g ? " selected" : ""}>${tr("ph_goal_" + g)}</option>`).join("")}</select></label>
      <button type="button" id="phOptBtn">${tr("ph_findOpt")}</button><span class="note" id="phOptOut"></span></div>` : "";
    const fSel = sim === "filt" ? `<label>${tr("ph_ftype")}<select data-pf>${["zero", "causal", "ma", "high"].map((k) => `<option value="${k}"${p.type === k ? " selected" : ""}>${tr("ph_ft_" + k)}</option>`).join("")}</select></label>` : "";
    $("phCtl").innerHTML = fSel + SL[sim].map(([k, mn, mx, stp, u, lab]) =>
      `<div class="phSl"><span>${tr(lab)} <b data-pv="${k}">${p[k]}</b> ${u}${lockBox(k)}</span><input type="range" min="${mn}" max="${mx}" step="${stp}" value="${p[k]}" data-pk="${k}"></div>`).join("") + gSel + opt;
    $("phNote").textContent = tr("ph_n_" + sim);
  }
  function reset() {
    const p = P[sim];
    if (sim === "proj") { const a = projectile(p.v, p.ang, 9.81); st = { t: 0, x: 0, y: p.h0, vx: a.vx, vy: a.vy, path: [[0, p.h0]], done: false }; }
    if (sim === "spring") st = { t: 0, x: p.x0, v: 0, hist: [] };
    if (sim === "pend") st = { t: 0, th: p.amp * Math.PI / 180, w: 0, hist: [], cross: [], prevW: 0 };
    if (sim === "filt") st = { t: 0, ...filtData(p) };
    if (sim === "robot") st = { t: 0, q: [-0.3, 1.2], w: [0, 0], tau: [0, 0], path: [], err: [] };
    if (sim === "multi") {
      const mk = (off) => ({ th: Float64Array.from({ length: p.n }, (_, i) => (p.amp + (i === p.n - 1 ? off : 0)) * Math.PI / 180), w: new Float64Array(p.n) });
      st = { t: 0, a: mk(0), b: p.ghost > 0 ? mk(p.ghost) : null, trail: [], E0: NaN };
    }
    if (sim === "coll") st = { t: 0, x1: -1.2, x2: 0.6, v1: p.v1, v2: p.v2, hit: false, after: null };
    last = 0; draw();
  }
  function step(dt) {
    const p = P[sim];
    if (sim === "proj") {
      if (st.done) return;
      const g = gOf(p.g), sp = Math.hypot(st.vx, st.vy), k = p.drag;   // quadratic drag per unit mass
      st.vx += -k * sp * st.vx * dt; st.vy += (-g - k * sp * st.vy) * dt;
      st.x += st.vx * dt; st.y += st.vy * dt; st.t += dt;
      if (st.y < 0) { st.y = 0; st.done = true; }
      if (!st.path.length || st.t - (st.path.lastT || 0) > 0.02) { st.path.push([st.x, st.y]); st.path.lastT = st.t; }
    } else if (sim === "spring") {
      const a = (-p.k * st.x - p.b * st.v) / p.m; st.v += a * dt; st.x += st.v * dt; st.t += dt;
      if (!st.hist.length || st.t - st.hist[st.hist.length - 1][0] > 0.02) st.hist.push([st.t, st.x]);
      while (st.hist.length && st.t - st.hist[0][0] > 10) st.hist.shift();
    } else if (sim === "pend") {
      const g = gOf(p.g), a = -(g / p.L) * Math.sin(st.th); st.w += a * dt; st.th += st.w * dt; st.t += dt;
      if (st.prevW > 0 && st.w <= 0) st.cross.push(st.t); st.prevW = st.w;   // turning points, one per period on this side
      if (!st.hist.length || st.t - st.hist[st.hist.length - 1][0] > 0.02) st.hist.push([st.t, st.th]);
      while (st.hist.length && st.t - st.hist[0][0] > 10) st.hist.shift();
    } else if (sim === "robot") {
      const l1 = 1, l2 = 0.8, qd = armIK(p.tx, p.ty, l1, l2), g = p.grav ? 9.81 : 0;
      const G = armDyn(st.q, st.w, [0, 0], 1, p.mass, l1, l2, g).slice(2);
      const lim = (v) => Math.max(-p.tmax, Math.min(p.tmax, v));
      st.tau = [0, 1].map((i) => lim(p.kp * (qd[i] - st.q[i]) - p.kd * st.w[i] + (p.comp ? G[i] : 0)));
      const a = armDyn(st.q, st.w, st.tau, 1, p.mass, l1, l2, g);
      for (let i = 0; i < 2; i++) { st.w[i] += a[i] * dt; st.w[i] *= 0.9995; st.q[i] += st.w[i] * dt; }
      st.t += dt;
    } else if (sim === "multi") {
      const gl = 9.81 / (p.L / p.n);
      multiRK4(st.a, dt, gl, p.damp); if (st.b) multiRK4(st.b, dt, gl, p.damp); st.t += dt;
    } else if (sim === "filt") {
      st.t += dt; if (st.t > 1) { Object.assign(st, filtData(p)); st.t = 0; }   // new noise every second while playing
    } else if (sim === "coll") {
      st.x1 += st.v1 * dt; st.x2 += st.v2 * dt; st.t += dt;
      if (!st.hit && st.x2 - st.x1 <= 0 && st.v1 > st.v2) {          // block 1 right face meets block 2 left face
        const r = collide(p.m1, st.v1, p.m2, st.v2, p.e); st.v1 = r.u1; st.v2 = r.u2; st.hit = true; st.after = r;
      }
    }
  }
  /* Whole flight with drag, no drawing: range, peak and flight time. */
  function flight(q) {
    const g = gOf(q.g), a = q.ang * Math.PI / 180, dt = 0.002;
    let x = 0, y = q.h0, vx = q.v * Math.cos(a), vy = q.v * Math.sin(a), t = 0, peak = y;
    while (t < 30) {
      const sp = Math.hypot(vx, vy); vx += -q.drag * sp * vx * dt; vy += (-g - q.drag * sp * vy) * dt;
      x += vx * dt; y += vy * dt; t += dt; if (y > peak) peak = y; if (y < 0) break;
    }
    return { range: x, peak, tf: t };
  }
  /* Find optimal: grid search over the unlocked sliders (within their ranges),
   * then a finer pass around the best point. Locked sliders keep their value. */
  function optimise() {
    const p = P.proj, free = SL.proj.filter(([k]) => !p.lock[k]);
    if (!free.length) { $("phOptOut").textContent = tr("ph_optNone"); return; }
    const n = free.length === 1 ? 81 : free.length === 2 ? 31 : 13;
    let best = null, bestV = -Infinity;
    const search = (lo, hi) => {
      const rec = (i, q) => {
        if (i === free.length) { const v = flight(q)[p.goal]; if (v > bestV) { bestV = v; best = { ...q }; } return; }
        const [k] = free[i];
        for (let j = 0; j < n; j++) rec(i + 1, { ...q, [k]: lo[k] + (hi[k] - lo[k]) * j / (n - 1) });
      };
      rec(0, { ...p });
    };
    const lo = {}, hi = {}; for (const [k, mn, mx] of free) { lo[k] = mn; hi[k] = mx; }
    search(lo, hi);
    for (const [k, mn, mx] of free) { const w = (mx - mn) / (n - 1); lo[k] = Math.max(mn, best[k] - w); hi[k] = Math.min(mx, best[k] + w); }
    search(lo, hi);
    for (const [k, , , stp] of free) p[k] = +(Math.round(best[k] / stp) * stp).toFixed(3);
    renderControls();
    const u = { range: "m", peak: "m", tf: "s" }[p.goal];
    $("phOptOut").textContent = tr("ph_optRes", { what: free.map(([k, , , , un, lab]) => `${tr(lab)} ${p[k]}${un ? " " + un : ""}`).join(", "), val: bestV.toFixed(2) + " " + u });
    reset(); play(true);
  }
  /* Signal filtering: 4 s at 200 Hz of a slow "movement" sine + white noise +
   * a 25 Hz component (vibration / soft-tissue artefact), filtered four ways. */
  const FS = 200;
  function filtData(p) {
    const n = 4 * FS, clean = new Float64Array(n), raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / FS; clean[i] = Math.sin(2 * Math.PI * p.f * t);
      raw[i] = clean[i] + p.hf * Math.sin(2 * Math.PI * 25 * t) + p.noise * (Math.random() * 2 - 1) * 1.2;
    }
    const order = 2 * p.ord, wn = Math.min(0.99, p.fc / (FS / 2));
    let out, b = null, a = null;
    try {
      if (p.type === "ma") out = movingAverage(raw, Math.max(1, Math.round(FS / p.fc)));
      else {
        ({ b, a } = butter(p.type === "zero" ? Math.max(1, order / 2) : order, wn, p.type === "high" ? "high" : "low"));
        out = p.type === "causal" ? lfilter(b, a, raw, lfilterZi(b, a).map((v) => v * raw[0])) : filtfilt(b, a, raw);
      }
    } catch { out = raw.slice(); }
    return { clean, raw, out: Float64Array.from(out), b, a };
  }
  /** |H(f)| of b/a at frequency f (Hz), squared for the zero-lag (forward-backward) filter. */
  function gainAt(b, a, f, twice) {
    const w = 2 * Math.PI * f / FS; let nr = 0, ni = 0, dr = 0, di = 0;
    b.forEach((c, k) => { nr += c * Math.cos(w * k); ni -= c * Math.sin(w * k); });
    a.forEach((c, k) => { dr += c * Math.cos(w * k); di -= c * Math.sin(w * k); });
    const g = Math.hypot(nr, ni) / Math.hypot(dr, di); return twice ? g * g : g;
  }
  function fit(cv) {
    const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext("2d"); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, r.width, r.height); return [c, r.width, r.height];
  }
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  function trace(c, pts, X, Y, col, w = 2) { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); pts.forEach(([a, b], i) => (i ? c.lineTo(X(a), Y(b)) : c.moveTo(X(a), Y(b)))); c.stroke(); }
  function info(rows) { $("phOut").innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join(""); }
  const f2 = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : "–");

  function draw() {
    const [c, W, H] = fit($("phCv")), p = P[sim], ink = css("--ink"), mut = css("--muted"), acc = css("--accent"), line = css("--line");
    c.font = "12px system-ui"; c.fillStyle = mut;
    if (sim === "proj") {
      const g = gOf(p.g), an = projectile(p.v, p.ang, g, p.h0);
      const span = Math.max(an.range, 2 * an.peak, 1) * 1.1, sc = Math.min((W - 40) / span, (H - 40) / Math.max(an.peak * 1.25, span * 0.3));
      const X = (x) => 20 + x * sc, Y = (y) => H - 20 - y * sc;
      c.strokeStyle = line; c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke();
      const ideal = []; for (let i = 0; i <= 60; i++) { const t = an.tf * i / 60; ideal.push([an.vx * t, p.h0 + an.vy * t - g * t * t / 2]); }
      c.setLineDash([5, 5]); trace(c, ideal, X, Y, mut, 1.5); c.setLineDash([]);
      trace(c, st.path.concat([[st.x, st.y]]), X, Y, acc, 3);
      c.fillStyle = ink; c.beginPath(); c.arc(X(st.x), Y(st.y), 7, 0, 7); c.fill();
      c.fillStyle = mut; c.fillText(tr("ph_dashed"), 24, 16);
      info([[tr("ph_range"), f2(an.range) + " m"], [tr("ph_peak"), f2(an.peak) + " m"], [tr("ph_tflight"), f2(an.tf) + " s"],
            [tr("ph_now"), `x ${f2(st.x)} m · y ${f2(st.y)} m · t ${f2(st.t)} s`]]);
    } else if (sim === "spring") {
      const s = springInfo(p.m, p.k, p.b), mid = W * 0.18, Y0 = 30, scale = (H * 0.5) / 0.6;
      const by = Y0 + H * 0.3 + st.x * scale;                // mass position (down = +)
      c.strokeStyle = ink; c.lineWidth = 2; c.beginPath(); c.moveTo(mid - 30, Y0); c.lineTo(mid + 30, Y0); c.stroke();
      c.beginPath(); c.moveTo(mid, Y0); const n = 12;
      for (let i = 1; i < n; i++) c.lineTo(mid + (i % 2 ? 12 : -12), Y0 + (by - 20 - Y0) * i / n); c.lineTo(mid, by - 20); c.stroke();
      const sz = 24 + 10 * Math.cbrt(p.m); c.fillStyle = acc; c.fillRect(mid - sz / 2, by - 20, sz, sz);
      const px0 = W * 0.36, X = (t) => px0 + (W - px0 - 10) * (t - Math.max(0, st.t - 10)) / 10, Yp = (x) => H / 2 + x * (H * 0.4) / 0.5;
      c.strokeStyle = line; c.beginPath(); c.moveTo(px0, H / 2); c.lineTo(W, H / 2); c.stroke();
      trace(c, st.hist, X, Yp, acc, 2);
      if (p.b > 0 && s.zeta < 1) {                           // decay envelope x0 e^(-zeta wn t)
        const env = st.hist.map(([t]) => [t, p.x0 * Math.exp(-s.zeta * 2 * Math.PI * s.fn * t)]);
        c.setLineDash([4, 4]); trace(c, env, X, Yp, mut, 1); trace(c, env.map(([t, v]) => [t, -v]), X, Yp, mut, 1); c.setLineDash([]);
      }
      c.fillStyle = mut; c.fillText("x(t)", px0 + 4, 16);
      const E = 0.5 * p.k * st.x * st.x + 0.5 * p.m * st.v * st.v;
      info([[tr("ph_fn"), f2(s.fn) + " Hz"], [tr("ph_period"), f2(s.T) + " s"], [tr("ph_zeta"), f2(s.zeta) + (s.zeta < 1 ? " " + tr("ph_under") : s.zeta === 1 ? "" : " " + tr("ph_over"))],
            [tr("ph_energy"), f2(E, 3) + " J"]]);
    } else if (sim === "pend") {
      const ox = W * 0.25, oy = 20, sc = (H - 60) / Math.max(p.L, 0.5), bx = ox + Math.sin(st.th) * p.L * sc, byy = oy + Math.cos(st.th) * p.L * sc;
      c.strokeStyle = ink; c.lineWidth = 2; c.beginPath(); c.moveTo(ox - 30, oy); c.lineTo(ox + 30, oy); c.moveTo(ox, oy); c.lineTo(bx, byy); c.stroke();
      c.fillStyle = acc; c.beginPath(); c.arc(bx, byy, 12, 0, 7); c.fill();
      const px0 = W * 0.5, X = (t) => px0 + (W - px0 - 10) * (t - Math.max(0, st.t - 10)) / 10, Yp = (a) => H / 2 - a * (H * 0.4) / Math.PI;
      c.strokeStyle = line; c.beginPath(); c.moveTo(px0, H / 2); c.lineTo(W, H / 2); c.stroke();
      trace(c, st.hist, X, Yp, acc, 2); c.fillStyle = mut; c.fillText("θ(t)", px0 + 4, 16);
      const g = gOf(p.g), Ts = 2 * Math.PI * Math.sqrt(p.L / g), cr = st.cross, Tm = cr.length > 1 ? cr[cr.length - 1] - cr[cr.length - 2] : NaN;
      info([[tr("ph_Tsmall"), f2(Ts) + " s"], [tr("ph_Tsim"), f2(Tm) + " s"], [tr("ph_diff"), Number.isFinite(Tm) ? f2((Tm / Ts - 1) * 100, 1) + " %" : "–"]]);
    } else if (sim === "robot") {
      const l1 = 1, l2 = 0.8, sc = Math.min(W, H * 1.6) / 4.4, ox = W / 2, oy = H * 0.62, X = (x) => ox + x * sc, Y = (y) => oy - y * sc;
      st.scale = { ox, oy, sc };
      c.strokeStyle = line; c.setLineDash([3, 5]); c.beginPath(); c.arc(ox, oy, (l1 + l2) * sc, 0, 7); c.stroke(); c.beginPath(); c.arc(ox, oy, (l1 - l2) * sc, 0, 7); c.stroke(); c.setLineDash([]);
      c.beginPath(); c.moveTo(0, oy + 30); c.lineTo(W, oy + 30); c.stroke();
      const qd = armIK(p.tx, p.ty, l1, l2), [ed, td] = armFK(qd, l1, l2), [e, tip] = armFK(st.q, l1, l2);
      c.strokeStyle = mut; c.setLineDash([6, 5]); c.lineWidth = 2; c.beginPath(); c.moveTo(ox, oy); c.lineTo(X(ed[0]), Y(ed[1])); c.lineTo(X(td[0]), Y(td[1])); c.stroke(); c.setLineDash([]);
      st.path.push([tip[0], tip[1]]); if (st.path.length > 300) st.path.shift();
      c.strokeStyle = "rgba(127,127,127,.4)"; c.lineWidth = 1; c.beginPath(); st.path.forEach(([a, b], i) => (i ? c.lineTo(X(a), Y(b)) : c.moveTo(X(a), Y(b)))); c.stroke();
      c.fillStyle = ink; c.fillRect(ox - 22, oy, 44, 30);
      c.lineCap = "round"; c.strokeStyle = acc; c.lineWidth = 12; c.beginPath(); c.moveTo(ox, oy); c.lineTo(X(e[0]), Y(e[1])); c.stroke();
      c.strokeStyle = css("--muted"); c.lineWidth = 9; c.beginPath(); c.moveTo(X(e[0]), Y(e[1])); c.lineTo(X(tip[0]), Y(tip[1])); c.stroke();
      for (const [a, b, r] of [[0, 0, 8], [e[0], e[1], 7], [tip[0], tip[1], 6 + 3 * p.mass]]) { c.fillStyle = ink; c.beginPath(); c.arc(X(a), Y(b), r, 0, 7); c.fill(); }
      c.strokeStyle = "#e76f51"; c.lineWidth = 2; c.beginPath(); c.arc(X(p.tx), Y(p.ty), 9, 0, 7); c.moveTo(X(p.tx) - 13, Y(p.ty)); c.lineTo(X(p.tx) + 13, Y(p.ty)); c.moveTo(X(p.tx), Y(p.ty) - 13); c.lineTo(X(p.tx), Y(p.ty) + 13); c.stroke();
      // end-effector frame: x axis along link 2, rotation matrix R(q1+q2)
      const ang = st.q[0] + st.q[1], ca = Math.cos(ang), sa = Math.sin(ang);
      c.strokeStyle = "#e76f51"; c.lineWidth = 2; c.beginPath(); c.moveTo(X(tip[0]), Y(tip[1])); c.lineTo(X(tip[0]) + 30 * ca, Y(tip[1]) - 30 * sa); c.stroke();
      c.strokeStyle = "#7ee787"; c.beginPath(); c.moveTo(X(tip[0]), Y(tip[1])); c.lineTo(X(tip[0]) - 30 * sa, Y(tip[1]) - 30 * ca); c.stroke();
      c.fillStyle = mut; c.fillText(tr("ph_robotTap"), 10, 16);
      c.font = "12px ui-monospace, monospace"; c.fillStyle = ink;
      c.fillText(`R(θ1+θ2) = [ ${f2(ca)} ${f2(-sa)} ]`, 10, H - 26); c.fillText(`            [ ${f2(sa)}  ${f2(ca)} ]`, 10, H - 10);
      const deg = (r) => Math.round(r * 180 / Math.PI) + "°", err = Math.hypot(tip[0] - p.tx, tip[1] - p.ty);
      info([[tr("ph_joints"), `θ1 ${deg(st.q[0])} · θ2 ${deg(st.q[1])}`], [tr("ph_target"), `θ1 ${deg(qd[0])} · θ2 ${deg(qd[1])}`],
            [tr("ph_tipErr"), f2(err * 100, 1) + " cm"], [tr("ph_torque"), `${f2(st.tau[0], 1)} · ${f2(st.tau[1], 1)} N·m`]]);
    } else if (sim === "multi") {
      const l = p.L / p.n, sc = (Math.min(W, H * 2) * 0.45) / p.L, ox = W / 2, oy = H / 2;
      const pts = (s2) => { const out = [[ox, oy]]; let x = ox, y = oy; for (const t of s2.th) { x += Math.sin(t) * l * sc; y += Math.cos(t) * l * sc; out.push([x, y]); } return out; };
      c.strokeStyle = line; c.lineWidth = 2; c.beginPath(); c.moveTo(ox - 40, oy); c.lineTo(ox + 40, oy); c.stroke();
      const A = pts(st.a), tip = A[A.length - 1];
      st.trail.push(tip); if (st.trail.length > 400) st.trail.shift();
      c.strokeStyle = "rgba(127,127,127,.35)"; c.lineWidth = 1; c.beginPath(); st.trail.forEach((q, i) => (i ? c.lineTo(...q) : c.moveTo(...q))); c.stroke();
      if (st.b) { const B = pts(st.b); c.strokeStyle = "rgba(160,160,160,.45)"; c.lineWidth = 2; c.beginPath(); B.forEach((q, i) => (i ? c.lineTo(...q) : c.moveTo(...q))); c.stroke(); }
      for (let i = 1; i < A.length; i++) {
        c.strokeStyle = `hsl(${(i - 1) * 300 / Math.max(1, p.n - 1)}, 80%, 65%)`; c.lineWidth = 4; c.lineCap = "round";
        c.beginPath(); c.moveTo(...A[i - 1]); c.lineTo(...A[i]); c.stroke();
        c.fillStyle = ink; c.beginPath(); c.arc(A[i][0], A[i][1], 3.5, 0, 7); c.fill();
      }
      const gl = 9.81 / l, E = multiEnergy(st.a.th, st.a.w, gl); if (!Number.isFinite(st.E0)) st.E0 = E;
      let dev = NaN; if (st.b) { dev = 0; for (let i = 0; i < p.n; i++) { const d = st.a.th[i] - st.b.th[i]; dev = Math.max(dev, Math.abs(Math.atan2(Math.sin(d), Math.cos(d)))); } }
      info([[tr("ph_links"), String(p.n)], [tr("ph_time"), f2(st.t, 1) + " s"], [tr("ph_eDrift"), Number.isFinite(st.E0) && st.E0 !== 0 ? f2((E - st.E0) / Math.abs(st.E0) * 100, 2) + " %" : "–"],
            [tr("ph_split"), st.b ? f2(dev * 180 / Math.PI, 1) + "°" : "–"]]);
    } else if (sim === "filt") {
      const n = st.raw.length, h1 = H * 0.66, X = (i) => 40 + (W - 50) * i / (n - 1), Y = (v) => h1 / 2 - v * (h1 / 2 - 12) / 2.2;
      c.strokeStyle = line; c.beginPath(); c.moveTo(40, Y(0)); c.lineTo(W, Y(0)); c.stroke();
      const tr2 = (arr, col, w, dash) => { c.setLineDash(dash || []); c.strokeStyle = col; c.lineWidth = w; c.beginPath(); for (let i = 0; i < n; i++) i ? c.lineTo(X(i), Y(arr[i])) : c.moveTo(X(i), Y(arr[i])); c.stroke(); c.setLineDash([]); };
      tr2(st.raw, "rgba(150,150,150,.55)", 1); tr2(st.clean, mut, 1.5, [5, 4]); tr2(st.out, acc, 2.5);
      c.fillStyle = mut; c.fillText(`${tr("ph_raw")} · ${tr("ph_clean")} (- -) · ${tr("ph_filtered")}`, 44, 14);
      // frequency response
      const y0 = h1 + 14, hh = H - y0 - 16, fmax = 50, XF = (f) => 40 + (W - 50) * f / fmax, YG = (g) => y0 + hh * (1 - Math.min(1.1, g) / 1.1);
      c.strokeStyle = line; c.beginPath(); c.moveTo(40, YG(0)); c.lineTo(W, YG(0)); c.moveTo(40, YG(1)); c.lineTo(W, YG(1)); c.stroke();
      c.fillStyle = mut; c.fillText(tr("ph_gain"), 4, y0 + 10); c.fillText("0", 36, H - 2); c.fillText("50 Hz", W - 40, H - 2);
      c.strokeStyle = acc; c.lineWidth = 2; c.beginPath();
      for (let f = 0; f <= fmax; f += 0.25) {
        let g;
        if (st.b) g = gainAt(st.b, st.a, f, p.type === "zero");
        else { const N = Math.max(1, Math.round(FS / p.fc)), w = Math.PI * f / FS; g = f === 0 ? 1 : Math.abs(Math.sin(N * w) / (N * Math.sin(w))); }
        f ? c.lineTo(XF(f), YG(g)) : c.moveTo(XF(f), YG(g));
      }
      c.stroke();
      for (const [f, lab] of [[p.f, "sig"], [25, "25 Hz"], [p.fc, "fc"]]) { c.strokeStyle = lab === "fc" ? "#e76f51" : mut; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(XF(f), y0); c.lineTo(XF(f), YG(0)); c.stroke(); c.setLineDash([]); c.fillStyle = mut; c.fillText(lab, XF(f) + 2, y0 + 10); }
      // numbers: error vs the clean signal, and lag of the filtered signal (cross-correlation)
      let se = 0, sr = 0; for (let i = 40; i < n - 40; i++) { se += (st.out[i] - st.clean[i]) ** 2; sr += (st.raw[i] - st.clean[i]) ** 2; }
      let best = 0, lag = 0; for (let L = -40; L <= 40; L++) { let s2 = 0; for (let i = 60; i < n - 60; i++) s2 += st.clean[i] * st.out[i + L]; if (s2 > best) { best = s2; lag = L; } }
      let num = 0, den = 0; for (let i = 60; i < n - 60; i++) { num += st.clean[i] * st.out[i + lag]; den += st.clean[i] ** 2; } const amp = num / den;   // movement amplitude kept (lag-aligned)
      info([[tr("ph_rmseRaw"), f2(Math.sqrt(sr / (n - 80)), 3)], [tr("ph_rmseFilt"), f2(Math.sqrt(se / (n - 80)), 3)],
            [tr("ph_lag"), Math.round(lag * 1000 / FS) + " ms"], [tr("ph_peakAmp"), f2(amp * 100, 0) + " %"]]);
    } else if (sim === "coll") {
      const X = (x) => W / 2 + x * (W / 5), y = H * 0.55;
      c.strokeStyle = line; c.beginPath(); c.moveTo(0, y + 30); c.lineTo(W, y + 30); c.stroke();
      const s1 = 24 + 14 * Math.cbrt(p.m1), s2 = 24 + 14 * Math.cbrt(p.m2);
      c.fillStyle = acc; c.fillRect(X(st.x1) - s1, y + 30 - s1, s1, s1);
      c.fillStyle = css("--muted"); c.fillRect(X(st.x2), y + 30 - s2, s2, s2);
      const p0 = p.m1 * p.v1 + p.m2 * p.v2, e0 = 0.5 * p.m1 * p.v1 ** 2 + 0.5 * p.m2 * p.v2 ** 2;
      const p1 = p.m1 * st.v1 + p.m2 * st.v2, e1 = 0.5 * p.m1 * st.v1 ** 2 + 0.5 * p.m2 * st.v2 ** 2;
      info([[tr("ph_mom"), `${f2(p0)} → ${f2(p1)} kg·m/s`], [tr("ph_ke"), `${f2(e0)} → ${f2(e1)} J`],
            [tr("ph_vel"), `v1 ${f2(st.v1)} · v2 ${f2(st.v2)} m/s`], [tr("ph_lost"), e0 > 0 ? f2((1 - e1 / e0) * 100, 0) + " %" : "–"]]);
      if (Math.abs(st.x1) > 6 && Math.abs(st.x2) > 6) running = false;
    }
  }
  function loop(ts) {
    if (!running) { raf = 0; return; }
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0; last = ts;
    for (let i = 0; i < Math.round(dt / 0.001); i++) step(0.001);
    draw(); raf = requestAnimationFrame(loop);
  }
  function play(on) {
    running = on; $("phPlay").textContent = tr(on ? "ph_pause" : "ph_play");
    if (on && !raf) { last = 0; raf = requestAnimationFrame(loop); }
  }
  function select(s) { sim = s; play(false); renderTabs(); renderControls(); reset(); }

  $("phCv").addEventListener("pointerdown", (e) => {
    if (sim !== "robot" || !st || !st.scale) return;
    const r = $("phCv").getBoundingClientRect(), { ox, oy, sc } = st.scale;
    let x = (e.clientX - r.left - ox) / sc, y = (oy - (e.clientY - r.top)) / sc;
    const d = Math.hypot(x, y), mx = 1.79, mn = 0.21; if (d > mx) { x *= mx / d; y *= mx / d; } if (d < mn && d > 0) { x *= mn / d; y *= mn / d; }
    P.robot.tx = x; P.robot.ty = y; if (!running) play(true);
  });
  tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-sim]"); if (b) select(b.dataset.sim); });
  $("phCtl").addEventListener("input", (e) => {
    const k = e.target.dataset.pk; if (!k) return;
    if ($("phOptOut")) $("phOptOut").textContent = "";
    P[sim][k] = +e.target.value; const o = $("phCtl").querySelector(`[data-pv="${k}"]`); if (o) o.textContent = e.target.value;
    reset();
  });
  $("phCtl").addEventListener("change", (e) => {
    if (e.target.dataset.pg) { P[sim].g = e.target.value; reset(); }
    if ("pf" in e.target.dataset) { P[sim].type = e.target.value; reset(); }
    if (e.target.dataset.lock) P[sim].lock[e.target.dataset.lock] = e.target.checked;
    if ("goal" in e.target.dataset) P[sim].goal = e.target.value;
  });
  $("phCtl").addEventListener("click", (e) => { if (e.target.id === "phOptBtn") optimise(); });
  $("phPlay").onclick = () => { if (sim === "proj" && st.done) reset(); play(!running); };
  $("phReset").onclick = () => { play(false); reset(); };
  window.addEventListener("resize", () => { if (!$("viewPhysics").classList.contains("hidden")) draw(); });

  return {
    open() { renderTabs(); renderControls(); reset(); },
    leave() { play(false); },
  };
}
