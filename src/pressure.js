/* Pressure sensor on the BioFeedback Arduino (sketch v4, A0).
 *
 * The board streams "F <0-1023>" lines at 50 Hz after 'S' ('s' stops,
 * 'F' asks for one reading). This module shows the live reading, keeps the
 * last 10 s as a trace, lets the user set zero (unloaded) and max (full
 * press), and can drive the lamp levels from the pressure instead of the
 * camera metric. An FSR is strongly non-linear and drifts, so the app shows
 * raw counts and % of the calibrated range - never newtons.
 *
 * Wiring: _private/arduino_server/arduino_setup.md
 */
const KEY = "bioscout.bfb.fsr.v1";
const SPAN_MS = 10000;

/** Level 0-3 for a % value given ascending thresholds, with hysteresis. */
export function pressureLevel(pct, thr, prev = 0, hyst = 3) {
  if (!Number.isFinite(pct)) return 0;
  let lv = 0;
  thr.forEach((t, i) => { if (Number.isFinite(t) && pct >= t - (prev > i ? hyst : 0)) lv = i + 1; });
  return lv;
}

/** "F 512" -> 512, anything else -> null. */
export function parseF(ln) {
  const m = /^F\s+(\d{1,4})$/.exec(ln);
  return m ? Math.min(1023, +m[1]) : null;
}

export function initPressure({ $, tr, writeLine, sendLevel }) {
  let cfg = { zero: 0, max: 1023, lamp: false, thr: [30, 60, 90], disp: "off" };
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* private */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* full */ } };
  const st = { streaming: false, raw: NaN, t0: 0, buf: [], all: [], lv: 0, has: false, disp: false, raf: 0, lastD: 0, sentD: null };

  const pct = (raw) => {
    const span = cfg.max - cfg.zero;
    return span > 5 ? Math.max(0, Math.min(100, (100 * (raw - cfg.zero)) / span)) : NaN;
  };

  function render() {
    const v = st.raw, p = pct(v);
    $("bfbFsrRaw").textContent = Number.isFinite(v) ? String(v) : "–";
    $("bfbFsrPct").textContent = Number.isFinite(p) ? p.toFixed(0) + " %" : "–";
    $("bfbFsrBar").style.width = (Number.isFinite(p) ? p : 0) + "%";
    $("bfbFsrCal").textContent = tr("bfb_fsrCal", { z: cfg.zero, m: cfg.max });
    $("bfbFsrStream").textContent = tr(st.streaming ? "bfb_fsrStop" : "bfb_fsrStart");
    $("bfbFsrCsv").disabled = !st.all.length;
  }
  function draw() {
    st.raf = 0;
    const cv = $("bfbFsrCv"), ctx = cv.getContext("2d");
    const w = (cv.width = cv.clientWidth || 300), h = (cv.height = 80);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(cv);
    ctx.strokeStyle = css.getPropertyValue("--line") || "#888"; ctx.globalAlpha = 0.5;
    for (const t of cfg.thr) if (Number.isFinite(t)) { const y = h - (t / 100) * h; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
    if (st.buf.length < 2) return;
    const tEnd = st.buf[st.buf.length - 1][0];
    ctx.strokeStyle = css.getPropertyValue("--acc") || "#3a8ee8"; ctx.lineWidth = 2; ctx.beginPath();
    st.buf.forEach(([t, r], i) => {
      const x = w - ((tEnd - t) / SPAN_MS) * w, p = pct(r), y = h - ((Number.isFinite(p) ? p : r / 10.23) / 100) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  /** Feed every serial line here; returns true when it was a pressure line. */
  function onLine(ln) {
    if (/^BIOSCOUT_LAMP_READY/.test(ln)) {
      st.has = /FSR/.test(ln); st.disp = /DISP/.test(ln);
      $("bfbFsrNote").textContent = !st.has ? tr("bfb_fsrOld") : !st.disp && cfg.disp !== "off" ? tr("bfb_fsrDispOld") : "";
      setTimeout(applyDisp, 300); return false;
    }
    if (ln === "DISP_ON" || ln === "DISP_OFF") return true;
    if (ln === "STREAM_ON" || ln === "STREAM_OFF") { st.streaming = ln === "STREAM_ON"; render(); return true; }
    const raw = parseF(ln); if (raw == null) return false;
    const now = performance.now(); if (!st.t0) st.t0 = now;
    st.raw = raw; st.buf.push([now, raw]); st.all.push([now - st.t0, raw]);
    while (st.buf.length && st.buf[0][0] < now - SPAN_MS) st.buf.shift();
    if (st.all.length > 200000) st.all.splice(0, 50000);   // ~1 h at 50 Hz
    if (cfg.lamp) {
      const lv = pressureLevel(pct(raw), cfg.thr, st.lv);
      if (lv !== st.lv) { st.lv = lv; sendLevel(lv); }
    }
    if (cfg.disp === "pct" && st.disp && now - st.lastD > 200) {   // 5 per second is plenty for the eye
      const p = pct(raw), txt = Number.isFinite(p) ? "D" + Math.round(p) : "D";
      if (txt !== st.sentD) { st.sentD = txt; writeLine(txt, true); }
      st.lastD = now;
    }
    render(); if (!st.raf) st.raf = requestAnimationFrame(draw);
    return true;
  }

  $("bfbFsrStream").onclick = () => { st.streaming = !st.streaming; writeLine(st.streaming ? "S" : "s"); render(); };
  $("bfbFsrOnce").onclick = () => writeLine("F");
  $("bfbFsrZero").onclick = () => { if (Number.isFinite(st.raw)) { cfg.zero = st.raw; if (cfg.max <= cfg.zero) cfg.max = 1023; save(); render(); } };
  $("bfbFsrMax").onclick = () => { if (Number.isFinite(st.raw) && st.raw > cfg.zero + 5) { cfg.max = st.raw; save(); render(); } };
  /* 4-digit display on the board (sketch v6): off, the app's % (sent as
   * D<n>), or the board's own raw A0 reading (plain D, no traffic). */
  function applyDisp() {
    st.sentD = null;
    if (!st.disp) return;
    writeLine(cfg.disp === "off" ? "d" : "D");
  }
  $("bfbFsrDisp").value = cfg.disp;
  $("bfbFsrDisp").onchange = () => { cfg.disp = $("bfbFsrDisp").value; save(); applyDisp(); };
  $("bfbFsrLamp").checked = !!cfg.lamp;
  $("bfbFsrLamp").onchange = () => { cfg.lamp = $("bfbFsrLamp").checked; st.lv = 0; save(); if (!cfg.lamp) sendLevel(0); };
  $("bfbFsrThr").value = cfg.thr.join(", ");
  $("bfbFsrThr").onchange = () => {
    const t = $("bfbFsrThr").value.split(/[,;\s]+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= 100).slice(0, 3).sort((a, b) => a - b);
    if (t.length) cfg.thr = t; $("bfbFsrThr").value = cfg.thr.join(", "); save(); draw();
  };
  $("bfbFsrCsv").onclick = () => {
    const rows = ["t_ms,raw,pct"].concat(st.all.map(([t, r]) => `${t.toFixed(0)},${r},${(pct(r) || 0).toFixed(1)}`));
    const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" })), a = document.createElement("a");
    a.href = url; a.download = `pressure_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
  };
  render();

  return {
    onLine,
    /** Camera loop asks this before driving the lamp. */
    drivesLamp: () => !!cfg.lamp,
    onOpen() { st.streaming = false; st.has = st.disp = false; render(); },
    onClose() { st.streaming = false; st.raw = NaN; render(); },
  };
}
