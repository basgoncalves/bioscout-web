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

export function viewTrc(t, trc, range) {
  const { names, P } = trc, T = trc.t, n = T.length;
  const idx = (time) => { let k = 0; while (k < n - 1 && T[k] < time - 1e-9) k++; return k; };
  let i0 = range && isFinite(range[0]) ? idx(range[0]) : 0;
  let i1 = range && isFinite(range[1]) ? idx(range[1]) : n - 1;
  let fr = i0, mode = "3d", yaw = -0.6, pitch = 0.35, zoom = 1;
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
    const d = dialog(`<div class="tvHead"><h3 style="margin:0">${esc(t("sim_v_title"))}</h3>
        <label class="sub">${esc(t("sim_v_view"))} <select data-mode>
          <option value="3d">${esc(t("sim_v_3d"))}</option><option value="sag">${esc(t("sim_v_sag"))}</option>
          <option value="front">${esc(t("sim_v_front"))}</option><option value="top">${esc(t("sim_v_top"))}</option></select></label>
        <span class="sub" data-info></span></div>
      <div class="tvBody"><div class="tvPlots"><canvas data-c></canvas><div class="note" data-hint>${esc(t("sim_v_hint"))}</div></div>
        <div class="tvSide"><div class="sub">${esc(t("sim_v_markers"))}</div>
          <div class="twBar"><button type="button" class="ghost" data-all="1">${esc(t("sim_tw_all"))}</button><button type="button" class="ghost" data-all="0">${esc(t("sim_tw_none"))}</button></div>
          <div class="tvList">${names.map((m) => `<label><input type="checkbox" data-m="${esc(m)}"${on.has(m) ? " checked" : ""}> ${esc(m)}</label>`).join("")}</div></div></div>
      <label class="tvSl"><span>${esc(t("sim_v_frame"))}</span><input type="range" min="0" max="${n - 1}" value="${fr}" data-fr><b data-frt></b></label>
      <label class="tvSl"><span>${esc(t("sim_v_start"))}</span><input type="range" min="0" max="${n - 1}" value="${i0}" data-i0><b data-t0></b></label>
      <label class="tvSl"><span>${esc(t("sim_v_end"))}</span><input type="range" min="0" max="${n - 1}" value="${i1}" data-i1><b data-t1></b></label>
      <div class="twBar" style="justify-content:flex-end"><button type="button" class="ghost" data-x>${esc(t("cancel"))}</button>
        <button type="button" data-ok>${esc(t("sim_v_use"))}</button></div>`);
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
    function draw() {
      q("[data-frt]").textContent = T[fr].toFixed(3) + " s";
      q("[data-t0]").textContent = T[i0].toFixed(3) + " s";
      q("[data-t1]").textContent = T[i1].toFixed(3) + " s";
      q("[data-info]").textContent = `${names.length} ${t("sim_v_nmk")} · ${n} ${t("sim_v_nfr")} · ${T[0].toFixed(2)}–${T[n - 1].toFixed(2)} s`;
      q("[data-hint]").style.visibility = mode === "3d" ? "visible" : "hidden";
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 500;
      const H = Math.max(260, Math.min(window.innerHeight * 0.55, W * 0.75));
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
    q("[data-i0]").oninput = (e) => { i0 = Math.min(+e.target.value, i1); e.target.value = i0; fr = i0; q("[data-fr]").value = fr; draw(); };
    q("[data-i1]").oninput = (e) => { i1 = Math.max(+e.target.value, i0); e.target.value = i1; fr = i1; q("[data-fr]").value = fr; draw(); };
    d.querySelectorAll("[data-m]").forEach((c) => { c.onchange = () => { c.checked ? on.add(c.dataset.m) : on.delete(c.dataset.m); draw(); }; });
    d.querySelectorAll(".tvSide [data-all]").forEach((b) => { b.onclick = () => {
      d.querySelectorAll("[data-m]").forEach((c) => { c.checked = b.dataset.all === "1"; c.checked ? on.add(c.dataset.m) : on.delete(c.dataset.m); }); draw(); }; });
    d.querySelector("[data-x]").onclick = () => { d.close(); resolve(null); };
    d.addEventListener("cancel", () => resolve(null));
    d.querySelector("[data-ok]").onclick = () => { d.close(); resolve({ t0: +T[i0].toFixed(5), t1: +T[i1].toFixed(5) }); };
    window.addEventListener("resize", draw);
    d.addEventListener("close", () => window.removeEventListener("resize", draw));
    requestAnimationFrame(draw);
  });
}
