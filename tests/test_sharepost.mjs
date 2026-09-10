/**
 * sharepost.js -- which rep a shared picture shows, which part of the set a
 * clip keeps, and what the strip and the post claim.
 *
 * The failures worth guarding: a picture of the wrong moment (frame index
 * confused with a file's grid index), a clip that cuts a rep in half, and a
 * count on the clip that runs ahead of the athlete.
 *
 *   node tests/test_sharepost.mjs
 */
import { frameTime, pickRep, shareMoment, nearestIndex, repTimes, clipWindow, repsDoneAt,
         fitRect, pickType, extFor, shareFacts, postMeta, CLIP_MAX_MS } from "../src/sharepost.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};
const tr = (k, v = {}) => k + (Object.keys(v).length ? ":" + Object.values(v).join(",") : "");

// A live take: frames by position, t in performance.now() ms, 30 fps from 5000.
const live = Array.from({ length: 300 }, (_, i) => ({ t: 5000 + i * (1000 / 30), lm: { nose: [i, i] } }));
// A file: grid index i, t = video time; frames 10-14 had no body (holes).
const file = Array.from({ length: 60 }, (_, i) => ({ i, t: 2000 + i * 100, lm: {} })).filter((f) => f.i < 10 || f.i > 14);

ok(frameTime(live, 30) === 6000, "a live frame index is its position", String(frameTime(live, 30)));
ok(frameTime(file, 20) === 4000, "a file's index is its grid index, not its position", String(frameTime(file, 20)));
ok(Math.abs(frameTime(file, 12, 10) - 3200) < 1e-9, "a hole is stepped over from the nearest frame", String(frameTime(file, 12, 10)));
ok(frameTime([], 3) === null, "no frames, no time");

const rep = (n, b, quality) => ({ rep: n, bounds: b, quality });
{
  const reps = [rep(1, [10, 20, 30], "poor"), rep(2, [40, 50, 60], "clean"), rep(3, [70, 80, 90], "clean"),
                rep(4, [100, 110, 120], "clean"), rep(5, [130, 140, 150], "acceptable")];
  ok(pickRep(reps).rep === 3, "the picture shows the middle clean rep", String(pickRep(reps).rep));
  ok(pickRep(reps.map((r) => ({ ...r, quality: "poor" }))).rep === 3, "no clean rep: the middle one");
  ok(pickRep([rep(1, [0, 5, 9], "clean"), { rep: "mean", isMean: true, bounds: [0, 1, 2] }]).rep === 1,
     "the mean curve is never a picture");
  ok(pickRep([]) === null, "no reps, no picture");
  const m = shareMoment({ reps }, live, 30);
  ok(m.t === frameTime(live, 80), "the moment is the rep's turning point", String(m.t));
}

ok(nearestIndex(live, 5990) === 30, "nearest frame to a time");
ok(nearestIndex(live, 1e6, 100) === -1, "none when the nearest is too far");
ok(nearestIndex([{ t: 1 }], 0) === 0 && nearestIndex([], 0) === -1, "one item, and none");

{
  // Reps every 2 s, each 1.6 s long. The window keeps whole reps only.
  const reps = Array.from({ length: 12 }, (_, i) => ({ from: 1000 + i * 2000, top: 1800 + i * 2000, to: 2600 + i * 2000 }));
  const w = clipWindow(reps);
  ok(w.to - w.from <= CLIP_MAX_MS, "a clip is at most 15 s", String(w.to - w.from));
  ok(w.reps === 7 && w.to >= reps[6].to && w.to < reps[7].to, "and ends after a whole rep, never inside one",
     `${w.reps} reps, ${w.from}-${w.to}`);
  ok(w.from === 400, "it starts just before the first rep");
  const short = clipWindow(reps.slice(0, 2));
  ok(short.reps === 2 && short.to === reps[1].to + 600, "a short set is kept whole");
  ok(clipWindow(reps, { start: 900 }).from === 900, "never before the video starts");
  ok(clipWindow(reps.slice(0, 2), { end: 4000 }).to === 4000, "nor after it ends");
  const long1 = clipWindow([{ from: 0, top: 10000, to: 40000 }]);
  ok(long1.reps === 1 && long1.to - long1.from === CLIP_MAX_MS, "one rep longer than 15 s is cut at 15 s rather than dropped");
  ok(repsDoneAt(reps, 1799) === 0 && repsDoneAt(reps, 1800) === 1 && repsDoneAt(reps, 6000) === 3,
     "the count ticks at each turning point, not before");
}
{
  const res = { reps: [rep(1, [30, 45, 60]), { rep: "mean", isMean: true, bounds: [0, 1, 2] }] };
  const rt = repTimes(res, live, 30);
  ok(rt.length === 1 && rt[0].from === 6000 && rt[0].to === 7000, "rep times are frame times, mean left out");
}

{
  const r = fitRect(720, 1280, 1080, 1080, "contain");
  ok(Math.abs(r.h - 1080) < 1e-9 && Math.abs(r.w - 607.5) < 1e-9 && Math.abs(r.x - 236.25) < 1e-9, "contain keeps the whole frame");
  const c = fitRect(720, 1280, 1080, 1080, "cover");
  ok(Math.abs(c.w - 1080) < 1e-9 && c.h > 1080 && c.y < 0, "cover fills and crops");
}

ok(pickType((t) => t === "video/webm") === "video/webm", "webm where that is all there is");
ok(pickType((t) => t.startsWith("video/mp4") || t.startsWith("video/webm")).startsWith("video/mp4"), "mp4 first when both work");
ok(pickType(() => false) === "", "nothing, when the browser cannot record");
ok(pickType(() => { throw new Error("x"); }) === "", "a browser that throws is not supported");
ok(extFor("video/mp4") === "mp4" && extFor("video/webm;codecs=vp9") === "webm", "file extension from the type");

{
  const res = { activity: "cmj", externalKg: 0,
    reps: [{ quality: "clean", height_flight_m: 0.312 }, { quality: "poor", height_flight_m: 0.351 },
           { quality: "clean", height_flight_m: 0.9, implausible: true }] };
  const f = shareFacts(res, tr, { name: "Bas", when: new Date(2026, 8, 10) });
  ok(f.reps === 3 && f.clean === 2 && f.bestCm === 35, "reps, clean reps, best jump (implausible ones ignored)", JSON.stringify(f));
  ok(f.title === "cmj" && f.cleanLabel === "shareCleanN:2" && f.bestLabel === "shareBestJump:35", "words come from the dictionary");
  const m = postMeta(f);
  ok(JSON.stringify(m) === JSON.stringify({ activity: "cmj", reps: 3, clean: 2, bestCm: 35 }),
     "a post carries only the set's summary", JSON.stringify(m));
  ok(!("name" in m) && !("date" in m), "and not the athlete's name");
  const g = shareFacts({ activity: "squat", externalKg: 20, reps: [{}, {}] }, tr);
  ok(g.clean === null && g.bestCm === null && g.loadKg === 20, "ungraded reps claim no clean count; load is said");
  const z = shareFacts({ activity: "squat", reps: [{ quality: "poor" }] }, tr);
  ok(z.clean === 0 && z.cleanLabel === "" && !("clean" in postMeta(z)), "no clean reps: the picture and the post say nothing, not \"0 clean\"");
}

if (bad) { console.log(`\n${bad} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed");
