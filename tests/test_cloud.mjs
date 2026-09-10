/**
 * Accounts + private sync, against a fake Supabase: auth (GoTrue) and the
 * records table (PostgREST) with the same last-writer-wins rule as the
 * records_lww trigger in supabase/schema.sql. Two devices, one account.
 *
 *   node tests/test_cloud.mjs
 */
let store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const devices = { phone: {}, laptop: {}, shared: {} };
const on = (d) => { store = devices[d]; };
const P = await import("../src/profiles.js");
const C = await import("../src/cloud.js");

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const tick = () => new Promise((r) => setTimeout(r, 3));

// --- fake server --------------------------------------------------------------
const users = new Map();          // email -> {id, password, meta}
const rows = new Map();           // owner|kind|rid -> row
let seq = 0;
const tokenOf = new Map();        // access token -> user id
function serverTime() { seq++; return new Date(Date.UTC(2026, 8, 10, 12, 0, 0, seq)).toISOString().replace("Z", "000+00:00"); }
const J = (status, body) => ({ ok: status < 400, status, statusText: String(status),
                               text: async () => JSON.stringify(body) });
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const auth = (init.headers.Authorization || "").replace("Bearer ", "");
  if (u.pathname === "/auth/v1/token") {
    if (u.searchParams.get("grant_type") === "password") {
      const x = users.get(body.email);
      if (!x || x.password !== body.password) return J(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" });
      const t = "tok" + Math.random(); tokenOf.set(t, x.id);
      return J(200, { access_token: t, refresh_token: "r" + t, expires_in: 3600, user: { id: x.id, email: body.email, user_metadata: x.meta } });
    }
    const t = "tok" + Math.random(); tokenOf.set(t, tokenOf.get(body.refresh_token.slice(1)));
    return J(200, { access_token: t, refresh_token: "r" + t, expires_in: 3600, user: {} });
  }
  if (u.pathname === "/functions/v1/signup-username") {
    const email = `${body.username}@${C.USERNAME_DOMAIN}`;
    if (users.has(email)) return J(409, { code: "username_taken", message: "That username is taken" });
    users.set(email, { id: "uid-" + body.username, password: body.password, meta: { username: body.username } });
    return J(200, { ok: true });
  }
  if (u.pathname === "/rest/v1/records") {
    const owner = tokenOf.get(auth);
    if (!owner) return J(401, { message: "JWT expired" });
    if (init.method === "POST") {
      for (const r of body) {
        const k = `${owner}|${r.kind}|${r.rid}`, old = rows.get(k);
        if (old && !(r.u > old.u)) continue;                  // records_lww
        rows.set(k, { ...r, owner, server_at: serverTime() });
      }
      return J(201, null);
    }
    const gt = (u.searchParams.get("server_at") || "").replace(/^gt\./, "");
    const out = [...rows.values()].filter((r) => r.owner === owner && (!gt || r.server_at > gt))
      .sort((a, b) => a.server_at.localeCompare(b.server_at));
    return J(200, out.map(({ owner: _o, ...r }) => r));
  }
  return J(404, { message: "no route " + u.pathname });
}
const cloud = C.makeCloud({ url: "https://x.supabase.co", key: "anon", fetchImpl: fakeFetch });
const local = { exportAll: P.exportAll, importAll: P.importAll };

// --- mapping ---------------------------------------------------------------
{
  const dump = { meals: [{ at: "2026-09-01T08:00:00.000Z", profile: "Bas", text: "oats", u: "2026-09-01T08:00:00.000Z" },
                         { at: "2026-09-01T09:00:00.000Z", profile: "Ana", text: "not mine", u: "2026-09-01T09:00:00.000Z" }],
                 deleted: [{ k: "sleep", id: "Bas|2026-09-02", at: "2026-09-03T00:00:00.000Z" },
                           { k: "sleep", id: "Ana|2026-09-02", at: "2026-09-03T00:00:00.000Z" }] };
  const r = C.toRows(dump, "Bas");
  ok(r.length === 2 && r.every((x) => !JSON.stringify(x).includes("Ana")), "only the chosen athlete leaves the device");
  ok(r.find((x) => x.kind === "meals").rid === "null|2026-09-01T08:00:00.000Z", "rows carry no athlete name");
  const back = C.fromRows(r, "Basilio");
  ok(back.meals[0].profile === "Basilio" && back.deleted[0].id === "Basilio|2026-09-02",
     "pulled rows land under this device's name for the athlete");
  ok(C.toRows(dump, "Bas", "2026-09-02T00:00:00.000Z").length === 1, "a push after the watermark sends only newer changes");
}

// --- sign up with a username, sync phone -> laptop ---------------------------
on("phone");
P.saveProfile({ name: "Bas", heightM: 1.81 });
P.saveProfile({ name: "Guest" });
P.addMeal({ profile: "Bas", text: "oats", at: "2026-09-09T08:00:00.000Z" });
P.addMeal({ profile: "Guest", text: "guest lunch", at: "2026-09-09T12:00:00.000Z" });
P.setSleep({ profile: "Bas", at: "2026-09-09T07:00:00.000Z", bed: "23:00", wake: "07:00" });
P.newSession("Bas", "2026-09-09T17:00:00.000Z");
P.addSet({ activity: "squat", reps: [1, 2, 3].map((rep) => ({ rep })) }, 30, { profile: "Bas" });

let login = await cloud.signUpUsername("bas_g", "hunter22!");
ok(login.user.id === "uid-bas_g", "a username account is created and signed in");
let taken = null;
try { await cloud.signUpUsername("bas_g", "x2345678"); } catch (e) { taken = e.code; }
ok(taken === "username_taken", "a taken username is refused", taken);
let phone = { login, athlete: "Bas" };
let r = await C.syncOnce(cloud, phone, local);
phone = r.state;
ok(r.pushed >= 4 && r.pulled === 0, "first sync uploads the athlete's history", `pushed ${r.pushed}`);
ok(![...rows.values()].some((x) => JSON.stringify(x).includes("guest")), "the other athlete on the phone stays on the phone");

on("laptop");
login = await cloud.signIn("BAS_G", "hunter22!");
let laptop = { login, athlete: "Bas" };
r = await C.syncOnce(cloud, laptop, local);
laptop = r.state;
ok(P.listMeals().length === 1 && P.listSleep().length === 1, "the laptop receives meals and sleep", JSON.stringify(r.report));
ok(P.getProfile("Bas")?.heightM === 1.81, "and the profile");
ok(P.listArchive().length === 1 && P.listArchive()[0].sets[0].reps === 3, "and the open session, as history");

// --- laptop edits, phone receives -------------------------------------------
await tick();
P.setSleep({ profile: "Bas", at: "2026-09-09T07:00:00.000Z", bed: "23:30", wake: "06:40" });
P.deleteMeal("2026-09-09T08:00:00.000Z", "Bas");
r = await C.syncOnce(cloud, laptop, local); laptop = r.state;
ok(r.pushed === 2, "the laptop pushes just its two changes", String(r.pushed));

on("phone");
await tick();
P.addSet({ activity: "cmj", reps: [1, 2].map((rep) => ({ rep })) }, 30, { profile: "Bas" });
r = await C.syncOnce(cloud, phone, local); phone = r.state;
ok(P.listSleep()[0].wake === "06:40", "the corrected night reaches the phone");
ok(!P.listMeals().some((m) => m.profile === "Bas"), "the meal deleted on the laptop is gone on the phone");
ok(P.listMeals().some((m) => m.profile === "Guest"), "the guest's meal is untouched");
ok(P.getSession()?.sets.length === 2 && !P.listArchive().length, "the phone's open session stays open, not duplicated");

on("laptop");
r = await C.syncOnce(cloud, laptop, local); laptop = r.state;
ok(P.listArchive()[0].sets.length === 2, "the new set reaches the laptop");
r = await C.syncOnce(cloud, laptop, local);
ok(r.pulled === 0 && r.pushed === 0, "a sync with nothing new moves nothing", `${r.pulled}/${r.pushed}`);

// --- a shared phone where the athlete has another name ----------------------
on("shared");
P.saveProfile({ name: "Basilio" });
login = await cloud.signIn("bas_g", "hunter22!");
r = await C.syncOnce(cloud, { login, athlete: "Basilio" }, local);
ok(P.listSleep().every((x) => x.profile === "Basilio") && P.listSleep().length === 1,
   "on a device where the athlete is 'Basilio', the data files under Basilio");

// --- wrong password ------------------------------------------------------
let bad = null;
try { await cloud.signIn("bas_g", "nope"); } catch (e) { bad = e.code; }
ok(bad === "invalid_credentials", "a wrong password is refused", bad);
ok(cloud.emailFor("someone@Mail.com") === "someone@mail.com" && cloud.emailFor("Bas_G") === "bas_g@" + C.USERNAME_DOMAIN,
   "email and username logins map to the right address");

if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed");
