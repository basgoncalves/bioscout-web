/**
 * syncmeta.js -- what makes a record mergeable between devices.
 *
 * Today the only "sync" is the export file, carried by hand. Accounts and a
 * server are coming (Supabase, EU region -- decided 2026-09-10), and the thing
 * a server cannot fix after the fact is data that does not say enough about
 * itself to be merged. Two gaps made the export additive-only:
 *
 *   1. EDITS DID NOT TRAVEL. Import skipped any record whose identity was
 *      already on the device, so correcting last night's sleep on the phone
 *      and importing into the laptop kept the laptop's old value. Every write
 *      now stamps `u` (updated, ISO time) and a merge keeps the newer one.
 *
 *   2. DELETIONS DID NOT TRAVEL. A meal deleted on the phone came straight
 *      back from the laptop's copy on the next import. A delete now leaves a
 *      tombstone {k: kind, id, at}, the tombstones travel with the data, and a
 *      record is dropped wherever it meets a tombstone newer than its own `u`.
 *      A record written AFTER the delete (the same day's sleep logged again)
 *      is newer than the tombstone and survives it.
 *
 * Last writer wins, by each device's clock. That is the honest limit of doing
 * this without a server: a phone whose clock is an hour wrong wins or loses
 * an hour's worth of ties. With a server, `u` can become the server's time.
 *
 * Records written before this file existed have no `u`; they read as oldest,
 * so any stamped copy beats them and any tombstone buries them.
 *
 * Pure: no storage, so test_syncmeta.mjs runs it in node.
 */

export const stamp = () => new Date().toISOString();
const day = (at) => String(at).slice(0, 10);
const who = (x) => x.profile ?? null;

/** Identity of a record, per store. Same identities the stores already
 *  de-duplicate on -- this only writes them down in one place. */
export const IDENTITY = {
  meals: (x) => `${who(x)}|${x.at}`,
  diary: (x) => `${who(x)}|${x.at}`,
  weights: (x) => `${who(x)}|${x.at}`,
  cycle: (x) => `${who(x)}|${day(x.at)}`,
  sleep: (x) => `${who(x)}|${day(x.at)}`,
  vitals: (x) => `${who(x)}|${day(x.at)}`,
  water: (x) => `${who(x)}|${day(x.at)}`,
  coffee: (x) => `${who(x)}|${day(x.at)}`,
  cardio: (x) => `${who(x)}|${x.id}`,
  profiles: (x) => String(x.name),
  sessions: (x) => String(x.started),
};

/** The fields a record must have to be one at all, per store. */
const VALID = {
  cardio: (x) => x.id && x.at,
  profiles: (x) => x.name,
  sessions: (x) => x.started && Array.isArray(x.sets),
};
const valid = (kind, x) => !!x && typeof x === "object" && (VALID[kind] ? !!VALID[kind](x) : !!x.at);

export const tombKey = (t) => `${t.k}|${t.id}`;

/** Tombstones from two sources, one per (kind, id), the latest delete kept. */
export function mergeTombs(a = [], b = []) {
  const m = new Map();
  for (const t of [...(a || []), ...(b || [])]) {
    if (!t || !t.k || t.id === undefined || !t.at) continue;
    const k = tombKey(t), have = m.get(k);
    if (!have || String(t.at) > String(have.at)) m.set(k, { k: t.k, id: t.id, at: t.at });
  }
  return [...m.values()].sort((x, y) => String(x.at).localeCompare(String(y.at)));
}

/** Is this record deleted? Only by a tombstone at least as new as its last write. */
export function buried(tombIndex, kind, rec) {
  const t = tombIndex.get(`${kind}|${IDENTITY[kind](rec)}`);
  return !!t && String(rec.u || "") <= String(t.at);
}

export const tombIndex = (tombs) => new Map((tombs || []).map((t) => [tombKey(t), t]));

/**
 * Merge `incoming` into `local` for one store.
 *
 * Union by identity; where both have a record, the one with the newer `u`
 * wins (a tie keeps local, so re-importing the same file changes nothing);
 * then anything a tombstone covers is dropped, on either side. Returns the
 * merged list (in the order records were first seen, the caller sorts) and
 * what happened, so the page can say it.
 */
export function mergeRecords(kind, local = [], incoming = [], tombs = []) {
  const id = IDENTITY[kind];
  const idx = tombIndex(tombs);
  const out = [];
  const at = new Map();
  for (const x of local || []) {
    if (!valid(kind, x)) continue;
    at.set(id(x), out.length); out.push(x);
  }
  let added = 0, updated = 0, removed = 0;
  for (const x of incoming || []) {
    if (!valid(kind, x) || buried(idx, kind, x)) continue;
    const i = at.get(id(x));
    if (i === undefined) { at.set(id(x), out.length); out.push(x); added++; continue; }
    if (String(x.u || "") > String(out[i].u || "")) { out[i] = x; updated++; }
  }
  const list = out.filter((x) => {
    if (!buried(idx, kind, x)) return true;
    removed++; return false;
  });
  return { list, added, updated, removed };
}
