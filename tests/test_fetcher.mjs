/**
 * fetcher.js, with no helper running and no network.
 *
 * The parsing is where the damage is. A mis-read id downloads the wrong video
 * and the person analyses somebody else's squat without ever knowing; a
 * mis-read range trims the wrong six seconds out of four minutes. Both fail
 * silently, which is why they are pinned here.
 *
 *   node test_fetcher.mjs
 */
import { videoId, parseRange, probe, fetchClip, HELPER } from "../src/fetcher.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/* ---- the four shapes people paste ------------------------------------- */

const ID = "kYYwGNK48VY";
for (const [url, want, label] of [
  [`https://youtube.com/shorts/${ID}`, ID, "a Shorts link"],
  [`https://www.youtube.com/watch?v=${ID}`, ID, "a watch link"],
  [`https://youtu.be/${ID}`, ID, "a short youtu.be link"],
  [`https://www.youtube.com/embed/${ID}`, ID, "an embed link"],
  [`https://m.youtube.com/watch?v=${ID}&t=42s`, ID, "a mobile link with a timestamp"],
  [`  https://youtube.com/shorts/${ID}?is=abc  `, ID, "a link with tracking junk and spaces"],
  [ID, ID, "a bare id"],
]) ok(videoId(url) === want, label, videoId(url) || "null");

/* Anything not clearly a YouTube video is refused. Guessing means quietly
 * downloading the wrong thing. */
for (const [url, label] of [
  ["https://vimeo.com/123456789", "another site"],
  ["https://youtube.com/", "the bare site"],
  ["https://youtube.com/watch?v=tooshort", "a malformed id"],
  ["https://evil.example/youtube.com/watch?v=" + ID, "a lookalike host"],
  ["not a url at all", "prose"],
  ["", "an empty string"],
  [null, "null"],
]) ok(videoId(url) === null, `refuses ${label}`, String(videoId(url)));

/* ---- ranges ------------------------------------------------------------ */

ok(parseRange("12-19")?.start === 12, "bare seconds");
ok(parseRange("0:12-0:19")?.end === 19, "mm:ss");
ok(parseRange("1:05.5-1:09")?.start === 65.5, "fractional seconds survive",
   String(parseRange("1:05.5-1:09")?.start));
ok(parseRange("1:02:03-1:02:04")?.start === 3723, "hh:mm:ss");
ok(parseRange("") === null, "an empty range means the whole video");
ok(parseRange("19-12") === null, "a backwards range is refused");
ok(parseRange("12") === null, "a single number is not a range");
ok(parseRange("abc-def") === null, "words are not a range");

/* ---- the request ------------------------------------------------------- */

const stubOK = (body) => async (url, opts) => ({
  ok: true, status: 200,
  json: async () => body ?? { service: "bioscout-fetch", version: 1 },
  blob: async () => ({ size: 1024 }),
  _url: url, _opts: opts,
});

{
  let seen = null;
  const spy = async (url, opts) => { seen = { url, opts }; return (await stubOK()(url, opts)); };
  const blob = await fetchClip({ url: `https://youtu.be/${ID}`, range: "0:12-0:19" }, spy);
  ok(blob.size === 1024, "a clip comes back as a blob");
  ok(seen.url === `${HELPER}/clip`, "asked the local helper, not the internet", seen.url);
  const sent = JSON.parse(seen.opts.body);
  ok(sent.id === ID && sent.start === 12 && sent.end === 19,
     "sent the id and the range, never the raw URL",
     JSON.stringify(sent));
}

const rejects = async (args, want, label) => {
  try {
    await fetchClip(args, stubOK());
    ok(false, label, "no error thrown");
  } catch (e) { ok(e.message === want, label, e.message); }
};
await rejects({ url: "https://vimeo.com/1" }, "badUrl", "a non-YouTube link is refused before any request");
await rejects({ url: ID, range: "abc" }, "badRange", "an unparseable range is refused");
await rejects({ url: ID, range: "0:00-9:00" }, "tooLong", "an overlong clip is refused");

{
  // The helper's own message survives: "yt-dlp is not installed" and "video is
  // private" need different reactions, and "download failed" gives neither.
  const failing = async () => ({ ok: false, status: 500,
    json: async () => ({ error: "yt-dlp is not installed" }) });
  try {
    await fetchClip({ url: ID }, failing);
    ok(false, "helper errors surface", "no error thrown");
  } catch (e) { ok(e.message === "yt-dlp is not installed", "helper errors surface", e.message); }
}

/* ---- the probe --------------------------------------------------------- */

ok(await probe(stubOK()) !== false, "a running helper is detected");
ok(await probe(async () => { throw new Error("ECONNREFUSED"); }) === false,
   "no helper is a plain false, not a throw");
ok(await probe(stubOK({ service: "something-else" })) === false,
   "something else on the port is not our helper");

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
