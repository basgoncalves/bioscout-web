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
export class CloudError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export function makeCloud({ url, key, fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now() }) {
  const base = String(url || "").replace(/\/+$/, "");
  const enabled = !!(base && key);

  async function call(path, { method = "GET", body, token, headers = {} } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { apikey: key, "Content-Type": "application/json",
                   ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
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
     *  record (public.delete_my_account on the server). Irreversible. */
    async deleteAccount(login) {
      await call("/rest/v1/rpc/delete_my_account", { method: "POST", token: login.access_token, body: {} });
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
