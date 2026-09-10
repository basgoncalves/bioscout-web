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
/* v33: the cardio/vitals/neck modules joined the shell, and a stale v32
 * client was still running the index.html from before the cardio argument
 * fix -- a blank dashboard on a site whose files were already correct.
 * Bumping evicts that cache outright rather than trusting network-first to
 * beat it on every load.
 * v41: the icons moved from the repo root into assets/icons/. The old cache
 * still holds ./logo.png and friends at paths that no longer exist, so it has
 * to be evicted rather than merged. */
/* TWO caches, and the split is the point.
 *
 * There used to be one. Every bump of it deleted everything, including the
 * pose model, the vision bundle, three.js and four character meshes -- twenty
 * megabytes that then had to come down again before the camera button could be
 * enabled. During a week of shell fixes that happened six times, and each time
 * the app looked broken on a phone: a dead Start camera button and no
 * explanation, because the shell had updated instantly and the engine had not.
 *
 * So the shell version moves whenever a source file changes, which is often,
 * and the heavy version moves only when a vendored asset actually changes,
 * which is rarely. A shell bump can no longer cost anybody a 20 MB download.
 */
const SHELL_CACHE = "bioscout-shell-v70";
const HEAVY_CACHE = "bioscout-heavy-v1";
const KEEP = [SHELL_CACHE, HEAVY_CACHE];

const SHELL = ["./", "./index.html", "./formats.html", "./src/kinematics.js", "./src/dynamics.js",
               "./src/forces.js", "./src/overlay.js", "./src/zip.js", "./src/detect.js", "./src/profiles.js", "./src/ensemble.js", "./src/dashboard.js", "./src/fetcher.js", "./src/diary.js", "./src/media.js", "./src/weight.js", "./src/cycle.js", "./src/foods.js", "./src/share.js", "./src/sleep.js", "./src/vitals.js", "./src/cardio.js", "./src/strava.js", "./src/neckload.js", "./src/neck_gload.js", "./src/assess.js", "./src/framing.js", "./src/gesture.js", "./src/muscle_groups.js", "./src/tiptoe_ref.js", "./src/neck_load.js", "./src/health.js", "./src/i18n.js", "./src/jointmetrics.js", "./data/norms.json", "./data/muscle_joints.json", "./manifest.webmanifest",
               "./assets/icons/logo.png", "./assets/icons/icon-192.png",
               "./assets/icons/icon-512.png", "./assets/icons/icon-maskable-512.png",
               "./assets/icons/apple-touch-icon.png", "./assets/icons/favicon.ico"];
const HEAVY = [
  // 1.4 MB and it changes only when the model is retrained: cache-first, like
  // the pose model and the meshes, rather than re-fetched on every analysis.
  "./data/force_model.json",
  "./assets/pose_landmarker_full.task",
  "./assets/vendor/vision_bundle.mjs",
  "./assets/vendor/three.module.min.js",
  "./assets/vendor/three.core.min.js",
  "./assets/meshes/gwen_v3.json", "./assets/meshes/gwen_v3.bin",
  "./assets/meshes/gohan_ss_v6.json", "./assets/meshes/gohan_ss_v6.bin",
  "./assets/meshes/bas_v3.json", "./assets/meshes/bas_v3.bin",
  "./assets/meshes/gpk_bones.json", "./assets/meshes/gpk_bones.bin",
  "./assets/vendor/wasm/vision_wasm_internal.js",
  "./assets/vendor/wasm/vision_wasm_internal.wasm",
  "./assets/vendor/wasm/vision_wasm_nosimd_internal.js",
  "./assets/vendor/wasm/vision_wasm_nosimd_internal.wasm",
  "./assets/vendor/wasm/vision_wasm_module_internal.js",
  "./assets/vendor/wasm/vision_wasm_module_internal.wasm",
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

// Individually, not addAll: one 404 must not fail the whole install -- but not
// silently either, because a renamed file that drops out of these lists leaves
// the app half-cached and broken offline with nothing to show for it.
const precache = (cache, urls, { skipExisting = false } = {}) =>
  caches.open(cache).then((c) => Promise.all(urls.map(async (u) => {
    // The heavy assets are re-added on every install otherwise, which is the
    // download this split exists to avoid.
    if (skipExisting && await c.match(u)) return;
    return c.add(u).catch((err) => console.warn("[sw] precache failed:", u, err));
  })));

self.addEventListener("install", (e) => {
  e.waitUntil(Promise.all([
    precache(SHELL_CACHE, SHELL),
    precache(HEAVY_CACHE, HEAVY, { skipExisting: true }),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (isHeavy(url)) {                                  // cache-first
    e.respondWith(caches.open(HEAVY_CACHE).then((c) => c.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        c.put(req, res.clone()).catch(() => {});
        return res;
      }))));
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
      caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((hit) => hit ||
        (req.mode === "navigate" ? caches.match("./index.html") : undefined))));
});
