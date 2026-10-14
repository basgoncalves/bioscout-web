/**
 * What counts as "the app" -- the files GitHub Pages serves to a browser.
 *
 * A change to any of these is a change somebody can see, so it has to move
 * window.BUILD: the corner stamp is the only way to tell "my fix is not live
 * yet" from "this tab is old", and the stale-tab reloader compares the same
 * number. Tests, tools, docs and the Supabase folder ship nothing.
 */
export const SHIPPED = [/^index\.html$/, /^sw\.js$/, /^src\//, /^data\//,
  /^assets\//, /^manifest\.webmanifest$/, /^privacy\.html$/, /^formats\.html$/, /^glossary\//];
export const isShipped = (f) => SHIPPED.some((re) => re.test(f));
export const BUILD_RE = /window\.BUILD = (\d+);/;
export const BUILD_AT_RE = /window\.BUILD_AT = "[^"]*";/;
export const RELEASE_RE = /window\.RELEASE = "([^"]*)";/;
/** The release a build number belongs to: a new release (V1 -> V2) starts again at build 1. */
export const releaseOf = (html) => { const m = (html || "").match(RELEASE_RE); return m ? m[1] : null; };
export const buildOf = (html) => { const m = (html || "").match(BUILD_RE); return m ? +m[1] : null; };
