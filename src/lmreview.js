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
export function openReview({ file, frames, fw, fh, crop = null, tr, onKeep, onDiscard }) {
  if (!file || !frames || !frames.length) return;
  const dlg = document.createElement("dialog");
  dlg.className = "lmReview";
  dlg.innerHTML = `
    <div class="lmHead"><b>${tr("lmReviewTitle")}</b><button type="button" class="ghost lmX" aria-label="Close">✕</button></div>
    <canvas width="960" height="540"></canvas>
    <input type="range" class="lmSlider" min="0" max="${frames.length - 1}" step="1" value="0">
    <div class="lmCtl">
      <button type="button" class="ghost lmPrev">◀ ${tr("lmPrev")}</button>
      <span class="lmLabel"></span>
      <button type="button" class="ghost lmNext">${tr("lmNext")} ▶</button>
    </div>
    <p class="note" style="margin:6px 0">${tr("lmReviewHint")}</p>
    <div class="lmCtl">
      <button type="button" class="lmKeep">${tr("lmKeep")}</button>
      <button type="button" class="danger lmDiscard">${tr("lmDiscard")}</button>
    </div>`;
  document.body.appendChild(dlg);
  const cv = dlg.querySelector("canvas"), sl = dlg.querySelector(".lmSlider"), label = dlg.querySelector(".lmLabel");
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = URL.createObjectURL(file);
  const sw = crop ? crop.w : fw, sh = crop ? crop.h : fh;
  cv.height = Math.round(cv.width * (sh / sw)) || 540;
  let k = 0, busy = false, want = null;
  const t0 = frames[0].t;
  async function show(idx) {
    k = Math.max(0, Math.min(frames.length - 1, idx)); sl.value = String(k);
    label.textContent = tr("lmFrame", { i: k + 1, n: frames.length, t: ((frames[k].t - t0) / 1000).toFixed(2) });
    if (busy) { want = k; return; }
    busy = true;
    await new Promise((res) => {
      const done = () => res(); v.addEventListener("seeked", done, { once: true }); setTimeout(done, 1500);
      v.currentTime = frames[k].t / 1000;
    });
    paint(cv, v, sw, sh, crop, frames[k].lm);
    busy = false;
    if (want != null && want !== k) { const w = want; want = null; show(w); } else want = null;
  }
  const close = () => { try { URL.revokeObjectURL(v.src); } catch { /* gone */ } dlg.close(); dlg.remove(); };
  dlg.querySelector(".lmPrev").onclick = () => show(k - 1);
  dlg.querySelector(".lmNext").onclick = () => show(k + 1);
  sl.oninput = () => show(+sl.value);
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); show(k - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); show(k + 1); }
  });
  dlg.querySelector(".lmX").onclick = close;
  dlg.querySelector(".lmKeep").onclick = () => { close(); if (onKeep) onKeep(); };
  dlg.querySelector(".lmDiscard").onclick = () => { close(); if (onDiscard) onDiscard(); };
  dlg.addEventListener("cancel", close);
  v.addEventListener("loadeddata", () => show(0), { once: true });
  dlg.showModal();
}
