/**
 * fetcher.js -- talking to the optional local download helper.
 *
 * A browser cannot pull a video off YouTube. The bytes are not served with
 * permissive CORS headers, an embedded player is cross-origin so its pixels
 * cannot be read, and deriving a stream URL means running code YouTube
 * changes every few weeks. None of that is a gap in this app; it is the
 * platform working as designed.
 *
 * What does work: a helper process on the SAME DEVICE. Browsers treat
 * http://127.0.0.1 as a trustworthy origin and exempt it from mixed-content
 * blocking, so this HTTPS page may call it. In Termux that helper is on the
 * phone itself -- no laptop, no tunnel, nothing exposed to the network. See
 * tools/bioscout_fetch.py.
 *
 * The feature is therefore OPTIONAL and self-declaring: the app probes for the
 * helper and only offers the link box if it answers. Nobody is shown a
 * control that cannot work, and the app keeps running with no helper at all.
 *
 * Nothing here downloads anything itself. It validates input, asks the helper,
 * and hands back a Blob -- so the whole module is testable without a network.
 */

/** Where the helper listens. Loopback only: a LAN address would be blocked as
 *  mixed content, and exposing a downloader to the network is nobody's idea of
 *  a good time. */
export const HELPER = "http://127.0.0.1:8765";

/** How long to wait for the probe. The helper is local; if it has not answered
 *  in a moment it is not running, and the app should get on with itself. */
const PROBE_MS = 700;

/**
 * The video id in a YouTube URL, or null.
 *
 * Handles the four shapes people actually paste: watch?v=, youtu.be/,
 * /shorts/, /embed/. Anything else is refused rather than guessed at -- a
 * wrong id means the helper cheerfully downloads the wrong video.
 */
export function videoId(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  // A bare id, which is what people paste about a third of the time.
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const path = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return valid(path[0]);
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (path[0] === "shorts" || path[0] === "embed" || path[0] === "v") return valid(path[1]);
  if (path[0] === "watch") return valid(u.searchParams.get("v"));
  return null;
}

const valid = (id) => (id && /^[\w-]{11}$/.test(id) ? id : null);

/**
 * "12-19", "0:12-0:19", "1:05.5-1:09" -> {start, end} in seconds.
 *
 * Trimming is not a nicety here. Tracking runs frame by frame, so a 4-minute
 * video is four minutes of pose estimation to reach six seconds of squat.
 */
export function parseRange(text) {
  if (!text || !String(text).trim()) return null;
  const parts = String(text).split("-").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const secs = parts.map(clock);
  if (secs.some((s) => s === null)) return null;
  const [start, end] = secs;
  if (end <= start) return null;
  return { start, end };
}

/** "1:05.5" -> 65.5; "12" -> 12; "1:02:03" -> 3723. */
function clock(t) {
  if (!/^\d+(:\d{1,2})*(\.\d+)?$/.test(t)) return null;
  const bits = t.split(":").map(Number);
  if (bits.some((n) => !Number.isFinite(n))) return null;
  return bits.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Is the helper running?
 *
 * Resolves false rather than throwing on every failure mode there is: not
 * running, wrong version, blocked, slow. A probe that can reject would put a
 * try/catch around every call site for no information.
 */
export async function probe(fetchImpl = fetch) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_MS) : null;
  try {
    const r = await fetchImpl(`${HELPER}/health`, { signal: ctrl?.signal });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.service === "bioscout-fetch" ? j : false;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask the helper for a clip. Resolves to a Blob the analysis path can open.
 *
 * Errors carry the helper's own message where there is one: "video is
 * private" and "yt-dlp is not installed" need different reactions from the
 * person reading them, and a single "download failed" tells them neither.
 */
export async function fetchClip({ url, range, maxSeconds = 120 }, fetchImpl = fetch) {
  const id = videoId(url);
  if (!id) throw new Error("badUrl");

  const span = parseRange(range);
  if (range && !span) throw new Error("badRange");
  // Guardrail, not policy: tracking a whole lecture frame by frame will hang
  // the tab for many minutes, and the person will read that as a crash.
  if (span && span.end - span.start > maxSeconds) throw new Error("tooLong");

  const r = await fetchImpl(`${HELPER}/clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...(span || {}) }),
  });

  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).error || ""; } catch { /* not json */ }
    throw new Error(detail || `helper ${r.status}`);
  }
  const blob = await r.blob();
  if (!blob.size) throw new Error("empty");
  return blob;
}
