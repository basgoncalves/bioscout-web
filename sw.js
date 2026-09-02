/* Cache everything on first visit so the app works with no network at all. */
const CACHE = "movement-lab-v1";
const ASSETS = [
  "./", "./index.html", "./pullupkit.js", "./manifest.webmanifest",
  "./pose_landmarker_full.task",
  "./vendor/vision_bundle.mjs",
  "./vendor/wasm/vision_wasm_internal.js",
  "./vendor/wasm/vision_wasm_internal.wasm",
  "./vendor/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/wasm/vision_wasm_nosimd_internal.wasm",
  "./vendor/wasm/vision_wasm_module_internal.js",
  "./vendor/wasm/vision_wasm_module_internal.wasm",
];

self.addEventListener("install", (e) => {
  // addAll fails the whole install if any one asset 404s, so add individually.
  e.waitUntil(caches.open(CACHE).then((c) =>
    Promise.all(ASSETS.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
