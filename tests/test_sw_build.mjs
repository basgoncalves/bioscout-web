/**
 * sw.js must carry the same build number as index.html.
 *
 * A browser installs a new service worker ONLY when sw.js differs byte for
 * byte from the one it has. Builds 137 to 144 all shipped an identical sw.js,
 * so every browser holding build 136's worker kept serving build 136's cached
 * shell: reg.update() found no new worker, the Update link had nothing to
 * activate, and a plain reload came back from the old cache. The served
 * index.html said 144 while the running app said 136, for twelve hours.
 *
 * This test is the thing that would have caught it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOf, swBuildOf } from "../tools/shipped.mjs";

const html = readFileSync("index.html", "utf8");
const sw = readFileSync("sw.js", "utf8");

const appBuild = buildOf(html);
const swBuild = swBuildOf(sw);
assert.ok(appBuild, "index.html has a window.BUILD");
assert.ok(swBuild, "sw.js has a `const BUILD = N;` line");
assert.equal(swBuild, appBuild,
  `sw.js says build ${swBuild} but index.html says ${appBuild}. ` +
  "They must match, or browsers on the old worker never see this build.");

// The shell cache name has to follow the build, or a new worker would reuse
// the previous build's cached files.
assert.match(sw, /const SHELL_CACHE = "bioscout-shell-b" \+ BUILD;/,
  "SHELL_CACHE must be derived from BUILD so each build gets its own cache");

/* The heavy cache must NOT follow the build: it holds the ~20 MB pose model
 * and wasm, which change only when a vendored asset does. Tying it to the
 * build would re-download them on every release. */
assert.match(sw, /const HEAVY_CACHE = "bioscout-heavy-v\d+";/,
  "HEAVY_CACHE stays on its own version, independent of the build");
assert.ok(!/HEAVY_CACHE = "[^"]*" \+ BUILD/.test(sw), "HEAVY_CACHE must not follow the build");

console.log(`sw build ok — index.html and sw.js both at build ${appBuild}`);
