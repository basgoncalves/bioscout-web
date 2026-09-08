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

const PKEY = "bioscout.profiles.v1";
const SKEY = "bioscout.session.v1";
const AKEY = "bioscout.archive.v1";
const CKEY = "bioscout.curves.v1";
const MKEY = "bioscout.meals.v1";
const DKEY = "bioscout.diary.v1";
const WKEY = "bioscout.weights.v1";
const CYKEY = "bioscout.cycle.v1";
const SLKEY = "bioscout.sleep.v1";

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

// --- profiles --------------------------------------------------------------
export function listProfiles() {
  const p = read(PKEY, { profiles: [], lastUsed: null });
  return Array.isArray(p.profiles) ? p : { profiles: [], lastUsed: null };
}

export function saveProfile(profile) {
  const store = listProfiles();
  const i = store.profiles.findIndex((x) => x.name === profile.name);
  if (i >= 0) store.profiles[i] = profile; else store.profiles.push(profile);
  store.lastUsed = profile.name;
  return write(PKEY, store);
}

export function deleteProfile(name) {
  const store = listProfiles();
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
export function newSession(profileName) {
  const s = { started: new Date().toISOString(), profile: profileName || null, sets: [] };
  write(SKEY, s);
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
  clearSession();
  if (!s || !s.sets || !s.sets.length) return listArchive().length;
  const a = listArchive();
  // `started` is the identity: importing the same file twice must not double
  // the history, and two sessions cannot begin at the same millisecond.
  if (!a.some((x) => x.started === s.started)) a.push(s);
  a.sort((x, y) => String(x.started).localeCompare(String(y.started)));
  const trimmed = a.slice(-ARCHIVE_MAX);
  write(AKEY, trimmed);
  return trimmed.length;
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
  };
  if (!entry.text.trim() && !parts.length) return null;
  const all = listMeals();
  // Two meals in the same millisecond is a double tap, not two meals.
  if (all.some((m) => m.at === entry.at && m.profile === entry.profile)) return null;
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(MKEY, all.slice(-MEALS_MAX));
  return entry;
}

export function deleteMeal(at, profile = null) {
  const kept = listMeals().filter((m) => !(m.at === at && m.profile === profile));
  write(MKEY, kept);
  return kept.length;
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
                           note = "", at = null }) {
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
  };
  // An entry with no mood, no tags and no note is a mis-tap.
  if (entry.mood === null && !entry.tags.length && !entry.note.trim()) return null;
  const all = listDiary().filter((x) => !(x.at === entry.at && x.profile === entry.profile));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(DKEY, all.slice(-DIARY_MAX));
  return entry;
}

export function deleteDiary(at, profile = null) {
  const kept = listDiary().filter((d) => !(d.at === at && d.profile === profile));
  write(DKEY, kept);
  return kept.length;
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
  const entry = { at: at || new Date().toISOString(), profile, kg: Math.round(v * 10) / 10 };
  const all = listWeights().filter((x) => !(x.at === entry.at && x.profile === entry.profile));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(WKEY, all.slice(-WEIGHTS_MAX));
  return entry;
}

export function deleteWeight(at, profile = null) {
  const kept = listWeights().filter((w) => !(w.at === at && w.profile === profile));
  write(WKEY, kept);
  return kept.length;
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
  };
  const day = String(at).slice(0, 10);
  const all = listCycle().filter(
    (x) => !(x.profile === entry.profile && String(x.at).slice(0, 10) === day));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(CYKEY, all.slice(-CYCLE_MAX));
  return entry;
}

export function clearCycleDay(at, profile = null) {
  const day = String(at).slice(0, 10);
  const kept = listCycle().filter(
    (x) => !(x.profile === profile && String(x.at).slice(0, 10) === day));
  write(CYKEY, kept);
  return kept.length;
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
  const entry = { at, profile, bed: String(bed).slice(0, 5), wake: String(wake).slice(0, 5) };
  if (!entry.bed || !entry.wake) return null;
  const day = String(at).slice(0, 10);
  const all = listSleep().filter(
    (x) => !(x.profile === entry.profile && String(x.at).slice(0, 10) === day));
  all.push(entry);
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(SLKEY, all.slice(-SLEEP_MAX));
  return entry;
}

export function clearSleep(at, profile = null) {
  const day = String(at).slice(0, 10);
  const kept = listSleep().filter(
    (x) => !(x.profile === profile && String(x.at).slice(0, 10) === day));
  write(SLKEY, kept);
  return kept.length;
}

// --- stored waveforms ------------------------------------------------------
const r3 = (a) => Array.from(a, (v) => (Number.isFinite(v) ? +v.toFixed(3) : 0));
const r2 = (a) => Array.from(a, (v) => (Number.isFinite(v) ? +v.toFixed(2) : 0));

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
    reps: result.reps.map((rp) => {
      const o = { rep: rp.rep, bounds: rp.bounds, times: r3(rp.times), coords: {} };
      for (const [k, v] of Object.entries(rp.coords || {})) o.coords[k] = r3(v);
      if (rp.dyn) {
        o.dyn = {};
        for (const [k, v] of Object.entries(rp.dyn)) {
          o.dyn[k] = Array.isArray(v) || ArrayBuffer.isView(v) ? r2(v) : v;
        }
      }
      for (const [k, v] of Object.entries(rp)) {
        if (typeof v === "number" || typeof v === "boolean") o[k] = v;
      }
      return o;
    }),
  };
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

// --- export and import -----------------------------------------------------
/* No server, so no automatic sync. What there is instead: one file carrying
 * everything this device knows, which the athlete moves themselves. That is a
 * real limitation and the app says so rather than implying otherwise. */
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
                   weightsAdded: 0, cycleAdded: 0, sleepAdded: 0 };

  const store = listProfiles();
  for (const p of (data.profiles && data.profiles.profiles) || []) {
    if (!p || !p.name) continue;
    const i = store.profiles.findIndex((x) => x.name === p.name);
    if (i < 0) { store.profiles.push(p); report.profilesAdded++; continue; }
    const merged = { ...store.profiles[i], ...p };
    // Only count a change that IS one: re-importing the same file should
    // report "nothing new", not invent an update.
    if (JSON.stringify(merged) !== JSON.stringify(store.profiles[i])) {
      store.profiles[i] = merged; report.profilesUpdated++;
    }
  }
  if (data.profiles && data.profiles.lastUsed) store.lastUsed = data.profiles.lastUsed;
  write(PKEY, store);

  const a = listArchive();
  const seen = new Set(a.map((x) => x.started));
  for (const s of data.archive || []) {
    if (!s || !s.started || seen.has(s.started)) continue;
    a.push(s); seen.add(s.started); report.sessionsAdded++;
  }
  // The open session on the other device is history here unless this device
  // has nothing open -- in which case adopt it, so a phone handed over
  // mid-workout carries on rather than starting again.
  const incoming = data.session;
  const open = getSession();
  const alreadyHere = incoming &&
    (seen.has(incoming.started) || (open && open.started === incoming.started));
  if (incoming && incoming.sets && incoming.sets.length && !alreadyHere) {
    if (!open) { write(SKEY, incoming); report.sessionAdopted = true; }
    else { a.push(incoming); report.sessionsAdded++; }
  }
  a.sort((x, y) => String(x.started).localeCompare(String(y.started)));
  write(AKEY, a.slice(-ARCHIVE_MAX));

  // Meals merge on (at, profile), so re-importing the same file adds nothing.
  const meals = listMeals();
  const have = new Set(meals.map((m) => `${m.profile}|${m.at}`));
  for (const m of data.meals || []) {
    if (!m || !m.at || have.has(`${m.profile}|${m.at}`)) continue;
    meals.push(m); have.add(`${m.profile}|${m.at}`); report.mealsAdded++;
  }
  meals.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  write(MKEY, meals.slice(-MEALS_MAX));

  const diary = listDiary();
  const seenD = new Set(diary.map((d) => `${d.profile}|${d.at}`));
  for (const d of data.diary || []) {
    if (!d || !d.at || seenD.has(`${d.profile}|${d.at}`)) continue;
    diary.push(d); seenD.add(`${d.profile}|${d.at}`); report.diaryAdded++;
  }
  diary.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  write(DKEY, diary.slice(-DIARY_MAX));

  const wts = listWeights();
  const seenW = new Set(wts.map((w) => `${w.profile}|${w.at}`));
  for (const w of data.weights || []) {
    if (!w || !w.at || seenW.has(`${w.profile}|${w.at}`)) continue;
    wts.push(w); seenW.add(`${w.profile}|${w.at}`); report.weightsAdded++;
  }
  wts.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  write(WKEY, wts.slice(-WEIGHTS_MAX));

  const cyc = listCycle();
  const seenC = new Set(cyc.map((c) => `${c.profile}|${String(c.at).slice(0, 10)}`));
  for (const c of data.cycle || []) {
    if (!c || !c.at || seenC.has(`${c.profile}|${String(c.at).slice(0, 10)}`)) continue;
    cyc.push(c); seenC.add(`${c.profile}|${String(c.at).slice(0, 10)}`); report.cycleAdded++;
  }
  cyc.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  write(CYKEY, cyc.slice(-CYCLE_MAX));

  const slp = listSleep();
  const seenS = new Set(slp.map((x) => `${x.profile}|${String(x.at).slice(0, 10)}`));
  for (const x of data.sleep || []) {
    if (!x || !x.at || seenS.has(`${x.profile}|${String(x.at).slice(0, 10)}`)) continue;
    slp.push(x); seenS.add(`${x.profile}|${String(x.at).slice(0, 10)}`); report.sleepAdded++;
  }
  slp.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  write(SLKEY, slp.slice(-SLEEP_MAX));

  // Photos are not in the export. They live in IndexedDB and would multiply
  // the file size by an order of magnitude in base64 -- an export you cannot
  // send yourself is not a backup. Meals still carry their `photo` flag, so
  // an imported meal knows a picture existed on the other device.
  return report;
}

/** Append one recording as the next set. Returns the stored (summary) set. */
export function addSet(result, fps, extra = {}) {
  const s = getSession() || newSession(extra.profile);
  const set = {
    index: s.sets.length + 1,
    at: new Date().toISOString(),
    activity: result.activity,
    fps: +fps.toFixed(1),
    reps: result.reps.length,
    massKg: result.massKg, addedKg: result.addedKg, assistKg: result.assistKg,
    ageY: result.ageY ?? null,
    view: result.view?.view ?? null,
    detected: result.detection ? result.detection.activity : null,
    perRep: result.reps.map((r) => summariseRep(r, result.activity)),
  };
  s.sets.push(set);
  write(SKEY, s);
  return set;
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
  } else if (activity === "run") {
    o.stride_s = r.stride_s ?? null;
    o.contact_s = r.contact_s ?? null;
    o.swing_s = r.swing_s ?? null;
    o.flight_s = r.flight_s ?? null;
    o.duty_factor = r.duty_factor ?? null;
    o.cadence_spm = r.cadence_spm ?? null;
    o.knee_flex_max_deg = r.knee_flex_max_deg;
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
  } else if (activity === "run") {
    // Contact time lengthening and cadence dropping is what fatigue looks like
    // in a run, the same way depth falling is in a squat.
    trends.push(trend("cadence_spm", "Cadence", "steps/min", true),
                trend("contact_s", "Ground contact time", "s", false),
                trend("flight_s", "Flight time", "s", true),
                trend("duty_factor", "Duty factor", "", false));
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
