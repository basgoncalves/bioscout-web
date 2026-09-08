/**
 * strava.js -- mapping Strava's shape onto the app's, and talking to the
 * helper without a network.
 *
 * The mapping is where the bugs live, and one of them is a genuine trap:
 * Strava's `start_date_local` carries wall-clock time with a Z on the end.
 *
 *   node tests/test_strava.mjs
 */
process.env.TZ = process.env.TZ || "Europe/Vienna";

import { probe, authorise, fetchActivities, toCardio, toCardioAll } from "../src/strava.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

const row = (over = {}) => ({
  id: 14123, name: "Morning Run", sport_type: "Run", type: "Run",
  start_date: "2026-09-07T05:30:00Z", start_date_local: "2026-09-07T07:30:00Z",
  elapsed_time: 3000, moving_time: 2730, distance: 8120,
  average_heartrate: 148.4, max_heartrate: 176, total_elevation_gain: 65,
  ...over,
});

/* ---- the mapping -------------------------------------------------------- */

{
  const c = toCardio(row(), "bas");
  ok(c.id === "strava:14123", "the id is namespaced by source", c.id);
  ok(c.profile === "bas", "and filed to the athlete importing it");
  // The trap: start_date_local is 07:30Z, which is NOT 07:30 UTC. Taking it
  // would shift this run two hours and, near midnight, a whole day.
  ok(c.at === "2026-09-07T05:30:00.000Z", "the UTC start is used, not the local one", c.at);
  ok(c.seconds === 2730, "moving time, not elapsed -- a coffee stop is not training");
  ok(c.metres === 8120 && c.avgHr === 148.4 && c.maxHr === 176, "the numbers carry across");
}

ok(toCardio(row({ sport_type: null })).sport === "Run", "sport_type falls back to type");
ok(toCardio(row({ sport_type: null, type: null })).sport === "Workout",
   "and to something honest when both are missing");

ok(toCardio(row({ moving_time: null })).seconds === 3000,
   "elapsed time stands in when moving time is absent");
ok(toCardio(row({ moving_time: null, elapsed_time: null })) === null,
   "but no duration at all is not an activity");
ok(toCardio(row({ start_date: null })) === null, "and neither is no start");
ok(toCardio(row({ id: null })) === null, "nor a row with no id to dedupe on");
ok(toCardio(null) === null, "null in, null out");

ok(toCardio(row({ distance: 0 })).metres === 0,
   "a treadmill session keeps a zero distance rather than being dropped");
ok(toCardio(row({ average_heartrate: 0 })).avgHr === null,
   "a zero average heart rate is absence, not a reading");

/* ---- batches ------------------------------------------------------------ */

{
  const out = toCardioAll([
    row({ id: 2, start_date: "2026-09-08T05:00:00Z" }),
    row({ id: 1, start_date: "2026-09-07T05:00:00Z" }),
    row({ id: 2, start_date: "2026-09-08T05:00:00Z" }),   // straddles a page boundary
    row({ id: 3, moving_time: null, elapsed_time: null }),
  ], "bas");
  ok(out.length === 2, "duplicates and unusable rows are dropped", String(out.length));
  ok(out[0].id === "strava:1" && out[1].id === "strava:2", "and the rest come back in time order");
}

/* ---- the helper, without a network -------------------------------------- */

const fakeFetch = (body, ok_ = true, status = 200) => async () => ({
  ok: ok_, status, json: async () => body,
});

ok(await probe(fakeFetch({ service: "bioscout-strava", authorised: true })) !== false,
   "a helper that identifies itself is accepted");
ok(await probe(fakeFetch({ service: "bioscout-fetch" })) === false,
   "the clip fetcher on the next port over is not the Strava helper");
ok(await probe(async () => { throw new Error("connection refused"); }) === false,
   "nothing running resolves false rather than throwing");

{
  let seen = "";
  const spy = async (url) => { seen = url; return { ok: true, json: async () => ({ activities: [row()] }) }; };
  const acts = await fetchActivities({ after: new Date("2026-09-01T00:00:00Z") }, spy);
  // 1788220800 is 2026-09-01T00:00:00Z. Hardcoded rather than recomputed from
  // the same Date, so this actually pins the seconds conversion instead of
  // agreeing with whatever the code happens to do.
  ok(seen.includes("?after=1788220800"), "an incremental import asks only for what is new", seen);
  ok(acts.length === 1, "and hands back the rows");

  await fetchActivities({}, spy);
  ok(!seen.includes("after"), "a first import asks for everything");
}

{
  // The helper's own word for it. "notAuthorised" and "rateLimited" need
  // different reactions, and "import failed" tells the person neither.
  let msg = "";
  try { await fetchActivities({}, fakeFetch({ error: "rateLimited" }, false, 429)); }
  catch (e) { msg = e.message; }
  ok(msg === "rateLimited", "an error carries the helper's own reason", msg);
}

{
  let called = false;
  await authorise(async (u, o) => { called = o.method === "POST"; return { ok: true, json: async () => ({}) }; });
  ok(called, "authorising is a POST, so a stray GET cannot start an OAuth dance");
}

console.log(bad ? `\n${bad} check(s) failed` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
