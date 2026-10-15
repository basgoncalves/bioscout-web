/* BioFeedback (testing) -- camera pose -> one joint metric -> threshold ->
 * an Arduino lamp over Web Serial.
 *
 * The Arduino side is assets/arduino/biofeedback_lamp.ino: it reads '1'/'0'
 * at the chosen baud and switches pin 13 (and a relay on pin 7).
 *
 * Web Serial exists only in Chromium desktop browsers (Chrome, Edge, Opera)
 * over https or localhost; elsewhere the screen still runs and shows the
 * light on screen, it just cannot reach a board.
 *
 * Angles come from MediaPipe WORLD landmarks (metres, 3D, hip-centred), so
 * they do not depend on how the person stands relative to the camera the way
 * 2D image angles do. They are camera estimates, not motion capture.
 */

const L = { sh: [11, 12], el: [13, 14], wr: [15, 16], hip: [23, 24], kn: [25, 26], an: [27, 28] };
const side = (s) => (s === "R" ? 1 : 0);
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
function ang(a, b, c) {           // angle at b, degrees, 3D
  const u = sub(a, b), v = sub(c, b);
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const m = Math.hypot(...u) * Math.hypot(...v);
  return m < 1e-9 ? NaN : (Math.acos(Math.max(-1, Math.min(1, d / m))) * 180) / Math.PI;
}
const midp = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/* Each metric: key, i18n label key, compute(world landmarks). Flexion is
 * 180 - included angle so standing straight reads ~0. */
export const METRICS = {
  kneeFlexL: { label: "bfb_m_kneeFlexL", f: (w) => 180 - ang(w[L.hip[0]], w[L.kn[0]], w[L.an[0]]) },
  kneeFlexR: { label: "bfb_m_kneeFlexR", f: (w) => 180 - ang(w[L.hip[1]], w[L.kn[1]], w[L.an[1]]) },
  hipFlexL:  { label: "bfb_m_hipFlexL",  f: (w) => 180 - ang(w[L.sh[0]], w[L.hip[0]], w[L.kn[0]]) },
  hipFlexR:  { label: "bfb_m_hipFlexR",  f: (w) => 180 - ang(w[L.sh[1]], w[L.hip[1]], w[L.kn[1]]) },
  elbowFlexL:{ label: "bfb_m_elbowFlexL",f: (w) => 180 - ang(w[L.sh[0]], w[L.el[0]], w[L.wr[0]]) },
  elbowFlexR:{ label: "bfb_m_elbowFlexR",f: (w) => 180 - ang(w[L.sh[1]], w[L.el[1]], w[L.wr[1]]) },
  shAbdL:    { label: "bfb_m_shAbdL",    f: (w) => ang(w[L.hip[0]], w[L.sh[0]], w[L.el[0]]) },
  shAbdR:    { label: "bfb_m_shAbdR",    f: (w) => ang(w[L.hip[1]], w[L.sh[1]], w[L.el[1]]) },
  trunkLean: { label: "bfb_m_trunkLean", f: (w) => {   // vs vertical; world y points down
    const s = midp(w[11], w[12]), h = midp(w[23], w[24]);
    const v = sub(s, h), m = Math.hypot(...v);
    return m < 1e-9 ? NaN : (Math.acos(Math.max(-1, Math.min(1, -v[1] / m))) * 180) / Math.PI;
  } },
};

/* Movement presets: which metrics make sense and a starting threshold. */
export const MOVES = {
  squat:  { label: "bfb_mv_squat",  metrics: ["kneeFlexL", "kneeFlexR", "hipFlexL", "hipFlexR", "trunkLean"], def: "kneeFlexL", thr: 70, dir: "above" },
  lunge:  { label: "bfb_mv_lunge",  metrics: ["kneeFlexL", "kneeFlexR", "hipFlexL", "hipFlexR", "trunkLean"], def: "kneeFlexL", thr: 80, dir: "above" },
  curl:   { label: "bfb_mv_curl",   metrics: ["elbowFlexL", "elbowFlexR"], def: "elbowFlexR", thr: 110, dir: "above" },
  raise:  { label: "bfb_mv_raise",  metrics: ["shAbdL", "shAbdR"], def: "shAbdR", thr: 90, dir: "above" },
  hinge:  { label: "bfb_mv_hinge",  metrics: ["trunkLean", "hipFlexL", "hipFlexR", "kneeFlexL", "kneeFlexR"], def: "trunkLean", thr: 45, dir: "above" },
  free:   { label: "bfb_mv_free",   metrics: Object.keys(METRICS), def: "kneeFlexL", thr: 70, dir: "above" },
};

const SKEL = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const SKEY = "bioscout.biofeedback.v1";

/** Wire up #viewBiofeedback. deps: { $, tr, getLandmarker } */
export function initBiofeedback({ $, tr, getLandmarker }) {
  const st = {
    port: null, writer: null, reader: null, lm: null, stream: null, raf: 0,
    active: false, lit: null, value: NaN, lastTs: -1,
  };
  let cfg = { move: "squat", metric: "kneeFlexL", thr: 70, dir: "above", hyst: 3, baud: 9600, invert: false };
  try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(SKEY) || "{}") }; } catch { /* private */ }
  const save = () => { try { localStorage.setItem(SKEY, JSON.stringify(cfg)); } catch { /* full */ } };

  const hasSerial = "serial" in navigator;
  const status = (k, vars, bad) => { const e = $("bfbPortStatus"); e.textContent = tr(k, vars); e.classList.toggle("bad", !!bad); };
  const log = (s) => { const e = $("bfbLog"); e.textContent = (s + "\n" + e.textContent).slice(0, 2000); };

  /* ---------- selects ---------- */
  function fillMoves() {
    $("bfbMove").innerHTML = Object.entries(MOVES).map(([k, m]) => `<option value="${k}">${tr(m.label)}</option>`).join("");
    $("bfbMove").value = cfg.move;
  }
  function fillMetrics() {
    const mv = MOVES[cfg.move] || MOVES.free;
    if (!mv.metrics.includes(cfg.metric)) cfg.metric = mv.def;
    $("bfbMetric").innerHTML = mv.metrics.map((k) => `<option value="${k}">${tr(METRICS[k].label)}</option>`).join("");
    $("bfbMetric").value = cfg.metric;
  }
  function syncInputs() {
    $("bfbThr").value = cfg.thr; $("bfbThrN").value = cfg.thr;
    $("bfbDir").value = cfg.dir; $("bfbHyst").value = cfg.hyst; $("bfbBaud").value = String(cfg.baud);
  }
  $("bfbMove").onchange = () => {
    cfg.move = $("bfbMove").value; const mv = MOVES[cfg.move];
    cfg.metric = mv.def; cfg.thr = mv.thr; cfg.dir = mv.dir;
    fillMetrics(); syncInputs(); save();
  };
  $("bfbMetric").onchange = () => { cfg.metric = $("bfbMetric").value; save(); };
  $("bfbThr").oninput = () => { cfg.thr = +$("bfbThr").value; $("bfbThrN").value = cfg.thr; save(); };
  $("bfbThrN").onchange = () => { cfg.thr = Math.max(0, Math.min(180, +$("bfbThrN").value || 0)); $("bfbThr").value = cfg.thr; save(); };
  $("bfbDir").onchange = () => { cfg.dir = $("bfbDir").value; save(); };
  $("bfbHyst").onchange = () => { cfg.hyst = Math.max(0, +$("bfbHyst").value || 0); save(); };
  $("bfbBaud").onchange = async () => { cfg.baud = +$("bfbBaud").value; save(); if (st.port) await openPort(st.port); };

  /* ---------- serial ---------- */
  async function listPorts() {
    const sel = $("bfbPortSel");
    if (!hasSerial) { sel.innerHTML = ""; return; }
    const ports = await navigator.serial.getPorts();
    sel.innerHTML = `<option value="">${tr("bfb_portPick")}</option>` + ports.map((p, i) => {
      const inf = p.getInfo(); const id = inf.usbVendorId ? `USB ${inf.usbVendorId.toString(16)}:${(inf.usbProductId || 0).toString(16)}` : tr("bfb_portN", { n: i + 1 });
      return `<option value="${i}">${id}${p === st.port ? " ✓" : ""}</option>`;
    }).join("");
    sel._ports = ports;
    if (st.port) sel.value = String(ports.indexOf(st.port));
  }
  async function closePort() {
    try { if (st.reader) { await st.reader.cancel(); st.reader.releaseLock(); } } catch { /* gone */ }
    try { if (st.writer) { st.writer.releaseLock(); } } catch { /* gone */ }
    try { if (st.port) await st.port.close(); } catch { /* already closed */ }
    st.reader = st.writer = null; st.lit = null;
  }
  async function openPort(port) {
    await closePort();
    try {
      await port.open({ baudRate: cfg.baud });
      st.port = port; st.writer = port.writable.getWriter();
      status("bfb_portOpen", { baud: cfg.baud });
      readLoop(port);
      await listPorts();
      // Uno-style boards reset when the port opens; give the bootloader a moment.
      setTimeout(() => send(false, true), 1800);
    } catch (e) { st.port = null; status("bfb_portFail", { err: e.message }, true); }
    renderConn();
  }
  async function readLoop(port) {
    const dec = new TextDecoder(); let buf = "";
    try {
      st.reader = port.readable.getReader();
      for (;;) {
        const { value, done } = await st.reader.read(); if (done) break;
        buf += dec.decode(value); let i;
        while ((i = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln) log("← " + ln); }
      }
    } catch { /* port closed or unplugged */ }
  }
  async function send(on, force = false) {
    if (cfg.invert) on = !on;
    if (!force && st.lit === on) return;
    st.lit = on;
    $("bfbLamp").classList.toggle("on", on);
    if (!st.writer) return;
    try { await st.writer.write(new TextEncoder().encode(on ? "1\n" : "0\n")); log("→ " + (on ? "1" : "0")); }
    catch (e) { status("bfb_portFail", { err: e.message }, true); }
  }
  function renderConn() {
    $("bfbDisconnect").disabled = !st.port;
    $("bfbTestOn").disabled = $("bfbTestOff").disabled = !st.port;
  }
  $("bfbChoosePort").onclick = async () => {
    if (!hasSerial) return;
    try { const p = await navigator.serial.requestPort(); await openPort(p); }
    catch { /* user cancelled the picker */ }
  };
  $("bfbPortSel").onchange = async () => {
    const p = ($("bfbPortSel")._ports || [])[+$("bfbPortSel").value];
    if (p && p !== st.port) await openPort(p);
  };
  $("bfbDisconnect").onclick = async () => { await send(false, true); await closePort(); st.port = null; status("bfb_portNone"); renderConn(); listPorts(); };
  $("bfbTestOn").onclick = () => send(true, true);
  $("bfbTestOff").onclick = () => send(false, true);
  if (hasSerial) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (e.target === st.port) { closePort(); st.port = null; status("bfb_portLost", null, true); renderConn(); }
      listPorts();
    });
    navigator.serial.addEventListener("connect", listPorts);
  }

  /* ---------- camera + pose ---------- */
  async function startCam() {
    if (st.stream) return true;
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = $("bfbVideo"); v.srcObject = st.stream; await v.play();
      return true;
    } catch (e) { $("bfbCamNote").textContent = tr("bfb_camFail", { err: e.message }); return false; }
  }
  function stopCam() {
    cancelAnimationFrame(st.raf); st.raf = 0;
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
  }
  let ema = NaN, on = false;
  function frame() {
    st.raf = requestAnimationFrame(frame);
    const v = $("bfbVideo"); if (!st.lm || v.readyState < 2) return;
    let ts = performance.now(); if (ts <= st.lastTs) ts = st.lastTs + 1; st.lastTs = ts;
    const r = st.lm.detectForVideo(v, ts);
    const cv = $("bfbCanvas"), ctx = cv.getContext("2d");
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const img = r.landmarks && r.landmarks[0], w = r.worldLandmarks && r.worldLandmarks[0];
    if (!img || !w) { $("bfbValue").textContent = "–"; if (st.active) send(false); return; }
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(80,200,170,.9)";
    for (const [a, b] of SKEL) { ctx.beginPath(); ctx.moveTo(img[a].x * cv.width, img[a].y * cv.height); ctx.lineTo(img[b].x * cv.width, img[b].y * cv.height); ctx.stroke(); }
    const raw = METRICS[cfg.metric].f(w);
    if (!Number.isFinite(raw)) return;
    ema = Number.isFinite(ema) ? ema + 0.35 * (raw - ema) : raw;     // light smoothing against jitter
    st.value = ema;
    $("bfbValue").textContent = ema.toFixed(0) + "°";
    $("bfbBarFill").style.width = Math.max(0, Math.min(100, (ema / 180) * 100)) + "%";
    $("bfbBarThr").style.left = (cfg.thr / 180) * 100 + "%";
    // Hysteresis: switch on past thr, off only once back by `hyst` degrees.
    const h = cfg.hyst;
    if (cfg.dir === "above") on = on ? ema > cfg.thr - h : ema > cfg.thr;
    else on = on ? ema < cfg.thr + h : ema < cfg.thr;
    $("bfbValue").classList.toggle("hit", on);
    if (st.active) send(on);
  }
  $("bfbCamBtn").onclick = async () => {
    if (st.stream) { stopCam(); $("bfbCamBtn").textContent = tr("bfb_camStart"); return; }
    $("bfbCamNote").textContent = tr("bfb_loadingModel");
    if (!st.lm) { st.lm = await getLandmarker(); if (!st.lm) { $("bfbCamNote").textContent = tr("bfb_modelFail"); return; } }
    if (!(await startCam())) return;
    $("bfbCamNote").textContent = "";
    $("bfbCamBtn").textContent = tr("bfb_camStop");
    frame();
  };
  $("bfbActivate").onclick = () => {
    st.active = !st.active;
    $("bfbActivate").textContent = tr(st.active ? "bfb_deactivate" : "bfb_activate");
    $("bfbActivate").classList.toggle("danger", st.active);
    if (!st.active) send(false, true);
  };

  /* ---------- open / leave ---------- */
  function open() {
    $("bfbNoSerial").classList.toggle("hidden", hasSerial);
    fillMoves(); fillMetrics(); syncInputs(); renderConn(); listPorts();
    if (!st.port) status("bfb_portNone");
  }
  async function leave() {
    if (st.active) $("bfbActivate").click();
    stopCam(); $("bfbCamBtn").textContent = tr("bfb_camStart");
  }
  return { open, leave, relabel: () => { fillMoves(); fillMetrics(); } };
}
