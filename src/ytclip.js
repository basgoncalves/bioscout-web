/**
 * A clip from a YouTube video, cut and analysed inside the app.
 *
 * Paste a link, the video plays in an embedded player here; set the start and
 * end of the movement (from where the player is, or typed); "Record clip"
 * plays exactly that stretch at 1x and records this tab, cropped to the
 * player, then hands the clip to the normal video analysis.
 *
 * Why record and not download: the embedded player is cross-origin, so its
 * pixels cannot be read, and YouTube offers no file. Recording this very tab
 * (getDisplayMedia with preferCurrentTab) and cropping it to the player
 * element (Region Capture, CropTarget) is what the browser allows. Where
 * Region Capture is missing, the player's rectangle travels as a crop for the
 * analysis instead. The person approves sharing "this tab" once per clip.
 */
export const ytSupported = () =>
  !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);

/** youtube.com/watch?v=, youtu.be/, /shorts/, /embed/ -> the 11-character id. */
export function youtubeId(url) {
  const s = String(url || "").trim();
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}
/** "1:23.4", "83.4", "1:02:03" -> seconds; null when not a time. */
export function parseTime(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (!/^\d+(:\d{1,2})*(\.\d+)?$/.test(t)) return null;
  return t.split(":").reduce((a, p) => a * 60 + parseFloat(p), 0);
}
export const fmtTime = (x) => {
  if (!Number.isFinite(x)) return "";
  const m = Math.floor(x / 60), s = x - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
};
/** Start time from the link itself (?t=83, &t=1m23s, #t=...). */
export function linkStart(url) {
  const m = String(url || "").match(/[?&#]t=(\d+h)?(\d+m)?(\d+)s?\b/);
  if (!m) return null;
  return (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
}

let apiP = null;
function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!apiP) apiP = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch { /* theirs */ } resolve(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api"; s.async = true;
    s.onerror = () => { apiP = null; reject(new Error("YouTube player could not be loaded (offline?)")); };
    document.head.appendChild(s);
  });
  return apiP;
}

const CSS = `
.ytWrap{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px}
.ytBox{background:var(--card,#1b1d24);color:var(--ink,#eee);border-radius:14px;max-width:960px;width:100%;max-height:100%;overflow:auto;padding:14px}
.ytPlayer{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden;margin:10px 0}
.ytPlayer iframe,.ytPlayer>div{position:absolute;inset:0;width:100%;height:100%}
.ytRow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.ytRow button{width:auto;margin:0}
.ytRow input{width:auto;margin:0}
.ytRec{color:#ff3b30;font:700 14px ui-monospace,Consolas,monospace;display:none;align-items:center;gap:8px}
.ytRec.on{display:inline-flex}
.ytRec .dot{width:12px;height:12px;border-radius:50%;background:#ff3b30;animation:ytBlink 1s steps(1) infinite}
@keyframes ytBlink{50%{opacity:0}}
`;
let cssAdded = false;

/** t(key) translates (HTML-escaped); onClip(file, crop|null) analyses the recording. */
export async function openYouTubeClip({ t, onClip, onFile = null, url = "" }) {
  if (!cssAdded) { const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st); cssAdded = true; }
  const wrap = document.createElement("div");
  wrap.className = "ytWrap";
  wrap.innerHTML = `<div class="ytBox">
    <b>${t("ytTitle")}</b>
    <p class="note" style="margin:4px 0 0">${t("ytNote")}</p>
    <div class="ytRow"><input type="url" data-url placeholder="https://www.youtube.com/watch?v=…" style="flex:1;min-width:220px">
      <button type="button" data-load>${t("ytLoad")}</button></div>
    <div class="ytPlayer" data-stage><div data-host></div></div>
    <div class="ytRow">
      <label class="simOpt">${t("ytStart")} <input type="text" data-start size="8" placeholder="0:00.0"></label>
      <button type="button" class="ghost" data-setstart>${t("ytSetStart")}</button>
      <label class="simOpt">${t("ytEnd")} <input type="text" data-end size="8" placeholder="0:05.0"></label>
      <button type="button" class="ghost" data-setend>${t("ytSetEnd")}</button>
      <button type="button" class="ghost" data-preview>${t("ytPreview")}</button>
    </div>
    <p class="note ytNoCap" data-nocap style="display:none;margin:8px 0 0;color:var(--warn,#e8a33a)"></p>
    <div class="ytRow">
      <button type="button" data-rec>${t("ytRecord")}</button>
      <span class="ytRec" data-recon><span class="dot"></span><span data-clock>REC</span></span>
      <button type="button" class="ghost" data-close>${t("srClose")}</button>
      <span class="sub" data-msg></span>
    </div></div>`;
  document.body.appendChild(wrap);
  const $ = (s) => wrap.querySelector(s);
  const msg = (s) => { $("[data-msg]").textContent = s || ""; };
  let player = null, busy = false, stopRec = null;
  const close = () => { if (stopRec) stopRec(true); try { if (player) player.destroy(); } catch { /* gone */ } wrap.remove(); };
  $("[data-close]").onclick = close;

  const load = async () => {
    const id = youtubeId($("[data-url]").value);
    if (!id) {
      // not YouTube: a direct link to a video file is fetched and analysed as it is
      const u = $("[data-url]").value.trim();
      if (!/^https?:\/\//i.test(u)) { msg(t("ytBadLink")); return; }
      msg(t("urlFetching"));
      try {
        const r = await fetch(u);
        if (!r.ok) throw new Error(r.status);
        const type = r.headers.get("content-type") || "";
        if (!/^video\//i.test(type) && !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u)) throw new Error(type || "not a video");
        const blob = await r.blob();
        const file = new File([blob], decodeURIComponent(u.split("/").pop().split("?")[0] || "video.mp4"), { type: blob.type || "video/mp4" });
        close(); onClip(file, null);
      } catch (e) { msg(t("urlFetchFailed", { err: String(e.message || e) })); }
      return;
    }
    msg("");
    let YT;
    try { YT = await loadApi(); } catch (e) { msg(e.message); return; }
    const st = linkStart($("[data-url]").value);
    if (st != null && !$("[data-start]").value) $("[data-start]").value = fmtTime(st);
    if (player) { player.loadVideoById({ videoId: id, startSeconds: st || 0 }); player.pauseVideo(); return; }
    await new Promise((resolve) => {
      player = new YT.Player($("[data-host]"), {
        videoId: id, host: "https://www.youtube-nocookie.com",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, start: st || 0 },
        events: { onReady: resolve, onError: (e) => { msg(t("ytEmbedBlocked", { code: e.data })); resolve(); } },
      });
    });
  };
  $("[data-load]").onclick = load;
  $("[data-url]").onkeydown = (e) => { if (e.key === "Enter") load(); };
  if (url) { $("[data-url]").value = url; load(); }

  const now = () => (player && player.getCurrentTime ? player.getCurrentTime() : null);
  $("[data-setstart]").onclick = () => { const x = now(); if (x != null) $("[data-start]").value = fmtTime(x); };
  $("[data-setend]").onclick = () => { const x = now(); if (x != null) $("[data-end]").value = fmtTime(x); };
  const range = () => {
    const a = parseTime($("[data-start]").value) ?? 0, b = parseTime($("[data-end]").value);
    if (!(b > a)) { msg(t("ytNeedRange")); return null; }
    if (b - a > 60) { msg(t("ytTooLong")); return null; }
    return [a, b];
  };
  // play [a, b] and resolve at b; onPlaying fires once the frames are moving
  const playRange = (a, b, onPlaying) => new Promise((resolve) => {
    player.mute(); player.setPlaybackRate(1); player.seekTo(a, true); player.playVideo();
    let started = false;
    const tick = setInterval(() => {
      const x = player.getCurrentTime(), s = player.getPlayerState();
      if (!started && s === 1 && x >= a - 0.05) { started = true; if (onPlaying) onPlaying(); }
      if (x >= b || s === 0) { clearInterval(tick); player.pauseVideo(); resolve(); }
    }, 30);
    stopRec = () => { clearInterval(tick); try { player.pauseVideo(); } catch { /* gone */ } resolve(); };
  });
  $("[data-preview]").onclick = async () => { const r = range(); if (!r || !player || busy) return; busy = true; await playRange(...r); stopRec = null; busy = false; };

  // phones and tablets: no recording a tab -- play and cut here, record with the phone's own screen recorder
  /* Phones: a browser cannot record another frame there, so the button
   * becomes "Analyse my screen recording" and the steps stay on screen (a
   * status line was cleared by Load and never seen). */
  const phone = !ytSupported();
  if (phone) {
    const n = $("[data-nocap]"); n.innerHTML = t("ytNoCapture"); n.style.display = "block";
    $("[data-rec]").textContent = t("ytUseFile");
    $("[data-rec]").disabled = !onFile;
  }
  $("[data-rec]").onclick = async () => {
    if (phone) { if (onFile) { close(); onFile(); } return; }
    if (!player || busy) { if (!player) msg(t("ytBadLink")); return; }
    const r = range(); if (!r) return;
    busy = true; msg(t("ytShareTab"));
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: false,
        preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude" });
    } catch { busy = false; msg(""); return; }
    const track = stream.getVideoTracks()[0];
    let crop = null;
    const stage = $("[data-stage]");
    // Region Capture: the recording IS the player. Otherwise: a crop for the analysis.
    try {
      if (window.CropTarget && track.cropTo) await track.cropTo(await window.CropTarget.fromElement(stage));
      else throw new Error("no region capture");
    } catch {
      const st = track.getSettings ? track.getSettings() : {}, b = stage.getBoundingClientRect();
      const k = (st.width || innerWidth) / innerWidth;
      crop = { x: b.left * k, y: b.top * k, w: b.width * k, h: b.height * k };
    }
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    const t0 = { v: 0 }, clock = setInterval(() => { if (t0.v) $("[data-clock]").textContent = `REC ${((Date.now() - t0.v) / 1000).toFixed(1)} s`; }, 100);
    msg(t("ytRecording"));
    let cancelled = false;
    await playRange(r[0], r[1], () => { rec.start(250); t0.v = Date.now(); $("[data-recon]").classList.add("on"); });
    stopRec = null;
    if (rec.state !== "inactive") rec.stop(); else cancelled = true;
    await (cancelled ? Promise.resolve() : done);
    clearInterval(clock); $("[data-recon]").classList.remove("on");
    for (const tr of stream.getTracks()) tr.stop();
    busy = false;
    if (cancelled || !chunks.length) { msg(""); return; }
    const id = youtubeId($("[data-url]").value) || "youtube";
    const file = new File(chunks, `yt_${id}_${fmtTime(r[0]).replace(/[:.]/g, "-")}.webm`, { type: rec.mimeType || "video/webm" });
    close();
    onClip(file, crop);
  };
}
