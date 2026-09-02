/**
 * Service worker.
 *
 * Split by how the files change, because a single cache-first strategy is a
 * trap: it pins every visitor to whatever version they first loaded, and no
 * amount of pushing fixes reaches them.
 *
 *   app shell (index.html, kinematics.js, the manifest)
 *       network-first. Small files that change whenever the code changes, so
 *       correctness beats latency. Falls back to cache when offline.
 *
 *   heavy immutable assets (the wasm engine and the pose model, ~44 MB)
 *       cache-first. They only change when the pinned MediaPipe version does,
 *       and re-downloading them on every visit would defeat the point.
 *
 * Bump CACHE when the vendored engine or model changes, to evict the old copy.
 */
const CACHE = "bioscout-web-v11";

const SHELL = ["./", "./index.html", "./kinematics.js", "./dynamics.js",
               "./forces.js", "./overlay.js", "./zip.js", "./detect.js", "./profiles.js", "./force_model.json", "./muscle_joints.json", "./manifest.webmanifest",
               "./logo.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
               "./apple-touch-icon.png", "./favicon.ico"];
const HEAVY = [
  "./pose_landmarker_full.task",
  "./vendor/vision_bundle.mjs",
  "./vendor/three.module.min.js",
  "./vendor/three.core.min.js",
  "./meshes/gwen_v3.json", "./meshes/gwen_v3.bin",
  "./meshes/gohan_ss_v4.json", "./meshes/gohan_ss_v4.bin",
  "./meshes/gpk_generic.json", "./meshes/gpk_generic.bin",
  "./meshes/bas_v3.json", "./meshes/bas_v3.bin",
  "./meshes/gpk_bones.json", "./meshes/gpk_bones.bin",
  "./vendor/wasm/vision_wasm_internal.js",
  "./vendor/wasm/vision_wasm_internal.wasm",
  "./vendor/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/wasm/vision_wasm_nosimd_internal.wasm",
  "./vendor/wasm/vision_wasm_module_internal.js",
  "./vendor/wasm/vision_wasm_module_internal.wasm",
];

const isHeavy = (url) =>
  url.pathname.includes("/vendor/") || url.pathname.endsWith(".task");

self.addEventListener("install", (e) => {
  // Individually, not addAll: one 404 must not fail the whole install.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all([...SHELL, ...HEAVY].map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (isHeavy(url)) {                                  // cache-first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    })));
    return;
  }

  e.respondWith(                                        // network-first
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((hit) => hit ||
        (req.mode === "navigate" ? caches.match("./index.html") : undefined))));
});
