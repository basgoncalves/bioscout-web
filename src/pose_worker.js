/* pose_worker.js -- the pose model off the page's thread, for video FILES.
 *
 * On the page, the model and the video decoder share one thread: while the
 * model looks at a frame, the video cannot present the next one, so a clip had
 * to be paused, seeked or slowed for every frame -- minutes for a 16 s phone
 * clip with a keyframe every 10 s (Bas, 2026-10-15). Here the page only copies
 * each presented frame (a small ImageBitmap) and the model runs in parallel.
 *
 *   {cmd:"init"}                         -> {ready:true} | {error}
 *   {cmd:"detect", k, ts, bmp}           -> {k, lms: [{x,y,z,visibility}] | null}
 * Timestamps must only go forward, as on the page. */
import { FilesetResolver, PoseLandmarker } from "../assets/vendor/vision_bundle.mjs";

let model = null;
self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.cmd === "init") {
      const fs = await FilesetResolver.forVisionTasks(new URL("../assets/vendor/wasm", import.meta.url).href);
      /* A MODULE worker has no importScripts, which is how the bundle loads its
       * wasm glue in a worker ("ModuleFactory not set"). Load the glue here as
       * a global script instead: an indirect eval defines its ModuleFactory on
       * the worker's global object, where the bundle looks for it. */
      if (typeof self.ModuleFactory === "undefined") {
        const glue = await (await fetch(fs.wasmLoaderPath)).text();
        (0, eval)(glue);
        self.importScripts = () => {};   // already loaded
      }
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: new URL("../assets/pose_landmarker_full.task", import.meta.url).href, delegate },
        runningMode: "VIDEO", numPoses: 1,
        minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
      });
      try { model = await PoseLandmarker.createFromOptions(fs, opts("GPU")); }
      catch { model = await PoseLandmarker.createFromOptions(fs, opts("CPU")); }
      self.postMessage({ ready: true });
    } else if (d.cmd === "detect") {
      const r = model.detectForVideo(d.bmp, d.ts);
      d.bmp.close();
      const lms = r.landmarks && r.landmarks.length
        ? r.landmarks[0].map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility })) : null;
      self.postMessage({ k: d.k, lms });
    } else if (d.cmd === "close") { if (model) model.close(); model = null; }
  } catch (err) {
    if (d.bmp) try { d.bmp.close(); } catch { /* gone */ }
    self.postMessage({ k: d.k, error: String(err && err.message || err) });
  }
};
