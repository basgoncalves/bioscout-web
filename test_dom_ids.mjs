/**
 * Every id the app reaches for exists somewhere.
 *
 * The page is one file with three views and ~60 wired elements, and the
 * scripts find all of them by id. Move a control from one view to another and
 * everything still looks right; delete one, or rename it, and the failure is a
 * TypeError at the moment somebody taps it -- on a phone, mid-session, with no
 * console open. Nothing else in the suite touches the DOM, so nothing else
 * catches it.
 *
 * An id counts as existing if it is in the markup, or if some module writes it
 * into an innerHTML string. The second case is real: the calendar's month
 * arrows only exist once the dashboard has rendered.
 *
 *   node test_dom_ids.mjs
 */
import { readFileSync, readdirSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

// Static markup only. Ids inside <script> are template-literal output: two
// render functions can each emit a #repTabs without either being a duplicate,
// because only one of them is ever on the page.
const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
const declared = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// Ids built at runtime, in the page's own scripts or in any module it loads.
const runtime = new Set();
const sources = [html, ...readdirSync(".").filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(f, "utf8"))];
for (const src of sources) {
  for (const m of src.matchAll(/id=\\?["']([A-Za-z0-9_-]+)\\?["']/g)) runtime.add(m[1]);
}

// What the page asks for: $("x"), and getElementById anywhere.
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).join("\n");
const used = new Set([
  ...[...scripts.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ...[...sources.join("\n").matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
]);

const missing = [...used].filter((id) => !declared.has(id) && !runtime.has(id));

// The reverse is not an error -- plenty of ids exist purely as label targets --
// but an id declared twice is, because getElementById silently takes the first
// and the second one is dead wiring.
const dupes = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  .filter((id, i, a) => a.indexOf(id) !== i);

let bad = 0;
if (missing.length) {
  bad += missing.length;
  console.error(`FAIL  ${missing.length} id(s) referenced but never created:`);
  for (const m of missing) console.error("  - " + m);
}
if (dupes.length) {
  bad += dupes.length;
  console.error(`FAIL  ${dupes.length} duplicate id(s) in the markup:`);
  for (const d of new Set(dupes)) console.error("  - " + d);
}

// Each view must exist and be reachable, or an athlete gets stuck on one.
for (const v of ["viewLogin", "viewDash", "viewRecord"]) {
  if (!declared.has(v)) { bad++; console.error(`FAIL  missing view: ${v}`); }
}

if (bad) process.exit(1);
console.log(`ok    ${used.size} referenced ids, all present; 3 views wired`);
