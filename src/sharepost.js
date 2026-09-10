/**
 * sharepost.js -- one set as a picture or a short clip, for a share sheet or
 * the BioScout feed.
 *
 * The picture is a frame from the set at its best rep with the skeleton drawn
 * on and a strip that says what it was. The clip replays the set's own video
 * with the skeleton and a running rep count burned in -- and exists only when
 * the athlete ticked "keep the video" before recording: the app does not film
 * anyone for sharing who did not ask it to keep the film.
 *
 * Where the frames come from:
 *   - a live recording keeps a few small JPEG stills a second while it runs
 *     (in memory, dropped with the next take) -- enough for the picture;
 *   - a kept video, or an analysed file, is seeked for the picture and played
 *     back for the clip.
 * Nothing here uploads anything. Posting is cloud.js, and only on a tap.
 *
 * Times: every time in here is FRAME time, the `t` on the recorded frames (ms).
 * `t0` maps it to the video: videoTime = (t - t0) / 1000. Live: t0 is the
 * performance.now() the recorder started at; a file: 0.
 *
 * The pure half (which rep, which moment, which window) is tested in
 * tests/test_sharepost.mjs; the drawing needs a browser.
 */

export const PIC = { w: 1080, h: 1350 };       // 4:5, the feed/Instagram portrait
export const CLIP = { w: 720, h: 1280 };       // 9:16, stories and reels
export const CLIP_MAX_MS = 15000;
export const CLIP_PAD_MS = 600;

/* ---- pure ------------------------------------------------------------- */

/** Frame time (ms) of analysis frame index `k`.
 *  A live take indexes frames by position; a file by its grid index `i`,
 *  with holes where no body was found -- so look the index up, and if it is
 *  one of the holes, step from the nearest frame that exists. */
export function frameTime(frames, k, fps = 30) {
  if (!frames || !frames.length || !Number.isFinite(k)) return null;
  const hasGrid = frames[0].i !== undefined;
  if (!hasGrid) {
    const j = Math.max(0, Math.min(frames.length - 1, Math.round(k)));
    return frames[j].t;
  }
  let best = frames[0];
  for (const f of frames) if (Math.abs(f.i - k) < Math.abs(best.i - k)) best = f;
  return best.t + (k - best.i) * (1000 / fps);
}

/** The rep to show: a clean one if there is any, and of those the middle one
 *  (the first is often the warm-up, the last the tired one). */
export function pickRep(reps) {
  const real = (reps || []).filter((r) => r && r.bounds && !r.isMean);
  if (!real.length) return null;
  const clean = real.filter((r) => r.quality === "clean");
  const pool = clean.length ? clean : real;
  return pool[Math.floor((pool.length - 1) / 2)];
}

/** The moment for the picture: the chosen rep's turning point. */
export function shareMoment(res, frames, fps) {
  const r = pickRep(res && res.reps);
  if (!r) return null;
  const [, top] = r.bounds;
  return { rep: r, t: frameTime(frames, top, fps) };
}

/** Index of the item whose `t` is nearest to `t` (binary search; `items`
 *  sorted by t). -1 for none, or when the nearest is further than maxGap. */
export function nearestIndex(items, t, maxGap = Infinity) {
  if (!items || !items.length || !Number.isFinite(t)) return -1;
  let lo = 0, hi = items.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t < t) lo = mid; else hi = mid;
  }
  const j = Math.abs(items[lo].t - t) <= Math.abs(items[hi].t - t) ? lo : hi;
  return Math.abs(items[j].t - t) <= maxGap ? j : -1;
}

/** Rep turning points as frame times, in order. What the clip counts. */
export function repTimes(res, frames, fps) {
  return (res && res.reps ? res.reps : [])
    .filter((r) => r && r.bounds && !r.isMean)
    .map((r) => ({ rep: r.rep, from: frameTime(frames, r.bounds[0], fps),
                   top: frameTime(frames, r.bounds[1], fps),
                   to: frameTime(frames, r.bounds[2], fps) }))
    .filter((x) => [x.from, x.top, x.to].every(Number.isFinite));
}

/**
 * The clip's window in frame time: from just before the first rep to just
 * after the last one that fits in `max`. A set longer than that shows its
 * first reps whole rather than every rep cut short -- a rep that stops halfway
 * is worse than one fewer rep.
 */
export function clipWindow(reps, { max = CLIP_MAX_MS, pad = CLIP_PAD_MS, start = null, end = null } = {}) {
  if (!reps.length) {
    if (start == null || end == null) return null;
    return { from: start, to: Math.min(end, start + max), reps: 0 };
  }
  let from = reps[0].from - pad;
  if (start != null) from = Math.max(start, from);
  let to = from, n = 0;
  for (const r of reps) {
    if (r.to + pad - from > max && n > 0) break;
    to = Math.min(r.to + pad, from + max);
    n++;
  }
  if (end != null) to = Math.min(end, to);
  return { from, to, reps: n };
}

/** Reps completed by frame time `t` -- counted at the turning point, which
 *  is where the athlete (and the analysis) calls it a rep. */
export function repsDoneAt(reps, t) {
  let n = 0;
  for (const r of reps) if (r.top <= t) n++;
  return n;
}

/** Place a sw x sh source in a dw x dh box: "contain" (all of it, bars) or
 *  "cover" (fills, crops). Centred. */
export function fitRect(sw, sh, dw, dh, mode = "contain") {
  if (!(sw > 0 && sh > 0)) return { x: 0, y: 0, w: dw, h: dh };
  const k = mode === "cover" ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = sw * k, h = sh * k;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

/** The first type on the list the browser can record. mp4 first: it is what
 *  Instagram and WhatsApp take; webm is what older Chrome can make. */
export const CLIP_TYPES = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4",
                           "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
export function pickType(isSupported, list = CLIP_TYPES) {
  for (const t of list) { try { if (isSupported(t)) return t; } catch { /* keep looking */ } }
  return "";
}
export const extFor = (type) => (String(type).startsWith("video/mp4") ? "mp4" : "webm");

/**
 * What the strip says, and what a post carries as its summary. Words come in
 * through `tr` so the picture is in the athlete's language.
 */
export function shareFacts(res, tr, { name = "", when = new Date() } = {}) {
  const reps = (res && res.reps ? res.reps : []).filter((r) => !r.isMean);
  const n = reps.length;
  const clean = reps.filter((r) => r.quality === "clean").length;
  const graded = reps.some((r) => r.quality);
  const load = res && res.externalKg ? Math.round(res.externalKg * 10) / 10 : 0;
  let best = null;
  const jumps = reps.map((r) => (!r.implausible && Number.isFinite(r.height_flight_m) ? r.height_flight_m : null))
    .filter((v) => v != null);
  if (jumps.length) best = Math.round(Math.max(...jumps) * 100);
  return {
    activity: res ? res.activity : null,
    title: res ? tr(res.activity) : "",
    reps: n,
    clean: graded ? clean : null,
    loadKg: load || null,
    bestCm: best,
    repsLabel: tr(n === 1 ? "shareRepWord" : "shareRepsWord"),
    ofLabel: tr("shareRepsSoFar"),
    // "0 clean" on a public picture reads as a verdict, not a count: say the
    // clean reps when there are some, and nothing when there are none.
    cleanLabel: clean ? tr("shareCleanN", { n: clean }) : "",
    bestLabel: best != null ? tr("shareBestJump", { cm: best }) : "",
    name: String(name || "").slice(0, 28),
    date: when.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }),
  };
}

/** The small summary stored with a post (and shown under it in the feed). */
export function postMeta(facts) {
  const m = { activity: facts.activity, reps: facts.reps };
  if (facts.clean) m.clean = facts.clean;
  if (facts.loadKg) m.loadKg = facts.loadKg;
  if (facts.bestCm != null) m.bestCm = facts.bestCm;
  return m;
}

/* ---- drawing (browser) -------------------------------------------------- */

const BONES = [["left_shoulder", "right_shoulder"], ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"], ["right_shoulder", "right_elbow"], ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"], ["right_shoulder", "right_hip"], ["left_hip", "right_hip"],
  ["left_hip", "left_knee"], ["left_knee", "left_ankle"], ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"], ["left_ankle", "left_foot_index"], ["right_ankle", "right_foot_index"],
  ["left_ankle", "left_heel"], ["right_ankle", "right_heel"], ["left_heel", "left_foot_index"],
  ["right_heel", "right_foot_index"]];
const JOINTS = ["nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist",
  "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"];
const INK = "#ffffff", MUTED = "rgba(255,255,255,.72)", BG = "#0f1317";

let blurCanvas = null;
/** A cheap blur that works everywhere (ctx.filter does not on older Safari):
 *  draw tiny, then scale up with smoothing. */
function blurredCover(ctx, src, sw, sh, W, H) {
  if (!blurCanvas) blurCanvas = document.createElement("canvas");
  const bw = 24, bh = Math.max(1, Math.round(24 * H / W));
  blurCanvas.width = bw; blurCanvas.height = bh;
  const b = blurCanvas.getContext("2d");
  const r = fitRect(sw, sh, bw, bh, "cover");
  b.drawImage(src, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(blurCanvas, 0, 0, W, H);
  ctx.fillStyle = "rgba(10,13,16,.55)";
  ctx.fillRect(0, 0, W, H);
}

/**
 * One frame of a share: blurred backdrop, the picture whole, the skeleton on
 * it, and the strip. `lm` is named landmarks in SOURCE pixels (unmirrored);
 * `mirror` flips picture and skeleton together, the way the preview showed it.
 * `count` (clip only) is "3 / 8" drawn large while the clip plays.
 */
export function drawShareFrame(ctx, W, H, src, sw, sh, lm, facts, { mirror = false, count = null, strip = 0.2 } = {}) {
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  if (src) blurredCover(ctx, src, sw, sh, W, H);
  const stripH = Math.round(H * strip);
  const box = fitRect(sw, sh, W, H - stripH, "contain");
  if (src) {
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, box.x, box.y, box.w, box.h);
    ctx.restore();
  }
  if (lm) drawBones(ctx, lm, sw, sh, box, W, mirror);
  drawStrip(ctx, W, H, stripH, facts, count);
  ctx.restore();
}

function drawBones(ctx, lm, sw, sh, box, W, mirror) {
  const k = box.w / sw;
  const P = (n) => {
    const p = lm[n];
    if (!p) return null;
    const x = box.x + p[0] * k, y = box.y + p[1] * k;
    return [mirror ? W - x : x, y];
  };
  const lw = Math.max(3, box.w / 150);
  ctx.lineCap = "round";
  // A dark halo under the line keeps it readable on a white wall.
  for (const [pass, style, width] of [[0, "rgba(0,0,0,.45)", lw * 2], [1, "rgba(91,147,245,.98)", lw]]) {
    ctx.strokeStyle = style; ctx.lineWidth = width;
    for (const [a, b] of BONES) {
      const A = P(a), B = P(b);
      if (!A || !B) continue;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
    }
    if (pass === 1) {
      ctx.fillStyle = "#fff";
      for (const n of JOINTS) {
        const A = P(n);
        if (!A) continue;
        ctx.beginPath(); ctx.arc(A[0], A[1], lw * 1.1, 0, 7); ctx.fill();
      }
    }
  }
}

function drawStrip(ctx, W, H, stripH, f, count) {
  const y0 = H - stripH;
  const g = ctx.createLinearGradient(0, y0 - stripH * 0.35, 0, H);
  g.addColorStop(0, "rgba(12,15,19,0)");
  g.addColorStop(0.3, "rgba(12,15,19,.88)");
  g.addColorStop(1, "rgba(12,15,19,.97)");
  ctx.fillStyle = g;
  ctx.fillRect(0, y0 - stripH * 0.35, W, stripH * 1.35);
  const u = W / 1080;                       // type scales with the canvas
  const x = Math.round(64 * u), right = W - x;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  ctx.fillStyle = INK;
  ctx.font = `700 ${Math.round(64 * u)}px system-ui, sans-serif`;
  const title = fitText(ctx, f.title, right - x - 280 * u);
  ctx.fillText(title, x, y0 + stripH * 0.38);

  const bits = [];
  if (f.loadKg) bits.push(`${f.loadKg > 0 ? "+" : ""}${f.loadKg} kg`);
  if (f.cleanLabel) bits.push(f.cleanLabel);
  if (f.bestCm != null) bits.push(f.bestLabel);
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${Math.round(34 * u)}px system-ui, sans-serif`;
  ctx.fillText(fitText(ctx, bits.join("  ·  "), right - x - 280 * u), x, y0 + stripH * 0.62);
  ctx.font = `500 ${Math.round(28 * u)}px system-ui, sans-serif`;
  ctx.fillText(fitText(ctx, [f.name, f.date].filter(Boolean).join("  ·  "), right - x - 280 * u),
               x, y0 + stripH * 0.84);

  // The number: reps in the set, or the running count while a clip plays.
  ctx.textAlign = "right";
  ctx.fillStyle = INK;
  ctx.font = `800 ${Math.round(120 * u)}px system-ui, sans-serif`;
  ctx.fillText(count != null ? String(count) : String(f.reps), right, y0 + stripH * 0.62);
  ctx.fillStyle = MUTED;
  ctx.font = `600 ${Math.round(28 * u)}px system-ui, sans-serif`;
  ctx.fillText(count != null ? f.ofLabel : f.repsLabel, right, y0 + stripH * 0.84);

  // The mark, top left, small: the picture is theirs, not an advert.
  ctx.textAlign = "left";
  ctx.font = `700 ${Math.round(30 * u)}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillText("BIOSCOUT", x + 2 * u, Math.round(78 * u) + 2 * u);
  ctx.fillStyle = "rgba(255,255,255,.9)";
  ctx.fillText("BIOSCOUT", x, Math.round(78 * u));
}

function fitText(ctx, s, max) {
  s = String(s || "");
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}

/* ---- sources (browser) ------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A video element for a blob, ready to seek. MediaRecorder's webm has no
 *  duration in its header (Chrome reports Infinity) and seeks badly until the
 *  browser has walked to the end once -- so walk it there first. */
export async function openVideo(blob) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto";
  v.src = URL.createObjectURL(blob);
  await new Promise((res, rej) => {
    v.onloadedmetadata = res; v.onerror = () => rej(new Error("video unreadable"));
    setTimeout(res, 8000);
  });
  if (!Number.isFinite(v.duration)) {
    await new Promise((res) => {
      v.ontimeupdate = () => { v.ontimeupdate = null; res(); };
      v.currentTime = 1e7;
      setTimeout(res, 4000);
    });
  }
  return v;
}

export function seek(v, t) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    v.addEventListener("seeked", fin, { once: true });
    setTimeout(fin, 3000);
    v.currentTime = Math.max(0, t);
  });
}

export function closeVideo(v) {
  try { v.pause(); URL.revokeObjectURL(v.src); v.removeAttribute("src"); v.load(); } catch { /* gone */ }
}

/** Blob -> ImageBitmap-ish drawable (an <img> where createImageBitmap is missing). */
async function drawable(blob) {
  if (globalThis.createImageBitmap) return createImageBitmap(blob);
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  return img;
}

/**
 * Keeps a few small stills a second while a live take records -- the picture
 * without keeping any video. `grab(video, t)` is called from the frame loop;
 * it takes a still at most every `every` ms, and when the take gets long it
 * thins what it has and slows down, so memory stays near `max` stills
 * (about 70 kB each) however long the set runs.
 */
export function stillKeeper({ every = 350, max = 240, edge = 960 } = {}) {
  let shots = [], gap = every, last = -Infinity, cv = null, busy = 0;
  return {
    get shots() { return shots; },
    reset() { shots = []; gap = every; last = -Infinity; },
    grab(video, t) {
      if (t - last < gap || busy > 2 || !video.videoWidth) return;
      last = t;
      const k = Math.min(1, edge / Math.max(video.videoWidth, video.videoHeight));
      if (!cv) cv = document.createElement("canvas");
      cv.width = Math.round(video.videoWidth * k); cv.height = Math.round(video.videoHeight * k);
      cv.getContext("2d").drawImage(video, 0, 0, cv.width, cv.height);
      const item = { t, w: video.videoWidth, h: video.videoHeight, blob: null };
      shots.push(item);
      busy++;
      cv.toBlob((b) => { busy--; item.blob = b; }, "image/jpeg", 0.82);
      if (shots.length > max) { shots = shots.filter((_, i) => i % 2 === 0); gap *= 2; }
    },
  };
}

/**
 * The picture, as a JPEG blob.
 * `src`: { video: Blob|null, stills: [...], frames, fps, t0, mirror }.
 */
export async function makePicture(res, src, facts) {
  const m = shareMoment(res, src.frames, src.fps);
  if (!m) throw new Error("no rep to show");
  const cv = document.createElement("canvas");
  cv.width = PIC.w; cv.height = PIC.h;
  const ctx = cv.getContext("2d");
  let img = null, sw = 0, sh = 0, t = m.t, v = null;
  try {
    if (src.video) {
      v = await openVideo(src.video);
      await seek(v, (t - src.t0) / 1000);
      await sleep(60);
      img = v; sw = v.videoWidth; sh = v.videoHeight;
    } else {
      const ready = (src.stills || []).filter((s) => s.blob);
      const j = nearestIndex(ready, t);
      if (j < 0) throw new Error("no picture was kept of this set");
      t = ready[j].t;
      img = await drawable(ready[j].blob);
      sw = ready[j].w; sh = ready[j].h;          // landmarks are in camera pixels
    }
    const fi = nearestIndex(src.frames, t, 150);
    drawShareFrame(ctx, PIC.w, PIC.h, img, sw, sh, fi >= 0 ? src.frames[fi].lm : null, facts,
                   { mirror: !!src.mirror });
  } finally {
    if (v) closeVideo(v);
    if (img && img.close) img.close();
  }
  return new Promise((r) => cv.toBlob(r, "image/jpeg", 0.9));
}

/**
 * The clip: the kept video replayed through a canvas with the skeleton and
 * the running count on it, recorded as it plays. Real time, so a 15 s clip
 * takes about 15 s; `onProgress(0..1)` says how far. Needs the page visible
 * (a hidden tab stops painting), which the caller says on screen.
 */
export async function makeClip(res, src, facts, { onProgress = () => {}, signal = null } = {}) {
  if (!src.video) throw new Error("no video was kept of this set");
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error("this browser cannot make clips");
  }
  const type = pickType((t) => MediaRecorder.isTypeSupported(t));
  const reps = repTimes(res, src.frames, src.fps);
  const v = await openVideo(src.video);
  const dur = Number.isFinite(v.duration) ? v.duration * 1000 : null;
  const win = clipWindow(reps, { start: src.t0, end: dur != null ? src.t0 + dur : null });
  if (!win || win.to <= win.from) { closeVideo(v); throw new Error("nothing to clip"); }
  const inClip = reps.slice(0, win.reps);

  const cv = document.createElement("canvas");
  cv.width = CLIP.w; cv.height = CLIP.h;
  const ctx = cv.getContext("2d");
  const stream = cv.captureStream(30);
  const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  const paint = () => {
    const t = src.t0 + v.currentTime * 1000;
    const fi = nearestIndex(src.frames, t, 120);
    const done = repsDoneAt(inClip, t);
    drawShareFrame(ctx, CLIP.w, CLIP.h, v, v.videoWidth, v.videoHeight,
                   fi >= 0 ? src.frames[fi].lm : null, facts,
                   { mirror: !!src.mirror, count: `${done}/${inClip.length || facts.reps}` });
    onProgress(Math.max(0, Math.min(1, (t - win.from) / (win.to - win.from))));
    return t;
  };

  try {
    await seek(v, (win.from - src.t0) / 1000);
    paint();
    rec.start(250);
    await v.play();
    await new Promise((resolve) => {
      // A frame callback never comes once the video has ended, so the end is
      // also listened for, and a clock stops a video that stalls outright.
      v.onended = () => resolve();
      setTimeout(resolve, (win.to - win.from) + 8000);
      const step = () => {
        if (signal && signal.aborted) return resolve();
        const t = paint();
        if (t >= win.to || v.ended) return resolve();
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
        else requestAnimationFrame(step);
      };
      step();
    });
  } finally {
    v.pause();
    if (rec.state !== "inactive") rec.stop();
    await stopped;
    stream.getTracks().forEach((tr) => tr.stop());
    closeVideo(v);
  }
  if (signal && signal.aborted) return null;
  return new Blob(chunks, { type: (type || "video/webm").split(";")[0] });
}
