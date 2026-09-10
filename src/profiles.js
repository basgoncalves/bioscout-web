/**
 * profiles.js -- athlete profiles and the running training session.
 *
 * Both live in localStorage, which is the right home for them: they are one
 * person's convenience on one device, they must survive a reload, and nothing
 * here should ever leave the phone. Every access is wrapped, because private
 * windows and "block site data" settings make localStorage throw rather than
 * return empty, and a profile feature must never take the app down with it.
 *
 * A training session holds SETS. Each set is one recording: its reps, the
 * settings in force at the time, and a small summary. Full waveforms are not
 * kept -- a long session would blow the storage quota -- so the export writes
 * whatever sets are still in memory in full, and older ones as summaries.
 */
import { UNITS } from "./foods.js";
import { groupPeaks } from "./muscle_groups.js";
import { listAssessments, importAssessments, eraseAssessments } from "./assess.js";
import { DRINKS, DRINK_KINDS } from "./water.js";
import { sessionReps } from "./achievements.js";
import { stamp, IDENTITY, mergeTombs, mergeRecords, tombIndex, buried } from "./syncmeta.js";

const PKEY = "bioscout.profiles.v1";
const SKEY = "bioscout.session.v1";
const AKEY = "bioscout.archive.v1";
const CKEY = "bioscout.curves.v1";
const MKEY = "bioscout.meals.v1";
const DKEY = "bioscout.diary.v1";
const WKEY = "bioscout.weights.v1";
const CYKEY = "bioscout.cycle.v1";
const SLKEY = "bioscout.sleep.v1";
const VKEY = "bioscout.vitals.v1";
const WAKEY = "bioscout.water.v1";
const COKEY = "bioscout.coffee.v1";
const RXKEY = "bioscout.reaction.v1";
const DRINK_KEY = { water: WAKEY, coffee: COKEY };
const CDKEY = "bioscout.cardio.v1";
const LKEY = "bioscout.ledger.v1";
const TKEY = "bioscout.deleted.v1";

/* How many sets keep their WAVEFORMS. Summaries are tiny and every set keeps
 * one; curves are not, so only the most recent sets keep those.
 *
 * The earlier design kept no curves at all, on the grounds that 80 muscle
 * forces per frame would blow the quota -- which is true of the forces and of
 * nothing else. Times, joint angles and the inverse-dynamics traces are about
 * 10 kB per set after rounding, so a dozen sets is ~120 kB against a quota of
 * several megabytes. Dropping them meant the set dropdown greyed out every set
 * from before the last reload, which is the wrong trade by two orders of
 * magnitude. */
const CURVE_SETS_MAX = 12;

// Finished sessions kept per device. Capped, because localStorage is a few
// megabytes and silently starts throwing when it is full -- and the thing it
// would break is the profile the athlete is standing there trying to use.
const ARCHIVE_MAX = 50;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }          // private window, quota, or blocked storage
}

/**
 * write(), for the records that must not be lost: a session and its sets.
 *
 * The stored curves are by far the biggest thing on the device (tens to
 * hundreds of kB a set) and the only thing here that can be rebuilt from
 * nothing -- a set without its curves is still a set in the log, one without
 * its row is gone. So when the quota refuses, the oldest curve sets are
 * dropped one at a time and the write is tried again. Before this, a full
 * store made addSet's write fail SILENTLY: the analysis showed, the log did
 * not get the set, and nothing said so.
 */
function writeKeep(key, value) {
  if (write(key, value)) return true;
  const store = read(CKEY, {});
  const keys = Object.keys(store)
    .sort((a, b) => String(store[a].at).localeCompare(String(store[b].at)));
  while (keys.length) {
    delete store[keys.shift()];
    if (!write(CKEY, store)) continue;
    if (write(key, value)) return true;
  }
  try { localStorage.removeItem(CKEY); } catch { /* ignore */ }
  return write(key, value);
}

// --- deletions -------------------------------------------------------------
/* A delete leaves a tombstone so it can travel to the other devices (see
 * syncmeta.js). Capped: a tombstone older than the oldest copy anyone could
 * still import is dead weight, and 5000 deletions is years of use. */
const TOMBS_MAX = 5000;

export function listDeleted() {
  const t = read(TKEY, []);
  return Array.isArray(t) ? t : [];
}

/** Record that these records of `kind` were deleted, now. */
function bury(kind, records) {
  const at = stamp();
  const t = (records || []).map((x) => ({ k: kind, id: IDENTITY[kind](x), at }));
  if (!t.length) return;
  write(TKEY, mergeTombs(listDeleted(), t).slice(-TOMBS_MAX));
}

/** A record written now is alive, whatever was deleted under its identity
 *  before: without this, a day cleared and re-logged in the same millisecond
 *  would read as deleted to the merge. */
function unbury(kind, rec) {
  const id = IDENTITY[kind](rec);
  const t = listDeleted();
  const kept = t.filter((x) => !(x.k === kind && x.id === id));
  if (kept.length !== t.length) write(TKEY, kept);
}

/** Keep `list` minus the records matching `drop`, and bury what was dropped. */
function dropAndBury(key, kind, list, drop) {
  const gone = list.filter(drop);
  const kept = list.filter((x) => !drop(x));
  write(key, kept);
  bury(kind, gone);
  return kept.length;
}

// --- profiles --------------------------------------------------------------
export function listProfiles() {
  const p = read(PKEY, { profiles: [], lastUsed: null });
  return Array.isArray(p.profiles) ? p : { profiles: [], lastUsed: null };
}

export function saveProfile(profile) {
  const store = listProfiles();
  const i = store.profiles.findIndex((x) => x.name === profile.name);
  profile.u = stamp();
  unbury("profiles", profile);
  if (i >= 0) store.profiles[i] = profile; else store.profiles.push(profile);
  store.lastUsed = profile.name;
  return write(PKEY, store);
}

export function deleteProfile(name) {
  const store = listProfiles();
  bury("profiles", store.profiles.filter((x) => x.name === name));
  store.profiles = store.profiles.filter((x) => x.name !== name);
  if (store.lastUsed === name) store.lastUsed = store.profiles[0]?.name ?? null;
  return write(PKEY, store);
}

export function getProfile(name) {
  return listProfiles().profiles.find((x) => x.name === name) || null;
}

export function lastUsedProfile() {
  const s = listProfiles();
  return s.lastUsed ? s.profiles.find((x) => x.name === s.lastUsed) || null : null;
}

// --- training session ------------------------------------------------------
/**
 * Start a session, optionally ON A GIVEN DAY.
 *
 * `startedAt` exists because the day view lets an athlete open a session on any
 * day of the calendar -- typically to work through videos they filmed earlier
 * -- and without it the session was stamped with the moment the button was
 * pressed. The recordings then filed themselves under today, the day the
 * athlete had selected stayed empty, and the honest reading of the screen was
 * that the work had been lost.
 */
/**
 * A `started` no filed session already has.
 *
 * `started` is a session's identity -- in the archive, in the sync, and in
 * the stored curves' keys -- and a session opened from the calendar starts at
 * noon on its day. So two sessions opened on the same day (two athletes on one
 * phone, or one athlete twice) got the same identity: the day view then opened
 * the wrong one, and archiveSession() quietly skipped the second as "already
 * filed". A millisecond later is the same noon to every reader, and unique.
 */
export function uniqueStarted(startedAt) {
  const taken = new Set(listArchive().map((x) => x.started));
  let t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return startedAt;
  let iso = new Date(t).toISOString();
  while (taken.has(iso)) iso = new Date(++t).toISOString();
  return iso;
}

export function newSession(profileName, startedAt = null, sport = null) {
  const s = { started: uniqueStarted(startedAt || new Date().toISOString()),
              profile: profileName || null, sets: [], u: stamp() };
  // Which sport the session is (sports.js). Absent on sessions from before
  // sports existed, which is read as "any".
  if (sport) s.sport = sport;
  writeKeep(SKEY, s);
  return s;
}

export function getSession() {
  const s = read(SKEY, null);
  return s && Array.isArray(s.sets) ? s : null;
}

export function clearSession() {
  try { localStorage.removeItem(SKEY); } catch { /* ignore */ }
}

// --- archive ---------------------------------------------------------------
export function listArchive() {
  const a = read(AKEY, []);
  return Array.isArray(a) ? a : [];
}

/** File the open session and clear it. Returns the number kept.
 *  A session with no sets is dropped rather than archived: an empty entry is
 *  not history, it is a session someone started and walked away from. */
export function archiveSession() {
  const s = getSession();
  if (!s || !s.sets || !s.sets.length) { clearSession(); return listArchive().length; }
  const a = listArchive();
  // `started` is the identity: importing the same file twice must not double
  // the history, and two sessions cannot begin at the same millisecond.
  if (!a.some((x) => x.started === s.started)) a.push(s);
  a.sort((x, y) => String(x.started).localeCompare(String(y.started)));
  const trimmed = trimArchive(a);
  if (!trimmed) return listArchive().length;
  // Filed FIRST, cleared after. The other order lost the whole session
  // whenever the archive write was refused (a full store).
  if (writeKeep(AKEY, trimmed)) clearSession();
  return trimmed.length;
}

/* --- ledger of dropped sessions --------------------------------------------
 * The archive keeps the last ARCHIVE_MAX sessions. A session that falls off
 * the end takes its reps with it, and achievements (achievements.js) count a
 * lifetime: so before a session is dropped, one line is written here -- when
 * it started, whose it was, reps per task. ~70 bytes a session, against the
 * tens of kB a set's curves cost, so it is not capped.
 *
 * `s` (started) is the identity, as in the archive: re-importing a file adds
 * nothing, and a session that is both here and back in the archive (an old
 * export imported) is counted once -- achievements.js skips ledger entries
 * whose session is live. */
export function listLedger() {
  const l = read(LKEY, []);
  return Array.isArray(l) ? l : [];
}

function ledgerAdd(entries) {
  const l = listLedger();
  const seen = new Set(l.map((e) => e.s));
  let added = 0;
  for (const e of entries) {
    if (!e || !e.s || seen.has(e.s)) continue;
    l.push(e); seen.add(e.s); added++;
  }
  if (!added) return true;
  l.sort((x, y) => String(x.s).localeCompare(String(y.s)));
  return writeKeep(LKEY, l);
}

/** Sorted archive, cut to ARCHIVE_MAX, with whatever is cut written to the
 *  ledger first. Null when the ledger could not be written: then nothing is
 *  dropped, because a dropped session nobody counted is lost reps. */
function trimArchive(a) {
  a.sort((x, y) => String(x.started).localeCompare(String(y.started)));
  const cut = a.length - ARCHIVE_MAX;
  if (cut <= 0) return a;
  const dropped = a.slice(0, cut).map((s) => ({ s: s.started, p: s.profile ?? null, r: sessionReps(s) }));
  try { if (!ledgerAdd(dropped)) return null; } catch { return null; }
  return a.slice(cut);
}

// --- meals -----------------------------------------------------------------
/* A meal is a time, a description and, if the person felt like typing it, a
 * calorie figure. That is the whole record on purpose: this is a log, not a
 * budget. There are no targets, no remaining-for-today, and nothing that
 * scores a day, because the app has no idea what anyone's intake should be and
 * inventing one would be worse than useless.
 *
 * `at` is the identity, as `started` is for sessions: it makes import
 * idempotent and gives deletion something to name. */
const MEALS_MAX = 2000;

export function listMeals() {
  const m = read(MKEY, []);
  return Array.isArray(m) ? m : [];
}

/** Add a meal. `at` defaults to now; pass one to log against another day. */
export function addMeal({ profile = null, text = "", kcal = null, at = null,
                          photo = false, items = [] }) {
  // Items are the record; text and kcal are what a meal logged before items
  // existed had, and what the list shows. Keeping all three means old entries
  // still read correctly and new ones can be edited back into their parts.
  const parts = (items || [])
    .map((i) => ({
      name: String(i.name || "").slice(0, 80),
      grams: Number.isFinite(+i.grams) && +i.grams > 0 ? Math.round(+i.grams) : null,
      kcal100: Number.isFinite(+i.kcal100) && +i.kcal100 >= 0 ? +i.kcal100 : null,
      // The unit and the amount as typed, so a meal read back later still
      // says "200 mL" rather than silently becoming "200 g" -- grams above
      // stays the figure the arithmetic runs on, this is only the label.
      unit: UNITS.includes(i.unit) ? i.unit : "g",
      qty: Number.isFinite(+i.qty) && +i.qty > 0 ? +i.qty : null,
    }))
    .filter((i) => i.name);
  const entry = {
    at: at || new Date().toISOString(),
    profile,
    items: parts,
    text: String(text).slice(0, 200),
    kcal: Number.isFinite(+kcal) && +kcal > 0 ? Math.round(+kcal) : null,
    // A flag, not the image. The photo itself is in IndexedDB under a key
    // derived from (at, profile) -- see media.js -- because a few hundred kB
    // of base64 in localStorage takes the whole store down with it.
    photo: !!photo,
    u: stamp(),
  };
  if (!entry.text.trim() && !parts.length) return null;
  const all = listMeals();
  // Two meals in the same millisecond is a double tap, not two meals.
  if (all.some((m) => m.at === entry.at && m.profile === entry.profile)) return null;
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  unbury("meals", entry);
  write(MKEY, all.slice(-MEALS_MAX));
  return entry;
}

export function deleteMeal(at, profile = null) {
  return dropAndBury(MKEY, "meals", listMeals(), (m) => m.at === at && m.profile === profile);
}

// --- diary -----------------------------------------------------------------
/* One athlete can write more than once a day, so entries are a flat list keyed
 * on `at`, exactly as meals are. Tags are free strings: the useful set is the
 * one the person keeps using, not one this file can predict. */
const DIARY_MAX = 3000;
const TAGS_MAX = 40;

export function listDiary() {
  const d = read(DKEY, []);
  return Array.isArray(d) ? d : [];
}

export function addDiary({ profile = null, mood = null, tags = [], levels = {},
                           note = "", at = null, quick = false }) {
  const m = Number(mood);
  const keep = [...new Set((tags || []).map((t) => String(t).slice(0, 40)))].slice(0, TAGS_MAX);
  const lv = {};
  for (const t of keep) {
    const n = Math.round(Number(levels?.[t]));
    // A level outside 1-10 is not a level; the tag stays, unquantified.
    if (Number.isFinite(n) && n >= 1 && n <= 10) lv[t] = n;
  }
  const entry = {
    at: at || new Date().toISOString(),
    profile,
    mood: Number.isInteger(m) && m >= 1 && m <= 5 ? m : null,
    tags: keep,
    levels: lv,
    note: String(note).slice(0, 1000),
    u: stamp(),
  };
  if (quick) entry.quick = true;       // the day's overall mood, see diary.js
  // An entry with no mood, no tags and no note is a mis-tap.
  if (entry.mood === null && !entry.tags.length && !entry.note.trim()) return null;
  const all = listDiary().filter((x) => !(x.at === entry.at && x.profile === entry.profile));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  unbury("diary", entry);
  write(DKEY, all.slice(-DIARY_MAX));
  return entry;
}

export function deleteDiary(at, profile = null) {
  return dropAndBury(DKEY, "diary", listDiary(), (d) => d.at === at && d.profile === profile);
}

/** Foods the athlete added, as name -> kcal per 100 g, on the profile. */
export function profileFoods(name) {
  return getProfile(name)?.foods || {};
}

export function saveProfileFood(name, food, kcal100) {
  const p = getProfile(name);
  if (!p) return false;
  const v = Number(kcal100);
  if (!String(food).trim() || !Number.isFinite(v) || v < 0 || v > 1000) return false;
  p.foods = { ...(p.foods || {}), [String(food).trim().slice(0, 80)]: Math.round(v) };
  return saveProfile(p);
}

/** The athlete's own tag list, kept on the profile so it travels with them. */
export function profileTags(name) {
  return getProfile(name)?.tags || null;
}

export function saveProfileTags(name, tags) {
  const p = getProfile(name);
  if (!p) return false;
  p.tags = [...new Set(tags.map((t) => String(t).slice(0, 40)))].slice(0, TAGS_MAX);
  return saveProfile(p);
}

// --- weight ----------------------------------------------------------------
/* Dated measurements, not a single number on the profile. Mass scales every
 * moment and contact force the app reports, so "83 kg" is only meaningful with
 * a date attached -- see weight.js for how a value carries forward. */
const WEIGHTS_MAX = 2000;

export function listWeights() {
  const w = read(WKEY, []);
  return Array.isArray(w) ? w : [];
}

export function addWeight({ profile = null, kg, at = null }) {
  const v = +kg;
  if (!Number.isFinite(v) || v <= 0 || v > 500) return null;
  const entry = { at: at || new Date().toISOString(), profile, kg: Math.round(v * 10) / 10,
                  u: stamp() };
  const all = listWeights().filter((x) => !(x.at === entry.at && x.profile === entry.profile));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  unbury("weights", entry);
  write(WKEY, all.slice(-WEIGHTS_MAX));
  return entry;
}

export function deleteWeight(at, profile = null) {
  return dropAndBury(WKEY, "weights", listWeights(), (w) => w.at === at && w.profile === profile);
}

// --- cycle -----------------------------------------------------------------
/* One record per logged day, keyed on the day itself rather than the instant:
 * logging the same day twice is a correction, not a second period. Cycles are
 * derived from these days in cycle.js -- nothing here declares one. */
const CYCLE_MAX = 2000;

export function listCycle() {
  const c = read(CYKEY, []);
  return Array.isArray(c) ? c : [];
}

export function setCycleDay({ profile = null, at, flow = null, symptoms = [] }) {
  if (!at) return null;
  const f = Number(flow);
  const entry = {
    at,
    profile,
    flow: Number.isInteger(f) && f >= 1 && f <= 4 ? f : null,
    symptoms: [...new Set((symptoms || []).map((s) => String(s).slice(0, 40)))].slice(0, 40),
    u: stamp(),
  };
  const day = String(at).slice(0, 10);
  const all = listCycle().filter(
    (x) => !(x.profile === entry.profile && String(x.at).slice(0, 10) === day));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  unbury("cycle", entry);
  write(CYKEY, all.slice(-CYCLE_MAX));
  return entry;
}

export function clearCycleDay(at, profile = null) {
  const day = String(at).slice(0, 10);
  return dropAndBury(CYKEY, "cycle", listCycle(),
    (x) => x.profile === profile && String(x.at).slice(0, 10) === day);
}

// --- sleep -----------------------------------------------------------------
/* One record per night, keyed on the morning it ended -- see sleep.js for why.
 * Logging the same night twice is a correction, not a second night. */
const SLEEP_MAX = 2000;

export function listSleep() {
  const s = read(SLKEY, []);
  return Array.isArray(s) ? s : [];
}

export function setSleep({ profile = null, at, bed = "", wake = "" }) {
  if (!at) return null;
  const entry = { at, profile, bed: String(bed).slice(0, 5), wake: String(wake).slice(0, 5),
                  u: stamp() };
  if (!entry.bed || !entry.wake) return null;
  const day = String(at).slice(0, 10);
  const all = listSleep().filter(
    (x) => !(x.profile === entry.profile && String(x.at).slice(0, 10) === day));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  unbury("sleep", entry);
  write(SLKEY, all.slice(-SLEEP_MAX));
  return entry;
}

export function clearSleep(at, profile = null) {
  const day = String(at).slice(0, 10);
  return dropAndBury(SLKEY, "sleep", listSleep(),
    (x) => x.profile === profile && String(x.at).slice(0, 10) === day);
}

// --- vitals (steps, resting heart rate, blood pressure) ----------------------
/* One reading per day, keyed like sleep -- see vitals.js for why these do not
 * carry forward the way weight does. */
const VITALS_MAX = 2000;

export function listVitals() {
  const v = read(VKEY, []);
  return Array.isArray(v) ? v : [];
}

/* Blood pressure is a pair or nothing. A systolic without its diastolic is not
 * half a reading, it is no reading -- and a pair where the lower number is the
 * higher one is two fields typed in the wrong order, not a pressure. The
 * ranges are wide on purpose: they refuse typos (1200/80), not unusual people. */
export function bpPair(sys, dia) {
  const blank = (v) => v === null || v === undefined || v === "";
  if (blank(sys) && blank(dia)) return null;
  const s = Math.round(+sys), d = Math.round(+dia);
  if (!Number.isFinite(s) || !Number.isFinite(d)) return false;
  if (s < 60 || s > 260 || d < 30 || d > 160 || s <= d) return false;
  return { sys: s, dia: d };
}

export function setVitals({ profile = null, at, steps = null, restingHr = null,
                            sys = null, dia = null }) {
  if (!at) return null;
  const s = steps === null || steps === "" ? null : Math.round(+steps);
  const h = restingHr === null || restingHr === "" ? null : Math.round(+restingHr);
  const bp = bpPair(sys, dia);
  if (bp === false) return null;           // half a pressure, or an impossible one
  const entry = {
    at, profile,
    steps: Number.isFinite(s) && s >= 0 ? s : null,
    restingHr: Number.isFinite(h) && h > 0 ? h : null,
    sys: bp ? bp.sys : null,
    dia: bp ? bp.dia : null,
    u: stamp(),
  };
  if (entry.steps === null && entry.restingHr === null && entry.sys === null) return null;
  const day = String(at).slice(0, 10);
  const all = listVitals().filter(
    (x) => !(x.profile === entry.profile && String(x.at).slice(0, 10) === day));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  unbury("vitals", entry);
  write(VKEY, all.slice(-VITALS_MAX));
  return entry;
}

export function clearVitals(at, profile = null) {
  const day = String(at).slice(0, 10);
  return dropAndBury(VKEY, "vitals", listVitals(),
    (x) => x.profile === profile && String(x.at).slice(0, 10) === day);
}

// --- water and coffee (glasses / cups a day) ---------------------------------
/* One count per day per drink, overwritten on every tap of + or - -- see
 * water.js. A count of zero removes the day rather than filing "drank none". */
const DRINK_MAX = 2000;

export function listDrink(kind) {
  if (!DRINK_KEY[kind]) return [];
  const v = read(DRINK_KEY[kind], []);
  return Array.isArray(v) ? v : [];
}

export function setDrink({ kind = "water", profile = null, at, n }) {
  const d = DRINKS[kind];
  if (!at || !d) return null;
  const g = Math.round(+n);
  if (!Number.isFinite(g)) return null;
  const c = Math.max(0, Math.min(d.max, g));
  const day = String(at).slice(0, 10);
  const had = listDrink(kind);
  const same = (x) => x.profile === profile && String(x.at).slice(0, 10) === day;
  const all = had.filter((x) => !same(x));
  // Down to zero is a delete: the day is removed, and the removal travels.
  if (c > 0) { const rec = { at, profile, [d.field]: c, u: stamp() }; all.push(rec); unbury(kind, rec); }
  else bury(kind, had.filter(same));
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(DRINK_KEY[kind], all.slice(-DRINK_MAX));
  return { at, profile, [d.field]: c };
}

export const listWater = () => listDrink("water");
export const listCoffee = () => listDrink("coffee");
export const setWater = ({ profile = null, at, glasses }) =>
  setDrink({ kind: "water", profile, at, n: glasses });
export const setCoffee = ({ profile = null, at, cups }) =>
  setDrink({ kind: "coffee", profile, at, n: cups });

// --- reaction time (finger test) ---------------------------------------------
/* One record per test, keyed by its time like a meal: a day can hold a
 * morning and an evening test. Only the raw counted trials are kept (plus
 * what went wrong and how the taps came in); median and best are derived in
 * reaction.js, so a better summary later applies to old tests too.
 * Local and in the export file; not in the cloud sync yet (the server's
 * list of record kinds does not include it). */
const REACTION_MAX = 2000;

export function listReaction() {
  const v = read(RXKEY, []);
  return Array.isArray(v) ? v : [];
}

export function addReaction({ profile = null, at = null, trials = [], falseStarts = 0,
                              misses = 0, errors = 0, input = null, game = "simple",
                              session = null }) {
  const t = (trials || []).map((x) => Math.round(+x)).filter((x) => Number.isFinite(x) && x > 0);
  if (!t.length) return null;
  const rec = { at: at || new Date().toISOString(), profile, trials: t,
                falseStarts: Math.max(0, Math.round(+falseStarts) || 0),
                misses: Math.max(0, Math.round(+misses) || 0),
                input: ["touch", "mouse", "pen", "key"].includes(input) ? input : null,
                // Which game (reaction.js GAMES), wrong-side taps / taps on the
                // cross, and the training session it was done in, if any.
                game: ["simple", "choice", "colour", "gonogo"].includes(game) ? game : "simple",
                errors: Math.max(0, Math.round(+errors) || 0),
                session: session ? String(session).slice(0, 40) : null,
                u: stamp() };
  const all = listReaction().filter((x) => !(x.at === rec.at && x.profile === profile));
  all.push(rec);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  unbury("reaction", rec);
  write(RXKEY, all.slice(-REACTION_MAX));
  return rec;
}

export function deleteReaction(at, profile = null) {
  return dropAndBury(RXKEY, "reaction", listReaction(), (x) => x.at === at && x.profile === profile);
}

// --- cardio (imported endurance activities) ---------------------------------
/* Keyed on the SOURCE's own id, not on the day: a day can hold a commute ride
 * and an evening run, and re-importing must recognise both rather than
 * stacking copies. See cardio.js for why these are not sessions. */
const CARDIO_MAX = 5000;

export function listCardio() {
  const c = read(CDKEY, []);
  return Array.isArray(c) ? c : [];
}

/**
 * Merge imported activities in, by id.
 *
 * Re-importing the same window is a no-op, and an activity renamed or
 * re-typed on the source updates in place instead of arriving as a second
 * copy. Only a change that IS one is counted, so an import that found nothing
 * new can say exactly that.
 */
export function mergeCardio(items) {
  const all = listCardio();
  const at = new Map(all.map((c, i) => [c.id, i]));
  let added = 0, updated = 0;
  // An activity deleted here stays deleted: the next import from the source
  // would otherwise bring it straight back.
  const tombs = tombIndex(listDeleted());
  for (const c of items || []) {
    if (!c || !c.id || !c.at || buried(tombs, "cardio", c)) continue;
    const i = at.get(c.id);
    if (i === undefined) { all.push({ ...c, u: c.u || stamp() }); at.set(c.id, all.length - 1); added++; continue; }
    const { u: _u, ...rest } = c;
    const merged = { ...all[i], ...rest };
    if (JSON.stringify(merged) !== JSON.stringify(all[i])) { all[i] = { ...merged, u: stamp() }; updated++; }
  }
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(CDKEY, all.slice(-CARDIO_MAX));
  return { added, updated };
}

export function deleteCardio(id, profile = null) {
  return dropAndBury(CDKEY, "cardio", listCardio(), (c) => c.id === id && c.profile === profile);
}

/**
 * When the newest stored activity happened, as a Date, or null.
 *
 * This is what makes a repeat import cheap: the source is asked only for what
 * has happened since, rather than for the whole history every time.
 */
export function latestCardioAt(profile = null) {
  let newest = null;
  for (const c of listCardio()) {
    if (profile && c.profile !== profile) continue;
    if (!newest || String(c.at) > newest) newest = String(c.at);
  }
  const d = newest ? new Date(newest) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// --- stored waveforms ------------------------------------------------------
const r3 = (a) => Array.from(a, (v) => (Number.isFinite(v) ? +v.toFixed(3) : 0));
const r2 = (a) => Array.from(a, (v) => (Number.isFinite(v) ? +v.toFixed(2) : 0));

/** One rep as saveCurves stores it. */
function curveRep(rp) {
  const o = { rep: rp.rep, bounds: rp.bounds, times: r3(rp.times), coords: {} };
  for (const [k, v] of Object.entries(rp.coords || {})) o.coords[k] = r3(v);
  if (rp.dyn) {
    o.dyn = {};
    for (const [k, v] of Object.entries(rp.dyn)) {
      o.dyn[k] = Array.isArray(v) || ArrayBuffer.isView(v) ? r2(v) : v;
    }
  }
  // Per-joint angle / velocity / moment / power (jointmetrics.js). Kept so
  // a restored set shows the same four plots, arm moments included --
  // they cannot be rebuilt from the .mot columns alone.
  if (rp.jm) {
    o.jm = {};
    for (const [k, v] of Object.entries(rp.jm)) {
      if (Array.isArray(v) || ArrayBuffer.isView(v)) o.jm[k] = r2(v);
    }
  }
  for (const [k, v] of Object.entries(rp)) {
    /* Strings as well as numbers.
     *
     * `stance_side` is the only string a rep carries, and dropping it made
     * a restored run a set of strides that belong to no foot: the panels
     * are built by pairing each left cycle with its right, so a reloaded
     * running set came back with no curves at all. Coordinate and moment
     * arrays are handled above; everything else scalar is small. */
    if (typeof v === "number" || typeof v === "boolean"
        || (typeof v === "string" && v.length <= 40)) o[k] = v;
  }
  return o;
}

/** Everything a chart needs, and nothing it does not. Muscle forces are left
 *  out on purpose: they are 80 traces per frame, an order of magnitude more
 *  than all the rest together, and the app can say so rather than not store
 *  the angles either. */
export function saveCurves(sessionStarted, index, result) {
  if (!sessionStarted || !result || !result.reps) return false;
  const store = read(CKEY, {});
  const key = `${sessionStarted}|${index}`;
  store[key] = {
    at: new Date().toISOString(),
    activity: result.activity, osimModel: result.osimModel,
    massKg: result.massKg, addedKg: result.addedKg, assistKg: result.assistKg,
    externalKg: result.externalKg, ageY: result.ageY ?? null,
    coverage: result.coverage, pxPerM: result.pxPerM, view: result.view,
    fps: result.fps,
    setIndex: index,
    reps: result.reps.map(curveRep),
    // Reps the athlete took out (setRepRemoved). Kept whole, so putting one
    // back restores its curves as well as its row.
    removedReps: (result.removedReps || []).map(curveRep),
  };
  if (!store[key].removedReps.length) delete store[key].removedReps;
  /* The whole-trial curve, if the analysis made one.
   *
   * It is the same size as all the reps put together, so it roughly doubles
   * what a set costs to store -- and the quota walk below already drops the
   * oldest set rather than losing the write, so the cost falls on old history
   * and not on this recording. A restored set without it would simply be
   * missing its last panel, with no way to tell that from a set that never
   * had one. */
  if (result.whole) {
    const w = result.whole;
    const o = { rep: "all", wholeTrial: true, bounds: w.bounds,
                contacts: w.contacts || null,
                times: r3(w.times), coords: {} };
    for (const [k, v] of Object.entries(w.coords || {})) o.coords[k] = r3(v);
    if (w.dyn) {
      o.dyn = {};
      for (const [k, v] of Object.entries(w.dyn)) {
        o.dyn[k] = Array.isArray(v) || ArrayBuffer.isView(v) ? r2(v) : v;
      }
    }
    if (w.jm) {
      o.jm = {};
      for (const [k, v] of Object.entries(w.jm)) {
        if (Array.isArray(v) || ArrayBuffer.isView(v)) o.jm[k] = r2(v);
      }
    }
    store[key].whole = o;
  }
  // Newest first, then trim. If the quota still refuses, drop the oldest and
  // try again rather than losing the write outright.
  let keys = Object.keys(store).sort((a, b) => store[b].at.localeCompare(store[a].at));
  for (const k of keys.slice(CURVE_SETS_MAX)) delete store[k];
  keys = Object.keys(store).sort((a, b) => store[b].at.localeCompare(store[a].at));
  while (keys.length) {
    if (write(CKEY, store)) return true;
    const oldest = keys.pop();
    if (oldest === key) return false;      // this set alone will not fit
    delete store[oldest];
  }
  return false;
}

export function getCurves(sessionStarted, index) {
  const store = read(CKEY, {});
  return store[`${sessionStarted}|${index}`] || null;
}

export function curveIndices(sessionStarted) {
  return Object.keys(read(CKEY, {}))
    .filter((k) => k.startsWith(sessionStarted + "|"))
    .map((k) => +k.split("|")[1]);
}

// --- erasing one athlete -----------------------------------------------------
/**
 * Remove everything this device holds for one athlete: the profile, sessions
 * (open and archived) and their curves, meals, diary, weights, cycle, sleep,
 * vitals, water, coffee, cardio, lifetime ledger and filed assessments.
 * Other athletes on the device are untouched.
 *
 * For "delete my account" with "also from this device" ticked. Unlike a delete,
 * this leaves NO tombstones: it is not a change to sync, it is this device
 * forgetting someone. Meal photos are in IndexedDB; the caller removes them
 * (the returned `photos` are their meal ids, see media.js photoId).
 */
export function eraseAthlete(name) {
  if (!name) return { photos: [] };
  const mine = (x) => x && x.profile === name;
  const photos = listMeals().filter((m) => mine(m) && m.photo).map((m) => ({ at: m.at, profile: name }));
  const store = listProfiles();
  store.profiles = store.profiles.filter((p) => p.name !== name);
  if (store.lastUsed === name) store.lastUsed = store.profiles[0]?.name ?? null;
  write(PKEY, store);
  const open = getSession();
  const gone = new Set();
  if (mine(open)) { gone.add(open.started); clearSession(); }
  const arch = listArchive();
  for (const s of arch) if (mine(s)) gone.add(s.started);
  write(AKEY, arch.filter((s) => !mine(s)));
  const curves = read(CKEY, {});
  for (const k of Object.keys(curves)) if (gone.has(k.split("|")[0])) delete curves[k];
  write(CKEY, curves);
  for (const key of [MKEY, DKEY, WKEY, CYKEY, SLKEY, VKEY, WAKEY, COKEY, CDKEY, RXKEY]) {
    const list = read(key, []);
    if (Array.isArray(list)) write(key, list.filter((x) => !mine(x)));
  }
  write(LKEY, listLedger().filter((e) => e.p !== name));
  write(TKEY, listDeleted().filter((t) => !(t.k === "profiles" ? t.id === name
                                                                 : String(t.id).startsWith(`${name}|`))));
  eraseAssessments(name);
  return { photos };
}

// --- export and import -----------------------------------------------------
/* No server yet, so no automatic sync. What there is instead: one file
 * carrying everything this device knows, which the athlete moves themselves.
 * The merge below is the same one a server sync will run (syncmeta.js):
 * newer edits win and deletions travel, so importing is a real two-way
 * reconciliation rather than "add what is missing". */
export const EXPORT_VERSION = 1;

export function exportAll() {
  return {
    format: "bioscout-profile-export",
    version: EXPORT_VERSION,
    exported: new Date().toISOString(),
    profiles: listProfiles(),
    session: getSession(),
    archive: listArchive(),
    meals: listMeals(),
    diary: listDiary(),
    weights: listWeights(),
    cycle: listCycle(),
    sleep: listSleep(),
    vitals: listVitals(),
    water: listWater(),
    coffee: listCoffee(),
    reaction: listReaction(),
    cardio: listCardio(),
    /* Filed assessments travel with everything else.
     *
     * They were missing, which made the export a backup of everything EXCEPT
     * the dated records of a person turning up and being tested -- the part
     * hardest to reproduce and most worth keeping. Old files simply lack the
     * field, so no version bump: an absent key imports as nothing. */
    assessments: listAssessments(),
    /* Reps of sessions the archive has let go of, so the achievements on
     * the device this is imported into count the same lifetime. */
    ledger: listLedger(),
    /* Deletions, so a record removed on this device is removed on the one
     * this file is imported into (syncmeta.js). */
    deleted: listDeleted(),
  };
}

/**
 * Merge an exported file into this device. Merging, not replacing: importing
 * on a phone that already has a session must not throw that session away, and
 * a re-import of the same file must be a no-op.
 *
 * Returns a report so the app can say what actually happened instead of a
 * blanket "imported".
 */
export function importAll(data) {
  if (!data || data.format !== "bioscout-profile-export") {
    throw new Error("not a BioScout export file");
  }
  if (!(data.version <= EXPORT_VERSION)) {
    throw new Error(`file is from a newer version (${data.version}) than this app understands`);
  }
  const report = { profilesAdded: 0, profilesUpdated: 0, sessionsAdded: 0,
                   sessionAdopted: false, mealsAdded: 0, diaryAdded: 0,
                   weightsAdded: 0, cycleAdded: 0, sleepAdded: 0, vitalsAdded: 0,
                   waterAdded: 0, coffeeAdded: 0, reactionAdded: 0, cardioAdded: 0, assessmentsAdded: 0,
                   ledgerAdded: 0, recordsUpdated: 0, recordsRemoved: 0 };
  report.assessmentsAdded = importAssessments(data.assessments);

  // Deletions first: the merged tombstones decide what survives below, on
  // both sides -- a meal deleted over there goes here too, and one deleted
  // here is not brought back by the file.
  const tombs = mergeTombs(listDeleted(), data.deleted);
  write(TKEY, tombs.slice(-TOMBS_MAX));
  let updated = 0, removed = 0;
  const merge = (kind, local, incoming) => {
    const r = mergeRecords(kind, local, Array.isArray(incoming) ? incoming : [], tombs);
    updated += r.updated; removed += r.removed;
    r.list.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    return r;
  };

  // Profiles: newer `u` wins, as for every other record. A profile with no
  // `u` on either side (files from before sync-readiness) keeps the old rule,
  // incoming fields laid over local ones, so an older file still carries a
  // height or a date of birth the device never had.
  const store = listProfiles();
  const pr = mergeRecords("profiles", store.profiles,
    ((data.profiles && data.profiles.profiles) || []), tombs);
  report.profilesAdded = pr.added; removed += pr.removed;
  for (const p of (data.profiles && data.profiles.profiles) || []) {
    if (!p || !p.name || p.u) continue;
    const i = pr.list.findIndex((x) => x.name === p.name);
    if (i < 0 || pr.list[i].u) continue;
    const merged = { ...pr.list[i], ...p };
    if (JSON.stringify(merged) !== JSON.stringify(pr.list[i])) { pr.list[i] = merged; pr.updated++; }
  }
  report.profilesUpdated = pr.updated;
  store.profiles = pr.list;
  if (data.profiles && data.profiles.lastUsed && pr.list.some((x) => x.name === data.profiles.lastUsed)) {
    store.lastUsed = data.profiles.lastUsed;
  }
  write(PKEY, store);

  // Sessions: new ones join the archive; one already here is replaced when
  // the incoming copy was changed later (a rep removed, a shot tapped).
  const open = getSession();
  const incoming = data.session;
  const hasSets = (x) => x && Array.isArray(x.sets) && x.sets.length > 0;
  // Any incoming copy of the session open here -- from a sync, it arrives in
  // the archive list -- updates the open session instead of being filed as a
  // second, archived copy of it.
  const others = [];
  for (const x of Array.isArray(data.archive) ? data.archive : []) {
    if (open && x && x.started === open.started) {
      if (String(x.u || "") > String(getSession().u || "")) { write(SKEY, x); updated++; }
    } else others.push(x);
  }
  let adopt = null;
  if (hasSets(incoming)) {
    if (open && incoming.started === open.started) {
      if (String(incoming.u || "") > String(getSession().u || "")) { write(SKEY, incoming); updated++; }
    } else {
      // The open session on the other device is history here unless this
      // device has nothing open -- then adopt it, so a phone handed over
      // mid-workout carries on rather than starting again.
      const known = [...listArchive(), ...others].some((x) => x && x.started === incoming.started);
      if (!open && !known) adopt = incoming; else others.push(incoming);
    }
  }
  const sr = mergeRecords("sessions", listArchive(), others, []);
  updated += sr.updated;
  report.sessionsAdded = sr.added;
  const a = sr.list;
  if (adopt) { write(SKEY, adopt); report.sessionAdopted = true; }
  // A ledger from the other device comes first, so a session it already
  // counted and this import would drop again is recognised as the same one.
  const ledger = Array.isArray(data.ledger) ? data.ledger : [];
  const beforeL = listLedger().length;
  try { ledgerAdd(ledger); } catch { /* counted as far as it went */ }
  report.ledgerAdded = listLedger().length - beforeL;
  // If the ledger could not take the overflow, fall back to the plain cut:
  // the imported sessions still land, only the oldest go uncounted.
  write(AKEY, trimArchive(a) || a.slice(-ARCHIVE_MAX));

  const stores = [
    ["meals", MKEY, listMeals, MEALS_MAX, "mealsAdded"],
    ["diary", DKEY, listDiary, DIARY_MAX, "diaryAdded"],
    ["weights", WKEY, listWeights, WEIGHTS_MAX, "weightsAdded"],
    ["cycle", CYKEY, listCycle, CYCLE_MAX, "cycleAdded"],
    ["sleep", SLKEY, listSleep, SLEEP_MAX, "sleepAdded"],
    ["vitals", VKEY, listVitals, VITALS_MAX, "vitalsAdded"],
    ...DRINK_KINDS.map((k) => [k, DRINK_KEY[k], () => listDrink(k), DRINK_MAX, k + "Added"]),
    ["cardio", CDKEY, listCardio, CARDIO_MAX, "cardioAdded"],
    ["reaction", RXKEY, listReaction, REACTION_MAX, "reactionAdded"],
  ];
  for (const [kind, key, list, max, field] of stores) {
    const r = merge(kind, list(), data[kind]);
    report[field] = r.added;
    // Only written when something changed: a no-op import leaves the store
    // byte-for-byte as it was.
    if (r.added || r.updated || r.removed) write(key, r.list.slice(-max));
  }
  report.recordsUpdated = updated;
  report.recordsRemoved = removed;

  // Photos are not in the export. They live in IndexedDB and would multiply
  // the file size by an order of magnitude in base64 -- an export you cannot
  // send yourself is not a backup. Meals still carry their `photo` flag, so
  // an imported meal knows a picture existed on the other device.
  return report;
}

/** Append one recording as the next set. Returns the stored (summary) set. */
export function addSet(result, fps, extra = {}) {
  const s = getSession() || newSession(extra.profile);
  // An empty session opened before uniqueStarted() existed may share its
  // identity with a filed one; nothing is keyed to it yet, so re-key it now.
  if (!s.sets.length) s.started = uniqueStarted(s.started);
  const set = {
    index: s.sets.length + 1,
    // On the session's day, at the clock time the set was recorded. A set
    // stamped with today's date inside a session filed on the 6th is a set the
    // day view will not show with its own session.
    at: onSessionDay(s.started),
    activity: result.activity,
    fps: +fps.toFixed(1),
    reps: result.reps.length,
    massKg: result.massKg, addedKg: result.addedKg, assistKg: result.assistKg,
    ageY: result.ageY ?? null,
    view: result.view?.view ?? null,
    detected: result.detection ? result.detection.activity : null,
    // Which assessment test this set was recorded for, if any. An assessment
    // set is still an ordinary set -- same session, same log -- and this is
    // the one thing that distinguishes it, including on the calendar.
    assess: extra.assess || null,
    perRep: result.reps.map((r) => summariseRep(r, result.activity)),
  };
  s.sets.push(set);
  s.u = stamp();
  // Throw rather than return a set that is not in the log: the caller says so
  // on the page (sayStorageFull), instead of the set vanishing quietly.
  if (!writeKeep(SKEY, s)) throw new Error("storage full: the set could not be saved");
  return set;
}

/**
 * Record whether an attempt went in.
 *
 * Writes onto the stored set, because the analysis in memory is gone as soon
 * as the athlete opens another one and the tap has to survive that. `made` is
 * true, false, or null for "not said" -- tapping the same answer twice clears
 * it, so a mis-tap is undoable and does not become permanent data.
 */
export function setRepOutcome(setIndex, rep, made) {
  const s = getSession();
  if (!s) return false;
  const set = s.sets.find((x) => x.index === setIndex);
  const r = set && (set.perRep || []).find((x) => x.rep === rep);
  if (!r) return false;
  r.made = r.made === made ? null : made;
  s.u = stamp();
  write(SKEY, s);
  return true;
}

/**
 * Take a rep out of a stored set, or put it back.
 *
 * For a rep that was tracked wrong -- a half-rep the detector counted, the
 * athlete stepping off, a pose-model glitch -- which would otherwise sit in
 * every mean, trend and chart built from the set. `removed` true takes it
 * out; false restores it.
 *
 * The rep is MOVED, not flagged: from `perRep` to `removedReps` on the set,
 * and from `reps` to `removedReps` in the stored curves. Everything that
 * reads a set -- the session table, the trends, the day view, exports, the
 * assessment report -- reads `perRep` and `reps`, so a removed rep is out of
 * all of them without any of them having to know removal exists; and nothing
 * is thrown away, so a mis-tap is one tap to undo. `set.reps` (the count)
 * follows.
 *
 * Works on the open session and on archived ones: `sessionStarted` is the
 * identity, as everywhere else. Returns the updated set, or null when there
 * was nothing to move.
 */
export function setRepRemoved(sessionStarted, setIndex, rep, removed = true) {
  const live = getSession();
  let sess = live && live.started === sessionStarted ? live : null;
  let arch = null;
  if (!sess) {
    arch = listArchive();
    sess = arch.find((x) => x.started === sessionStarted) || null;
  }
  const set = sess && sess.sets.find((x) => x.index === setIndex);
  if (!set) return null;
  const move = (holder, fromKey, toKey) => {
    const from = holder[fromKey] || [], i = from.findIndex((x) => x.rep === rep);
    if (i < 0) return false;
    const to = holder[toKey] || (holder[toKey] = []);
    to.push(from.splice(i, 1)[0]);
    to.sort((a, b) => a.rep - b.rep);
    holder[fromKey] = from;
    for (const k of [fromKey, toKey]) {
      if (k === "removedReps" && !holder[k].length) delete holder[k];
    }
    return true;
  };
  if (!move(set, removed ? "perRep" : "removedReps", removed ? "removedReps" : "perRep")) {
    return null;
  }
  set.reps = set.perRep.length;
  sess.u = stamp();
  if (!(arch ? writeKeep(AKEY, arch) : writeKeep(SKEY, sess))) return null;
  const store = read(CKEY, {});
  const c = store[`${sessionStarted}|${setIndex}`];
  if (c && move(c, removed ? "reps" : "removedReps", removed ? "removedReps" : "reps")) {
    write(CKEY, store);
  }
  return set;
}

/** Now, moved onto the session's calendar day. Same clock time, so the sets of
 *  a back-dated session still read in the order they were recorded. */
function onSessionDay(started) {
  const now = new Date();
  const d = new Date(started);
  if (isNaN(d) || d.toDateString() === now.toDateString()) return now.toISOString();
  d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return d.toISOString();
}

function summariseRep(r, activity) {
  const num = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);
  const o = { rep: r.rep, duration_s: num(r.duration_s) };
  if (r.dyn) {
    const pk = (a) => +Math.max(...a.map(Math.abs)).toFixed(1);
    o.peak_hip_Nm = pk(r.dyn.hip_moment);
    o.peak_knee_Nm = pk(r.dyn.knee_moment);
    o.peak_ankle_Nm = pk(r.dyn.ankle_moment);
    o.peak_grf_bw = +(Math.max(...r.dyn.grf_vertical) / r.dyn.body_weight_n).toFixed(2);
    /* Extensor and flexor peaks kept apart.
     *
     * The magnitude above answers "how big did it get", which for a stride is
     * almost always the extensor peak -- so a flexor moment that halved between
     * sets moved that number not at all. The convention here is extension
     * positive, so the two peaks are the signed maximum and the signed minimum,
     * and a joint that never went the other way reports 0 rather than a
     * borrowed value from the side it did go.
     *
     * The antero-posterior ground reaction is split the same way and for the
     * same reason: braking and propulsion are different events of the stride
     * and one summary number hides whichever is smaller. */
    const hi = (a) => +Math.max(0, ...a).toFixed(1);
    const lo = (a) => +Math.max(0, ...a.map((v) => -v)).toFixed(1);
    o.peak_hip_ext_Nm = hi(r.dyn.hip_moment);
    o.peak_hip_flex_Nm = lo(r.dyn.hip_moment);
    o.peak_knee_ext_Nm = hi(r.dyn.knee_moment);
    o.peak_knee_flex_Nm = lo(r.dyn.knee_moment);
    o.peak_ankle_pf_Nm = hi(r.dyn.ankle_moment);
    o.peak_ankle_df_Nm = lo(r.dyn.ankle_moment);
    if (r.dyn.grf_horizontal && r.dyn.body_weight_n) {
      const bw = r.dyn.body_weight_n;
      o.peak_grf_prop_bw = +(Math.max(0, ...r.dyn.grf_horizontal) / bw).toFixed(2);
      o.peak_grf_brake_bw =
        +(Math.max(0, ...r.dyn.grf_horizontal.map((v) => -v)) / bw).toFixed(2);
    }
  }
  /* Peak force per functional muscle group.
   *
   * The stance side's, when the rep has one -- a stride's forces belong to the
   * foot the stride belongs to, and taking the larger of the two sides there
   * would report the swinging leg whenever it happened to peak higher. These
   * come from the surrogate, and every place they are shown says so. */
  if (r.forces && r.forceNames) {
    const g = groupPeaks(r.forces, r.forceNames, r.stance_side || null);
    for (const [k, v] of Object.entries(g)) o["peak_" + k + "_N"] = +v.toFixed(0);
  }
  if (activity === "squat") {
    o.knee_flex_max_deg = r.knee_flex_max_deg;
    o.hip_flex_max_deg = r.hip_flex_max_deg;
    o.depth_m = r.depth_m != null ? +r.depth_m.toFixed(3) : null;
    o.down_s = +r.eccentric_s?.toFixed(2);
    o.up_s = +r.concentric_s?.toFixed(2);
  } else if (activity === "pullup") {
    o.elbow_flex_max_deg = r.elbow_flex_max_deg;
    o.travel_m = r.pelvis_travel_m != null ? +r.pelvis_travel_m.toFixed(3) : null;
    o.up_s = +r.concentric_s?.toFixed(2);
    o.down_s = +r.eccentric_s?.toFixed(2);
  } else if (activity === "jumpshot") {
    o.release_height_m = r.release_height_m ?? null;
    o.release_elbow_deg = r.release_elbow_deg ?? null;
    o.knee_flex_at_dip_deg = r.knee_flex_at_dip_deg ?? null;
    o.apex_offset_s = r.apex_offset_s ?? null;
    o.load_s = r.load_s ?? null;
    o.jump_height_m = r.jump_height_m ?? null;
    o.shoot_side = r.shoot_side ?? null;
    /* `made` is deliberately absent until the athlete taps it.
     *
     * null is not "missed": nothing in this app can see the ball, so an
     * untapped attempt has no outcome, and a make percentage computed over
     * untapped shots would be a number invented out of silence. */
    o.made = r.made ?? null;
  } else if (activity === "pushup") {
    // Depth from the shoulders (the hips travel half as far), and how far the
    // body bent at the hip -- the plank line.
    o.elbow_flex_max_deg = r.elbow_flex_max_deg;
    o.depth_m = r.depth_m != null ? +(+r.depth_m).toFixed(3) : null;
    o.body_bend_deg = r.body_bend_deg ?? null;
    o.down_s = +r.eccentric_s?.toFixed(2);
    o.up_s = +r.concentric_s?.toFixed(2);
  } else if (activity === "dip") {
    // The depth is the travel, named for what it is in this movement. Down
    // before up, because that is the order a dip happens in.
    o.elbow_flex_max_deg = r.elbow_flex_max_deg;
    o.arm_flex_range_deg = r.arm_flex_range_deg ?? null;
    o.depth_m = r.pelvis_travel_m != null ? +r.pelvis_travel_m.toFixed(3) : null;
    o.down_s = +r.eccentric_s?.toFixed(2);
    o.up_s = +r.concentric_s?.toFixed(2);
  } else if (activity === "cmj" || activity === "sj") {
    o.height_flight_m = r.height_flight_m ?? null;
    o.height_com_m = r.height_com_m ?? null;
    o.flight_s = r.flight_s ?? null;
    o.countermovement_m = r.countermovement_m ?? null;
    o.push_s = r.push_s ?? null;
    // The measured free-fall acceleration. About 9.8 means the body really was
    // in the air; anything else is the reason the rep should be distrusted, and
    // it belongs in the export where it can be checked.
    o.free_fall_accel_ms2 = r.free_fall_accel_ms2 ?? null;
    o.knee_flex_max_deg = r.knee_flex_max_deg;
  } else if (activity === "slsquat") {
    // The stance leg's numbers, plus the side it was on. A single-leg squat
    // logged without which leg it was is not a training record of anything.
    o.stance_side = r.stance_side ?? null;
    o.stance_knee_flex_max_deg = r.stance_knee_flex_max_deg ?? null;
    o.stance_hip_flex_max_deg = r.stance_hip_flex_max_deg ?? null;
    o.knee_asymmetry_deg = r.knee_asymmetry_deg ?? null;
    o.depth_m = r.depth_m != null ? +r.depth_m.toFixed(3) : null;
    o.down_s = +r.eccentric_s?.toFixed(2);
    o.up_s = +r.concentric_s?.toFixed(2);
  } else if (activity == "heelraise") {
    o.stance_side = r.stance_side ?? null;
    o.heel_lift = r.heel_lift ?? null;
    o.up_s = r.up_s ?? null;
    o.down_s = r.down_s ?? null;
  } else if (activity === "kickback") {
    // The leg that kicked, and what its hip did. Extension positive.
    o.stance_side = r.stance_side ?? null;
    o.hip_ext_max_deg = r.hip_ext_max_deg ?? null;
    o.hip_range_deg = r.hip_range_deg ?? null;
    o.trunk_motion_deg = r.trunk_motion_deg ?? null;
    o.kick_s = r.kick_s != null ? +r.kick_s.toFixed(2) : null;
    o.return_s = r.return_s != null ? +r.return_s.toFixed(2) : null;
  } else if (activity === "run" || activity === "walk") {
    // Which foot the stride belongs to. Without it a gait recording cannot be
    // split left from right, which is most of what the assessment reads.
    o.stance_side = r.stance_side ?? null;
    o.stride_s = r.stride_s ?? null;
    o.contact_s = r.contact_s ?? null;
    o.swing_s = r.swing_s ?? null;
    o.flight_s = r.flight_s ?? null;
    o.duty_factor = r.duty_factor ?? null;
    o.cadence_spm = r.cadence_spm ?? null;
    o.stride_length_m = r.stride_length_m ?? null;
    o.knee_flex_max_deg = r.knee_flex_max_deg;
    o.hip_flex_max_deg = r.hip_flex_max_deg ?? null;
    o.ankle_dorsi_max_deg = r.ankle_dorsi_max_deg ?? null;
    o.knee_asymmetry_deg = r.knee_asymmetry_deg ?? null;
  } else if (activity === "sidestep") {
    o.excursion_m = r.excursion_m ?? null;
    o.plant_side = r.plant_side ?? null;
    o.knee_flex_at_plant_deg = r.knee_flex_at_plant_deg ?? null;
    o.trunk_lean_at_plant_deg = r.trunk_lean_at_plant_deg ?? null;
    o.out_s = r.out_s ?? null;
    o.back_s = r.back_s ?? null;
  } else if (activity === "neck") {
    o.flex_ext_deg = r.flexion_extension_range_deg;
    o.bend_deg = r.lateral_bend_range_deg;
    o.rotation_deg = r.rotation_range_deg;
  }
  return o;
}

// --- summary ---------------------------------------------------------------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Whole-session summary, plus first-to-last trends.
 *
 *  Trends are reported as a plain change from the first set to the last, not a
 *  fitted slope: with three or four sets a regression implies a precision that
 *  is not there. */
export function summariseSession(session) {
  if (!session || !session.sets.length) return null;
  const sets = session.sets;
  const totalReps = sets.reduce((s, x) => s + x.reps, 0);
  const allReps = sets.flatMap((s) => s.perRep);
  const activity = sets[0].activity;

  const pick = (k) => sets.map((s) => mean(s.perRep.map((r) => r[k]).filter((v) => v != null)))
                          .filter((v) => v != null);
  const trend = (k, label, unit, lowerIsWorse) => {
    const v = pick(k);
    if (v.length < 2) return null;
    const change = v[v.length - 1] - v[0];
    const pct = v[0] ? (100 * change) / Math.abs(v[0]) : 0;
    return { key: k, label, unit, first: +v[0].toFixed(2), last: +v[v.length - 1].toFixed(2),
             change: +change.toFixed(2), pct: +pct.toFixed(1), lowerIsWorse: !!lowerIsWorse };
  };

  const trends = [];
  if (activity === "squat") {
    trends.push(trend("depth_m", "Depth", "m", true),
                trend("knee_flex_max_deg", "Peak knee flexion", "°", true),
                trend("up_s", "Concentric time", "s", false),
                trend("peak_knee_Nm", "Peak knee moment", "N·m", false));
  } else if (activity === "pushup" || activity === "dip") {
    trends.push(trend("depth_m", "Depth", "m", true),
                trend("elbow_flex_max_deg", "Peak elbow flexion", "°", true),
                trend("up_s", "Concentric time", "s", false));
  } else if (activity === "pullup") {
    trends.push(trend("travel_m", "Body travel", "m", true),
                trend("elbow_flex_max_deg", "Peak elbow flexion", "°", true),
                trend("up_s", "Concentric time", "s", false));
  } else if (activity === "cmj" || activity === "sj") {
    // Height falling and contact time lengthening across a session is the
    // usual signature of fatigue in a jump, the same way depth is in a squat.
    trends.push(trend("height_flight_m", "Jump height (flight time)", "m", true),
                trend("height_com_m", "Jump height (hip rise)", "m", true),
                trend("push_s", "Push time", "s", false),
                trend("countermovement_m", "Countermovement depth", "m", false));
  } else if (activity === "slsquat") {
    // Depth falling and the left-right difference widening are the two things
    // worth watching across a set of single-leg squats.
    trends.push(trend("stance_knee_flex_max_deg", "Stance knee flexion", "°", true),
                trend("depth_m", "Depth", "m", true),
                trend("knee_asymmetry_deg", "Left\u2013right knee difference", "°", false),
                trend("down_s", "Eccentric time", "s", false));
  } else if (activity === "run" || activity === "walk") {
    // Contact time lengthening and cadence dropping is what fatigue looks like
    // in a run, the same way depth falling is in a squat.
    trends.push(trend("cadence_spm", "Cadence", "steps/min", true),
                trend("contact_s", "Ground contact time", "s", false),
                trend("flight_s", "Flight time", "s", true),
                trend("duty_factor", "Duty factor", "", false));
  } else if (activity === "kickback") {
    // Range shrinking and the trunk starting to help are what fatigue looks
    // like in a kick back.
    trends.push(trend("hip_range_deg", "Hip range", "°", true),
                trend("hip_ext_max_deg", "Peak hip extension", "°", true),
                trend("trunk_motion_deg", "Trunk movement", "°", false),
                trend("kick_s", "Kick time", "s", false));
  } else if (activity === "sidestep") {
    trends.push(trend("excursion_m", "Lateral excursion", "m", true),
                trend("out_s", "Time out", "s", false),
                trend("knee_flex_at_plant_deg", "Knee flexion at plant", "°", true));
  } else if (activity === "neck") {
    trends.push(trend("rotation_deg", "Rotation range", "°", true),
                trend("flex_ext_deg", "Flexion/extension range", "°", true));
  }

  return {
    started: session.started,
    profile: session.profile,
    activity,
    sets: sets.length,
    total_reps: totalReps,
    reps_per_set: sets.map((s) => s.reps),
    mean_rep_duration_s: +(mean(allReps.map((r) => r.duration_s)) || 0).toFixed(2),
    trends: trends.filter(Boolean),
  };
}
