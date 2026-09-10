/**
 * cloud.js -- BioScout accounts and private sync (Supabase).
 *
 * Local-first stays the rule: the app works with no account and offline, and
 * the device's localStorage is still where everything is read from. Signing
 * in adds one thing -- the athlete you pick as "this is me" is copied to your
 * account and kept in step with your other devices. Other athletes on a
 * shared phone never leave it.
 *
 * The sync reuses the device's own merge. Rows pulled from the server are
 * turned back into an export-shaped object and handed to importAll(), so the
 * rules are the ones syncmeta.js already tests: newer edit wins, deletions
 * travel. Pushing is the reverse: exportAll(), keep this athlete's records
 * changed since the last push, one row each. The server keeps whichever copy
 * is newer (records_lww trigger), so two devices pushing in any order agree.
 *
 * Not synced: stored motion curves (hundreds of kB a set -- the set summaries
 * travel, the waveforms stay where they were recorded) and meal photos.
 *
 * Posts are the one thing that is not private: a picture or clip of a set the
 * person chose to post, with up to 42 characters. They live in their own
 * table and storage bucket (supabase/schema.sql), never in `records`.
 *
 * No SDK: GoTrue (auth) and PostgREST (tables) are plain HTTP, and a few
 * fetch calls are smaller than the client library and keep the app free of a
 * dependency. `fetch` is injectable so test_cloud.mjs runs without a network.
 */
import { IDENTITY } from "./syncmeta.js";

const STATE_KEY = "bioscout.cloud.v1";
/* Username-only accounts get a placeholder address: Supabase needs an email
 * behind every login. `.invalid` is reserved (RFC 2606), so nothing is ever
 * sent anywhere -- which is also why such an account cannot reset a password. */
export const USERNAME_DOMAIN = "users.bioscout.invalid";
export const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;
const PAGE = 1000;
const PUSH_BATCH = 500;

/** Kinds that carry `profile` and whose identity starts with it. */
const PER_ATHLETE = ["meals", "diary", "weights", "cycle", "sleep", "vitals", "water", "coffee", "cardio"];
export const SYNCED_KINDS = [...PER_ATHLETE, "profiles", "sessions", "ledger", "assessments"];

// --- local state -------------------------------------------------------------
export function loadState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || "null") || {}; } catch { return {}; }
}
export function saveState(s) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* private window */ }
}
export function clearState() {
  try { localStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
}

// --- mapping between device records and server rows (pure) ------------------
const ANON = "null";
/** A device identity ("Bas|2026-09-10") as the server knows it ("null|2026-09-10"). */
function toRid(kind, localId, athlete) {
  if (kind === "profiles") return "me";
  const pre = `${athlete}|`;
  return String(localId).startsWith(pre) ? ANON + "|" + String(localId).slice(pre.length) : String(localId);
}
function fromRid(kind, rid, athlete) {
  if (kind === "profiles") return athlete;
  return rid.startsWith(ANON + "|") ? `${athlete}|${rid.slice(ANON.length + 1)}` : rid;
}
const after = (u, since) => !since || String(u || "") > String(since);

/**
 * Rows to push: this athlete's records written after `since` (all of them
 * when `since` is empty), and this athlete's deletions after it.
 * `dump` is exportAll()'s object.
 */
export function toRows(dump, athlete, since = null) {
  const rows = [];
  const add = (kind, rid, data, u) => rows.push({ kind, rid, data, u: String(u), deleted: false });
  /* Records from before write stamps have no `u`. They are sent with their
   * own date as `u` -- older than any real edit, and the same on every device
   * that holds a copy, so two devices uploading the same old meal agree. */
  const EPOCH = "1970-01-01T00:00:00.000Z";
  for (const kind of PER_ATHLETE) {
    for (const x of dump[kind] || []) {
      if (!x || x.profile !== athlete) continue;
      const u = x.u || x.at;
      if (!u || !after(u, since)) continue;
      const data = { ...x, u, profile: null };
      add(kind, IDENTITY[kind](data), data, u);
    }
  }
  const me = ((dump.profiles && dump.profiles.profiles) || []).find((p) => p.name === athlete);
  if (me && after(me.u || EPOCH, since)) add("profiles", "me", { ...me, u: me.u || EPOCH, name: null }, me.u || EPOCH);
  const sessions = [...(dump.archive || []), ...(dump.session ? [dump.session] : [])];
  for (const s of sessions) {
    if (!s || s.profile !== athlete) continue;
    const u = s.u || s.started;
    if (!u || !after(u, since)) continue;
    add("sessions", String(s.started), { ...s, u, profile: null }, u);
  }
  // Ledger lines and filed assessments are written once and never edited, so
  // their own timestamp is their last write.
  for (const e of dump.ledger || []) {
    if (e && e.p === athlete && after(e.s, since)) add("ledger", String(e.s), { ...e, p: null }, e.s);
  }
  for (const a of dump.assessments || []) {
    if (a && a.profile === athlete && a.finished && after(a.finished, since)) {
      add("assessments", String(a.finished), { ...a, profile: null }, a.finished);
    }
  }
  for (const t of dump.deleted || []) {
    if (!t || !SYNCED_KINDS.includes(t.k) || !after(t.at, since)) continue;
    const mine = t.k === "profiles" ? t.id === athlete : String(t.id).startsWith(`${athlete}|`);
    if (!mine) continue;
    rows.push({ kind: t.k, rid: toRid(t.k, t.id, athlete), data: null, u: String(t.at), deleted: true });
  }
  return rows;
}

/**
 * Pulled rows as an export file for importAll(): every record put back under
 * the local athlete's name, deletions as tombstones.
 */
export function fromRows(rows, athlete) {
  const out = { format: "bioscout-profile-export", version: 1, profiles: { profiles: [] },
                archive: [], ledger: [], assessments: [], deleted: [] };
  for (const k of PER_ATHLETE) out[k] = [];
  for (const r of rows || []) {
    if (!r || !SYNCED_KINDS.includes(r.kind)) continue;
    if (r.deleted) {
      out.deleted.push({ k: r.kind, id: fromRid(r.kind, r.rid, athlete), at: r.u });
      continue;
    }
    const d = r.data || {};
    if (PER_ATHLETE.includes(r.kind)) out[r.kind].push({ ...d, profile: athlete });
    else if (r.kind === "profiles") out.profiles.profiles.push({ ...d, name: athlete });
    else if (r.kind === "sessions") out.archive.push({ ...d, profile: athlete });
    else if (r.kind === "ledger") out.ledger.push({ ...d, p: athlete });
    else if (r.kind === "assessments") out.assessments.push({ ...d, profile: athlete });
  }
  return out;
}

// --- HTTP ----------------------------------------------------------------------
// --- posts (pure) --------------------------------------------------------------
/** The storage bucket that holds posted pictures and clips (private). */
export const BUCKET = "posts";
/* A profile picture lives in the same bucket, at <uid>/avatar.jpg: the
 * folder already says whose it is, the bucket's policies already say who may
 * see it (you, and -- as for posts -- anyone when your account is open, your
 * friends once friends exist), and deleting the account's media folder
 * already takes it with it. No table change was needed for it. */
export const AVATAR_NAME = "avatar.jpg";
export const avatarPath = (uid) => `${uid}/${AVATAR_NAME}`;
/** A post's words. Counted the way Postgres counts them (code points), so an
 *  emoji is one, and the server's char_length(body) <= 42 can never refuse
 *  what the page let through. */
export const CAPTION_MAX = 42;
export function clampCaption(s) {
  const cps = [...String(s ?? "").replace(/\s+/g, " ").trim()];
  return cps.slice(0, CAPTION_MAX).join("").trim();
}
export function captionLength(s) { return [...String(s ?? "")].length; }
const EXT = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "video/webm": "webm",
              "video/quicktime": "mov" };
/** Where a post's media goes: the owner's own folder (the storage policy and
 *  the posts table both check the first segment), a time, and some noise so
 *  two posts in one millisecond cannot collide. */
export function mediaPath(uid, type, t = Date.now(), rand = Math.random) {
  const ext = EXT[String(type || "").split(";")[0]] || "bin";
  const noise = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0");
  return `${uid}/${t}-${noise}.${ext}`;
}

export class CloudError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export function makeCloud({ url, key, fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now() }) {
  const base = String(url || "").replace(/\/+$/, "");
  const enabled = !!(base && key);

  async function call(path, { method = "GET", body, token, headers = {} } = {}) {
    let res;
    try {
      // A Blob (a picture or a clip on its way to storage) goes up as it is,
      // typed as itself; everything else is JSON.
      const raw = typeof Blob !== "undefined" && body instanceof Blob;
      res = await fetchImpl(base + path, {
        method,
        headers: { apikey: key, "Content-Type": raw ? (body.type || "application/octet-stream") : "application/json",
                   ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
    } catch (e) {
      throw new CloudError("offline", "No connection to the account server.");
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = json && (json.msg || json.message || json.error_description || json.error) || text || res.statusText;
      const code = json && (json.error_code || json.code) || String(res.status);
      throw new CloudError(code, String(msg));
    }
    return json;
  }

  /** The login as stored: tokens plus who. */
  function keep(tok) {
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: now() + (Number(tok.expires_in) || 3600) * 1000,
      user: { id: tok.user?.id, email: tok.user?.email,
              username: tok.user?.user_metadata?.username || null },
    };
  }

  const emailFor = (login) => {
    const s = String(login || "").trim();
    return s.includes("@") ? s.toLowerCase() : `${s.toLowerCase()}@${USERNAME_DOMAIN}`;
  };

  return {
    enabled,
    emailFor,

    async signIn(login, password) {
      return keep(await call("/auth/v1/token?grant_type=password",
        { method: "POST", body: { email: emailFor(login), password } }));
    },

    /** Email sign-up. Returns a login if the project does not ask for email
     *  confirmation, otherwise null: the person confirms, then signs in. */
    async signUpEmail(email, password, redirectTo = null) {
      // redirect_to: where the confirmation link lands. Honoured only if the
      // project allows the address (Auth -> URL Configuration); otherwise the
      // project's Site URL is used.
      const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : "";
      const r = await call("/auth/v1/signup" + q, { method: "POST", body: { email: emailFor(email), password } });
      return r && r.access_token ? keep(r) : null;
    },

    /**
     * The login carried back by a confirmation link. The server confirms the
     * address and then redirects to the app with the tokens in the URL hash
     * (#access_token=...&refresh_token=...); this turns them into a login.
     * Returns null for a hash without tokens; throws the link's own error
     * (an expired or already-used link) when there is one.
     */
    async fromRedirect(hash) {
      const h = new URLSearchParams(String(hash || "").replace(/^#/, ""));
      if (h.get("error") || h.get("error_code")) {
        throw new CloudError(h.get("error_code") || h.get("error"),
                             (h.get("error_description") || "").replace(/\+/g, " "));
      }
      const access = h.get("access_token");
      if (!access) return null;
      const user = await call("/auth/v1/user", { token: access });
      return keep({ access_token: access, refresh_token: h.get("refresh_token"),
                    expires_in: h.get("expires_in"), user });
    },

    /** Username sign-up. Done by the `signup-username` edge function, which
     *  creates the login already confirmed (there is no inbox to confirm). */
    async signUpUsername(username, password) {
      const name = String(username || "").trim().toLowerCase();
      if (!USERNAME_RE.test(name)) throw new CloudError("bad_username");
      await call("/functions/v1/signup-username", { method: "POST", body: { username: name, password },
                                                     headers: { Authorization: `Bearer ${key}` } });
      return this.signIn(name, password);
    },

    async refresh(login) {
      return keep(await call("/auth/v1/token?grant_type=refresh_token",
        { method: "POST", body: { refresh_token: login.refresh_token } }));
    },

    async signOut(login) {
      try { await call("/auth/v1/logout", { method: "POST", token: login.access_token }); }
      catch { /* signed out locally either way */ }
    },

    /** A login good for at least another minute, refreshed if needed. */
    async fresh(login) {
      if (!login) throw new CloudError("signed_out");
      return login.expires_at - now() > 60e3 ? login : this.refresh(login);
    },

    /** Delete the signed-in account: login, account row and every synced
     *  record (public.delete_my_account on the server). Irreversible.
     *
     *  Posted pictures and clips go FIRST, from here: the database cannot
     *  delete storage objects itself, and once the login is gone nobody can.
     *  If that step fails the account is left alone, so it can be retried
     *  rather than leaving media behind with no owner to remove it. */
    async deleteAccount(login) {
      await this.removeAllMedia(login);
      await call("/rest/v1/rpc/delete_my_account", { method: "POST", token: login.access_token, body: {} });
    },

    /* ---- the feed: posts, their media, and who can see them ------------ */

    /** Your own account row: username, display name, open/private. */
    async account(login) {
      const rows = await call(`/rest/v1/accounts?select=username,display_name,visibility&id=eq.${login.user.id}`,
                              { token: login.access_token });
      return (rows && rows[0]) || null;
    },

    /** "open": everyone signed in sees your posts. "private": you and your friends. */
    async setVisibility(login, visibility) {
      if (visibility !== "open" && visibility !== "private") throw new CloudError("bad_visibility");
      await call(`/rest/v1/accounts?id=eq.${login.user.id}`, {
        method: "PATCH", token: login.access_token, body: { visibility },
        headers: { Prefer: "return=minimal" } });
    },

    /* ---- usernames and friends (public.friendships, functions in schema.sql) ---- */

    /** Choose a username, once (the server refuses a change). */
    async setUsername(login, username) {
      const name = String(username || "").trim().replace(/^@/, "").toLowerCase();
      if (!USERNAME_RE.test(name)) throw new CloudError("bad_username");
      try {
        await call(`/rest/v1/accounts?id=eq.${login.user.id}`, {
          method: "PATCH", token: login.access_token, body: { username: name },
          headers: { Prefer: "return=minimal" } });
      } catch (e) {
        if (e.code === "23505") throw new CloudError("username_taken");     // unique violation
        throw e;
      }
      return name;
    },

    /** Accounts whose username starts with `q` (2+ characters), not you. */
    async searchUsers(login, q) {
      return (await call("/rest/v1/rpc/search_accounts", {
        method: "POST", token: login.access_token, body: { q: String(q || "") } })) || [];
    },

    /** Everyone you are linked to: {id, username, display_name, status, outgoing, since}. */
    async friends(login) {
      return (await call("/rest/v1/rpc/my_friends", {
        method: "POST", token: login.access_token, body: {} })) || [];
    },

    /** Ask someone by username. Returns sent | accepted | already_sent |
     *  already_friends | not_found | self | too_many. */
    async requestFriend(login, username) {
      return call("/rest/v1/rpc/request_friend", {
        method: "POST", token: login.access_token, body: { p_username: String(username || "") } });
    },

    async respondFriend(login, otherId, accept) {
      await call("/rest/v1/rpc/respond_friend", {
        method: "POST", token: login.access_token, body: { p_other: otherId, p_accept: !!accept } });
    },

    /** Unfriend, or take back a request you sent -- or decline one sent to you. */
    async removeFriend(login, otherId) {
      await call("/rest/v1/rpc/remove_friend", {
        method: "POST", token: login.access_token, body: { p_other: otherId } });
    },

    /**
     * Post a picture or clip with up to 42 characters.
     * `blob` is the file, `kind` "image" | "video", `meta` a small summary of
     * the set (movement, reps) the feed prints under it. The media is uploaded
     * first; if the row then fails, the upload is taken back down.
     */
    async post(login, { blob, kind, body = "", meta = null }) {
      const text = clampCaption(body);
      if (!blob && !text) throw new CloudError("empty_post");
      let path = null;
      if (blob) {
        path = mediaPath(login.user.id, blob.type, now());
        await call(`/storage/v1/object/${BUCKET}/${path}`, {
          method: "POST", token: login.access_token, body: blob,
          headers: { "x-upsert": "false", "cache-control": "3600" } });
      }
      try {
        const rows = await call("/rest/v1/posts", {
          method: "POST", token: login.access_token,
          body: { body: text, media_path: path, media_type: blob ? kind : null, meta },
          headers: { Prefer: "return=representation" } });
        return rows && rows[0];
      } catch (e) {
        if (path) { try { await this.removeMedia(login, [path]); } catch { /* best effort */ } }
        throw e;
      }
    },

    /**
     * Newest posts you are allowed to see (yours, and open accounts'), with a
     * short-lived link for each picture or clip. `before` is the created_at of
     * the last post already shown, for the next page.
     */
    async feed(login, { before = null, limit = 20 } = {}) {
      const q = "/rest/v1/posts?select=id,owner,body,media_path,media_type,meta,created_at,"
        + "author:accounts(username,display_name)&order=created_at.desc"
        + `&limit=${limit}` + (before ? `&created_at=lt.${encodeURIComponent(before)}` : "");
      const posts = (await call(q, { token: login.access_token })) || [];
      const paths = posts.map((p) => p.media_path).filter(Boolean);
      if (paths.length) {
        const signed = await call(`/storage/v1/object/sign/${BUCKET}`, {
          method: "POST", token: login.access_token, body: { expiresIn: 3600, paths } });
        const url = new Map((signed || []).filter((x) => x && x.signedURL)
          .map((x) => [x.path, base + "/storage/v1" + x.signedURL]));
        for (const p of posts) p.media_url = p.media_path ? url.get(p.media_path) || null : null;
      }
      return posts;
    },

    /* ---- profile picture ------------------------------------------------ */

    /** Put up your profile picture (a small square JPEG), replacing any old
     *  one. Delete then upload: the bucket lets you add and remove your own
     *  files but not overwrite them. Short cache so a new face shows soon. */
    async setAvatar(login, blob) {
      const path = avatarPath(login.user.id);
      try { await this.removeMedia(login, [path]); } catch { /* there was none */ }
      await call(`/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST", token: login.access_token, body: blob,
        headers: { "x-upsert": "false", "cache-control": "60" } });
      return path;
    },

    async removeAvatar(login) {
      await this.removeMedia(login, [avatarPath(login.user.id)]);
    },

    /** Signed links to the profile pictures of these accounts, as {id: url}.
     *  Someone with no picture -- or whose picture you may not see -- is
     *  simply absent; the page draws their initial instead. */
    async avatarUrls(login, ids) {
      const uniq = [...new Set((ids || []).filter(Boolean))];
      if (!uniq.length) return {};
      const signed = await call(`/storage/v1/object/sign/${BUCKET}`, {
        method: "POST", token: login.access_token,
        body: { expiresIn: 3600, paths: uniq.map(avatarPath) } });
      const out = {};
      for (const x of signed || []) {
        if (!x || !x.signedURL || x.error) continue;
        const id = String(x.path || "").split("/")[0];
        if (id) out[id] = base + "/storage/v1" + x.signedURL;
      }
      return out;
    },

    /** Take down one of your posts, and its picture or clip with it. */
    async deletePost(login, post) {
      await call(`/rest/v1/posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: "DELETE", token: login.access_token, headers: { Prefer: "return=minimal" } });
      if (post.media_path) await this.removeMedia(login, [post.media_path]);
    },

    async removeMedia(login, paths) {
      if (!paths.length) return;
      await call(`/storage/v1/object/${BUCKET}`, {
        method: "DELETE", token: login.access_token, body: { prefixes: paths } });
    },

    /** Everything in your media folder, e.g. before the account goes. */
    async removeAllMedia(login) {
      const uid = login.user.id;
      for (let round = 0; round < 50; round++) {
        const list = await call(`/storage/v1/object/list/${BUCKET}`, {
          method: "POST", token: login.access_token,
          body: { prefix: uid, limit: 100, offset: 0 } });
        const names = (list || []).map((o) => o && o.name).filter(Boolean);
        if (!names.length) return;
        await this.removeMedia(login, names.map((n) => `${uid}/${n}`));
      }
    },

    async pull(login, cursor = null) {
      const rows = [];
      let c = cursor;
      for (;;) {
        const q = `/rest/v1/records?select=kind,rid,data,u,deleted,server_at&order=server_at.asc&limit=${PAGE}`
          + (c ? `&server_at=gt.${encodeURIComponent(c)}` : "");
        const page = await call(q, { token: login.access_token });
        rows.push(...(page || []));
        if (page && page.length) c = page[page.length - 1].server_at;
        if (!page || page.length < PAGE) break;
      }
      return { rows, cursor: c };
    },

    async push(login, rows) {
      for (let i = 0; i < rows.length; i += PUSH_BATCH) {
        await call("/rest/v1/records?on_conflict=owner,kind,rid", {
          method: "POST", token: login.access_token, body: rows.slice(i, i + PUSH_BATCH),
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        });
      }
      return rows.length;
    },
  };
}

/**
 * One full sync: pull everything new since the cursor into the device, then
 * push what this device changed since its last push.
 *
 * `local` is { exportAll, importAll } from profiles.js, passed in so this file
 * does not import the storage layer (and the test can stand in for it).
 */
export async function syncOnce(cloud, state, local, clock = () => new Date().toISOString()) {
  if (!state.login || !state.athlete) throw new CloudError("signed_out");
  const login = await cloud.fresh(state.login);
  const startedAt = clock();
  const { rows, cursor } = await cloud.pull(login, state.cursor || null);
  const report = rows.length ? local.importAll(fromRows(rows, state.athlete)) : null;
  const out = toRows(local.exportAll(), state.athlete, state.pushedAt || null);
  const pushed = out.length ? await cloud.push(login, out) : 0;
  return { state: { ...state, login, cursor, pushedAt: startedAt, lastSync: clock() },
           pulled: rows.length, pushed, report };
}
