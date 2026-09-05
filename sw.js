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
const CACHE = "bioscout-web-v31";

const SHELL = ["./", "./index.html", "./kinematics.js", "./dynamics.js",
               "./forces.js", "./overlay.js", "./zip.js", "./detect.js", "./profiles.js", "./ensemble.js", "./i18n.js", "./norms.json", "./muscle_joints.json", "./manifest.webmanifest",
               "./logo.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
               "./apple-touch-icon.png", "./favicon.ico"];
const HEAVY = [
  "./pose_landmarker_full.task",
  // The force model is 1.4 MB and only changes when it is retrained, which
  // already requires a CACHE bump for the pose model beside it. Network-first
  // meant paying for it on every single load.
  "./force_model.json",
  "./vendor/vision_bundle.mjs",
  "./vendor/three.module.min.js",
  "./vendor/three.core.min.js",
  "./meshes/gwen_v3.json", "./meshes/gwen_v3.bin",
  "./meshes/gohan_ss_v6.json", "./meshes/gohan_ss_v6.bin",
  "./meshes/bas_v3.json", "./meshes/bas_v3.bin",
  "./meshes/gpk_bones.json", "./meshes/gpk_bones.bin",
  "./vendor/wasm/vision_wasm_internal.js",
  "./vendor/wasm/vision_wasm_internal.wasm",
  "./vendor/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/wasm/vision_wasm_nosimd_internal.wasm",
  "./vendor/wasm/vision_wasm_module_internal.js",
  "./vendor/wasm/vision_wasm_module_internal.wasm",
];

// Must classify every HEAVY entry as heavy and every SHELL entry as not.
// test_sw_cache.mjs asserts exactly that: when the two lists and this predicate
// disagree, a precached file is still served network-first, and `cache:
// "reload"` below means it is refetched in full on every load -- the cached
// copy only ever gets used offline. That is how the 15 MB of meshes came to be
// downloaded on every avatar switch while sitting in the cache untouched.
const isHeavy = (url) =>
  url.pathname.includes("/vendor/") ||
  url.pathname.includes("/meshes/") ||
  url.pathname.endsWith(".task") ||
  url.pathname.endsWith("/force_model.json");

self.addEventListener("install", (e) => {
  // Individually, not addAll: one 404 must not fail the whole install.
  e.waitUntil(
    caches.open(CACHE)
      // Individually so one 404 cannot fail the whole install -- but not
      // silently: a renamed file that drops out of this list leaves the app
      // half-cached and broken offline, with nothing to show for it.
      .then((c) => Promise.all([...SHELL, ...HEAVY].map(
        (u) => c.add(u).catch((err) => console.warn("[sw] precache failed:", u, err)))))
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

  // cache: "reload" bypasses the HTTP cache on the way out. Without it
  // "network-first" is only first past the BROWSER cache, and GitHub Pages
  // serves the shell with max-age=600 -- so a pushed fix could sit invisible
  // for ten minutes behind a service worker that believed it had gone to the
  // network. Falls back to a plain fetch where the option is unsupported.
  const fresh = (r) => fetch(r, { cache: "reload" }).catch(() => fetch(r));

  e.respondWith(                                        // network-first
    fresh(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((hit) => hit ||
        (req.mode === "navigate" ? caches.match("./index.html") : undefined))));
});
