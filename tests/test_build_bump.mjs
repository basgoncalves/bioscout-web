/**
 * A commit that changes the app moves window.BUILD.
 *
 * The pre-commit hook (.githooks/pre-commit -> tools/bump_build.mjs) does this
 * on a machine where it is switched on. This is the net under it: `git am`
 * (push.py, from the phone) runs no pre-commit hook, and a fresh clone has the
 * hook off until `git config core.hooksPath .githooks`. push.py runs the suite
 * before it pushes, so a patch that forgot the bump stops here instead of
 * deploying under the previous build's number.
 *
 * Only HEAD against its parent: older history is what it is.
 *
 *   node tests/test_build_bump.mjs
 */
import { execFileSync } from "node:child_process";
import { isShipped, buildOf } from "../tools/shipped.mjs";

const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };

const changed = git("diff", "--name-only", "HEAD~1", "HEAD");
if (changed == null) { console.log("ok    no parent commit here (shallow clone or no git) -- nothing to compare"); process.exit(0); }
const shipped = changed.split("\n").filter(Boolean).filter(isShipped);
const was = buildOf(git("show", "HEAD~1:index.html")), now = buildOf(git("show", "HEAD:index.html"));
if (shipped.length && was != null && !(now > was)) {
  console.error(`FAIL  HEAD changes ${shipped.slice(0, 4).join(", ")}${shipped.length > 4 ? ", ..." : ""} but window.BUILD is still ${now}`);
  console.error(`      set window.BUILD = ${was + 1} in index.html and amend -- or run: git config core.hooksPath .githooks`);
  process.exit(1);
}
console.log(shipped.length ? `ok    build ${was} -> ${now} for ${shipped.length} shipped file(s)` : `ok    HEAD ships nothing; build stays ${now}`);
