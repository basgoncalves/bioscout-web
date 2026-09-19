/**
 * browser.mjs -- drive the harness page in headless Chromium.
 *
 * Playwright is an OPTIONAL dependency: the scoring half of this harness runs
 * with nothing installed, and only tracking needs a browser. So it is imported
 * dynamically and a missing install says what to do rather than throwing a
 * module-not-found at someone who only wanted to re-score existing tracks.
 *
 *   npm i -D playwright && npx playwright install chromium
 *
 * Tracks are CACHED to results/tracks/<clip>__<model>.json. Tracking is the
 * slow half (a minute a clip a model), scoring is the half that gets iterated
 * on, and nobody should re-run a GPU for a change to a report column. --retrack
 * forces it.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { serveRepo } from "./serve.mjs";

async function playwright() {
  try { return await import("playwright"); }
  catch {
    throw new Error(
      "playwright is not installed -- tracking needs it.\n" +
      "  npm i -D playwright && npx playwright install chromium\n" +
      "(scoring existing tracks in results/tracks/ works without it)");
  }
}

export const trackPath = (outDir, clipId, modelId) =>
  join(outDir, "tracks", `${clipId}__${modelId}.json`);

/**
 * @param repoRoot  absolute path to the repo root (what gets served)
 * @param jobs      [{ clip, model }] -- clip from the manifest, model from config
 * @returns         a map "clipId__modelId" -> track result
 */
export async function trackAll(repoRoot, jobs, { outDir, retrack = false,
                                                 headless = true,
                                                 onProgress = () => {} } = {}) {
  const results = {};
  const todo = [];
  for (const job of jobs) {
    const p = trackPath(outDir, job.clip.id, job.model.id);
    if (!retrack && existsSync(p)) {
      results[`${job.clip.id}__${job.model.id}`] = JSON.parse(readFileSync(p, "utf8"));
      onProgress({ ...job, cached: true });
    } else todo.push(job);
  }
  if (!todo.length) return results;

  const { chromium } = await playwright();
  const srv = await serveRepo(repoRoot);
  const base = `http://127.0.0.1:${srv.port}`;
  // --use-gl=angle keeps the GPU delegate on a real backend in headless mode;
  // without it MediaPipe silently falls back to CPU and every model looks
  // equally slow, which is the one result this harness must not invent.
  const browser = await chromium.launch({
    headless,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
           "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${base}/tests/vision_model/bench/harness.html`);
    await page.waitForFunction(() => window.__vmReady === true, null, { timeout: 30000 });
    await page.evaluate((u) => window.__vm.loadEngine(u),
                        `${base}/assets/vendor/vision_bundle.mjs`);

    for (const job of todo) {
      const { clip, model } = job;
      onProgress({ ...job, cached: false });
      const cfg = {
        video: `${base}/${clip.video.replace(/^\.?\//, "")}`,
        fps: clip.fps || null, from: clip.from ?? 0, to: clip.to ?? null,
        model: {
          id: model.id,
          wasmUrl: `${base}/assets/vendor/wasm`,
          modelUrl: `${base}/${model.task.replace(/^\.?\//, "")}`,
          delegate: model.delegate || "GPU",
          numPoses: model.numPoses || 1,
          minDet: model.minDet ?? 0.3, minPres: model.minPres ?? 0.3,
          minTrack: model.minTrack ?? 0.3,
        },
      };
      let res;
      try {
        res = await page.evaluate((c) => window.__vm.track(c), cfg);
      } catch (err) {
        res = { error: String(err && err.message || err), frames: [], offered: 0 };
      }
      res.model = model.id; res.clip = clip.id; res.trackedAt = new Date().toISOString();
      const p = trackPath(outDir, clip.id, model.id);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(res));
      results[`${clip.id}__${model.id}`] = res;
    }
    if (errors.length) results.__pageErrors = errors;
  } finally {
    await browser.close();
    await srv.close();
  }
  return results;
}
