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

/* ---- a whole session, as a card ----------------------------------------
 * For sessions already filed: their video and stills are long gone (they
 * were never kept), so what can be shared is what was logged -- sets, reps,
 * movements -- drawn as a card, the way the monthly card is. */

/** What a session card says. `sess` is a stored session ({started, sport,
 *  sets: [{index, activity, reps, addedKg, assistKg, at}]}). */
export function sessionFacts(sess, tr, { name = "" } = {}) {
  const sets = (sess && sess.sets) || [];
  const rows = [];
  const by = new Map();
  for (const s of sets) {
    let r = by.get(s.activity);
    if (!r) { r = { activity: s.activity, title: tr(s.activity), sets: 0, reps: 0, loadKg: 0 }; by.set(s.activity, r); rows.push(r); }
    r.sets++;
    r.reps += Number(s.reps) || 0;
    const load = (Number(s.addedKg) || 0) - (Number(s.assistKg) || 0);
    if (load > r.loadKg) r.loadKg = Math.round(load * 10) / 10;
  }
  const reps = rows.reduce((a, r) => a + r.reps, 0);
  const when = new Date((sets[0] && sets[0].at) || sess?.started || Date.now());
  const first = sets.length ? new Date(sets[0].at).getTime() : NaN;
  const last = sets.length ? new Date(sets[sets.length - 1].at).getTime() : NaN;
  const minutes = sets.length > 1 && last > first ? Math.round((last - first) / 60000) : null;
  return {
    name: String(name || sess?.profile || "").slice(0, 28),
    sport: sess && sess.sport ? tr("sport_" + sess.sport) : "",
    date: when.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
    sets: sets.length, reps, minutes,
    perSet: sets.map((s) => Number(s.reps) || 0),
    rows,
    rowText: (r) => tr(r.sets === 1 ? "nSet" : "nSets", { n: r.sets }) + " · "
                  + tr(r.reps === 1 ? "nRep" : "nRepsCount", { n: r.reps }),
    labels: { sets: tr("cardSets"), reps: tr("cardReps"), minutes: tr("cardMinutes"),
              moves: tr("cardMovements"), perSet: tr("cardRepsPerSet"),
              more: (n) => tr("cardMore", { n }) },
  };
}

/** The small summary stored with a posted session card. */
export function sessionMeta(f) {
  return { kind: "session", sets: f.sets, reps: f.reps,
           activities: f.rows.map((r) => r.activity).slice(0, 8) };
}

export function drawSessionCard(ctx, f) {
  const W = PIC.w, H = PIC.h;
  const INK2 = "#e9edf1", MUT = "#8b97a3", ACC = "#49b39b", CARDBG = "#161b21";
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CARDBG;
  const r = 44, x0 = 48, y0 = 48, w = W - 96, h = H - 96;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0); ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r); ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  ctx.arcTo(x0, y0 + h, x0, y0, r); ctx.arcTo(x0, y0, x0 + w, y0, r); ctx.closePath(); ctx.fill();
  const L = 104, R = W - 104;
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.fillStyle = MUT; ctx.font = "600 30px system-ui, sans-serif"; ctx.fillText("BIOSCOUT", L, 148);
  ctx.fillStyle = INK2; ctx.font = "700 72px system-ui, sans-serif";
  ctx.fillText(fitText(ctx, f.name || f.sport || "", R - L), L, 240);
  ctx.fillStyle = MUT; ctx.font = "500 34px system-ui, sans-serif";
  ctx.fillText(fitText(ctx, [f.sport, f.date].filter(Boolean).join("  ·  "), R - L), L, 294);

  const tiles = [[f.sets, f.labels.sets], [f.reps, f.labels.reps],
                 f.minutes != null ? [f.minutes, f.labels.minutes] : [f.rows.length, f.labels.moves]];
  tiles.forEach(([v, label], i) => {
    const x = L + i * 292;
    ctx.fillStyle = INK2; ctx.font = "700 96px system-ui, sans-serif"; ctx.fillText(String(v), x, 450);
    ctx.fillStyle = MUT; ctx.font = "500 30px system-ui, sans-serif"; ctx.fillText(label, x, 496);
  });

  ctx.fillStyle = MUT; ctx.font = "600 28px system-ui, sans-serif"; ctx.fillText(f.labels.perSet, L, 586);
  const n = Math.max(1, f.perSet.length), top = Math.max(1, ...f.perSet), bw = (R - L) / n;
  f.perSet.forEach((v, i) => {
    const bh = Math.max(4, Math.round((v / top) * 150));
    ctx.fillStyle = ACC;
    ctx.fillRect(Math.round(L + i * bw + bw * 0.12), 770 - bh, Math.max(2, Math.round(bw * 0.76)), bh);
  });

  let y = 870;
  const show = f.rows.slice(0, f.rows.length > 5 ? 4 : 5);
  for (const row of show) {
    ctx.textAlign = "left"; ctx.fillStyle = INK2; ctx.font = "600 38px system-ui, sans-serif";
    ctx.fillText(fitText(ctx, row.title + (row.loadKg ? `  +${row.loadKg} kg` : ""), (R - L) * 0.55), L, y);
    ctx.textAlign = "right"; ctx.fillStyle = MUT; ctx.font = "500 32px system-ui, sans-serif";
    ctx.fillText(f.rowText(row), R, y);
    y += 70;
  }
  if (f.rows.length > show.length) {
    ctx.textAlign = "left"; ctx.fillStyle = MUT; ctx.font = "500 30px system-ui, sans-serif";
    ctx.fillText(f.labels.more(f.rows.length - show.length), L, y);
  }
  ctx.textAlign = "left"; ctx.fillStyle = MUT; ctx.font = "500 26px system-ui, sans-serif";
  ctx.fillText("A physics-informed, AI-powered bio tracker", L, H - 110);
}

export async function makeSessionCard(facts) {
  const cv = document.createElement("canvas");
  cv.width = PIC.w; cv.height = PIC.h;
  drawSessionCard(cv.getContext("2d"), facts);
  return new Promise((r) => cv.toBlob(r, "image/jpeg", 0.92));
}

/* ---- a picture or video from the phone, for a post --------------------- */

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
/** Can this file be posted as it is? Pictures always can (they are
 *  re-encoded first); a video must be a type the bucket takes and fit. */
export function checkUpload(file) {
  const type = String(file && file.type || "");
  if (type.startsWith("image/")) return { ok: true, kind: "image" };
  if (!type.startsWith("video/")) return { ok: false, reason: "type" };
  if (!UPLOAD_VIDEO_TYPES.includes(type.split(";")[0])) return { ok: false, reason: "type" };
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, reason: "size" };
  return { ok: true, kind: "video" };
}

/** A photo as a JPEG no longer than `edge` px: a feed does not need 12 MP,
 *  and re-encoding also turns HEIC (iPhone) into something every browser shows. */
export async function toJpeg(file, edge = 1440, quality = 0.86) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  const out = await new Promise((r) => cv.toBlob(r, "image/jpeg", quality));
  if (!out) throw new Error("could not encode the picture");
  return out;
}
