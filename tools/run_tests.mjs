/**
 * Run every test_*.mjs in the repository root.
 *
 * A shell loop would have done this on Linux, but development here happens on
 * Windows, where an npm script runs under cmd. Node is the one interpreter
 * both sides already have.
 *
 *   node tools/run_tests.mjs          all of them
 *   node tools/run_tests.mjs port sw  only tests whose name contains these
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filters = process.argv.slice(2);

const tests = readdirSync(root)
  .filter((f) => /^test_.*\.mjs$/.test(f))
  .filter((f) => !filters.length || filters.some((s) => f.includes(s)))
  .sort();

if (!tests.length) {
  console.error("no tests matched", filters.join(" "));
  process.exit(1);
}

const failed = [];
for (const t of tests) {
  process.stdout.write(`\n=== ${t} ${"=".repeat(Math.max(0, 60 - t.length))}\n`);
  const r = spawnSync(process.execPath, [t], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) failed.push(t);
}

console.log(`\n${"-".repeat(64)}`);
if (failed.length) {
  console.error(`FAIL  ${failed.length}/${tests.length}: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`ok    ${tests.length}/${tests.length} passed`);
