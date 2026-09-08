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
for (const f of readdirSync("src").filter((f) => f.endsWith(".js") && f !== "sw.js")) {
  const src = readFileSync("src/" + f, "utf8");
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
  exportsOf.set("./src/" + f, names);
}

/* ---- what the page imported ------------------------------------------- */

const imported = new Set();

/* Two ways in, and both count. A name pulled in with `const { X } = await
 * import(...)` is as imported as one on a static import line -- the module is
 * simply fetched when it is first needed instead of at page load, which is
 * how the heavy optional branches (the pose engine, the 3D overlay) avoid
 * costing anything on a load that never opens them. A checker that knew only
 * the static form would report those as calls to something never imported,
 * and the fix for that complaint would be to undo the laziness. */
const STATIC_IMPORT = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT =
  /(?:const|let|var)\s*\{([^{}\n]+)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g;

for (const m of [...script.matchAll(STATIC_IMPORT), ...script.matchAll(DYNAMIC_IMPORT)]) {
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

/* A method call is not a call to an imported name: `spec.findReps(...)` reads
 * findReps off an object the page already has, and flagging it as a missing
 * import sent the last reader looking for a bug that was not there. The
 * lookbehind drops anything preceded by a dot (or by more identifier, which
 * `\b` alone also let through), and anything introduced by `get`, `set` or
 * `function`, which is a definition rather than a call. A bare call still
 * matches, which is the case this check exists for. */
const CALL = /(?<![.\w$]|\bget |\bset |\bfunction )([A-Za-z_$][\w$]*)\s*\(/g;
const used = new Set([...script.matchAll(CALL)].map((m) => m[1]));
for (const name of used) {
  if (!offered.has(name) || declared.has(name)) continue;
  fail(`calls ${name}(), exported by ${offered.get(name)}, but never imports it`);
}

/* ---- and every module calls only what it has --------------------------
 *
 * The import check above is about names crossing a file boundary. This one is
 * about names inside a file: a helper that gets deleted while an edit moves
 * the code around it leaves calls behind, and they only throw on the branch
 * that reaches them. `shortDay` went missing from dashboard.js exactly this
 * way and broke the Cycle form, while Meal and Diary looked fine because
 * their only call to it sits in the branch for a day that is not today.
 */
const KEYWORDS = new Set(["if","for","while","switch","catch","return","typeof","function","async",
  "new","await","of","in","do","else","case","delete","void","instanceof","yield","throw"]);
const GLOBALS = new Set(["Math","JSON","Date","Number","String","Object","Array","Set","Map",
  "WeakMap","Boolean","Promise","Error","TypeError","RegExp","Symbol","BigInt","Proxy","Reflect",
  "parseInt","parseFloat","isNaN","isFinite","console","document","window","navigator","location",
  "localStorage","sessionStorage","indexedDB","caches","fetch","setTimeout","clearTimeout",
  "setInterval","clearInterval","queueMicrotask","requestAnimationFrame","alert","prompt","confirm",
  "URL","URLSearchParams","Blob","File","FileReader","FormData","Image","Audio","atob","btoa",
  "structuredClone","createImageBitmap","AbortController","CustomEvent","Event","TextEncoder",
  "TextDecoder","performance","crypto","self","Intl","ArrayBuffer","Uint8Array","Uint8ClampedArray",
  "Int32Array","Uint32Array","Float32Array","Float64Array","DataView","XMLSerializer","encodeURIComponent","decodeURIComponent",
  "getComputedStyle","MediaRecorder","ResizeObserver","IntersectionObserver","Worker","OffscreenCanvas",
  "import","require","super","this","eval"]);

/**
 * Strip comments and string text, keeping template-literal ${...} expressions.
 *
 * Without this the scan matches rgba(), var() and height() inside CSS strings.
 * With a blunt strip it would miss the calls that matter, because nearly all
 * the rendering code lives inside template literals -- shortDay() among them.
 */
function codeOnly(src) {
  let out = "", i = 0;
  // A / starts a regex rather than a division when the last meaningful
  // character cannot end an expression. Without this, /[&<>"]/g looks like the
  // start of a string and swallows the code after it.
  const REGEX_OK = new Set([..."(,=:[!&|?{};+-*%<>~^", ""]);
  const lastMeaningful = () => {
    for (let j = out.length - 1; j >= 0; j--) if (!/\s/.test(out[j])) return out[j];
    return "";
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "/" && REGEX_OK.has(lastMeaningful())) {
      i++;
      let cls = false;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "/" && !cls) break;
        else if (src[i] === "\n") break;          // not a regex after all
        i++;
      }
      i++; while (/[a-z]/.test(src[i] || "")) i++;   // flags
      out += " "; continue;
    }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; out += " "; continue;
    }
    if (c === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") {
          i += 2; let n = 1; const start = i;
          while (i < src.length && n) {
            if (src[i] === "{") n++;
            else if (src[i] === "}") n--;
            if (n) i++;
          }
          out += " " + codeOnly(src.slice(start, i)) + " ";
          i++; continue;
        }
        i++;
      }
      i++; out += " "; continue;
    }
    out += c; i++;
  }
  return out;
}

const declaredIn = (src) => {
  const names = new Set();
  const add = (s) => { for (const p of s.split(",")) {
    const n = p.split(/[:=]/)[0].replace(/[{}[\]\s.]|\.\.\./g, "").trim();
    if (n) names.add(n);
  } };
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // `const X = ..., Y = ...` declares both; the rule above only sees X.
  for (const m of src.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) add(m[1]);
  for (const m of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of src.matchAll(/catch\s*\(([^)]*)\)/g)) add(m[1]);
  // Class and object-literal methods: `resize(w, h) {` declares resize.
  // `get sawBody() {` declares one too -- an accessor is a definition, and
  // reading it as a call to something unimported is the same false positive
  // as reading `spec.findReps(...)` that way.
  for (const m of src.matchAll(/^\s*(?:async\s+|\*\s*|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    names.add(m[1]); add(m[2]);
  }
  // `probe as probeHelper` declares probeHelper, not probe.
  for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
    for (const p of m[1].split(",")) { const n = p.split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
};

const files = [["index.html (module)", script],
  ...readdirSync("src").filter((f) => f.endsWith(".js") && f !== "sw.js")
    .map((f) => [f, readFileSync("src/" + f, "utf8")])];

for (const [label, raw] of files) {
  const src = codeOnly(raw);
  const known = declaredIn(src);
  const seen = new Set();
  for (const m of src.matchAll(/(?<![.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (seen.has(name) || KEYWORDS.has(name) || GLOBALS.has(name) || known.has(name)) continue;
    seen.add(name);
    fail(`${label} calls ${name}(), which it neither declares nor imports`);
  }
}

if (bad) {
  console.error(`\nFAIL  ${bad} wiring problem(s)`);
  process.exit(1);
}
console.log(`ok    ${imported.size} imported names, all exported and all used ones imported`);
