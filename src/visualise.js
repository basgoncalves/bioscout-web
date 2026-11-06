// Visualise — load a BioScout session folder (or individual OpenSim result files) and show it the way the
// running playground does: stick figure + GRF, hip/knee/ankle angle and moment with stacked muscle-group
// moment contributions (force x moment arm) and reserves, group activations over time, bars at this frame.
// Everything is read in the browser; nothing is uploaded.

const DOFS = ["hip_flexion", "knee_angle", "ankle_angle"];
export const GROUPS = [                                 // sagittal summary groups, base muscle names (Rajagopal / gait2392 style)
  ["Gluteus max", /^glmax|^glut_max/, "#e63946"], ["Gluteus med+min", /^glmed|^glmin|^glut_med|^glut_min/, "#f4a6a6"],
  ["Hamstrings", /^bflh|^semimem|^semiten|^bifemlh/, "#90be6d"], ["Biceps fem. short", /^bfsh|^bifemsh/, "#43aa8b"],
  ["Adductors", /^add|^grac/, "#2ec4b6"], ["Iliopsoas", /^iliacus|^psoas/, "#e9c46a"], ["Rectus femoris", /^recfem|^rect_fem/, "#57cc99"],
  ["Vasti", /^vas/, "#48cae4"], ["Gastrocnemius", /^gas|^lat_gas|^med_gas/, "#4361ee"], ["Soleus", /^soleus|^soleus/, "#8e44ec"],
  ["Dorsiflexors", /^tibant|^edl|^ehl|^tib_ant|^ext_dig|^ext_hal/, "#e056c1"],
];
const OTHER = ["Other muscles", null, "#9aa0a6"];
const RCOL = "#ff8a65";

// ---------- parsing ----------
export function parseSto(text) {                       // OpenSim .mot/.sto -> { names, cols: {name: Float64Array}, n, inDeg }
  const L = text.split(/\r?\n/), h = L.findIndex((l) => l.trim().toLowerCase() === "endheader");
  if (h < 0) throw new Error("no endheader");
  const inDeg = !/inDegrees\s*=\s*no/i.test(L.slice(0, h).join("\n"));
  let r = h + 1; while (r < L.length && !L[r].trim()) r++;
  const names = L[r].trim().split(/\s+/), rows = [];
  for (let i = r + 1; i < L.length; i++) { const l = L[i].trim(); if (l) rows.push(l.split(/\s+/)); }
  const cols = {}; names.forEach((k, j) => { const a = new Float64Array(rows.length); for (let i = 0; i < rows.length; i++) a[i] = +rows[i][j]; cols[k] = a; });
  return { names, cols, n: rows.length, inDeg };
}
export function parseCycles(yaml) {                    // movement_detection.yaml -> [{name, side, t0, t1}] (only the "cycles:" list)
  const out = [], L = yaml.split(/\r?\n/); let on = false, cur = null, tr = null;
  for (const l of L) {
    if (/^cycles:/.test(l)) { on = true; continue; }
    if (!on) continue;
    if (/^\S/.test(l) && !/^-/.test(l)) break;
    let m;
    if ((m = l.match(/^- name:\s*(\S+)/))) { cur = { name: m[1] }; out.push(cur); tr = null; continue; }
    if (!cur) continue;
    if ((m = l.match(/^  side:\s*(\w+)/))) cur.side = m[1][0];
    if (/^  time_range:/.test(l)) { tr = []; continue; }
    if (tr && (m = l.match(/^  - ([-\d.eE]+)/))) { tr.push(+m[1]); if (tr.length === 2) { cur.t0 = tr[0]; cur.t1 = tr[1]; tr = null; } continue; }
    if (!/^  - /.test(l)) tr = null;
  }
  return out.filter((c) => Number.isFinite(c.t0));
}
function interp(t, x, y) {                             // y(x) sampled at t; NaN outside
  const out = new Float64Array(t.length); let j = 0;
  for (let i = 0; i < t.length; i++) {
    const v = t[i]; if (v < x[0] - 1e-9 || v > x[x.length - 1] + 1e-9) { out[i] = NaN; continue; }
    while (j < x.length - 2 && x[j + 1] < v) j++;
    const d = x[j + 1] - x[j]; out[i] = d > 0 ? y[j] + (y[j + 1] - y[j]) * (v - x[j]) / d : y[j];
  }
  return out;
}

// ---------- build one view model from parsed files ----------
// F: { ik, id, act, force, ma: {hip_flexion, knee_angle, ankle_angle}, mk, grf }  (parsed .sto objects; any but ik may be missing)
export function buildModel(F, side, win) {
  const tAll = F.ik.cols.time, keep = []; for (let i = 0; i < tAll.length; i++) if (!win || (tAll[i] >= win[0] - 1e-9 && tAll[i] <= win[1] + 1e-9)) keep.push(i);
  if (keep.length < 3) throw new Error("no frames in this window");
  const t = Float64Array.from(keep, (i) => tAll[i]), N = t.length, at = (p, k) => (p && p.cols[k] ? interp(t, p.cols.time, p.cols[k]) : null);
  const conv = F.ik.inDeg ? 1 : 180 / Math.PI;
  const ang = DOFS.map((d) => { const a = at(F.ik, `${d}_${side}`); return a ? a.map((v) => v * conv) : new Float64Array(N).fill(NaN); });
  const mom = DOFS.map((d) => at(F.id, `${d}_${side}_moment`) || new Float64Array(N).fill(NaN));
  const res = DOFS.map((d) => at(F.force, `${d}_${side}_reserve`));
  const muscles = (F.force || F.act) ? (F.force || F.act).names.filter((n) => new RegExp(`_${side}$`).test(n)) : [];
  const groups = GROUPS.concat([OTHER]).map(([n, re, col]) => ({ n, re, col, mem: [] }));
  for (const m of muscles) { const b = m.replace(/_[lr]$/, ""); (groups.find((g) => g.re && g.re.test(b)) || groups[groups.length - 1]).mem.push(m); }
  const G = groups.filter((g) => g.mem.length).map((g) => {
    const act = new Float64Array(N), contrib = DOFS.map(() => new Float64Array(N));
    for (const m of g.mem) {
      const a = at(F.act, m); if (a) for (let i = 0; i < N; i++) act[i] += a[i] / g.mem.length;
      const f = at(F.force, m);
      if (f) DOFS.forEach((d, k) => { const r = F.ma && F.ma[d] ? at(F.ma[d], m) : null; if (r) for (let i = 0; i < N; i++) contrib[k][i] += (f[i] * r[i]) || 0; });
    }
    return { n: g.n, col: g.col, act: F.act ? act : null, contrib, mem: g.mem };
  });
  // stick figure from model marker locations (sagittal: x forward, y up)
  const stickFor = (sd) => {
    const S = sd.toUpperCase(), P = (m) => { const x = at(F.mk, `${m}_tx`), y = at(F.mk, `${m}_ty`); return x && y ? { x, y } : null; };
    const mids = (a, b) => (a && b ? { x: a.x.map((v, i) => (v + b.x[i]) / 2), y: a.y.map((v, i) => (v + b.y[i]) / 2) } : a || b);
    const names = F.mk.names.filter((k) => k.endsWith("_tx")).map((k) => k.slice(0, -3));
    const asis = P(S + "ASIS") || P(S + "ASI"), psis = P(S + "PSIS") || P(S + "PSI");
    return {
      pelvis: [asis, psis], knee: mids(P(S + "MCO") || P(S + "KNEM"), P(S + "LCO") || P(S + "KNE")),
      ankle: mids(P(S + "MMA") || P(S + "ANKM"), P(S + "LMA") || P(S + "ANK")), heel: P(S + "HEEL") || P(S + "HEE"),
      toe: P(S + "MET01") || P(S + "TOE") || P(S + "METP"), met5: P(S + "MET05"),
      all: names.filter((m) => m[0] === S || !/^[LR][A-Z]/.test(m)).map((m) => ({ m, ...P(m) })),
    };
  };
  const stick = F.mk ? stickFor(side) : null, stick2 = F.mk ? stickFor(side === "r" ? "l" : "r") : null;
  const grf = [];
  if (F.grf) for (let k = 1; k <= 4; k++) { const fx = at(F.grf, `ground_force_${k}_vx`), fy = at(F.grf, `ground_force_${k}_vy`), px = at(F.grf, `ground_force_${k}_px`); if (fx && fy && px) grf.push({ fx, fy, px }); }
  return { t, N, ang, mom, res, G, stick, stick2, grf, side };
}

// ---------- UI ----------
export function initVisualise({ host, tr }) {
  const S = { mode: "session", side: "r", fr: 0, play: false, files: null, sess: null, iter: "", trial: "", cycle: "", M: null, err: "" };
  const hide = new Set(), css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  const f = (x, n = 1) => (Number.isFinite(x) ? x.toFixed(n) : "–");
  let raf = 0, last = 0;
  const ROLES = [["ik", "vi_fIK"], ["id", "vi_fID"], ["force", "vi_fForce"], ["act", "vi_fAct"], ["ma_hip_flexion", "vi_fMAhip"], ["ma_knee_angle", "vi_fMAknee"], ["ma_ankle_angle", "vi_fMAankle"], ["mk", "vi_fMk"], ["grf", "vi_fGrf"]];
  const single = {};                                   // role -> File (individual mode)

  // session folder: index the picked files by their path inside the session
  function indexSession(list) {
    const byPath = new Map(); let root = null;
    for (const fl of list) { const p = (fl.webkitRelativePath || fl.name).replace(/\\/g, "/"); byPath.set(p, fl); }
    const iters = {}, exp = {};
    for (const p of byPath.keys()) {
      let m = p.match(/^(.*?)3_iterations\/([^/]+)\/([^/]+)\/external_biomechanics\/joint_angles\.mot$/);
      if (m) { root = m[1]; (iters[m[2]] = iters[m[2]] || []).push(m[3]); }
      m = p.match(/^(.*?)2_experimental\/([^/]+)\//); if (m) exp[m[2]] = true;
    }
    if (root == null) throw new Error(tr("vi_noSession"));
    return { byPath, root, iters };
  }
  const sessFile = (rel) => S.sess.byPath.get(S.sess.root + rel);
  const read = async (fl) => (fl ? parseSto(await fl.text()) : null);
  async function loadSession() {
    const it = S.iter, tl = S.trial, b = `3_iterations/${it}/${tl}/`, side = S.side;
    const F = {
      ik: await read(sessFile(b + "external_biomechanics/joint_angles.mot")), id: await read(sessFile(b + "external_biomechanics/inverse_dynamics.sto")),
      act: await read(sessFile(b + "static_optimisation/StaticOptimization_activation.sto")), force: await read(sessFile(b + "static_optimisation/StaticOptimization_force.sto")),
      mk: await read(sessFile(b + "external_biomechanics/_ik_model_marker_locations.sto")), grf: await read(sessFile(`2_experimental/${tl}/grf.mot`)), ma: {},
    };
    for (const d of DOFS) F.ma[d] = await read(sessFile(`${b}muscle_analysis/_MuscleAnalysis_MomentArm_${d}_${side}.sto`));
    const y = sessFile(`2_experimental/${tl}/movement_detection.yaml`);
    S.cycles = y ? parseCycles(await y.text()) : [];
    return F;
  }
  async function loadSingle() {
    const F = { ma: {} };
    for (const [k] of ROLES) { const v = await read(single[k]); if (k.startsWith("ma_")) F.ma[k.slice(3)] = v; else F[k] = v; }
    if (!F.ik) throw new Error(tr("vi_needIK"));
    return F;
  }
  async function refresh() {
    S.err = ""; S.M = null;
    try {
      const F = S.mode === "session" ? (S.sess && S.iter && S.trial ? await loadSession() : null) : await loadSingle();
      if (F) { const c = (S.cycles || []).find((x) => x.name === S.cycle); S.M = buildModel(F, S.side, c ? [c.t0, c.t1] : null); S.fr = 0; }
    } catch (e) { S.err = e.message || String(e); }
    render();
  }

  function controls() {
    if (S.mode === "single") return `<div class="phCtl">${ROLES.map(([k, lab]) => `<label class="phSl">${tr(lab)}<input type="file" accept=".mot,.sto,.txt" data-role="${k}"><small>${single[k] ? single[k].name : ""}</small></label>`).join("")}
      <label class="phSl">${tr("vi_side")}<select data-vs="side"><option value="r"${S.side === "r" ? " selected" : ""}>${tr("vi_right")}</option><option value="l"${S.side === "l" ? " selected" : ""}>${tr("vi_left")}</option></select></label></div>`;
    const it = S.sess ? Object.keys(S.sess.iters) : [], trials = S.sess && S.iter ? S.sess.iters[S.iter] || [] : [];
    const opt = (arr, v) => arr.map((a) => `<option value="${a}"${a === v ? " selected" : ""}>${a}</option>`).join("");
    return `<label class="phSl">${tr("vi_pick")}<input type="file" webkitdirectory directory multiple data-dir></label>
      ${S.sess ? `<div class="phCtl"><label class="phSl">${tr("vi_iter")}<select data-vs="iter">${opt(it, S.iter)}</select></label>
      <label class="phSl">${tr("vi_trial")}<select data-vs="trial">${opt(trials, S.trial)}</select></label>
      <label class="phSl">${tr("vi_cycle")}<select data-vs="cycle"><option value="">${tr("vi_whole")}</option>${(S.cycles || []).map((c) => `<option value="${c.name}"${c.name === S.cycle ? " selected" : ""}>${c.name} (${c.side || "?"}, ${f(c.t0, 2)}–${f(c.t1, 2)} s)</option>`).join("")}</select></label>
      <label class="phSl">${tr("vi_side")}<select data-vs="side"><option value="r"${S.side === "r" ? " selected" : ""}>${tr("vi_right")}</option><option value="l"${S.side === "l" ? " selected" : ""}>${tr("vi_left")}</option></select></label></div>` : ""}`;
  }
  const legend = () => !S.M ? "" : S.M.G.map((g) => [g.n, g.col]).concat([[tr("vi_reserve"), RCOL]]).map(([n, col]) =>
    `<button type="button" class="ghost${hide.has(n) ? " off" : ""}" data-mu="${n}"><i style="background:${col}"></i>${n}</button>`).join("") + `<span class="note">${tr("rm_legTap")}</span>`;
  function render() {
    host.innerHTML = `<div class="rmWrap"><div class="rmSide">
      <div class="chips phTabs"><button type="button" class="ghost${S.mode === "session" ? " on" : ""}" data-mode="session">${tr("vi_tSession")}</button><button type="button" class="ghost${S.mode === "single" ? " on" : ""}" data-mode="single">${tr("vi_tSingle")}</button></div>
      ${controls()}${S.err ? `<p class="warn">${S.err}</p>` : ""}<p class="note">${tr("vi_note")}</p></div>
      ${S.M ? `<div class="rmMain"><canvas class="phCv rmCv" id="viCv"></canvas><div class="rmLeg">${legend()}</div>
      <div class="row bfbRow"><button type="button" id="viPlay">${tr(S.play ? "ph_pause" : "ph_play")}</button></div>
      <div class="phSl"><span>${tr("vi_time")} <b data-vv>${f(S.M.t[Math.round(S.fr)], 3)} s</b></span><input type="range" min="0" max="${S.M.N - 1}" step="1" value="${Math.round(S.fr)}" data-vfr></div></div>` : ""}</div>`;
    draw();
  }
  function fit(cv) {
    const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1, w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext("2d"); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, r.width, r.height); return [c, r.width, r.height];
  }
  function axes(c, x0, y0, w, h, ser, side) {
    let lo = Infinity, hi = -Infinity; for (const s of ser) for (const v of s.v) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    lo = Math.min(lo, 0); hi = Math.max(hi, 0); if (hi - lo < 1e-6) hi = lo + 1; const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const Y = (v) => y0 + h - h * (v - lo) / (hi - lo);
    c.font = "11px system-ui"; c.fillStyle = ser[0].col || css("--muted");
    for (const v of [hi, (hi + lo) / 2, lo]) { const t = f(v, Math.abs(hi - lo) < 5 ? 1 : 0), tw = c.measureText(t).width; c.fillText(t, side < 0 ? x0 - tw - 4 : x0 + w + 4, Math.min(y0 + h, Math.max(y0 + 10, Y(v) + 4))); }
    return Y;
  }
  function panel(c, x0, y0, w, h, title, L, R, fr, stack, N) {
    const line = css("--line"), X = (i) => x0 + w * i / (N - 1);
    c.fillStyle = css("--card"); c.fillRect(x0, y0, w, h); c.strokeStyle = line; c.lineWidth = 1; c.strokeRect(x0, y0, w, h);
    for (let g = 1; g < 4; g++) { c.globalAlpha = 0.35; c.beginPath(); c.moveTo(x0 + w * g / 4, y0); c.lineTo(x0 + w * g / 4, y0 + h); c.stroke(); c.globalAlpha = 1; }
    const draw1 = (ser, Y) => { c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x0 + w, Y(0)); c.strokeStyle = line; c.stroke();
      for (const s of ser) { if (s.hide) continue; c.setLineDash(s.dash ? [6, 4] : []); c.strokeStyle = s.col; c.lineWidth = s.lw || 2.5; c.beginPath(); let pen = false;
        s.v.forEach((v, i) => { if (!Number.isFinite(v)) { pen = false; return; } pen ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)); pen = true; }); c.stroke(); }
      c.setLineDash([]); };
    if (L && L.s.length) draw1(L.s, axes(c, x0, y0, w, h, L.s, -1));
    if (R && R.s.length) {
      const Y = axes(c, x0, y0, w, h, R.s, 1);
      if (stack) { const up = new Array(N).fill(0), dn = new Array(N).fill(0);
        for (const it of stack) for (const sg of [1, -1]) { const base = sg > 0 ? up : dn, top = Array.from(it.v, (v, i) => base[i] + (sg > 0 ? Math.max(v || 0, 0) : Math.min(v || 0, 0)));
          if (top.every((v, i) => Math.abs(v - base[i]) < 1e-9)) continue;
          c.fillStyle = it.col; c.globalAlpha = it.res ? 0.45 : 0.8; c.beginPath(); top.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
          for (let i = N - 1; i >= 0; i--) c.lineTo(X(i), Y(base[i])); c.closePath(); c.fill(); c.globalAlpha = 1; for (let i = 0; i < N; i++) base[i] = top[i]; } }
      draw1(R.s, Y);
    }
    c.strokeStyle = "#e76f51"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(fr), y0); c.lineTo(X(fr), y0 + h); c.stroke();
    c.font = "bold 12px system-ui"; c.fillStyle = css("--ink"); c.fillText(title, x0 + 6, y0 + 15);
    let tx = x0 + 12 + c.measureText(title).width; c.font = "11px system-ui";
    for (const a of [L, R]) if (a && a.lab) { c.fillStyle = a.s[0].col; c.fillText(a.lab, tx, y0 + 15); tx += c.measureText(a.lab).width + 10; }
  }
  function draw() {
    const cv = host.querySelector("#viCv"), M = S.M; if (!cv || !M) return;
    const [c, W, H] = fit(cv), ink = css("--ink"), mut = css("--muted"), acc = css("--accent"), mom = "#f4a261", N = M.N, fr = Math.round(S.fr);
    const fh = 300, px = 44, py = fh + 8, pw = W - 88, ph = H - py - 4;
    // stick figure (sagittal), centred on the pelvis at this frame
    const st = M.stick;
    if (st) {
      const pv = st.pelvis[0] || st.knee, cx = pv ? pv.x[fr] : 0, sc = (fh - 30) / 1.2, X = (x) => W / 2 + (x - cx) * sc, Y = (y) => fh - 12 - y * sc, P = (p) => (p ? [X(p.x[fr]), Y(p.y[fr])] : null);
      c.strokeStyle = css("--line"); c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke();
      const pm = st.pelvis[0] && st.pelvis[1] ? [(P(st.pelvis[0])[0] + P(st.pelvis[1])[0]) / 2, (P(st.pelvis[0])[1] + P(st.pelvis[1])[1]) / 2] : null;
      c.lineCap = "round"; c.lineJoin = "round";
      const chain = (pts) => { const q = pts.filter(Boolean); if (q.length < 2) return; c.beginPath(); q.forEach((p, i) => (i ? c.lineTo(...p) : c.moveTo(...p))); c.stroke(); };
      const legOf = (s2, col, lw) => { if (!s2) return; const pm2 = s2.pelvis[0] && s2.pelvis[1] ? [(P(s2.pelvis[0])[0] + P(s2.pelvis[1])[0]) / 2, (P(s2.pelvis[0])[1] + P(s2.pelvis[1])[1]) / 2] : null;
        c.strokeStyle = col; c.lineWidth = lw; chain([P(s2.pelvis[1]), pm2, P(s2.pelvis[0])]); chain([pm2, P(s2.knee), P(s2.ankle), P(s2.heel), P(s2.toe), P(s2.ankle)]); };
      legOf(M.stick2, mut, 3); legOf(st, acc, 4);
      c.fillStyle = mut; for (const m of st.all) if (m.x) { const p = P(m); c.beginPath(); c.arc(p[0], p[1], 2, 0, 7); c.fill(); }
      const k = 0.3 / 1000;                          // 1000 N drawn as 30 cm
      for (const g of M.grf) { const fy = g.fy[fr]; if (!(fy > 20)) continue; const x0 = X(g.px[fr]);
        c.strokeStyle = "#e76f51"; c.lineWidth = 3; c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x0 + g.fx[fr] * k * sc, Y(fy * k)); c.stroke(); }
    } else { c.fillStyle = mut; c.fillText(tr("vi_noStick"), 10, 20); }
    // plots on one time axis
    const gap = 8, jh = ph * 0.2, ah = ph * 0.22, bh = ph - 3 * (jh + gap) - ah - gap, JN = [tr("rm_hip"), tr("rm_knee"), tr("rm_ankle")];
    for (let d = 0; d < 3; d++) {
      const items = M.G.filter((g) => !hide.has(g.n) && g.contrib[d].some((v) => v)).map((g) => ({ col: g.col, v: g.contrib[d] }));
      if (M.res[d] && !hide.has(tr("vi_reserve"))) items.push({ col: RCOL, res: true, v: M.res[d] });
      const pos = Array.from({ length: N }, (_, i) => items.reduce((s, it) => s + Math.max(0, it.v[i] || 0), 0)), neg = Array.from({ length: N }, (_, i) => items.reduce((s, it) => s + Math.min(0, it.v[i] || 0), 0));
      panel(c, px, py + d * (jh + gap), pw, jh, JN[d], { lab: tr("vi_angAx"), s: [{ v: M.ang[d], col: acc }] },
        { lab: tr("vi_momAx"), s: [{ v: M.mom[d], col: mom, lw: 3 }, { v: pos, hide: true }, { v: neg, hide: true }] }, fr, items, N);
    }
    const ay = py + 3 * (jh + gap), al = M.G.filter((g) => g.act && !hide.has(g.n)).map((g) => ({ v: Array.from(g.act, (v) => v * 100), col: g.col, lw: 2 }));
    panel(c, px, ay, pw, ah, tr("rm_actLines"), al.length ? { lab: "%", s: al.concat([{ v: [0, 100], hide: true }]) } : null, null, fr, null, N);
    const by = ay + ah + gap, items = M.G.filter((g) => g.act && !hide.has(g.n));
    c.fillStyle = css("--card"); c.fillRect(px, by, pw, bh); c.strokeStyle = css("--line"); c.strokeRect(px, by, pw, bh);
    c.font = "bold 12px system-ui"; c.fillStyle = ink; c.fillText(tr("vi_actNow"), px + 6, by + 15);
    const bw = pw / Math.max(1, items.length), base = by + bh - 30, top = by + 34;
    items.forEach((g, i) => { const v = g.act[fr] * 100, x = px + i * bw + bw * 0.15, w = bw * 0.7, h = (base - top) * Math.min(1, Math.max(0, v / 100));
      c.fillStyle = g.col; c.fillRect(x, base - h, w, h); c.fillStyle = ink; c.font = "11px system-ui";
      const vt = f(v, 0); c.fillText(vt, x + w / 2 - c.measureText(vt).width / 2, base - h - 4);
      c.font = "10px system-ui"; const words = g.n.split(" "); words.forEach((wd, j) => c.fillText(wd, x + w / 2 - c.measureText(wd).width / 2, base + 12 + j * 11)); });
    c.font = "11px system-ui"; c.fillStyle = mut; c.fillText(`${f(M.t[0], 2)} s`, px, H - 2); const te = `${f(M.t[N - 1], 2)} s`; c.fillText(te, px + pw - c.measureText(te).width, H - 2);
  }
  function loop(ts) {
    if (!S.play || !S.M) { raf = 0; return; }
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
    const span = S.M.t[S.M.N - 1] - S.M.t[0]; S.fr = (S.fr + dt / 4 * (S.M.N - 1) / Math.max(span, 1e-3)) % (S.M.N - 1);   // quarter speed
    const sl = host.querySelector("[data-vfr]"), o = host.querySelector("[data-vv]"); if (sl) sl.value = Math.round(S.fr); if (o) o.textContent = f(S.M.t[Math.round(S.fr)], 3) + " s";
    draw(); raf = requestAnimationFrame(loop);
  }
  function play(on) { S.play = on; const b = host.querySelector("#viPlay"); if (b) b.textContent = tr(on ? "ph_pause" : "ph_play"); if (on && !raf) { last = 0; raf = requestAnimationFrame(loop); } }

  host.addEventListener("click", (e) => {
    const md = e.target.closest("[data-mode]"); if (md) { S.mode = md.dataset.mode; play(false); refresh(); return; }
    if (e.target.id === "viPlay") { play(!S.play); return; }
    const mu = e.target.closest("[data-mu]"); if (mu) { const n = mu.dataset.mu; hide.has(n) ? hide.delete(n) : hide.add(n); mu.classList.toggle("off", hide.has(n)); draw(); }
  });
  host.addEventListener("input", (e) => { if ("vfr" in e.target.dataset) { S.fr = +e.target.value; const o = host.querySelector("[data-vv]"); if (o) o.textContent = f(S.M.t[S.fr], 3) + " s"; draw(); } });
  host.addEventListener("change", async (e) => {
    const el = e.target;
    if ("dir" in el.dataset) {
      try { S.sess = indexSession(el.files); S.iter = Object.keys(S.sess.iters)[0]; S.trial = S.sess.iters[S.iter][0]; S.cycle = ""; } catch (err) { S.sess = null; S.err = err.message; render(); return; }
      return refresh();
    }
    if (el.dataset.role) { single[el.dataset.role] = el.files[0]; return refresh(); }
    const k = el.dataset.vs; if (!k) return;
    S[k] = el.value;
    if (k === "iter") { S.trial = S.sess.iters[S.iter][0]; S.cycle = ""; }
    if (k === "trial") S.cycle = "";
    if (k === "cycle") { const c = (S.cycles || []).find((x) => x.name === S.cycle); if (c && c.side) S.side = c.side; }
    refresh();
  });
  window.addEventListener("resize", () => { if (!host.closest(".hidden")) draw(); });
  return {
    open() { render(); },
    leave() { play(false); },
  };
}
