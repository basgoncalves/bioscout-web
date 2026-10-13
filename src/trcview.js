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
export function viewTrc(t, trc, range) {
  const { names, P } = trc, T = trc.t, n = T.length;
  const idx = (time) => { let k = 0; while (k < n - 1 && T[k] < time - 1e-9) k++; return k; };
  let i0 = range && isFinite(range[0]) ? idx(range[0]) : 0;
  let i1 = range && isFinite(range[1]) ? idx(range[1]) : n - 1;
  let fr = i0;
  const on = new Set(names.filter((m) => /ASI|PSI|SACR|HEE|TOE|C7/i.test(m)));
  // bounds per axis (finite values only)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of names) for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) {
    const v = P[m][3 * k + a]; if (isFinite(v)) { lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v); }
  }
  const css = getComputedStyle(document.documentElement);
  const C = { fg: css.getPropertyValue("--text").trim() || "#ddd", line: css.getPropertyValue("--line").trim() || "#555",
    acc: css.getPropertyValue("--accent").trim() || "#4ab", sub: css.getPropertyValue("--sub").trim() || "#999" };
  const VIEWS = [["sim_v_sag", 0, 1], ["sim_v_front", 2, 1], ["sim_v_top", 0, 2]];
  return new Promise((resolve) => {
    const d = dialog(`<div class="tvHead"><h3 style="margin:0">${esc(t("sim_v_title"))}</h3>
        <span class="sub" data-info></span></div>
      <div class="tvBody"><div class="tvPlots">${VIEWS.map(([k]) => `<div><div class="sub">${esc(t(k))}</div><canvas data-c></canvas></div>`).join("")}</div>
        <div class="tvSide"><div class="sub">${esc(t("sim_v_markers"))}</div>
          <div class="twBar"><button type="button" class="ghost" data-all="1">${esc(t("sim_tw_all"))}</button><button type="button" class="ghost" data-all="0">${esc(t("sim_tw_none"))}</button></div>
          <div class="tvList">${names.map((m) => `<label><input type="checkbox" data-m="${esc(m)}"${on.has(m) ? " checked" : ""}> ${esc(m)}</label>`).join("")}</div></div></div>
      <label class="tvSl"><span>${esc(t("sim_v_frame"))}</span><input type="range" min="0" max="${n - 1}" value="${fr}" data-fr><b data-frt></b></label>
      <label class="tvSl"><span>${esc(t("sim_v_start"))}</span><input type="range" min="0" max="${n - 1}" value="${i0}" data-i0><b data-t0></b></label>
      <label class="tvSl"><span>${esc(t("sim_v_end"))}</span><input type="range" min="0" max="${n - 1}" value="${i1}" data-i1><b data-t1></b></label>
      <div class="twBar" style="justify-content:flex-end"><button type="button" class="ghost" data-x>${esc(t("cancel"))}</button>
        <button type="button" data-ok>${esc(t("sim_v_use"))}</button></div>`);
    const cans = [...d.querySelectorAll("[data-c]")];
    const q = (s) => d.querySelector(s);
    function draw() {
      q("[data-frt]").textContent = T[fr].toFixed(3) + " s";
      q("[data-t0]").textContent = T[i0].toFixed(3) + " s";
      q("[data-t1]").textContent = T[i1].toFixed(3) + " s";
      q("[data-info]").textContent = `${names.length} ${t("sim_v_nmk")} · ${n} ${t("sim_v_nfr")} · ${T[0].toFixed(2)}–${T[n - 1].toFixed(2)} s`;
      VIEWS.forEach(([, ax, ay], vi) => {
        const cv = cans[vi], dpr = window.devicePixelRatio || 1;
        const W = cv.clientWidth || 300, sx = hi[ax] - lo[ax] || 1, sy = hi[ay] - lo[ay] || 1;
        const pad = 16, H = Math.max(110, Math.min(320, (W - 2 * pad) * sy / sx + 2 * pad));
        cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
        const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
        const s = Math.min((W - 2 * pad) / sx, (H - 2 * pad) / sy);
        const ox = pad + ((W - 2 * pad) - sx * s) / 2, oy = pad + ((H - 2 * pad) - sy * s) / 2;
        // top view: Z points toward the viewer's bottom like the course figures; Y up elsewhere
        const X = (v) => ox + (v - lo[ax]) * s, Y = (v) => (ay === 2 ? oy + (v - lo[ay]) * s : H - oy - (v - lo[ay]) * s);
        g.strokeStyle = C.line; g.lineWidth = 1; g.strokeRect(0.5, 0.5, W - 1, H - 1);
        for (const m of names) {
          const p = P[m], hl = on.has(m);
          g.beginPath(); let pen = false;
          for (let k = 0; k < n; k++) {
            const x = p[3 * k + ax], y = p[3 * k + ay];
            if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
            pen ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); pen = true;
          }
          g.globalAlpha = hl ? 0.55 : 0.25; g.strokeStyle = hl ? C.acc : C.sub; g.lineWidth = 1; g.stroke();
          // the selected range drawn on top, thicker
          g.beginPath(); pen = false;
          for (let k = i0; k <= i1; k++) {
            const x = p[3 * k + ax], y = p[3 * k + ay];
            if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
            pen ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); pen = true;
          }
          g.globalAlpha = hl ? 1 : 0.6; g.lineWidth = hl ? 2 : 1.2; g.stroke(); g.globalAlpha = 1;
          const x = p[3 * fr + ax], y = p[3 * fr + ay];
          if (isFinite(x) && isFinite(y)) {
            g.fillStyle = hl ? C.acc : C.fg;
            g.beginPath(); g.arc(X(x), Y(y), hl ? 5 : 1.8, 0, 7); g.fill();
            if (hl && vi === 0) { g.font = "10px system-ui"; g.fillText(m, X(x) + 6, Y(y) - 4); }
          }
        }
      });
    }
    q("[data-fr]").oninput = (e) => { fr = +e.target.value; draw(); };
    q("[data-i0]").oninput = (e) => { i0 = Math.min(+e.target.value, i1); e.target.value = i0; fr = i0; q("[data-fr]").value = fr; draw(); };
    q("[data-i1]").oninput = (e) => { i1 = Math.max(+e.target.value, i0); e.target.value = i1; fr = i1; q("[data-fr]").value = fr; draw(); };
    d.querySelectorAll("[data-m]").forEach((c) => { c.onchange = () => { c.checked ? on.add(c.dataset.m) : on.delete(c.dataset.m); draw(); }; });
    d.querySelectorAll(".tvSide [data-all]").forEach((b) => { b.onclick = () => {
      d.querySelectorAll("[data-m]").forEach((c) => { c.checked = b.dataset.all === "1"; c.checked ? on.add(c.dataset.m) : on.delete(c.dataset.m); }); draw(); }; });
    d.querySelector("[data-x]").onclick = () => { d.close(); resolve(null); };
    d.addEventListener("cancel", () => resolve(null));
    d.querySelector("[data-ok]").onclick = () => { d.close(); resolve({ t0: +T[i0].toFixed(5), t1: +T[i1].toFixed(5) }); };
    requestAnimationFrame(draw);
  });
}
