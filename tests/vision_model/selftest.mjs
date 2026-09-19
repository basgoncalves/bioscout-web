#!/usr/bin/env node
/**
 * selftest.mjs -- does the harness itself measure what it says it measures?
 *
 *   node tests/vision_model/selftest.mjs
 *
 * No browser, no clips, no model files, no network. A benchmark that is only
 * ever run on real data cannot be checked: if it reported the heavy model as
 * 2 deg better, nobody could tell whether that was the model or an off-by-one
 * in an alignment. So here the answer is KNOWN.
 *
 * A synthetic squat is built from a chosen knee-flexion trajectory, with the
 * skeleton constructed so that the app's own definitions come out exactly:
 *
 *     knee flexion  = k          (shank tilt minus thigh tilt)
 *     hip flexion   = 0.9 k      (trunk lean minus thigh tilt)
 *     ankle dorsi   = 0.6 k      (shank tilt, foot flat)
 *
 * Those three series are also written out as an OpenSim .mot. So a perfect
 * tracker must score ~0 deg RMSE against it, and every degradation a real
 * model shows -- noise, dropped frames, a left/right swap -- must move the
 * numbers in the direction the report claims. That is what is asserted.
 */

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readStorage, writeStorage, resample } from "./lib/mot.mjs";
import { gtAngles, alignGt, alignLag, pearson } from "./lib/gt.mjs";
import { agreement, countScore, eventScore, median } from "./lib/score.mjs";
import { quality } from "./lib/quality.mjs";
import { runTask } from "./lib/tasks.mjs";
import { VIS_CUT, toNamed, clipFps } from "./lib/format.mjs";
import { MODELS, THRESHOLDS } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

let bad = 0;
const ok = (cond, msg, extra = "") => {
  if (!cond) bad++;
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
};
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// --- the fixture ------------------------------------------------------------
const FPS = 60, REPS = 5, PX_PER_M = 320, HEIGHT_M = 1.80;
const L_SHANK = 0.246 * HEIGHT_M * PX_PER_M;
const L_THIGH = 0.245 * HEIGHT_M * PX_PER_M;
const L_TRUNK = 0.288 * HEIGHT_M * PX_PER_M;
const FOOT = 0.16 * PX_PER_M;
const D = Math.PI / 180;

/** The knee-flexion trajectory: REPS squats to 95 deg, with a rest either end. */
function kneeTrace(n) {
  const k = new Array(n).fill(5);
  const pre = Math.round(0.8 * FPS), per = Math.round(1.8 * FPS);
  for (let r = 0; r < REPS; r++) {
    for (let i = 0; i < per; i++) {
      const f = pre + r * per + i;
      if (f >= n) break;
      k[f] = 5 + 90 * (1 - Math.cos(2 * Math.PI * i / per)) / 2;
    }
  }
  return k;
}

/** Landmarks from the trajectory -- a tracker that made no error at all. */
function poseFrom(k) {
  const s = 0.6 * k * D;            // shank tilt from vertical, forward +
  const t = (0.6 * k - k) * D;      // thigh tilt: hip travels back
  const tau = (0.6 * k - k + 0.9 * k) * D; // trunk lean, giving 0.9k at the hip
  const ax = 520, ay = 1150;                       // ankle, image pixels
  const up = (p, L, a) => [p[0] + L * Math.sin(a), p[1] - L * Math.cos(a)];
  const ankle = [ax, ay];
  const knee = up(ankle, L_SHANK, s);
  const hip = up(knee, L_THIGH, t);
  const sh = up(hip, L_TRUNK, tau);
  const toe = [ax + FOOT, ay + 2];
  const heel = [ax - 0.3 * FOOT, ay + 2];
  const head = up(sh, 0.12 * HEIGHT_M * PX_PER_M, tau);
  const dx = 9;                                   // the two sides, side-on
  const pair = (p) => [[p[0] - dx, p[1]], [p[0] + dx, p[1]]];
  const [la, ra] = pair(ankle), [lk, rk] = pair(knee), [lh, rh] = pair(hip);
  const [ls, rs] = pair(sh), [lt, rt] = pair(toe), [lhe, rhe] = pair(heel);
  const [le, re] = pair([sh[0] + 20, sh[1] + 0.35 * L_TRUNK]);
  const [lw, rw] = pair([sh[0] + 40, sh[1] + 0.70 * L_TRUNK]);
  return { nose: head, left_ear: [head[0] - dx, head[1]], right_ear: [head[0] + dx, head[1]],
           left_shoulder: ls, right_shoulder: rs, left_elbow: le, right_elbow: re,
           left_wrist: lw, right_wrist: rw,
           left_hip: lh, right_hip: rh, left_knee: lk, right_knee: rk,
           left_ankle: la, right_ankle: ra, left_heel: lhe, right_heel: rhe,
           left_foot_index: lt, right_foot_index: rt };
}

function buildFrames(k, { noisePx = 0, dropEvery = 0, swapAt = null, seed = 7 } = {}) {
  // A fixed generator, so a failure is reproducible rather than "sometimes".
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff - 0.5; };
  const frames = [];
  for (let i = 0; i < k.length; i++) {
    if (dropEvery && i % dropEvery === 0) continue;
    const lm = poseFrom(k[i]);
    if (noisePx) for (const nm of Object.keys(lm)) {
      lm[nm] = [lm[nm][0] + 2 * noisePx * rnd(), lm[nm][1] + 2 * noisePx * rnd()];
    }
    if (swapAt && i >= swapAt[0] && i < swapAt[1]) {
      for (const nm of ["shoulder", "hip", "knee", "ankle", "wrist"]) {
        const a = lm["left_" + nm], b = lm["right_" + nm];
        lm["left_" + nm] = b; lm["right_" + nm] = a;
      }
    }
    frames.push({ i, t: (i / FPS) * 1000, lm });
  }
  return frames;
}

const N = Math.round(0.8 * FPS) * 2 + REPS * Math.round(1.8 * FPS);
const K = kneeTrace(N);

// --- 1. the storage reader --------------------------------------------------
console.log("\nOpenSim storage");
const tmp = mkdtempSync(join(tmpdir(), "vmsel-"));
const gtFile = join(tmp, "gt.mot");
const LAB_LAG = 0.37;               // the lab started 0.37 s before the camera
const gtTime = K.map((_, i) => i / FPS + LAB_LAG);
writeStorage(gtFile, gtTime, {
  knee_angle_r: K, knee_angle_l: K,
  hip_flexion_r: K.map((v) => 0.9 * v), hip_flexion_l: K.map((v) => 0.9 * v),
  ankle_angle_r: K.map((v) => 0.6 * v), ankle_angle_l: K.map((v) => 0.6 * v),
}, { title: "selftest IK" });

const store = readStorage(gtFile);
ok(store.time.length === N, "every row read back", `${store.time.length}/${N}`);
ok(near(store.cols.knee_angle_r[100], K[100], 1e-3), "values survive the round trip");
ok(store.names.includes("hip_flexion_l"), "column names read");

const A = gtAngles(store, "rajagopal");
ok(near(A.angles.knee[200], K[200], 1e-3), "knee_angle_r -> knee, sign +1 in rajagopal");
ok(near(A.angles.ankle_r[200], 0.6 * K[200], 1e-3), "ankle mapped and per side");
const gait = gtAngles(store, "gait2392");
ok(near(gait.angles.knee[200], -K[200], 1e-3), "gait2392 flips the knee sign, as KNEE_SIGN says");

// a degrees/radians file must come back in degrees either way
const radFile = join(tmp, "gt_rad.mot");
writeStorage(radFile, gtTime, { knee_angle_r: K.map((v) => v * D) }, { inDegrees: false });
ok(near(readStorage(radFile).cols.knee_angle_r[200], K[200], 1e-3),
   "inDegrees=no is converted on read");

// --- 2. the perfect tracker -------------------------------------------------
console.log("\nA tracker that makes no error");
const clean = buildFrames(K);
const tClean = runTask(clean, { activity: "squat", heightM: HEIGHT_M, gridFps: FPS });
ok(tClean.ok && !tClean.error, "the app's analyse() ran", tClean.error || "");
ok(tClean.nReps === REPS, `finds all ${REPS} reps`, `got ${tClean.nReps}`);
ok(tClean.classified === "squat", "classify() calls it a squat", String(tClean.classified));
ok(near(tClean.fps, FPS, 0.01), "grid fps used as given");
ok(near(Math.max(...tClean.angles.knee), 95, 0.5), "knee angle reproduces the trajectory",
   `peak ${Math.max(...tClean.angles.knee).toFixed(1)}`);
ok(near(Math.max(...tClean.angles.hip), 85.5, 1.0), "hip angle is 0.9x the knee, as built");

// --- 3. alignment -----------------------------------------------------------
console.log("\nClock alignment");
const lag = alignLag(tClean.angleT, tClean.angles.knee,
                     { time: store.time, values: A.angles.knee }, { maxLagS: 2 });
ok(near(lag.lag, LAB_LAG, 1 / FPS + 1e-6), "recovers the injected lag", `${lag.lag.toFixed(3)} s`);
ok(lag.r > 0.99, "and says how sure it is", `r=${lag.r.toFixed(4)}`);

const aligned = alignGt(A, tClean.angleT, { syncAgainst: tClean.angles });
ok(aligned.channel === "knee" || aligned.channel === "hip",
   "picks the busiest shared channel to align on", aligned.channel);
let threw = null;
try {
  alignGt(A, tClean.angleT, { syncAgainst: { knee: tClean.angles.knee.map(() => 1) }, minR: 0.5 });
} catch (e) { threw = e.message; }
ok(!!threw, "refuses to align a flat signal instead of picking a lag at random");

// --- 4. scoring -------------------------------------------------------------
console.log("\nAgreement with the lab");
const sClean = agreement(tClean.angles.knee, aligned.angles.knee);
ok(sClean.rmse < 0.5, "perfect tracker scores ~0 deg RMSE", `${sClean.rmse.toFixed(3)}`);
ok(Math.abs(sClean.romErr) < 1, "and no ROM error", `${sClean.romErr.toFixed(2)}`);
ok(sClean.r > 0.999, "and r ~ 1", sClean.r.toFixed(5));

// a pure offset must show as bias, NOT as shape error -- the distinction the
// whole report rests on
const off = agreement(tClean.angles.knee.map((v) => v + 7), aligned.angles.knee);
ok(near(off.bias, 7, 0.2) && off.rmseDetrended < 0.5,
   "a constant offset lands in bias and leaves the shape error alone",
   `bias ${off.bias.toFixed(2)}, detrended ${off.rmseDetrended.toFixed(2)}`);
ok(near(off.loa[1] - off.loa[0], 3.92 * 0, 3), "limits of agreement collapse when only an offset differs");

// --- 5. a worse tracker must score worse ------------------------------------
console.log("\nA noisier tracker scores worse, on every axis the report uses");
const noisy = buildFrames(K, { noisePx: 6, dropEvery: 23 });
const tNoisy = runTask(noisy, { activity: "squat", heightM: HEIGHT_M, gridFps: FPS });
const aNoisy = alignGt(A, tNoisy.angleT, { syncAgainst: tNoisy.angles });
const sNoisy = agreement(tNoisy.angles.knee, aNoisy.angles.knee);
ok(sNoisy.rmse > sClean.rmse, "RMSE goes up", `${sClean.rmse.toFixed(2)} -> ${sNoisy.rmse.toFixed(2)}`);

const qClean = quality(clean, N), qNoisy = quality(noisy, N);
ok(qClean.detection === 1 && qNoisy.detection < 1, "detection rate sees the dropped frames",
   `${(qNoisy.detection * 100).toFixed(1)}%`);
ok(qNoisy.jitterPct > qClean.jitterPct, "jitter goes up",
   `${qClean.jitterPct.toFixed(3)} -> ${qNoisy.jitterPct.toFixed(3)}`);
ok(qNoisy.segmentCV > qClean.segmentCV, "segment length stability gets worse",
   `${qClean.segmentCV.toFixed(2)} -> ${qNoisy.segmentCV.toFixed(2)}`);
ok(qClean.keyPresence === 1, "a full skeleton reports every lower-limb landmark");

const swapped = buildFrames(K, { swapAt: [120, 200] });
ok(quality(swapped, N).swaps >= 2, "a left/right swap is counted (in and out)",
   `${quality(swapped, N).swaps}`);
ok(quality(clean, N).swaps === 0, "and a clean clip has none");

// --- 6. task-level outcomes -------------------------------------------------
console.log("\nWhat the app reports, which is the thing being compared");
ok(Object.keys(tClean.outcomes).length >= 3, "squat outcomes collected",
   Object.keys(tClean.outcomes).join(","));
ok(near(tClean.outcomes.knee_flex_max_deg.mean, 95, 2), "peak knee flexion per rep",
   tClean.outcomes.knee_flex_max_deg.mean.toFixed(1));
ok(tClean.outcomes.depth_m.mean > 0.15 && tClean.outcomes.depth_m.mean < 0.8,
   "squat depth is a plausible number of metres", tClean.outcomes.depth_m.mean.toFixed(3));
const cs = countScore(tNoisy.nReps, REPS);
ok(cs.diff === tNoisy.nReps - REPS, "rep counting is scored as a signed difference", String(cs.diff));
const ev = eventScore([1.0, 2.0, 3.05], [1.02, 2.5, 3.0], 0.1);
ok(ev.matched === 2 && ev.missed === 1, "event matching honours the tolerance",
   JSON.stringify(ev.matched + "/" + ev.missed));

// --- 7. the harness must not drift from the app -----------------------------
console.log("\nThe harness still describes the app it is benchmarking");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
ok(new RegExp(`visibility \\?\\? 1\\) >= ${VIS_CUT}`).test(indexHtml)
   || indexHtml.includes(`>= ${VIS_CUT}`),
   `visibility cut still ${VIS_CUT} in index.html`);
const harness = readFileSync(join(HERE, "bench", "harness.html"), "utf8");
for (const opt of ["runningMode: \"VIDEO\"", "minPoseDetectionConfidence", "delegate"]) {
  ok(harness.includes(opt) && indexHtml.includes(opt), `harness and app share ${opt}`);
}
ok(/MAX_SAMPLE_FRAMES = 3000/.test(harness) && /MAX_SAMPLE_FRAMES = 3000/.test(indexHtml),
   "same sampling ceiling as the app");
const shipped = MODELS.find((m) => m.baseline);
ok(shipped && indexHtml.includes(shipped.task.replace(/^assets\//, "assets/")),
   "the baseline entry points at the file index.html actually loads", shipped && shipped.task);
ok(existsSync(join(ROOT, shipped.task)), "and that file is in the repo");

// --- 8. small things that break silently ------------------------------------
console.log("\nOdds and ends");
ok(clipFps([{ t: 0 }, { t: 1000 }], null).fps === 1, "wall-clock fps when there is no grid");
ok(clipFps([], null).assumed === true, "an empty clip says its 30 fps was assumed");
ok(toNamed([{ x: 0.5, y: 0.25, visibility: 0.9 }], 100, 200).nose[1] === 50,
   "landmarks are scaled to pixels");
ok(toNamed([{ x: 0.5, y: 0.25, visibility: 0.1 }], 100, 200).nose === undefined,
   "and dropped below the visibility cut");
ok(near(median([3, 1, 2]), 2, 1e-9) && Number.isNaN(median([])), "median handles the empty case");
ok(near(pearson([1, 2, 3], [2, 4, 6]), 1, 1e-9), "pearson on a straight line");
ok(Number.isNaN(resample([0, 1], [0, 1], [5])[0]), "resample does not extrapolate");
ok(THRESHOLDS.rmseDeg > 0 && THRESHOLDS.detection <= 1, "thresholds are stated and sane");

// --- 9. run.mjs end to end, on cached tracks --------------------------------
/* The scoring half of the benchmark, driven exactly as a real run drives it:
 * a manifest, a ground-truth file and two cached tracks -- a good tracker and
 * a bad one -- straight into run.mjs with --no-track. This catches the things
 * unit tests never do: a manifest field read under the wrong name, a report
 * column wired to the wrong statistic, an aggregation that silently drops a
 * clip. The bad tracker MUST come out worse in the report, or the report is
 * decorative. */
console.log("\nrun.mjs end to end");
const { mkdirSync, writeFileSync } = await import("node:fs");
const { spawnSync } = await import("node:child_process");

const e2e = join(tmp, "e2e");
mkdirSync(join(e2e, "tracks"), { recursive: true });
const asTrack = (frames, id) => ({
  clip: "sq", model: id, frames, offered: N, gridFps: FPS,
  width: 1080, height: 1920, duration: N / FPS,
  timing: { loadMs: 100, firstMs: 40, medianMs: id === "full-cpu" ? 30 : 12,
            p95Ms: 40, meanMs: 15, samples: N },
});
writeFileSync(join(e2e, "tracks", "sq__full.json"), JSON.stringify(asTrack(clean, "full")));
writeFileSync(join(e2e, "tracks", "sq__full-cpu.json"),
              JSON.stringify(asTrack(buildFrames(K, { noisePx: 9, dropEvery: 17 }), "full-cpu")));

const manifest = join(tmp, "manifest.json");
writeFileSync(manifest, JSON.stringify({ clips: [{
  id: "sq", video: "tests/vision_model/clips/none.mp4", activity: "squat",
  fps: FPS, heightM: HEIGHT_M, massKg: 78,
  groundTruth: { file: gtFile, convention: "rajagopal", offsetS: null },
  expect: { activity: "squat", reps: REPS },
}] }));

const r = spawnSync(process.execPath,
  [join(HERE, "run.mjs"), "--clips", manifest, "--out", e2e,
   "--no-track", "--models", "full,full-cpu"],
  { encoding: "utf8", cwd: ROOT });
ok(r.status === 0, "run.mjs exits clean", `status ${r.status}`);
const out = (r.stdout || "") + (r.stderr || "");
ok(existsSync(join(e2e, "report.md")), "writes report.md");
ok(existsSync(join(e2e, "report.html")), "writes report.html");
ok(existsSync(join(e2e, "results.json")), "writes results.json");
ok(/passes every threshold/.test(out), "the good tracker passes");

const res = JSON.parse(readFileSync(join(e2e, "results.json"), "utf8"));
const good = res.perModel.full, worse = res.perModel["full-cpu"];
ok(good && worse, "both models aggregated");
ok(worse.gt.rmse > good.gt.rmse, "the noisy track scores a worse joint RMSE",
   `${good.gt.rmse.toFixed(2)} -> ${worse.gt.rmse.toFixed(2)}`);
ok(worse.quality.jitterPct > good.quality.jitterPct, "and worse jitter");
ok(/NOT clear/.test(worse.verdict), "and is refused by the thresholds", worse.verdict.slice(0, 60));
ok(good.task.repsOk === 1 && good.task.activityOk === 1,
   "the clean track matches the manifest's rep count and task");
ok(res.perClip.sq__full.align && near(res.perClip.sq__full.align.lag, LAB_LAG, 1 / FPS + 1e-6),
   "run.mjs recovered the lab clock offset by itself");
ok(Number.isFinite(good.timing.vsBaseline) && good.timing.vsBaseline === 1,
   "the baseline is 1.00x itself");
const htmlOut = readFileSync(join(e2e, "report.html"), "utf8");
ok(/<svg/.test(htmlOut) && !/https?:\/\//.test(htmlOut.replace(/<!--[\s\S]*?-->/g, "")),
   "the HTML report draws waveforms and loads nothing from the network");

console.log(`\n${bad ? bad + " FAILED" : "all passed"}\n`);
process.exit(bad ? 1 : 0);
