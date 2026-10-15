/**
 * builds.json: every committed build -> its commit, for the "older build"
 * picker (the service worker serves that commit's files from the repository).
 *
 *   node tools/builds_json.mjs      (run before committing a new build)
 *
 * Built from the commit messages ("V2 build 23: ..."); the build being
 * committed is not in it yet -- it is "Latest".
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const log = execFileSync("git", ["log", "--format=%h\t%cI\t%s"], { encoding: "utf8" });
const out = [], seen = new Set();
for (const line of log.split("\n")) {
  const [commit, iso, subj] = line.split("\t");
  const m = /^(V\d+) build (\d+)\b/.exec(subj || "");
  if (!m) continue;
  const key = `${m[1]}-${m[2]}`;
  if (seen.has(key)) continue;           // the newest commit of a build number wins
  seen.add(key);
  const d = new Date(iso);
  const at = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna", dateStyle: "short", timeStyle: "short" }).format(d);
  out.push({ release: m[1], build: +m[2], commit, at });
}
out.reverse();
writeFileSync(new URL("../builds.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`builds.json: ${out.length} builds`);
