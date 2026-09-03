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
const PKEY = "bioscout.profiles.v1";
const SKEY = "bioscout.session.v1";
const AKEY = "bioscout.archive.v1";
const CKEY = "bioscout.curves.v1";

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
  const report = { profilesAdded: 0, profilesUpdated: 0, sessionsAdded: 0, sessionAdopted: false };

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
