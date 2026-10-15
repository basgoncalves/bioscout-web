/**
 * Screen recording: a clip from a video the person can play but not export
 * (YouTube, a club app, a coach's message). The browser asks which screen,
 * window or tab to share; a live preview lets them draw the area the athlete
 * is in; the REC button starts and stops whenever they like -- no countdown,
 * just a camcorder red dot and a running clock. With Document Picture-in-
 * Picture (desktop Chrome / Edge) the REC button can float above the other
 * app, so they never have to come back here to press it.
 *
 * The capture is recorded whole; the drawn area travels with the clip as a
 * crop the analysis applies (analyseVideoFile's `crop`), so nothing has to be
 * drawn per frame while this tab is in the background -- a hidden tab's timers
 * are throttled, MediaRecorder is not.
 */
export const screenRecSupported = () =>
  !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);

const CSS = `
.srWrap{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px}
.srBox{background:var(--card,#1b1d24);color:var(--ink,#eee);border-radius:14px;max-width:900px;width:100%;max-height:100%;overflow:auto;padding:14px}
.srStage{position:relative;margin:10px 0;user-select:none;touch-action:none;line-height:0}
.srStage video{width:100%;height:auto;display:block;border-radius:8px;background:#000}
.srStage canvas{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair}
.srRow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.srRow button{width:auto;margin:0}
.srRec{font:700 18px ui-monospace,Consolas,monospace;letter-spacing:.08em;padding:10px 18px;border-radius:10px;
  background:#111;color:#ddd;border:2px solid #555;display:inline-flex;align-items:center;gap:10px;cursor:pointer}
.srRec .dot{width:14px;height:14px;border-radius:50%;background:#777}
.srRec.on{color:#ff3b30;border-color:#ff3b30}
.srRec.on .dot{background:#ff3b30;animation:srBlink 1s steps(1) infinite}
@keyframes srBlink{50%{opacity:0}}
`;

let cssAdded = false;
/* The share and the drawn area outlive one recording: until the page closes,
 * sharing is stopped, or "Change screen" is pressed, the next recording opens
 * on the same screen with the same area -- no picker again. */
const live = { stream: null, crop: null };
const isLive = () => !!(live.stream && live.stream.getVideoTracks().some((t) => t.readyState === "live"));

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Open the recorder. t(key) translates; onClip(file, crop|null) gets the
 * finished recording (crop in the video's own pixels).
 */
export async function openScreenRecorder({ t, onClip }) {
  let stream = isLive() ? live.stream : null;
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: false });
    } catch { return; }                     // the person closed the share picker
    live.stream = stream; live.crop = null;
    stream.getVideoTracks()[0].addEventListener("ended", () => { if (live.stream === stream) { live.stream = null; live.crop = null; } });
  }
  if (!cssAdded) {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st); cssAdded = true;
  }
  const wrap = document.createElement("div");
  wrap.className = "srWrap";
  wrap.innerHTML = `<div class="srBox">
    <b>${t("srTitle")}</b>
    <p class="note" style="margin:4px 0 0">${t("srNote")}</p>
    <div class="srStage"><video muted playsinline autoplay></video><canvas></canvas></div>
    <div class="srRow">
      <button type="button" class="srRec" data-rec><span class="dot"></span><span data-lab>REC</span></button>
      <button type="button" class="ghost" data-whole>${t("srWhole")}</button>
      ${window.documentPictureInPicture ? `<button type="button" class="ghost" data-float>${t("srFloat")}</button>` : ""}
      <button type="button" class="ghost" data-change>${t("srChange")}</button>
      <button type="button" class="ghost" data-close>${t("srClose")}</button>
      <span class="sub" data-area></span>
    </div></div>`;
  document.body.appendChild(wrap);
  const $ = (s) => wrap.querySelector(s);
  const video = $("video"), cv = $("canvas"), cx = cv.getContext("2d");
  video.srcObject = stream;
  await new Promise((r) => { if (video.videoWidth) r(); else video.onloadedmetadata = () => r(); });

  let crop = live.crop, drag = null;
  const draw = () => {
    cv.width = cv.clientWidth; cv.height = cv.clientHeight;
    cx.clearRect(0, 0, cv.width, cv.height);
    const k = cv.width / video.videoWidth;
    const r = drag || (crop && { x: crop.x * k, y: crop.y * k, w: crop.w * k, h: crop.h * k });
    $("[data-area]").textContent = crop ? `${Math.round(crop.w)}×${Math.round(crop.h)} px` : t("srWholeNow");
    if (!r) return;
    cx.fillStyle = "rgba(0,0,0,.55)"; cx.fillRect(0, 0, cv.width, cv.height);
    cx.clearRect(r.x, r.y, r.w, r.h);
    cx.strokeStyle = "#ff3b30"; cx.lineWidth = 2; cx.strokeRect(r.x, r.y, r.w, r.h);
  };
  const pt = (e) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); const [x, y] = pt(e); drag = { x0: x, y0: y, x, y, w: 0, h: 0 }; };
  cv.onpointermove = (e) => {
    if (!drag) return; const [x, y] = pt(e);
    Object.assign(drag, { x: Math.min(drag.x0, x), y: Math.min(drag.y0, y), w: Math.abs(x - drag.x0), h: Math.abs(y - drag.y0) }); draw();
  };
  cv.onpointerup = () => {
    if (!drag) return;
    const k = video.videoWidth / cv.clientWidth;
    crop = drag.w > 12 && drag.h > 12 ? { x: drag.x * k, y: drag.y * k, w: drag.w * k, h: drag.h * k } : crop;
    drag = null; live.crop = crop; draw();
  };
  const ro = new ResizeObserver(draw); ro.observe(cv); draw();

  // ------------------------------------------------------------ recording
  let rec = null, chunks = [], t0 = 0, tick = 0, pip = null;
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const buttons = () => [$("[data-rec]"), pip && pip.document.querySelector("[data-rec]")].filter(Boolean);
  const paint = () => {
    for (const b of buttons()) {
      b.classList.toggle("on", !!rec);
      b.querySelector("[data-lab]").textContent = rec ? `REC ${fmt(Date.now() - t0)}` : "REC";
    }
  };
  const close = (endShare = false) => {
    clearInterval(tick); ro.disconnect();
    video.srcObject = null;
    try { stream.getVideoTracks()[0].removeEventListener("ended", onEnded); } catch { /* gone */ }
    if (endShare) { for (const tr of stream.getTracks()) tr.stop(); live.stream = null; live.crop = null; }
    try { if (pip) pip.close(); } catch { /* gone */ }
    wrap.remove();
  };
  const start = () => {
    chunks = [];
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || mime || "video/webm";
      const file = new File(chunks, `screen_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${/mp4/.test(type) ? "mp4" : "webm"}`, { type });
      const c = crop; rec = null; paint(); close();
      if (file.size) onClip(file, c);
    };
    rec.start(1000); t0 = Date.now();
    tick = setInterval(paint, 500); paint();
  };
  const stop = () => { if (rec && rec.state !== "inactive") { clearInterval(tick); rec.stop(); } };
  const toggle = () => (rec ? stop() : start());
  $("[data-rec]").onclick = toggle;
  $("[data-whole]").onclick = () => { crop = null; live.crop = null; draw(); };
  // another screen or window: end this share and ask again
  $("[data-change]").onclick = () => { if (rec) { rec.onstop = null; rec.stop(); rec = null; } close(true); openScreenRecorder({ t, onClip }); };
  $("[data-close]").onclick = () => { if (rec) { rec.onstop = null; rec.stop(); rec = null; } close(); };
  // "Stop sharing" in the browser's own bar: keep what was recorded
  const onEnded = () => { if (rec) stop(); else close(true); };
  stream.getVideoTracks()[0].addEventListener("ended", onEnded);

  const fl = $("[data-float]");
  if (fl) fl.onclick = async () => {
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: 220, height: 90 });
      const st = pip.document.createElement("style"); st.textContent = CSS + "body{margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh}";
      pip.document.head.appendChild(st);
      pip.document.body.innerHTML = `<button type="button" class="srRec" data-rec><span class="dot"></span><span data-lab>REC</span></button>`;
      pip.document.querySelector("[data-rec]").onclick = toggle;
      pip.addEventListener("pagehide", () => { pip = null; });
      paint();
    } catch (e) { console.warn("floating REC button not available", e); }
  };
}
