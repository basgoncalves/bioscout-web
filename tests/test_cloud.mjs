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
const posts = new Map();          // id -> row
const media = new Map();          // "uid/file" -> {type, size}
const visibility = new Map();     // uid -> "open" | "private" (default private)
const usernameOf = (id) => String(id).replace(/^uid-/, "");
const tokenOf = new Map();        // access token -> user id
function serverTime() { seq++; return new Date(Date.UTC(2026, 8, 10, 12, 0, 0, seq)).toISOString().replace("Z", "000+00:00"); }
const J = (status, body) => ({ ok: status < 400, status, statusText: String(status),
                               text: async () => JSON.stringify(body) });
async function fakeFetch(url, init) {
  const u = new URL(url);
  const body = typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? null);
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
  if (u.pathname === "/auth/v1/user") {
    const id = tokenOf.get(auth) || (auth === "linktoken" ? "uid-link" : null);
    if (!id) return J(401, { message: "invalid JWT" });
    return J(200, { id, email: "link@example.com", user_metadata: {} });
  }
  if (u.pathname === "/functions/v1/signup-username") {
    const email = `${body.username}@${C.USERNAME_DOMAIN}`;
    if (users.has(email)) return J(409, { code: "username_taken", message: "That username is taken" });
    users.set(email, { id: "uid-" + body.username, password: body.password, meta: { username: body.username } });
    return J(200, { ok: true });
  }
  if (u.pathname === "/rest/v1/rpc/delete_my_account") {
    const owner = tokenOf.get(auth);
    if (!owner) return J(401, { message: "JWT expired" });
    for (const [k, r] of rows) if (r.owner === owner) rows.delete(k);
    for (const [email, x] of users) if (x.id === owner) users.delete(email);
    for (const [id, p] of posts) if (p.owner === owner) posts.delete(id);   // on delete cascade
    visibility.delete(owner);
    return J(204, null);
  }
  // --- accounts (visibility), posts and the storage bucket, with the same
  // read rule as the policies: your own, or an open account's.
  const me = tokenOf.get(auth);
  const canSee = (owner) => owner === me || visibility.get(owner) === "open";
  if (u.pathname === "/rest/v1/accounts") {
    if (!me) return J(401, { message: "JWT expired" });
    const id = (u.searchParams.get("id") || "").replace(/^eq\./, "");
    if (init.method === "PATCH") {
      if (id === me && ["open", "private"].includes(body.visibility)) visibility.set(me, body.visibility);
      return J(204, null);
    }
    return J(200, canSee(id) ? [{ username: usernameOf(id), display_name: null, visibility: visibility.get(id) || "private" }] : []);
  }
  if (u.pathname === "/rest/v1/posts") {
    if (!me) return J(401, { message: "JWT expired" });
    if (init.method === "POST") {
      if ([...String(body.body)].length > 42) return J(400, { code: "23514", message: "posts_body_check" });
      if (body.media_type && !["image", "video"].includes(body.media_type)) return J(400, { code: "23514", message: "posts_media_type_check" });
      if (body.media_path && body.media_path.split("/")[0] !== me) return J(400, { code: "23514", message: "posts_media_path_check" });
      const row = { id: "p" + (++seq), owner: me, created_at: serverTime(), ...body };
      posts.set(row.id, row);
      return J(201, [row]);
    }
    if (init.method === "DELETE") {
      const id = (u.searchParams.get("id") || "").replace(/^eq\./, "");
      if (posts.get(id)?.owner === me) posts.delete(id);          // RLS: someone else's is a no-op
      return J(204, null);
    }
    const lt = (u.searchParams.get("created_at") || "").replace(/^lt\./, "");
    const limit = +u.searchParams.get("limit") || 20;
    const out = [...posts.values()].filter((p) => canSee(p.owner) && (!lt || p.created_at < lt))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
      .map((p) => ({ ...p, author: { username: usernameOf(p.owner), display_name: null } }));
    return J(200, out);
  }
  if (u.pathname.startsWith("/storage/v1/object/")) {
    if (!me) return J(401, { message: "JWT expired" });
    const rest = u.pathname.slice("/storage/v1/object/".length);
    if (rest.startsWith("sign/posts")) {
      return J(200, body.paths.map((path) => (canSee(path.split("/")[0])
        ? { path, signedURL: `/object/sign/posts/${path}?token=t`, error: null }
        : { path, signedURL: null, error: "Object not found" })));
    }
    if (rest.startsWith("list/posts")) {
      const pre = body.prefix + "/";
      return J(200, [...media.keys()].filter((k) => k.startsWith(pre) && canSee(body.prefix))
        .slice(0, body.limit).map((k) => ({ name: k.slice(pre.length) })));
    }
    if (rest === "posts" && init.method === "DELETE") {
      for (const k of body.prefixes) if (k.split("/")[0] === me) media.delete(k);
      return J(200, []);
    }
    if (rest.startsWith("posts/") && init.method === "POST") {
      const key = rest.slice("posts/".length);
      if (key.split("/")[0] !== me) return J(403, { message: "new row violates row-level security policy" });
      media.set(key, { type: init.headers["Content-Type"], size: body.size });
      return J(200, { Key: "posts/" + key });
    }
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

// --- back from a confirmation email -----------------------------------------
{
  const l = await cloud.fromRedirect("#access_token=linktoken&expires_in=3600&refresh_token=rt&token_type=bearer&type=signup");
  ok(l && l.user.id === "uid-link" && l.refresh_token === "rt", "a confirmation link's tokens become a login");
  ok(await cloud.fromRedirect("#viewDash") === null, "an ordinary hash is not a login");
  let code = null;
  try { await cloud.fromRedirect("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid"); }
  catch (e) { code = e.code; }
  ok(code === "otp_expired", "an expired link says so", code);
}

// --- posts, the feed and who sees what ---------------------------------------
{
  ok(C.clampCaption("  New   PB!  ") === "New PB!", "a caption is trimmed and its spaces folded");
  ok(C.clampCaption("\u{1F4AA}".repeat(50)) === "\u{1F4AA}".repeat(42), "and cut at 42, an emoji counting as one (as Postgres counts)");
  ok(/^u1\/\d+-[0-9a-z]{6}\.mp4$/.test(C.mediaPath("u1", "video/mp4;codecs=avc1")), "media goes in the owner's own folder");

  const bas = await cloud.signIn("bas_g", "hunter22!");
  const ana = await cloud.signUpUsername("ana_x", "correct horse");
  const pic = new Blob([new Uint8Array(1000)], { type: "image/jpeg" });
  const clip = new Blob([new Uint8Array(5000)], { type: "video/mp4" });

  const p1 = await cloud.post(ana, { blob: pic, kind: "image", body: "first squat set " + "x".repeat(40),
                                     meta: { activity: "squat", reps: 8, clean: 6 } });
  ok(p1 && [...p1.body].length === 42 && p1.media_path.startsWith("uid-ana_x/"), "a post goes up with its picture, caption cut to 42");
  ok(media.get(p1.media_path)?.type === "image/jpeg", "the picture is stored as itself, typed");
  let feed = await cloud.feed(ana);
  ok(feed.length === 1 && feed[0].media_url && feed[0].media_url.startsWith("https://x.supabase.co/storage/v1/object/sign/posts/"),
     "the author sees it, with a signed link", feed[0]?.media_url);
  ok((await cloud.feed(bas)).length === 0, "a private account's post is seen by nobody else");

  ok((await cloud.account(ana)).visibility === "private", "accounts start private");
  await cloud.setVisibility(ana, "open");
  feed = await cloud.feed(bas);
  ok(feed.length === 1 && feed[0].author.username === "ana_x" && feed[0].media_url, "open: others see the post, its author and its picture");
  let bad = null;
  try { await cloud.setVisibility(ana, "everyone"); } catch (e) { bad = e.code; }
  ok(bad === "bad_visibility", "only open or private");

  await cloud.post(bas, { blob: clip, kind: "video", body: "", meta: { activity: "cmj", reps: 3 } });
  feed = await cloud.feed(bas);
  ok(feed.length === 2 && feed[0].media_type === "video", "the newest first; a clip is a post like a picture");
  ok((await cloud.feed(bas, { before: feed[0].created_at })).length === 1, "and the next page starts after the last one shown");

  // A post whose row is refused takes its upload back down.
  const n0 = media.size;
  let refused = null;
  try { await cloud.post(bas, { blob: pic, kind: "gif", body: "x" }); } catch (e) { refused = e.code; }
  ok(refused === "23514" && media.size === n0, "a refused post leaves no orphan file behind", `${n0} -> ${media.size}`);

  // Someone else's post cannot be taken down.
  await cloud.deletePost(bas, feed.find((p) => p.owner === "uid-ana_x"));
  ok(posts.has(p1.id) && media.has(p1.media_path), "deleting someone else's post does nothing");
  await cloud.deletePost(ana, p1);
  ok(!posts.has(p1.id) && !media.has(p1.media_path), "the author's delete removes the post and its picture");
  await cloud.deleteAccount(ana);
}

// --- delete my account ---------------------------------------------------
{
  on("phone");
  const before = [...rows.values()].length;
  const l = await cloud.signIn("bas_g", "hunter22!");
  ok([...media.keys()].some((k) => k.startsWith("uid-bas_g/")), "(Bas has a clip posted)");
  await cloud.deleteAccount(l);
  ok(before > 0 && ![...rows.values()].length, "deleting the account removes every synced record", `${before} -> ${rows.size}`);
  ok(![...media.keys()].some((k) => k.startsWith("uid-bas_g/")) && ![...posts.values()].some((p) => p.owner === "uid-bas_g"),
     "and every post and posted file");
  let gone = null;
  try { await cloud.signIn("bas_g", "hunter22!"); } catch (e) { gone = e.code; }
  ok(gone === "invalid_credentials", "and the login no longer works");
  ok(P.listMeals().some((m) => m.profile === "Bas") || P.listSleep().some((x) => x.profile === "Bas"),
     "the phone's own copy is untouched by the account deletion");
  // Optional: forget the athlete on this device too.
  P.addWeight({ profile: "Bas", kg: 83 });
  P.addWeight({ profile: "Guest", kg: 70 });
  const r = P.eraseAthlete("Bas");
  const left = JSON.stringify(P.exportAll());
  ok(!P.getProfile("Bas") && !P.getSession() && !P.listSleep().length && !P.listWeights().some((w) => w.profile === "Bas"),
     "erasing the athlete removes their profile, session and logs", JSON.stringify(r));
  ok(P.getProfile("Guest") && P.listWeights().some((w) => w.profile === "Guest") && P.listMeals().some((m) => m.profile === "Guest"),
     "and leaves the other athlete alone");
  ok(!/"profile":"Bas"/.test(left) && !/"p":"Bas"/.test(left), "nothing of Bas is left in an export");
}

if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
console.log("\nAll checks passed");
