/**
 * trcview.js -- marker tools for the Simulate page (no server needed):
 *   parseTrc(text)               -> { t, names, P: {name: Float64Array(3n)}, units }
 *   editTaskWeights(t, opts)     -> dialog to tick / weight IK marker tasks; resolves to task-set XML or null
 *   viewTrc(t, trc, range)       -> dialog with sagittal / frontal / top views, a frame slider,
 *                                   markers to highlight, and start / end sliders; resolves to {t0, t1} or null
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function parseTrc(text) {
  const L = text.split(/\r?\n/);
  const keys = L[1].split("\t"), vals = L[2].split("\t"), info = {};
  keys.forEach((k, i) => { info[k.trim()] = (vals[i] || "").trim(); });
  const sc = { mm: 1e-3, cm: 1e-2, m: 1 }[(info.Units || "mm").toLowerCase()] ?? 1e-3;
  const names = L[3].split("\t").slice(2).map((s) => s.trim()).filter(Boolean);
  const rows = L.slice(5).filter((l) => l.trim()).map((l) => l.split("\t"));
  const n = rows.length, t = new Float64Array(n), P = {};
  names.forEach((nm) => { P[nm] = new Float64Array(3 * n).fill(NaN); });
  rows.forEach((r, k) => {
    t[k] = +r[1];
    names.forEach((nm, i) => {
      for (let a = 0; a < 3; a++) {
        const v = r[2 + 3 * i + a];
        P[nm][3 * k + a] = v === undefined || v.trim() === "" ? NaN : +v * sc;
      }
    });
  });
  return { t, names, P, rate: +info.DataRate || 1 / (t[1] - t[0]) };
}

function dialog(html) {
  const d = document.createElement("dialog");
  d.className = "trcDlg";
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener("close", () => setTimeout(() => d.remove(), 0));
  d.showModal();
  return d;
}

/* ------------------------------------------------------------ task weights */
export function editTaskWeights(t, { names, xml }) {
  // start from the dropped / template task set, then add every .trc marker it misses (off)
  const rows = new Map();
  if (xml) {
    const doc = new window.DOMParser().parseFromString(xml, "text/xml");
    doc.querySelectorAll("IKMarkerTask").forEach((el) => {
      const g = (tag) => (el.querySelector(tag)?.textContent || "").trim();
      rows.set(el.getAttribute("name"), { on: g("apply") !== "false", w: +(g("weight") || 1) });
    });
  }
  const inTrc = new Set(names || []);
  const anyMatch = [...rows.keys()].some((n) => inTrc.has(n));
  for (const n of names || []) if (!rows.has(n)) rows.set(n, { on: !anyMatch, w: 1 });
  const list = [...rows.entries()];
  return new Promise((resolve) => {
    const d = dialog(`<h3 style="margin:0 0 6px">${esc(t("sim_tw_title"))}</h3>
      <p class="note" style="margin:0 0 8px">${esc(t("sim_tw_note"))}</p>
      <div class="twBar"><button type="button" class="ghost" data-all="1">${esc(t("sim_tw_all"))}</button>
        <button type="button" class="ghost" data-all="0">${esc(t("sim_tw_none"))}</button>
        <label>${esc(t("sim_tw_setw"))} <input type="number" step="any" min="0" value="1" data-allw style="width:80px"></label></div>
      <div class="twList">${list.map(([n, r]) => `<label class="twRow${inTrc.size && !inTrc.has(n) ? " miss" : ""}">
        <input type="checkbox" data-n="${esc(n)}"${r.on ? " checked" : ""}> <span>${esc(n)}</span>
        <input type="number" step="any" min="0" value="${r.w}" data-w="${esc(n)}"></label>`).join("")}</div>
      <p class="note" style="margin:6px 0 0">${esc(t("sim_tw_miss"))}</p>
      <div class="twBar" style="justify-content:flex-end"><button type="button" class="ghost" data-x>${esc(t("cancel"))}</button>
        <button type="button" data-ok>${esc(t("sim_tw_use"))}</button></div>`);
    d.querySelectorAll("[data-all]").forEach((b) => { b.onclick = () => d.querySelectorAll("[data-n]").forEach((c) => { c.checked = b.dataset.all === "1"; }); });
    d.querySelector("[data-allw]").onchange = (e) => d.querySelectorAll("[data-w]").forEach((i) => { i.value = e.target.value; });
    d.querySelector("[data-x]").onclick = () => { d.close(); resolve(null); };
    d.addEventListener("cancel", () => resolve(null));
    d.querySelector("[data-ok]").onclick = () => {
      const tasks = [...d.querySelectorAll("[data-n]")].map((c) => {
        const n = c.dataset.n, w = d.querySelector(`[data-w="${CSS.escape(n)}"]`).value || "1";
        return `\t\t\t<IKMarkerTask name="${esc(n)}">\n\t\t\t\t<apply>${c.checked}</apply>\n\t\t\t\t<weight>${+w}</weight>\n\t\t\t</IKMarkerTask>`;
      }).join("\n");
      d.close();
      resolve(`<?xml version="1.0" encoding="UTF-8" ?>\n<OpenSimDocument Version="40000">\n\t<IKTaskSet name="ik_tasks">\n\t\t<objects>\n${tasks}\n\t\t</objects>\n\t\t<groups />\n\t</IKTaskSet>\n</OpenSimDocument>\n`);
    };
  });
}

/* ------------------------------------------------------------ marker viewer */
// Which lab axis is up / forward: up = biggest marker spread within a frame (head to feet),
// forward = biggest travel of the rest. Works for OpenSim (Y up) and Vicon (Z up) files.
function axesOf(names, P, n) {
  const span = [0, 0, 0], travel = [0, 0, 0];
  const step = Math.max(1, Math.floor(n / 20));
  let cnt = 0;
  for (let k = 0; k < n; k += step) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of names) for (let a = 0; a < 3; a++) {
      const v = P[m][3 * k + a]; if (isFinite(v)) { lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v); }
    }
    if (isFinite(lo[0])) { for (let a = 0; a < 3; a++) span[a] += hi[a] - lo[a]; cnt++; }
  }
  for (const m of names) for (let a = 0; a < 3; a++) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) { const v = P[m][3 * k + a]; if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (isFinite(lo)) travel[a] = Math.max(travel[a], hi - lo - span[a] / Math.max(cnt, 1));
  }
  const up = [0, 1, 2].reduce((b, a) => (span[a] > span[b] ? a : b), 0);
  const rest = [0, 1, 2].filter((a) => a !== up);
  const fwd = travel[rest[0]] >= travel[rest[1]] ? rest[0] : rest[1];
  const side = rest.find((a) => a !== fwd);
  return { up, fwd, side };
}

/** grf.mot -> { t, series: [{name, y}] } of the vertical forces (columns ending vy / _fy / force_y). */
export function parseGrfMot(text) {
  const L = text.split(/\r?\n/); let h = L.findIndex((l) => /^endheader/i.test(l.trim()));
  const head = L[h + 1].split(/\t/).map((s) => s.trim()), rows = L.slice(h + 2).filter((l) => l.trim()).map((l) => l.split(/\s+/).filter(Boolean).map(Number));
  const ti = Math.max(0, head.findIndex((c) => /^time$/i.test(c)));
  const cols = head.map((c, i) => [c, i]).filter(([c]) => /(_?vy|_fy|force_y|ground_force_vy)$/i.test(c) && !/torque|moment|_p[xyz]$/i.test(c));
  return { t: Float64Array.from(rows, (r) => r[ti]), series: cols.map(([c, i]) => ({ name: c, y: Float64Array.from(rows, (r) => r[i]) })) };
}

/** opts (all optional): signals [{key, label, t, series: [{name, y}]}] -- the plot under the markers, picked
 *  from a drop-down (default: the vertical GRF); trials + trial -- a trial drop-down (resolves {switchTo});
 *  signal -- the signal key to start with; okLabel -- the confirm button's text. */
export function viewTrc(t, trc, range, grf = null, opts = {}) {
  const { names, P } = trc, T = trc.t, n = T.length;
  const idx = (time) => { let k = 0; while (k < n - 1 && T[k] < time - 1e-9) k++; return k; };
  let i0 = range && isFinite(range[0]) ? idx(range[0]) : 0;
  let i1 = range && isFinite(range[1]) ? idx(range[1]) : n - 1;
  let fr = i0, mode = "3d", yaw = -0.6, pitch = 0.35, zoom = 1;
  // the signal plot's time window: around the crop (or where the force plates are loaded), zoomable
  let va = T[0], vb = T[n - 1];
  const on = new Set(names.filter((m) => /ASI|PSI|SACR|HEE|TOE|C7/i.test(m)));
  const ax = axesOf(names, P, n);
  // centre and size of the whole trial
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of names) for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) {
    const v = P[m][3 * k + a]; if (isFinite(v)) { lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v); }
  }
  const mid = lo.map((v, a) => (v + hi[a]) / 2), ext = Math.max(...hi.map((v, a) => v - lo[a])) || 1;
  const css = getComputedStyle(document.documentElement);
  const C = { fg: css.getPropertyValue("--text").trim() || "#ddd", line: css.getPropertyValue("--line").trim() || "#555",
    acc: css.getPropertyValue("--accent").trim() || "#4ab", sub: css.getPropertyValue("--sub").trim() || "#999" };
  const sigs = (opts.signals && opts.signals.length) ? opts.signals : (grf && grf.series.length ? [{ key: "grf", label: "GRF vertical (N)", t: grf.t, series: grf.series }] : []);
  let sk = Math.max(0, sigs.findIndex((x) => x.key === opts.signal));
  if (i0 > 0 || i1 < n - 1) { const pad = Math.max(0.3, (T[i1] - T[i0]) * 0.75); va = Math.max(T[0], T[i0] - pad); vb = Math.min(T[n - 1], T[i1] + pad); }
  // body frame: x forward, y up, z side (right-handed)
  const body = (m, k) => {
    const b = 3 * k, p = P[m];
    return [p[b + ax.fwd] - mid[ax.fwd], p[b + ax.up] - mid[ax.up], p[b + ax.side] - mid[ax.side]];
  };
  // screen projection for each view: returns [sx, sy, depth]
  const PROJ = {
    sag: (v) => [v[0], v[1], v[2]],
    front: (v) => [v[2], v[1], -v[0]],
    top: (v) => [v[0], v[2], v[1]],
    "3d": (v) => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const x = cy * v[0] + sy * v[2], z = -sy * v[0] + cy * v[2];
      return [x, cp * v[1] - sp * z, sp * v[1] + cp * z];
    },
  };
  return new Promise((resolve) => {
    const f3 = (v) => (+v).toFixed(3);
    const d = dialog(`<div class="tvHead tvCompact"><h3 style="margin:0">${esc(opts.title || t("sim_v_title"))}</h3>
        ${opts.trials && opts.trials.length > 1 ? `<label class="sub">${esc(t("sim_crop_trial"))} <select data-trial>${opts.trials.map((x) => `<option${x === opts.trial ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>` : ""}
        ${sigs.length > 1 ? `<label class="sub">${esc(t("sim_crop_signal"))} <select data-sig>${sigs.map((x, j) => `<option value="${j}"${j === sk ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>` : ""}
        <label class="sub">${esc(t("sim_v_view"))} <select data-mode>
          <option value="3d">${esc(t("sim_v_3d"))}</option><option value="sag">${esc(t("sim_v_sag"))}</option>
          <option value="front">${esc(t("sim_v_front"))}</option><option value="top">${esc(t("sim_v_top"))}</option></select></label>
        <span class="sub" data-info></span></div>
      <div class="tvBody"><div class="tvPlots"><canvas data-c></canvas>${sigs.length ? `<canvas data-g style="width:100%;margin-top:4px;touch-action:none"></canvas>` : ""}
          <div class="note" style="margin:2px 0 0;font-size:11px">${esc(t("sim_v_hint"))}${sigs.length ? " · " + esc(t("sim_crop_hint")) : ""}</div></div>
        <div class="tvSide tvCompact"><div class="sub">${esc(t("sim_v_markers"))} <a href="#" data-all="1">${esc(t("sim_tw_all"))}</a> · <a href="#" data-all="0">${esc(t("sim_tw_none"))}</a></div>
          <div class="tvList" data-list>${names.map((m) => `<label><input type="checkbox" data-m="${esc(m)}"${on.has(m) ? " checked" : ""}> ${esc(m)}</label>`).join("")}</div></div></div>
      <label class="tvSl"><span>${esc(t("sim_v_frame"))}</span><input type="range" min="0" max="${n - 1}" value="${fr}" data-fr><b data-frt></b></label>
      <div class="tvCompact" style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:6px">
        <label class="sub" style="display:flex;gap:4px;align-items:center">${esc(t("sim_v_start"))} <input type="text" inputmode="decimal" data-t0 style="width:76px"> s</label>
        <label class="sub" style="display:flex;gap:4px;align-items:center">${esc(t("sim_v_end"))} <input type="text" inputmode="decimal" data-t1 style="width:76px"> s</label>
        <button type="button" class="ghost" data-setS>${esc(t("sim_crop_setStart"))}</button><button type="button" class="ghost" data-setE>${esc(t("sim_crop_setEnd"))}</button>
        <button type="button" class="ghost" data-whole>${esc(t("sim_tr_whole"))}</button>
        <span style="flex:1"></span><button type="button" class="ghost" data-x>${esc(t("cancel"))}</button><button type="button" data-ok>${esc(opts.okLabel || t("sim_v_use"))}</button></div>`);
    const q = (s) => d.querySelector(s), cv = q("[data-c]");
    function path(g, m, a, b, X, Y, proj) {
      g.beginPath(); let pen = false;
      for (let k = a; k <= b; k++) {
        const v = body(m, k);
        if (!isFinite(v[0]) || !isFinite(v[1]) || !isFinite(v[2])) { pen = false; continue; }
        const s = proj(v);
        pen ? g.lineTo(X(s[0]), Y(s[1])) : g.moveTo(X(s[0]), Y(s[1])); pen = true;
      }
    }
    let draw = function () {
      q("[data-frt]").textContent = T[fr].toFixed(3) + " s";
      for (const [k, v] of [["[data-t0]", T[i0]], ["[data-t1]", T[i1]]]) { const el = q(k); if (document.activeElement !== el) el.value = f3(v); }
      q("[data-info]").textContent = `${names.length} ${t("sim_v_nmk")} · ${n} ${t("sim_v_nfr")} · ${T[0].toFixed(2)}–${T[n - 1].toFixed(2)} s`;
      { const h = q("[data-hint]"); if (h) h.style.visibility = mode === "3d" ? "visible" : "hidden"; }
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 500;
      const H = Math.max(180, Math.min(window.innerHeight * (gc ? 0.36 : 0.55), W * 0.6));
      const lst = q("[data-list]"); if (lst) lst.style.maxHeight = (H + (gc ? 180 : 0)) + "px";
      cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
      const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const proj = PROJ[mode], s = (Math.min(W, H) * 0.9 / ext) * zoom;
      const X = (v) => W / 2 + v * s, Y = (v) => H / 2 - v * s;
      g.strokeStyle = C.line; g.lineWidth = 1; g.strokeRect(0.5, 0.5, W - 1, H - 1);
      if (mode === "3d") {                    // ground grid under the feet
        const y0 = lo[ax.up] - mid[ax.up];
        g.globalAlpha = 0.25; g.strokeStyle = C.sub;
        const R = Math.ceil(ext / 2 / 0.5) * 0.5;
        for (let u = -R; u <= R + 1e-9; u += 0.5) {
          for (const [a, b] of [[[u, y0, -R], [u, y0, R]], [[-R, y0, u], [R, y0, u]]]) {
            const p = proj(a), r = proj(b); g.beginPath(); g.moveTo(X(p[0]), Y(p[1])); g.lineTo(X(r[0]), Y(r[1])); g.stroke();
          }
        }
        g.globalAlpha = 1;
      }
      for (const m of names) {
        const hl = on.has(m);
        path(g, m, 0, n - 1, X, Y, proj);
        g.globalAlpha = hl ? 0.45 : 0.18; g.strokeStyle = hl ? C.acc : C.sub; g.lineWidth = 1; g.stroke();
        path(g, m, i0, i1, X, Y, proj);
        g.globalAlpha = hl ? 1 : 0.5; g.lineWidth = hl ? 2 : 1.1; g.stroke(); g.globalAlpha = 1;
      }
      const dots = names.map((m) => [m, body(m, fr)]).filter(([, v]) => v.every(isFinite))
        .map(([m, v]) => [m, proj(v)]).sort((a, b) => a[1][2] - b[1][2]);
      for (const [m, p] of dots) {
        const hl = on.has(m);
        g.fillStyle = hl ? C.acc : C.fg;
        g.beginPath(); g.arc(X(p[0]), Y(p[1]), hl ? 5.5 : 2, 0, 7); g.fill();
        if (hl) { g.font = "11px system-ui"; g.fillText(m, X(p[0]) + 7, Y(p[1]) - 5); }
      }
    }
    const gc = q("[data-g]"), COLS = ["#4ab", "#e95", "#9c6", "#c7e", "#eb4", "#6ae"];
    function drawGrf() {
      if (!gc || !sigs.length) return;
      const sig = sigs[sk], st = sig.t;
      const dpr = window.devicePixelRatio || 1, W = gc.clientWidth || 500, H = Math.max(120, Math.min(180, window.innerHeight * 0.2));
      gc.width = W * dpr; gc.height = H * dpr; gc.style.height = H + "px";
      const g = gc.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const ta = va, tb = vb, X = (x) => 4 + (W - 8) * (x - ta) / ((tb - ta) || 1);
      let lo = Infinity, hi = -Infinity;
      for (const s of sig.series) for (let k = 0; k < st.length; k++) { const v = s.y[k]; if (isFinite(v) && st[k] >= ta && st[k] <= tb) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      if (!(hi > lo)) { lo = 0; hi = 1; } if (lo > 0 && lo < hi * 0.2) lo = 0;
      const Y = (v) => H - 16 - (H - 30) * (v - lo) / (hi - lo);
      g.fillStyle = C.acc; g.globalAlpha = 0.12; g.fillRect(X(T[i0]), 0, X(T[i1]) - X(T[i0]), H); g.globalAlpha = 1;
      g.strokeStyle = C.line; g.strokeRect(0.5, 0.5, W - 1, H - 1);
      if (lo < 0 && hi > 0) { g.globalAlpha = 0.4; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke(); g.globalAlpha = 1; }
      let lx = 6;
      sig.series.forEach((s, j) => {
        g.beginPath(); g.strokeStyle = s.color || COLS[j % COLS.length]; g.lineWidth = s.width || 1.2; let pen = false;
        const step = Math.max(1, Math.floor(st.length / (W * 2)));
        for (let k = 0; k < st.length; k += step) { const x = st[k]; if (x < ta || x > tb || !isFinite(s.y[k])) { pen = false; continue; } pen ? g.lineTo(X(x), Y(s.y[k])) : g.moveTo(X(x), Y(s.y[k])); pen = true; }
        g.stroke(); g.fillStyle = g.strokeStyle; g.font = "10px system-ui";
        if (lx < W - 60) { g.fillText(s.name, lx, H - 3); lx += g.measureText(s.name).width + 14; }
      });
      g.strokeStyle = C.fg; g.beginPath(); g.moveTo(X(T[fr]), 0); g.lineTo(X(T[fr]), H); g.stroke();
      for (const [k, col] of [[i0, "#2ca02c"], [i1, "#d62728"]]) {          // start / end bars, dragged with the mouse
        const x = X(T[k]); g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
        g.fillRect(x - 5, H / 2 - 12, 10, 24); g.lineWidth = 1;
      }
      gc._X = X;
      g.fillStyle = C.sub; g.font = "10px system-ui"; g.fillText(`${sig.label} · ${lo.toFixed(Math.abs(hi) < 10 ? 2 : 0)} … ${hi.toFixed(Math.abs(hi) < 10 ? 2 : 0)}`, 6, 12);
    }
    const draw3 = draw; draw = () => { draw3(); drawGrf(); };
    // mouse / touch: drag to rotate (3D), wheel or pinch to zoom
    let drag = null;
    cv.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener("pointermove", (e) => {
      if (!drag || mode !== "3d") return;
      yaw += (e.clientX - drag[0]) * 0.01; pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag[1]) * 0.01));
      drag = [e.clientX, e.clientY]; draw();
    });
    cv.addEventListener("pointerup", () => { drag = null; });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); zoom = Math.max(0.3, Math.min(6, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); draw(); }, { passive: false });
    cv.style.touchAction = "none"; cv.style.cursor = "grab";
    q("[data-mode]").onchange = (e) => { mode = e.target.value; draw(); };
    q("[data-fr]").oninput = (e) => { fr = +e.target.value; draw(); };
    d.querySelectorAll("[data-m]").forEach((c) => { c.onchange = () => { c.checked ? on.add(c.dataset.m) : on.delete(c.dataset.m); draw(); }; });
    d.querySelectorAll(".tvSide [data-all]").forEach((b) => { b.onclick = (ev) => { ev.preventDefault();
      d.querySelectorAll("[data-m]").forEach((c) => { c.checked = b.dataset.all === "1"; c.checked ? on.add(c.dataset.m) : on.delete(c.dataset.m); }); draw(); }; });
    d.querySelector("[data-x]").onclick = () => { d.close(); resolve(null); };
    d.addEventListener("cancel", () => resolve(null));
    const out = (extra) => ({ t0: +T[i0].toFixed(5), t1: +T[i1].toFixed(5), whole: i0 === 0 && i1 === n - 1, signal: sigs[sk] ? sigs[sk].key : null, ...extra });
    d.querySelector("[data-ok]").onclick = () => { d.close(); resolve(out()); };
    const sel = (k) => { const v = Math.max(0, Math.min(n - 1, k)); q("[data-fr]").value = fr = v; draw(); };
    q("[data-setS]").onclick = () => { i0 = Math.min(fr, i1); sel(fr); };
    q("[data-setE]").onclick = () => { i1 = Math.max(fr, i0); sel(fr); };
    q("[data-whole]").onclick = () => { i0 = 0; i1 = n - 1; sel(fr); };
    if (q("[data-sig]")) q("[data-sig]").onchange = (e) => { sk = +e.target.value; draw(); };
    if (q("[data-trial]")) q("[data-trial]").onchange = (e) => { d.close(); resolve(out({ switchTo: e.target.value })); };
    // typed times
    for (const [k, which] of [["[data-t0]", 0], ["[data-t1]", 1]]) q(k).onchange = (e) => {
      const v = parseFloat(String(e.target.value).replace(",", ".")); if (!isFinite(v)) { draw(); return; }
      const j = idx(v); if (which === 0) i0 = Math.min(j, i1); else i1 = Math.max(j, i0); e.target.blur(); sel(which === 0 ? i0 : i1);
    };
    // signal plot: drag the green / red bar = start / end, click or drag elsewhere = frame, wheel = zoom, double-click = whole trial
    if (gc) {
      const tAt = (e) => { const r = gc.getBoundingClientRect(); return va + (vb - va) * (e.clientX - r.left - 4) / ((r.width - 8) || 1); };
      let gdrag = null;
      gc.addEventListener("pointerdown", (e) => {
        const r = gc.getBoundingClientRect(), x = e.clientX - r.left, X = gc._X || (() => -99);
        gdrag = Math.abs(x - X(T[i0])) < 8 ? "s" : Math.abs(x - X(T[i1])) < 8 ? "e" : "f";
        gc.setPointerCapture(e.pointerId); gmove(e);
      });
      const gmove = (e) => {
        const r = gc.getBoundingClientRect(), x = e.clientX - r.left, X = gc._X || (() => -99);
        if (!gdrag) { gc.style.cursor = Math.abs(x - X(T[i0])) < 8 || Math.abs(x - X(T[i1])) < 8 ? "ew-resize" : "crosshair"; return; }
        const k = idx(tAt(e));
        if (gdrag === "s") i0 = Math.min(k, i1); else if (gdrag === "e") i1 = Math.max(k, i0);
        sel(gdrag === "s" ? i0 : gdrag === "e" ? i1 : k);
      };
      gc.addEventListener("pointermove", gmove);
      gc.addEventListener("pointerup", () => { gdrag = null; });
      gc.addEventListener("wheel", (e) => {
        e.preventDefault(); const c = tAt(e), f = e.deltaY < 0 ? 0.8 : 1.25, full = T[n - 1] - T[0];
        let a = c - (c - va) * f, b = c + (vb - c) * f;
        if (b - a > full) { a = T[0]; b = T[n - 1]; } if (b - a < 0.05) return;
        if (a < T[0]) { b += T[0] - a; a = T[0]; } if (b > T[n - 1]) { a -= b - T[n - 1]; b = T[n - 1]; }
        va = a; vb = b; draw();
      }, { passive: false });
      gc.addEventListener("dblclick", () => { va = T[0]; vb = T[n - 1]; draw(); });
    }
    window.addEventListener("resize", draw);
    d.addEventListener("close", () => window.removeEventListener("resize", draw));
    requestAnimationFrame(draw);
  });
}
