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
const SHELL_CACHE = "bioscout-shell-v286";
const HEAVY_CACHE = "bioscout-heavy-v1";
const PIN_CACHE = "bioscout-pin";        // which old build the person chose (one entry), and its files
const KEEP = [SHELL_CACHE, HEAVY_CACHE, PIN_CACHE];
/* Old builds come from the repository at that build's commit (raw files, CORS
 * open), served here under this origin -- so an old build still sees this
 * browser's saved data. builds.json lists build -> commit. */
const RAW = "https://raw.githubusercontent.com/basgoncalves/bioscout-web/";
const TYPES = { html: "text/html", js: "text/javascript", mjs: "text/javascript", json: "application/json", css: "text/css",
  webmanifest: "application/manifest+json", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", wasm: "application/wasm",
  osim: "text/xml", xml: "text/xml", txt: "text/plain", md: "text/plain", task: "application/octet-stream" };
const PIN_KEY = "./__pinned_build";
async function pinned() {
  try { const r = await (await caches.open(PIN_CACHE)).match(PIN_KEY); return r ? await r.json() : null; } catch { return null; }
}

const SHELL = ["./", "./index.html", "./builds.json", "./formats.html", "./privacy.html", "./limitations.html", "./glossary/", "./glossary/index.html", "./src/kinematics.js", "./src/dynamics.js",
               "./src/forces.js", "./src/overlay.js", "./src/zip.js", "./src/detect.js", "./src/profiles.js", "./src/ensemble.js", "./src/dashboard.js", "./src/fetcher.js", "./src/diary.js", "./src/media.js", "./src/weight.js", "./src/bodyfat.js", "./src/cycle.js", "./src/foods.js", "./src/energy.js", "./src/share.js", "./src/trainsummary.js", "./src/athsummary.js", "./src/plans.js", "./src/resttimer.js", "./src/protocol.js", "./src/sharepost.js", "./src/sleep.js", "./src/vitals.js", "./src/water.js", "./src/reaction.js", "./src/friends.js", "./src/cardio.js", "./src/strava.js", "./src/neckload.js", "./src/neck_gload.js", "./src/assess.js", "./src/framing.js", "./src/gesture.js", "./src/muscle_groups.js", "./src/armmuscles.js", "./src/tiptoe_ref.js", "./src/neck_load.js", "./src/loaddir.js", "./src/neckmuscles.js", "./data/neck_muscles.json", "./src/health.js", "./src/i18n.js", "./src/jointmetrics.js", "./src/grf.js", "./src/jointload.js", "./src/repquality.js", "./src/sports.js", "./src/multiplayer.js", "./src/playerzones.js", "./src/balltrack.js", "./src/screenrec.js", "./src/ballmodel.js", "./src/ytclip.js", "./src/osimlab.js", "./src/simtools.js", "./src/simsetup.js", "./src/simfigs.js", "./src/simstack.js", "./src/simsession.js", "./src/labtrial.js", "./src/simquick.js", "./src/c3dexport.js", "./src/trcview.js", "./src/localengine.js", "./src/pyosim_worker.js", "./src/pose_worker.js", "./src/biofeedback.js", "./src/physics.js", "./src/phonemotion.js", "./src/pressure.js", "./src/stk500.js", "./src/bodyscale.js", "./src/analysis.js", "./src/stats.js", "./src/reliability.js", "./src/spm.js", "./src/anfigs.js", "./src/anexport.js", "./src/presence.js", "./src/lmreview.js", "./src/jcfcontrib.js", "./data/opensim/tools.json", "./data/opensim/engine.json", "./src/process.js", "./src/proc_io.js", "./src/proc_dsp.js", "./src/osimexport.js", "./src/rtp.js", "./src/bodymap.js", "./src/achievements.js", "./src/syncmeta.js", "./src/cloud.js", "./src/cloud_config.js", "./src/help.js", "./src/chat.js", "./data/norms.json", "./data/muscle_joints.json", "./manifest.webmanifest",
               "./assets/icons/logo.png", "./assets/icons/icon-192.png",
               "./assets/icons/icon-512.png", "./assets/icons/icon-maskable-512.png",
               "./assets/icons/apple-touch-icon.png", "./assets/icons/favicon.ico"];
const HEAVY = [
  // 1.4 MB and it changes only when the model is retrained: cache-first, like
  // the pose model and the meshes, rather than re-fetched on every analysis.
  "./data/force_model_v2.json",
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
  url.pathname.includes("/media/") ||
  url.pathname.endsWith("/force_model_v2.json");

// Individually, not addAll: one 404 must not fail the whole install -- but not
// silently either, because a renamed file that drops out of these lists leaves
// the app half-cached and broken offline with nothing to show for it.
const precache = (cache, urls, { skipExisting = false } = {}) =>
  caches.open(cache).then((c) => Promise.all(urls.map(async (u) => {
    // The heavy assets are re-added on every install otherwise, which is the
    // download this split exists to avoid.
    if (skipExisting && await c.match(u)) return;
    // "reload": straight from the network, not a copy the HTTP cache kept from the last build
    return c.add(new Request(u, { cache: "reload" })).catch((err) => console.warn("[sw] precache failed:", u, err));
  })));

self.addEventListener("install", (e) => {
  e.waitUntil(Promise.all([
    precache(SHELL_CACHE, SHELL),
    precache(HEAVY_CACHE, HEAVY, { skipExisting: true }),
  ]));
  /* No skipWaiting here. A new build waits until the page says so -- at start,
   * or when the person presses Update -- so it never swaps under someone who is
   * mid-recording. */
});

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.cmd === "skipWaiting") self.skipWaiting();
  if (d.cmd === "pin") e.waitUntil(caches.open(PIN_CACHE).then(async (c) => {
    for (const k of await c.keys()) await c.delete(k);           // the old build's files go with the old choice
    if (d.pin) await c.put(PIN_KEY, new Response(JSON.stringify(d.pin), { headers: { "content-type": "application/json" } }));
    if (e.source) e.source.postMessage({ cmd: "pinned", pin: d.pin || null });
  }));
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

  // video: straight to the network. A cached whole-file answer to a Range request
  // leaves the <video> black, and the browser's own media cache does this better.
  if (url.pathname.includes("/media/")) return;
  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  // these always come from the network: the build list, and the worker itself
  if (rel === "builds.json" || rel === "sw.js" || url.searchParams.has("check")) { e.respondWith(fetch(req, { cache: "no-store" }).catch(() => caches.match(req))); return; }

  if (!isHeavy(url)) {                                 // an old build chosen? serve its files
    e.respondWith(pinned().then(async (pin) => {
      if (!pin || !pin.commit) return shell(req);
      const path = rel === "" || rel.endsWith("/") ? rel + "index.html" : rel;
      const c = await caches.open(PIN_CACHE), key = "./__b/" + pin.commit + "/" + path;
      const hit = await c.match(key); if (hit) return hit;
      const r = await fetch(RAW + pin.commit + "/" + path);
      if (!r.ok) return shell(req);                    // not in that commit: today's copy
      const ext = (path.split(".").pop() || "").toLowerCase();
      let body = await r.arrayBuffer();
      if (ext === "html") {
        // an old page does not know about old builds: give it a way back to the latest
        const bar = `<div style="position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#333;color:#eee;font:13px system-ui;padding:6px 10px;text-align:center">`
          + `Older BioScout build ${pin.build} &middot; <a href="#" style="color:#7fd" onclick="try{localStorage.setItem('bioscout.pinBuild','null')}catch(e){};`
          + `navigator.serviceWorker.controller.postMessage({cmd:'pin',pin:null});setTimeout(function(){location.reload()},400);return false">back to the latest build</a></div>`;
        body = new TextEncoder().encode(new TextDecoder().decode(body).replace(/<\/body>/i, bar + "</body>"));
      }
      const res = new Response(body, { headers: { "content-type": TYPES[ext] || "application/octet-stream" } });
      c.put(key, res.clone()).catch(() => {});
      return res;
    }).catch(() => shell(req)));
    return;
  }

  if (isHeavy(url)) {                                  // cache-first
    e.respondWith(caches.open(HEAVY_CACHE).then((c) => c.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        c.put(req, res.clone()).catch(() => {});
        return res;
      }))));
    return;
  }

});

/* The shell: CACHE-first from this worker's own build.
 *
 * It was network-first, so a push reached a page that was already running --
 * a module loaded late (Simulate, the share dialog) came from the new build
 * and the rest from the old, and the worker swap reloaded the page mid-take.
 * Now every file of the running build comes from the cache this worker
 * filled at install, and a new build arrives as a new worker that waits. A
 * file the precache list missed is fetched once and kept with this build. */
async function shell(req) {
  const c = await caches.open(SHELL_CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req, { cache: "reload" }).catch(() => fetch(req));
    if (res.ok) c.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const f = req.mode === "navigate" ? await c.match("./index.html") : null;
    return f || Response.error();
  }
}
