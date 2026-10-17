/* Physics playground: four small interactive simulations that show basic
 * mechanics concepts used across BioScout (projectiles = jumps and throws,
 * spring-mass-damper = tendon / leg stiffness, pendulum = swinging limbs,
 * collisions = momentum and energy in impacts).
 *
 * Plain canvas, fixed-step integration (semi-implicit Euler, 1 ms), sliders
 * for the parameters, live numbers next to the analytical value where one
 * exists, so the user can see when the simple formula holds and when not.
 * initPhysics({ $, tr }) -> { open(), leave() }. */

const G_OPTS = { earth: 9.81, moon: 1.62, mars: 3.71 };

export const SIMS = ["proj", "spring", "pend", "coll"];

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
/** 1D collision with restitution e: velocities after. */
export function collide(m1, v1, m2, v2, e) {
  const p = m1 * v1 + m2 * v2, M = m1 + m2;
  return { u1: (p + m2 * e * (v2 - v1)) / M, u2: (p + m1 * e * (v1 - v2)) / M };
}

export function initPhysics({ $, tr }) {
  const host = $("phHost"), tabs = $("phTabs");
  let sim = "proj", raf = 0, st = null, last = 0, running = false;
  const P = {
    proj: { v: 8, ang: 45, g: "earth", drag: 0 },
    spring: { m: 1, k: 40, b: 1, x0: 0.3 },
    pend: { L: 1, amp: 30, g: "earth" },
    coll: { m1: 2, v1: 3, m2: 1, v2: -1, e: 1 },
  };
  const SL = {
    proj: [["v", 1, 30, 0.5, "m/s", "ph_speed"], ["ang", 5, 85, 1, "°", "ph_angle"], ["drag", 0, 0.1, 0.005, "", "ph_drag"]],
    spring: [["m", 0.2, 5, 0.1, "kg", "ph_mass"], ["k", 5, 200, 1, "N/m", "ph_stiff"], ["b", 0, 20, 0.1, "N·s/m", "ph_damp"], ["x0", 0.05, 0.5, 0.01, "m", "ph_x0"]],
    pend: [["L", 0.2, 3, 0.05, "m", "ph_len"], ["amp", 5, 170, 1, "°", "ph_amp"]],
    coll: [["m1", 0.5, 10, 0.5, "kg", "ph_m1"], ["v1", -5, 5, 0.5, "m/s", "ph_v1"], ["m2", 0.5, 10, 0.5, "kg", "ph_m2"], ["v2", -5, 5, 0.5, "m/s", "ph_v2"], ["e", 0, 1, 0.05, "", "ph_e"]],
  };
  const gOf = (k) => G_OPTS[k] || 9.81;

  function renderTabs() {
    tabs.innerHTML = SIMS.map((s) => `<button type="button" class="ghost${s === sim ? " on" : ""}" data-sim="${s}">${tr("ph_t_" + s)}</button>`).join("");
  }
  function renderControls() {
    const p = P[sim];
    const gSel = "g" in p ? `<label>${tr("ph_g")}<select data-pg="g">${Object.keys(G_OPTS).map((k) => `<option value="${k}"${p.g === k ? " selected" : ""}>${tr("ph_g_" + k)} (${G_OPTS[k]} m/s²)</option>`).join("")}</select></label>` : "";
    $("phCtl").innerHTML = SL[sim].map(([k, mn, mx, stp, u, lab]) =>
      `<label class="phSl"><span>${tr(lab)} <b data-pv="${k}">${p[k]}</b> ${u}</span><input type="range" min="${mn}" max="${mx}" step="${stp}" value="${p[k]}" data-pk="${k}"></label>`).join("") + gSel;
    $("phNote").textContent = tr("ph_n_" + sim);
  }
  function reset() {
    const p = P[sim];
    if (sim === "proj") st = { t: 0, x: 0, y: 0, vx: projectile(p.v, p.ang, 9.81).vx, vy: projectile(p.v, p.ang, 9.81).vy, path: [[0, 0]], done: false };
    if (sim === "spring") st = { t: 0, x: p.x0, v: 0, hist: [] };
    if (sim === "pend") st = { t: 0, th: p.amp * Math.PI / 180, w: 0, hist: [], cross: [], prevW: 0 };
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
    } else if (sim === "coll") {
      st.x1 += st.v1 * dt; st.x2 += st.v2 * dt; st.t += dt;
      if (!st.hit && st.x2 - st.x1 <= 0 && st.v1 > st.v2) {          // block 1 right face meets block 2 left face
        const r = collide(p.m1, st.v1, p.m2, st.v2, p.e); st.v1 = r.u1; st.v2 = r.u2; st.hit = true; st.after = r;
      }
    }
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
      const g = gOf(p.g), an = projectile(p.v, p.ang, g);
      const span = Math.max(an.range, 2 * an.peak, 1) * 1.1, sc = Math.min((W - 40) / span, (H - 40) / Math.max(an.peak * 1.25, span * 0.3));
      const X = (x) => 20 + x * sc, Y = (y) => H - 20 - y * sc;
      c.strokeStyle = line; c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke();
      const ideal = []; for (let i = 0; i <= 60; i++) { const t = an.tf * i / 60; ideal.push([an.vx * t, an.vy * t - g * t * t / 2]); }
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

  tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-sim]"); if (b) select(b.dataset.sim); });
  $("phCtl").addEventListener("input", (e) => {
    const k = e.target.dataset.pk; if (!k) return;
    P[sim][k] = +e.target.value; const o = $("phCtl").querySelector(`[data-pv="${k}"]`); if (o) o.textContent = e.target.value;
    reset();
  });
  $("phCtl").addEventListener("change", (e) => { if (e.target.dataset.pg) { P[sim].g = e.target.value; reset(); } });
  $("phPlay").onclick = () => { if (sim === "proj" && st.done) reset(); play(!running); };
  $("phReset").onclick = () => { play(false); reset(); };
  window.addEventListener("resize", () => { if (!$("viewPhysics").classList.contains("hidden")) draw(); });

  return {
    open() { renderTabs(); renderControls(); reset(); },
    leave() { play(false); },
  };
}
