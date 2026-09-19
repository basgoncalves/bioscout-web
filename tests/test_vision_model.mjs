/**
 * The vision-model benchmark's own self-test, wired into the normal suite.
 *
 * The benchmark in tests/vision_model/ needs a browser, model files and video
 * to RUN -- none of which belong in `npm test`. Its self-test needs none of
 * them, takes half a second, and is what stops the harness drifting away from
 * the app it measures: it asserts that the sampling grid, the visibility cut
 * and the landmarker options in bench/harness.html still match index.html's.
 * Those are exactly the things a change to the app would silently break.
 *
 *   node tests/test_vision_model.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(here, "vision_model", "selftest.mjs")],
                    { encoding: "utf8" });
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
