/* Translations rot in two directions and only one of them is visible.
 *
 *   missing  a key English has that a translation does not. Falls back to
 *            English, so the page still works and nobody notices.
 *   stale    a key a translation has that English no longer does. Invisible:
 *            the wording changed on one side and the other kept the old text
 *            for a string that is never looked up again.
 *
 * Both are failures here, so neither can accumulate quietly.
 */
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
Object.defineProperty(globalThis, "navigator",
  { value: { languages: ["en"] }, configurable: true });
const m = await import("../src/i18n.js");

let bad = 0;
for (const lang of m.ALL_LANGS) {
  const missing = m.missingKeys(lang), stale = m.staleKeys(lang);
  const ok = !missing.length && !stale.length;
  if (!ok) bad++;
  
/* No duplicate keys.
 *
 * A repeated key in an object literal is legal and silent: the later one wins.
 * Three had crept in, and while all three happened to carry the same text, the
 * failure mode when they do not is a string that changes for no visible reason
 * and cannot be found by searching for the value you can see.
 */
{
  const src = readFileSync("src/i18n.js", "utf8");
  for (const name of ["EN", "PT", "DE"]) {
    const start = src.indexOf(`const ${name} =`);
    const end = src.indexOf("\n};", start);
    const keys = [...src.slice(start, end).matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
    const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    if (dupes.length) {
      bad += dupes.length;
      console.log(`  [FAIL] ${name} has duplicate keys: ${dupes.join(", ")}`);
    } else {
      console.log(`  [OK  ] ${name} ${keys.length} keys, none repeated`);
    }
  }
}

console.log(`  [${ok ? "OK  " : "FAIL"}] ${lang}  missing ${missing.length}, stale ${stale.length}`
    + (missing.length ? `\n         missing: ${missing.join(", ")}` : "")
    + (stale.length ? `\n         stale:   ${stale.join(", ")}` : ""));
}

/* Every key the page ASKS for must exist, and every placeholder a key declares
 * must survive into each translation.
 *
 * The two failures this catches are the ones the dictionary check above cannot
 * see: tr("noteCoverge") is not a missing translation, it is a typo, and t()
 * answers it with the key itself -- so the page prints "noteCoverge" in all
 * three languages and every dictionary still reports complete. The same goes
 * for a data-i18n attribute pointing at a key that was renamed.
 */
import { readFileSync } from "node:fs";
const html = readFileSync("./index.html", "utf8");
const asked = new Set();
for (const mm of html.matchAll(/\btr\(\s*"([A-Za-z0-9_.]+)"/g)) asked.add(mm[1]);
for (const mm of html.matchAll(/data-i18n(?:-html)?="([A-Za-z0-9_.]+)"/g)) asked.add(mm[1]);
// Keys built at runtime from data rather than written out literally.
// The assess_ prefixes are built from ASSESS_TESTS ids and the score bands;
// test_assess.mjs checks that every one of those concrete keys exists, which
// is the coverage this pattern would otherwise lose.
const DYNAMIC = /^(cond_|why_|view_|var_|assessHow_|assessTest_|assessBand_|assessPart_|hudFrame_|assessBadFraming_|series_)/;
m.setLang("en");
// Membership, not t() -- a key whose English value happens to equal its name
// ("years") is present, and t() cannot tell that from a miss.
const unknown = [...asked].filter((k) => !DYNAMIC.test(k) && !(k in m.EN_KEYS)).sort();
if (unknown.length) {
  bad++;
  console.log(`  [FAIL] index.html asks for ${unknown.length} key(s) no dictionary has:\n`
    + `         ${unknown.join(", ")}`);
} else {
  console.log(`  [OK  ] index.html: all ${asked.size} keys it asks for exist`);
}


/* The series_ prefix is built from the seriesLabel/pairLabel fields of
 * PEAK_VARS, so DYNAMIC lets the literal through. That would lose the coverage
 * entirely -- an unlabelled half of a pair falls back to the raw English word
 * in every language and nothing says so -- unless the concrete keys are
 * checked here, which is what this does. */
{
  const html = readFileSync("index.html", "utf8");
  const missing = [];
  for (const mm of html.matchAll(/(?:series|pair)Label: "([^"]+)"/g)) {
    const key = "series_" + mm[1].replace(/\s+/g, "_");
    if (!(key in m.EN_KEYS)) missing.push(key);
  }
  if (missing.length) {
    bad++;
    console.log(`  [FAIL] PEAK_VARS names series labels with no key: ${
      [...new Set(missing)].join(", ")}`);
  } else {
    console.log("  [OK  ] every paired-measure series label has a key");
  }
}

// Placeholders, for every key that declares one, in every language.
let holes = 0;
for (const key of Object.keys(m.EN_KEYS)) {
  const vars = [...m.EN_KEYS[key].matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
  if (!vars.length) continue;
  for (const lang of m.ALL_LANGS) {
    m.setLang(lang);
    for (const v of vars) {
      if (!m.t(key, { [v]: "@@" }).includes("@@")) {
        console.log(`  [FAIL] ${lang}/${key}: placeholder {${v}} is missing`);
        holes++;
      }
    }
  }
}
if (!holes) console.log("  [OK  ] every placeholder survives every translation");
bad += holes;

console.log(bad ? "\nTRANSLATIONS INCOMPLETE" : "\nALL TRANSLATIONS COMPLETE AND CONSISTENT");
process.exit(bad ? 1 : 0);
