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
