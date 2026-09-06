/**
 * Everything the page calls, it imported.
 *
 * The page is one module that pulls from eight local files by name. Miss a
 * name off the import list and nothing complains: the file parses, the app
 * loads, the dashboard renders, and the button that needed it throws a
 * ReferenceError the moment somebody taps it. That is exactly how the Cycle
 * option shipped doing nothing -- `cycleFormHTML` was written, exported,
 * called, and never imported.
 *
 * Syntax checks cannot catch this and neither can the DOM test: the element
 * exists, the handler is wired, and the reference is only resolved when it
 * runs.
 *
 *   node test_wiring.mjs
 */
import { readFileSync, readdirSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const script = [...html.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).join("\n");

let bad = 0;
const fail = (msg) => { bad++; console.error("  - " + msg); };

/* ---- what each local module offers ------------------------------------ */

const exportsOf = new Map();
for (const f of readdirSync(".").filter((f) => f.endsWith(".js") && f !== "sw.js")) {
  const src = readFileSync(f, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // `export const a = ..., b = ...` and `export { a, b }`
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  exportsOf.set("./" + f, names);
}

/* ---- what the page imported ------------------------------------------- */

const imported = new Set();
for (const m of script.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
  const from = m[2];
  for (const part of m[1].split(",")) {
    const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
    if (!orig) continue;
    imported.add(alias || orig);
    // An import of a name the module does not export is the same bug, seen
    // from the other side, and it fails silently as undefined.
    if (exportsOf.has(from) && !exportsOf.get(from).has(orig)) {
      fail(`imports ${orig} from ${from}, which does not export it`);
    }
  }
}

/* ---- what the page declares for itself -------------------------------- */

const declared = new Set(imported);
for (const re of [/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
                  /^\s*(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm]) {
  for (const m of script.matchAll(re)) declared.add(m[1]);
}

/* ---- the check --------------------------------------------------------- */

/* Only names some module actually exports are considered. A page-local helper
 * that happens to share a name with nothing is not evidence of anything, and
 * flagging every unknown identifier would drown the real finding in globals. */
const offered = new Map();
for (const [file, names] of exportsOf) for (const n of names) offered.set(n, file);

const used = new Set([...script.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
for (const name of used) {
  if (!offered.has(name) || declared.has(name)) continue;
  fail(`calls ${name}(), exported by ${offered.get(name)}, but never imports it`);
}

if (bad) {
  console.error(`\nFAIL  ${bad} wiring problem(s)`);
  process.exit(1);
}
console.log(`ok    ${imported.size} imported names, all exported and all used ones imported`);
