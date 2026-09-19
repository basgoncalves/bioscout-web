/**
 * Give this commit its own build number, if it changes the app.
 *
 * Called by .githooks/pre-commit. window.BUILD was bumped by hand, and 106 of
 * 173 commits never did it -- three different deploys all read "build 104", so
 * the stamp could not answer the one question it exists for (Bas, 2026-09-19).
 *
 *   staged files include a shipped one  AND  staged BUILD <= HEAD's BUILD
 *     -> BUILD = HEAD + 1, written to index.html and staged.
 *
 * A commit that already bumped by hand is left alone. So is one that touches
 * only tests/tools/docs.
 *
 *   node tools/bump_build.mjs          (what the hook runs)
 *   node tools/bump_build.mjs --check  say what it would do, change nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isShipped, buildOf, BUILD_RE } from "./shipped.mjs";

const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const check = process.argv.includes("--check");

const staged = (git("diff", "--cached", "--name-only", "--diff-filter=ACMRD") || "").split("\n").filter(Boolean);
if (!staged.some(isShipped)) process.exit(0);

const head = buildOf(git("show", "HEAD:index.html"));
if (head == null) process.exit(0);                       // first commit, or no stamp yet
const index = buildOf(git("show", ":index.html"));       // what is about to be committed
if (index != null && index > head) process.exit(0);      // bumped by hand already

const next = head + 1;
if (check) { console.log(`would bump build ${head} -> ${next}`); process.exit(0); }

// index.html with changes that are NOT staged: `git add` would sweep them into
// this commit. Refuse rather than commit something nobody asked to commit.
const unstaged = (git("diff", "--name-only") || "").split("\n").includes("index.html");
if (unstaged) {
  console.error(`build: index.html has unstaged edits, so the build number cannot be bumped for you.\n` +
    `       Set window.BUILD = ${next} yourself (or stage/stash index.html) and commit again.`);
  process.exit(1);
}
const html = readFileSync("index.html", "utf8");
if (!BUILD_RE.test(html)) { console.error("build: no window.BUILD line in index.html"); process.exit(1); }
writeFileSync("index.html", html.replace(BUILD_RE, `window.BUILD = ${next};`));
git("add", "index.html");
console.log(`build ${head} -> ${next}`);
