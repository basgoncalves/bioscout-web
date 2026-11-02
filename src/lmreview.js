/**
 * lmreview.js -- see the pose landmarks on the video.
 *
 *  1. createPreview(): while a file / URL clip is tracked, a small live view of
 *     the frame being tracked with its skeleton, refreshed a few times a second
 *     (not every frame: drawing must not slow the tracking). Hidden when done.
 *  2. openReview(): after the analysis, step through the tracked frames one by
 *     one (slider, previous / next, arrow keys) to judge whether the landmarks
 *     sat on the body, then Keep or Discard the trial.
 *
 * Landmarks arrive "named" ({nose: [x, y, z], ...}) in the pixels of the frame
 * the model saw -- the crop rectangle when the clip was cropped.
 */

const BONES = [["left_shoulder", "right_shoulder"], ["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"], ["right_elbow", "right_wrist"], ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"], ["left_hip", "right_hip"], ["left_hip", "left_knee"], ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"], ["right_knee", "right_ankle"], ["left_ankle", "left_foot_index"],
  ["right_ankle", "right_foot_index"], ["left_ankle", "left_heel"], ["right_ankle", "right_heel"],
  ["left_ear", "nose"], ["nose", "right_ear"]];

/** Skeleton of named landmarks onto ctx; k scales frame pixels to canvas. */
export function drawPose(ctx, lm, k = 1, ox = 0, oy = 0) {
  if (!lm) return;
  const P = (n) => lm[n] && [ox + lm[n][0] * k, oy + lm[n][1] * k];
  ctx.lineWidth = Math.max(2, 3 * k); ctx.strokeStyle = "rgba(80,200,170,.95)";
  for (const [a, b] of BONES) {
    const p = P(a), q = P(b); if (!p || !q) continue;
    ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,213,74,.95)";
  for (const n of Object.keys(lm)) { const p = P(n); ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(2.5, 3.5 * k), 0, 7); ctx.fill(); }
}

/**
 * Where a click on the canvas lands in FRAME pixels.
 *
 * Two letterboxings sit between a finger and a landmark, and both have to be
 * undone or the point jumps:
 *   1. the CSS box -> the bitmap. The canvas is capped with object-fit:contain
 *      so a portrait clip fits a phone screen, so the bitmap is centred inside
 *      the element with bars around it.
 *   2. the bitmap -> the frame, which paint() centres the same way.
 * Pure so it can be tested without a browser.
 */
export function frameFromClient(clientX, clientY, rect, cw, ch, sw, sh) {
  const fit = Math.min(rect.width / cw, rect.height / ch);
  const padX = (rect.width - cw * fit) / 2, padY = (rect.height - ch * fit) / 2;
  const bx = (clientX - rect.left - padX) / fit, by = (clientY - rect.top - padY) / fit;
  const kk = Math.min(cw / sw, ch / sh);
  const ox = (cw - sw * kk) / 2, oy = (ch - sh * kk) / 2;
  return [(bx - ox) / kk, (by - oy) / kk];
}

/** Draw `src` (video / canvas / bitmap), optionally a crop of it, scaled into cv. */
function paint(cv, src, sw, sh, crop, lm) {
  const ctx = cv.getContext("2d");
  const k = Math.min(cv.width / sw, cv.height / sh), dw = sw * k, dh = sh * k;
  const ox = (cv.width - dw) / 2, oy = (cv.height - dh) / 2;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
  try {
    if (crop) ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, ox, oy, dw, dh);
    else ctx.drawImage(src, ox, oy, dw, dh);
  } catch { /* frame not decodable yet */ }
  drawPose(ctx, lm, k, ox, oy);
}

/** Live preview box placed after `anchor`. draw() is throttled to ~6/s. */
export function createPreview(anchor, tr) {
  let box = document.querySelector(".lmPreview");
  if (!box) {
    box = document.createElement("div");
    box.className = "lmPreview hidden";
    box.innerHTML = `<div class="note" style="margin:0 0 4px">${tr("lmPreviewTitle")}</div><canvas width="480" height="270"></canvas>`;
    anchor.insertAdjacentElement("afterend", box);
  }
  const cv = box.querySelector("canvas");
  let last = 0;
  return {
    show() { box.classList.remove("hidden"); last = 0; },
    hide() { box.classList.add("hidden"); },
    draw(src, lm, w, h, crop = null) {
      const now = performance.now(); if (now - last < 160) return; last = now;
      const sw = crop ? crop.w : w, sh = crop ? crop.h : h;
      cv.height = Math.round(cv.width * (sh / sw)) || 270;
      paint(cv, src, sw, sh, crop, lm);
    },
  };
}

/**
 * Frame-by-frame review in a dialog.
 *   file    the clip (Blob/File)       frames  [{i, t (ms), lm}] as tracked
 *   fw, fh  frame size the model saw   crop    {x,y,w,h} or null
 *   onKeep / onDiscard                 callbacks
 */
export function openReview({ file, frames, fw, fh, crop = null, fps = null, tr,
                             onKeep, onDiscard, onApply }) {
  if (!file || !frames || !frames.length) return;
  /* Work on a COPY. Nothing the reviewer drags or trims touches the analysed
   * frames until they press Apply, so closing the dialog is always a no-op. */
  const work = frames.map((f) => ({ ...f, lm: f.lm ? Object.fromEntries(
    Object.entries(f.lm).map(([n, p]) => [n, p.slice()])) : f.lm }));
  let a = 0, b = work.length - 1;          // the kept span
  let edited = false;

  const dlg = document.createElement("dialog");
  dlg.className = "lmReview";
  dlg.innerHTML = `
    <div class="lmHead"><b>${tr("lmReviewTitle")}</b><button type="button" class="ghost lmX" aria-label="Close">&#10005;</button></div>
    <div class="lmStage"><canvas width="960" height="540"></canvas></div>
    <input type="range" class="lmSlider" min="0" max="${work.length - 1}" step="1" value="0">
    <div class="lmCtl">
      <button type="button" class="ghost lmPrev">&#9664; ${tr("lmPrev")}</button>
      <span class="lmLabel"></span>
      <button type="button" class="ghost lmNext">${tr("lmNext")} &#9654;</button>
    </div>
    <div class="lmCtl" style="margin-top:6px">
      <button type="button" class="ghost lmSetA">${tr("lmSetStart")}</button>
      <span class="lmLabel lmSpan"></span>
      <button type="button" class="ghost lmSetB">${tr("lmSetEnd")}</button>
    </div>
    <div class="lmCtl" style="margin-top:6px">
      <button type="button" class="ghost lmResetFrame">${tr("lmResetFrame")}</button>
      <button type="button" class="ghost lmResetAll">${tr("lmResetAll")}</button>
    </div>
    <p class="note" style="margin:6px 0">${tr("lmReviewHint")}</p>
    <p class="note lmEditHint" style="margin:6px 0">${tr("lmEditHint")}</p>
    <div class="lmCtl">
      <button type="button" class="lmApply" disabled>${tr("lmApply")}</button>
    </div>
    <div class="lmCtl" style="margin-top:6px">
      <button type="button" class="ghost lmKeep">${tr("lmKeep")}</button>
      <button type="button" class="danger lmDiscard">${tr("lmDiscard")}</button>
    </div>`;
  document.body.appendChild(dlg);
  const cv = dlg.querySelector("canvas"), sl = dlg.querySelector(".lmSlider");
  const label = dlg.querySelector(".lmLabel"), spanLbl = dlg.querySelector(".lmSpan");
  const applyBtn = dlg.querySelector(".lmApply");

  /* The video must be IN the document.
   *
   * A detached <video> decodes on desktop but not on a phone: mobile browsers
   * only run the decoder for an element that is in the layout, so drawImage()
   * painted nothing and the review showed a skeleton on black. It is in the
   * dialog, one pixel, transparent -- present for the decoder, invisible to
   * the reviewer. `display:none` would put it back in the broken state. */
  const v = document.createElement("video");
  v.muted = true; v.defaultMuted = true; v.playsInline = true;
  v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
  v.preload = "auto";
  v.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0";
  v.src = URL.createObjectURL(file);
  dlg.querySelector(".lmStage").appendChild(v);

  const sw = crop ? crop.w : fw, sh = crop ? crop.h : fh;
  cv.height = Math.round(cv.width * (sh / sw)) || 540;
  let k = 0, busy = false, want = null;
  const t0 = work[0].t;

  // Canvas <-> frame mapping, the inverse of paint()'s letterboxing.
  const geom = () => {
    const kk = Math.min(cv.width / sw, cv.height / sh);
    return { kk, ox: (cv.width - sw * kk) / 2, oy: (cv.height - sh * kk) / 2 };
  };
  const toFrame = (ev) =>
    frameFromClient(ev.clientX, ev.clientY, cv.getBoundingClientRect(),
                    cv.width, cv.height, sw, sh);

  function paintNow() {
    paint(cv, v, sw, sh, crop, work[k].lm);
    // Mark the frame as outside the kept span, so a trim is visible.
    if (k < a || k > b) {
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = "#fff"; ctx.font = "28px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(tr("lmTrimmedOut"), cv.width / 2, cv.height / 2);
    }
    if (dragName) {
      const g = geom(), p = work[k].lm[dragName];
      if (p) { const ctx = cv.getContext("2d");
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(g.ox + p[0] * g.kk, g.oy + p[1] * g.kk, 14, 0, 7); ctx.stroke(); }
    }
  }
  function paintLabels() {
    label.textContent = tr("lmFrame", { i: k + 1, n: work.length, t: ((work[k].t - t0) / 1000).toFixed(2) });
    spanLbl.textContent = tr("lmSpan", { a: a + 1, b: b + 1, n: b - a + 1 });
    applyBtn.disabled = !edited && a === 0 && b === work.length - 1;
  }
  async function show(idx) {
    k = Math.max(0, Math.min(work.length - 1, idx)); sl.value = String(k);
    paintLabels();
    if (busy) { want = k; return; }
    busy = true;
    await new Promise((res) => {
      const done = () => res();
      v.addEventListener("seeked", done, { once: true });
      setTimeout(done, 1500);
      v.currentTime = work[k].t / 1000;
    });
    paintNow();
    busy = false;
    if (want != null && want !== k) { const w = want; want = null; show(w); } else want = null;
  }

  // --- dragging a landmark --------------------------------------------------
  let dragName = null;
  const nearest = (fx, fy) => {
    let best = null, bd = Infinity;
    for (const [n, p] of Object.entries(work[k].lm || {})) {
      const d = Math.hypot(p[0] - fx, p[1] - fy);
      if (d < bd) { bd = d; best = n; }
    }
    // Within ~6% of the frame's smaller side; otherwise the tap was not on a point.
    return bd <= Math.min(sw, sh) * 0.06 ? best : null;
  };
  cv.addEventListener("pointerdown", (e) => {
    const [fx, fy] = toFrame(e);
    dragName = nearest(fx, fy);
    if (!dragName) return;
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
    paintNow();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!dragName) return;
    const [fx, fy] = toFrame(e);
    const p = work[k].lm[dragName];
    p[0] = Math.max(0, Math.min(sw, fx));
    p[1] = Math.max(0, Math.min(sh, fy));
    edited = true;
    paintLabels();
    paintNow();
  });
  const endDrag = () => { if (dragName) { dragName = null; paintNow(); } };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  dlg.querySelector(".lmResetFrame").onclick = () => {
    const src = frames[k].lm;
    work[k].lm = src ? Object.fromEntries(Object.entries(src).map(([n, p]) => [n, p.slice()])) : src;
    edited = work.some((f, i) => JSON.stringify(f.lm) !== JSON.stringify(frames[i].lm));
    paintLabels(); paintNow();
  };
  dlg.querySelector(".lmResetAll").onclick = () => {
    frames.forEach((f, i) => { work[i].lm = f.lm ? Object.fromEntries(
      Object.entries(f.lm).map(([n, p]) => [n, p.slice()])) : f.lm; });
    a = 0; b = work.length - 1; edited = false;
    paintLabels(); paintNow();
  };
  dlg.querySelector(".lmSetA").onclick = () => { a = Math.min(k, b); paintLabels(); paintNow(); };
  dlg.querySelector(".lmSetB").onclick = () => { b = Math.max(k, a); paintLabels(); paintNow(); };

  const close = () => { try { URL.revokeObjectURL(v.src); } catch { /* gone */ } dlg.close(); dlg.remove(); };
  dlg.querySelector(".lmPrev").onclick = () => show(k - 1);
  dlg.querySelector(".lmNext").onclick = () => show(k + 1);
  sl.oninput = () => show(+sl.value);
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); show(k - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); show(k + 1); }
  });
  dlg.querySelector(".lmX").onclick = close;
  applyBtn.onclick = () => {
    const kept = work.slice(a, b + 1);
    close();
    if (onApply) onApply(kept, { fps, trimmed: a > 0 || b < work.length - 1, edited });
  };
  dlg.querySelector(".lmKeep").onclick = () => { close(); if (onKeep) onKeep(); };
  dlg.querySelector(".lmDiscard").onclick = () => { close(); if (onDiscard) onDiscard(); };
  dlg.addEventListener("cancel", close);
  /* Prime the decoder before the first seek: some mobile browsers hand back
   * blank frames until the element has played once. Muted, so nothing is heard
   * and no autoplay policy is tripped. */
  v.addEventListener("loadeddata", async () => {
    try { await v.play(); v.pause(); } catch { /* fine: seeking may still work */ }
    show(0);
  }, { once: true });
  dlg.showModal();
}
