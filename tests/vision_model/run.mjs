#!/usr/bin/env node
/**
 * run.mjs -- the vision-model benchmark.
 *
 *   node tests/vision_model/run.mjs                       everything in the manifest
 *   node tests/vision_model/run.mjs --models full,heavy   just these
 *   node tests/vision_model/run.mjs --clips my.json       another manifest
 *   node tests/vision_model/run.mjs --no-track            re-score cached tracks
 *   node tests/vision_model/run.mjs --retrack             ignore the cache
 *
 * Order of operations, and why:
 *
 *   track    each model over each clip, on the app's own sampling grid, in
 *            the app's own vendored MediaPipe build. Cached.
 *   quality  what can be said without a lab: dropout, jitter, segment length
 *            stability, left/right swaps.
 *   analyse  the APP's pipeline on those landmarks -- classify(), analyse().
 *            This is the thing being compared; landmarks are only the input.
 *   score    joint angles against marker-based IK, once the two clocks are
 *            aligned. Bias and shape error reported separately.
 *   report   markdown for the decision, HTML for the evidence.
 *
 * A model wins here by making the APP right, not by looking good in isolation.
 */

import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS, DEFAULT_MODEL_IDS, THRESHOLDS } from "./config.mjs";
import { trackAll } from "./bench/browser.mjs";
import { quality } from "./lib/quality.mjs";
import { runTask, scoredJoints } from "./lib/tasks.mjs";
import { readStorage } from "./lib/mot.mjs";
import { gtAngles, alignGt } from "./lib/gt.mjs";
import { agreement, median } from "./lib/score.mjs";
import { markdown, html } from "./lib/report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// --- arguments --------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes("--" + name);

const manifestPath = resolve(ROOT, arg("clips", "tests/vision_model/clips/manifest.json"));
const outDir = resolve(ROOT, arg("out", "tests/vision_model/results"));
const wantIds = (arg("models") || DEFAULT_MODEL_IDS.join(",")).split(",").map((s) => s.trim());

if (!existsSync(manifestPath)) {
  console.error(`no manifest at ${manifestPath}`);
  console.error(`Copy tests/vision_model/clips/manifest.example.json and point it at your clips.`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const clips = manifest.clips.filter((c) => !arg("clip") || c.id === arg("clip"));
if (!clips.length) { console.error("no clips selected"); process.exit(2); }

const notes = [];
const models = [];
for (const id of wantIds) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) { notes.push(`unknown model "${id}" -- see config.mjs`); continue; }
  const p = resolve(ROOT, m.task);
  if (!existsSync(p)) {
    notes.push(`${id}: model file missing (${m.task}). Run: node tests/vision_model/fetch_models.mjs`);
    continue;
  }
  models.push({ ...m, sizeMB: statSync(p).size / 1e6 });
}
if (!models.length) { console.error(notes.join("\n") || "no models"); process.exit(2); }

const baseline = (models.find((m) => m.baseline) || models[0]).id;
mkdirSync(outDir, { recursive: true });

// --- 1. track ---------------------------------------------------------------
const jobs = [];
for (const c of clips) for (const m of models) jobs.push({ clip: c, model: m });

let tracks = {};
if (flag("no-track")) {
  const { trackPath } = await import("./bench/browser.mjs");
  for (const j of jobs) {
    const p = trackPath(outDir, j.clip.id, j.model.id);
    if (existsSync(p)) tracks[`${j.clip.id}__${j.model.id}`] = JSON.parse(readFileSync(p, "utf8"));
    else notes.push(`no cached track for ${j.clip.id} / ${j.model.id}`);
  }
} else {
  tracks = await trackAll(ROOT, jobs, {
    outDir, retrack: flag("retrack"), headless: !flag("headed"),
    onProgress: ({ clip, model, cached }) =>
      console.log(`  ${cached ? "cached " : "track  "} ${clip.id} / ${model.id}`),
  });
  if (tracks.__pageErrors) {
    notes.push(`browser reported ${tracks.__pageErrors.length} error(s): ` +
               tracks.__pageErrors.slice(0, 3).join(" | "));
    delete tracks.__pageErrors;
  }
}

// --- 2..4. score ------------------------------------------------------------
const perClip = {};
const plotJoints = {};

for (const c of clips) {
  const gtCache = {};
  for (const m of models) {
    const key = `${c.id}__${m.id}`;
    const tr = tracks[key];
    const R = perClip[key] = { clip: c.id, model: m.id };
    if (!tr) { R.error = "not tracked"; continue; }
    if (tr.error) { R.error = tr.error; continue; }
    if (!tr.frames || tr.frames.length < 20) {
      R.error = `only ${tr.frames ? tr.frames.length : 0} frames tracked`;
      continue;
    }
    R.timing = { ...tr.timing, sizeMB: m.sizeMB };
    R.quality = quality(tr.frames, tr.offered);

    const task = runTask(tr.frames, {
      activity: c.activity, heightM: c.heightM ?? 1.75, massKg: c.massKg ?? 75,
      gridFps: tr.gridFps ?? c.fps ?? null,
      osimModel: (c.groundTruth && c.groundTruth.convention) || "rajagopal",
    });
    R.task = task;
    if (task.error) { R.error = task.error; continue; }

    // --- ground truth ------------------------------------------------------
    const g = c.groundTruth;
    if (!g || !g.file) { R.gt = {}; continue; }
    const gp = resolve(ROOT, g.file);
    if (!existsSync(gp)) { notes.push(`${c.id}: ground truth missing (${g.file})`); R.gt = {}; continue; }
    try {
      const store = gtCache[gp] || (gtCache[gp] = readStorage(gp));
      const A = gtAngles(store, g.convention || "rajagopal");
      const aligned = alignGt(A, task.angleT, {
        offsetS: g.offsetS ?? null, syncChannel: g.syncChannel ?? null,
        syncAgainst: task.angles, maxLagS: g.maxLagS ?? 2.0, minR: g.minR ?? 0.5,
      });
      R.align = { lag: aligned.lag, r: aligned.r, channel: aligned.channel };
      R.gt = {};
      const joints = scoredJoints(c.activity, task.angles)
        .filter((j) => aligned.angles[j]);
      for (const j of joints) R.gt[j] = agreement(task.angles[j], aligned.angles[j]);
      R.gtSummary = { rmse: median(joints.map((j) => R.gt[j].rmse)),
                      rmseDetrended: median(joints.map((j) => R.gt[j].rmseDetrended)),
                      bias: median(joints.map((j) => R.gt[j].bias)),
                      romErr: median(joints.map((j) => Math.abs(R.gt[j].romErr))),
                      r: median(joints.map((j) => R.gt[j].r)),
                      n: joints.length };
      // Waveforms for the HTML report, thinned so the file stays small.
      plotJoints[c.id] = joints.slice(0, 3);
      R.plot = {};
      for (const j of plotJoints[c.id]) {
        const step = Math.max(1, Math.ceil(task.angleT.length / 600));
        const pick = (a) => a.filter((_, i) => i % step === 0);
        R.plot[j] = { t: pick(task.angleT), est: pick(task.angles[j]),
                      ref: pick(aligned.angles[j]) };
      }
    } catch (err) {
      notes.push(`${c.id} / ${m.id}: ground truth not used -- ${err.message}`);
      R.gt = {};
    }
  }
}

// --- 5. aggregate per model -------------------------------------------------
const perModel = {};
for (const m of models) {
  const rows = clips.map((c) => perClip[`${c.id}__${m.id}`]).filter(Boolean);
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) { perModel[m.id] = null; notes.push(`${m.id}: every clip failed`); continue; }

  const allJoint = [];
  for (const r of ok) for (const a of Object.values(r.gt || {})) allJoint.push(a);
  const gt = {
    rmse: median(allJoint.map((a) => a.rmse)),
    rmseDetrended: median(allJoint.map((a) => a.rmseDetrended)),
    bias: median(allJoint.map((a) => a.bias)),
    romErr: median(allJoint.map((a) => Math.abs(a.romErr))),
    r: median(allJoint.map((a) => a.r)),
    n: allJoint.length,
  };

  const q = {
    detection: median(ok.map((r) => r.quality.detection)),
    keyPresence: median(ok.map((r) => r.quality.keyPresence)),
    jitterPct: median(ok.map((r) => r.quality.jitterPct)),
    segmentCV: median(ok.map((r) => r.quality.segmentCV)),
    swapsPerS: median(ok.map((r) => r.quality.swapsPerS)),
  };

  const t = {
    sizeMB: m.sizeMB,
    loadMs: median(ok.map((r) => r.timing.loadMs)),
    firstMs: median(ok.map((r) => r.timing.firstMs)),
    medianMs: median(ok.map((r) => r.timing.medianMs)),
    p95Ms: median(ok.map((r) => r.timing.p95Ms)),
  };

  // Task-level: did the app come out the same place?
  const withExpect = ok.filter((r) => clipOf(r).expect);
  const activityN = withExpect.filter((r) => clipOf(r).expect.activity).length;
  const activityOk = withExpect.filter((r) => r.task.classified === clipOf(r).expect.activity).length;
  const repsN = withExpect.filter((r) => Number.isFinite(clipOf(r).expect.reps)).length;
  const repDiffs = withExpect.filter((r) => Number.isFinite(clipOf(r).expect.reps))
    .map((r) => r.task.nReps - clipOf(r).expect.reps);
  const repsOk = repDiffs.filter((d) => d === 0).length;

  // Drift: how far the headline outcomes moved from the shipped model, in
  // percent. This is the number to quote when nobody has ground truth -- it
  // says what switching would change, without claiming which is right.
  const drift = driftVsBaseline(m.id);

  perModel[m.id] = { gt, quality: q, timing: t,
                     task: { activityOk, activityN, repsOk, repsN, repDiffs, drift },
                     verdict: verdict({ id: m.id, gt, q, repDiffs, activityOk, activityN }) };
}
for (const m of models) {
  const s = perModel[m.id];
  if (s) s.timing.vsBaseline = perModel[baseline]
    ? s.timing.medianMs / perModel[baseline].timing.medianMs : NaN;
}

function clipOf(r) { return clips.find((c) => c.id === r.clip); }

function driftVsBaseline(id) {
  if (id === baseline) return "baseline";
  const d = [];
  for (const c of clips) {
    const a = perClip[`${c.id}__${id}`], b = perClip[`${c.id}__${baseline}`];
    if (!a || !b || a.error || b.error || !a.task.outcomes || !b.task.outcomes) continue;
    for (const [k, va] of Object.entries(a.task.outcomes)) {
      const vb = b.task.outcomes[k];
      if (!vb || !Number.isFinite(va.mean) || !Number.isFinite(vb.mean) || !vb.mean) continue;
      d.push(Math.abs((va.mean - vb.mean) / vb.mean) * 100);
    }
  }
  return d.length ? `${median(d).toFixed(1)}% median (${d.length} outcomes)` : "--";
}

function verdict({ id, gt, q, repDiffs, activityOk, activityN }) {
  const bad = [];
  if (Number.isFinite(gt.rmse) && gt.rmse > THRESHOLDS.rmseDeg) bad.push(`joint RMSE ${gt.rmse.toFixed(1)} deg`);
  if (Number.isFinite(gt.romErr) && gt.romErr > THRESHOLDS.romErrDeg) bad.push(`ROM error ${gt.romErr.toFixed(1)} deg`);
  if (q.detection < THRESHOLDS.detection) bad.push(`detection ${(q.detection * 100).toFixed(0)}%`);
  if (q.keyPresence < THRESHOLDS.keyPresence) bad.push(`lower-limb landmarks ${(q.keyPresence * 100).toFixed(0)}%`);
  if (q.jitterPct > THRESHOLDS.jitterPct) bad.push(`jitter ${q.jitterPct.toFixed(2)}% torso`);
  if (q.segmentCV > THRESHOLDS.segmentCV) bad.push(`segment CV ${q.segmentCV.toFixed(1)}%`);
  if (q.swapsPerS > THRESHOLDS.swapsPerS) bad.push(`${q.swapsPerS.toFixed(2)} L/R swaps per s`);
  if (repDiffs.some((d) => Math.abs(d) > THRESHOLDS.repDiff)) bad.push(`rep count off by ${repDiffs.join(",")}`);
  if (activityN && activityOk < activityN) bad.push(`task misread on ${activityN - activityOk} clip(s)`);
  if (!Number.isFinite(gt.rmse)) bad.push("no ground truth scored");
  const head = id === baseline ? "the shipped model" : "candidate";
  return bad.length ? `${head}: NOT clear -- ${bad.join("; ")}`
                    : `${head}: passes every threshold on this set`;
}

// --- 6. write ---------------------------------------------------------------
const run = { startedAt: new Date().toISOString(), baseline, thresholds: THRESHOLDS,
              models, clips, perClip, perModel, plotJoints, notes };

writeFileSync(join(outDir, "results.json"), JSON.stringify(run, null, 1));
const md = markdown(run);
writeFileSync(join(outDir, "report.md"), md);
writeFileSync(join(outDir, "report.html"), html(run));
console.log("\n" + md + "\n");
console.log(`written: ${join(outDir, "report.md")}`);
console.log(`         ${join(outDir, "report.html")}`);

// A model failing a threshold is a RESULT, not a broken run, so it does not
// fail the process. Only a run that could not measure anything does.
const measured = Object.values(perModel).filter(Boolean).length;
process.exit(measured ? 0 : 1);
