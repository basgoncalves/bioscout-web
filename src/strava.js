/**
 * strava.js -- talking to the optional local Strava helper.
 *
 * The page cannot talk to Strava directly, and this is not a limitation that
 * can be coded around. Strava's token exchange requires the application's
 * client secret, which a static site cannot hold without publishing it to
 * everyone who opens the page, and there is no PKCE flow for public clients.
 * On top of that the API sends no CORS headers, so even a valid token would
 * be refused at the door.
 *
 * The answer is the one this app already uses for YouTube downloads: a helper
 * process on the SAME DEVICE, on loopback, started deliberately by the person
 * whose data it is. See tools/bioscout_strava.py and fetcher.js -- same
 * shape, same reasons, same self-declaring optionality. The app probes for
 * the helper and only offers the button if it answers.
 *
 * The helper never hands this module a token, and this module never asks for
 * one. It asks for activities. That boundary is what makes a compromised page
 * unable to lift a credential, so it is worth keeping even though it would be
 * convenient to fetch from Strava directly once authorised.
 */

/** Where the helper listens. The fetcher is on 8765; this is its neighbour. */
export const HELPER = "http://127.0.0.1:8766";

const PROBE_MS = 700;

/**
 * Is the helper running, and how far along is it?
 *
 * Three states matter and they need different words in the UI: not running at
 * all (say nothing, the feature is optional), running but with no credentials
 * (tell them what to configure), and running and authorised (import). Resolves
 * false for "not running" and the health object otherwise.
 */
export async function probe(fetchImpl = fetch) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_MS) : null;
  try {
    const r = await fetchImpl(`${HELPER}/health`, { signal: ctrl?.signal });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.service === "bioscout-strava" ? j : false;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Ask the helper to open Strava's approval page. The person approves in
 *  their own browser, on Strava's own domain; nothing here sees a password. */
export async function authorise(fetchImpl = fetch) {
  const r = await fetchImpl(`${HELPER}/auth`, { method: "POST" });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).error || ""; } catch { /* not json */ }
    throw new Error(detail || `helper ${r.status}`);
  }
  return true;
}

/**
 * Activities since `after` (a Date, or unix seconds), as raw Strava rows.
 *
 * `after` is what makes a second import cheap: Strava is asked only for what
 * happened since the newest activity already stored, so a daily import is one
 * request rather than a decade of history every time.
 */
export async function fetchActivities({ after = null } = {}, fetchImpl = fetch) {
  const qs = after
    ? "?after=" + Math.floor(after instanceof Date ? after.getTime() / 1000 : after)
    : "";
  const r = await fetchImpl(`${HELPER}/activities${qs}`);
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).error || ""; } catch { /* not json */ }
    throw new Error(detail || `helper ${r.status}`);
  }
  const j = await r.json();
  return Array.isArray(j.activities) ? j.activities : [];
}

/**
 * One raw Strava row -> the app's cardio shape, or null if it is unusable.
 *
 * On the timestamp: `start_date` is used and `start_date_local` is
 * deliberately ignored. Strava formats the local one with a trailing Z while
 * it actually holds wall-clock time in the activity's own zone, so parsing it
 * as a date silently shifts every activity by the offset. `start_date` is
 * genuine UTC, and every other record in this app is UTC ISO bucketed by the
 * local calendar, so this stays consistent with sets, meals and sleep.
 *
 * On duration: moving time, not elapsed. A ride with a twenty-minute coffee
 * stop is not a three-hour ride, and moving time is the figure that compares
 * across days.
 */
export function toCardio(a, profile = null) {
  if (!a || a.id === undefined || a.id === null) return null;
  const at = a.start_date;
  if (!at || Number.isNaN(new Date(at).getTime())) return null;

  const num = (v, min = 0) => (Number.isFinite(+v) && +v > min ? +v : null);
  const seconds = num(a.moving_time) ?? num(a.elapsed_time);
  if (!seconds) return null;              // no duration is not an activity

  return {
    // Namespaced so a future source cannot collide with a Strava id, and so
    // the origin of a row is readable without a separate lookup.
    id: `strava:${a.id}`,
    source: "strava",
    profile,
    at: new Date(at).toISOString(),
    sport: String(a.sport_type || a.type || "Workout").slice(0, 40),
    name: String(a.name || "").slice(0, 120),
    seconds,
    metres: num(a.distance) ?? 0,
    avgHr: num(a.average_heartrate),
    maxHr: num(a.max_heartrate),
    elevM: num(a.total_elevation_gain),
    // Kept because it comes free on rides with power, and it is the only
    // energy figure Strava puts in the list response. Not a calorie count.
    kj: num(a.kilojoules),
  };
}

/** Normalise a batch, dropping what cannot be used and de-duplicating on id.
 *  Strava can return the same activity twice across page boundaries if one is
 *  uploaded mid-import, and a duplicate would double a day's totals. */
export function toCardioAll(rows, profile = null) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const c = toCardio(row, profile);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}
