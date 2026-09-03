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
const m = await import("./i18n.js");

let bad = 0;
for (const lang of m.ALL_LANGS) {
  const missing = m.missingKeys(lang), stale = m.staleKeys(lang);
  const ok = !missing.length && !stale.length;
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${lang}  missing ${missing.length}, stale ${stale.length}`
    + (missing.length ? `\n         missing: ${missing.join(", ")}` : "")
    + (stale.length ? `\n         stale:   ${stale.join(", ")}` : ""));
}

// Placeholders must survive translation: a {name} dropped from one language
// silently prints a sentence with a hole in it.
const WITH_VARS = { savedTo: ["name"], profileDeleted: ["name"], daysAgo: ["n"],
                    feetNotInFrame: ["pct"], heightsDisagree: ["n", "total"],
                    hadCountermovement: ["n", "total"], noCountermovement: ["n", "total"],
                    noRepsFound: ["activity"] };
for (const lang of m.ALL_LANGS) {
  m.setLang(lang);
  for (const [key, vars] of Object.entries(WITH_VARS)) {
    for (const v of vars) {
      const out = m.t(key, { [v]: "@@" });
      if (!out.includes("@@")) {
        console.log(`  [FAIL] ${lang}/${key}: placeholder {${v}} is missing`);
        bad++;
      }
    }
  }
}
console.log(bad ? "\nTRANSLATIONS INCOMPLETE" : "\nALL TRANSLATIONS COMPLETE AND CONSISTENT");
process.exit(bad ? 1 : 0);
