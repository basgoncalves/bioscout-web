/**
 * labtrial.js -- a recording from the Record screen written as ONE bioscout
 * trial, in the layout the Python bioscout and Batch mode read:
 *
 *   2_experimental/<trial>/marker_experimental.trc    the camera's landmarks as markers (m, y up)
 *   2_experimental/<trial>/grf.mot                     the ESTIMATED ground reaction (from body-mass x COM acceleration)
 *   2_experimental/<trial>/video.<ext>                 when the video was kept
 *   3_iterations/bioscout_web/<trial>/external_biomechanics/joint_angles.mot, inverse_dynamics_2d.sto
 *
 * Nothing is kept in the browser: the trial is a .zip the user downloads, or,
 * when a session folder is open in Simulate's Batch mode, it is written
 * straight into that session (and listed in its session.yaml).
 */
import { writeTrc, writeSto, trialFiles, ITERATION } from "./osimexport.js";
import { makeZip } from "./zip.js";
import { S as session, writeTrial } from "./simsession.js";

export const trialFolderName = (activity, n) => `${String(activity || "trial").toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${String(n || 1).padStart(2, "0")}`;

/** Next free <activity>_NN in the open session, or the set index. */
export function nextTrialName(activity, setIndex) {
  if (!session.root || !session.session) return trialFolderName(activity, setIndex || 1);
  const re = new RegExp(`^${String(activity || "trial").toLowerCase()}_(\\d+)$`);
  const used = session.trials.map((t) => (t.match(re) || [])[1]).filter(Boolean).map(Number);
  return trialFolderName(activity, used.length ? Math.max(...used) + 1 : 1);
}

/** grf.mot (OpenSim columns, one "plate") from the planar inverse dynamics of the whole take. */
function grfMot(res, frames, fps) {
  const r = res.whole && res.whole.times ? res.whole : res.reps[0];
  const d = r && r.dyn;
  if (!d || !Array.isArray(d.grf_vertical) || d.grf_vertical.length !== r.times.length) return null;
  const t0 = frames[0].t, pxPerM = res.pxPerM || 1;
  const floorY = Math.max(...frames.flatMap((f) => Object.values(f.lm || {}).map((p) => p[1])));
  const cols = ["ground_force_1_vx", "ground_force_1_vy", "ground_force_1_vz", "ground_force_1_px", "ground_force_1_py", "ground_force_1_pz", "ground_moment_1_mx", "ground_moment_1_my", "ground_moment_1_mz"];
  const rows = r.times.map((t, i) => {
    // centre of pressure: between the ankles at that moment (the midfoot the ID assumed)
    const k = Math.min(frames.length - 1, Math.max(0, Math.round(t * fps)));
    const lm = frames[k].lm || {}, a = lm.left_ankle, b = lm.right_ankle, p = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a || b;
    const px = p ? p[0] / pxPerM : 0, pz = p && Number.isFinite(p[2]) ? p[2] / pxPerM : 0;
    void floorY;
    return [d.grf_horizontal ? d.grf_horizontal[i] : 0, d.grf_vertical[i], 0, px, 0, pz, 0, 0, 0];
  });
  return writeSto("grf", cols, r.times, rows, { note: "BioScout Web: ESTIMATED ground reaction from body mass x centre-of-mass acceleration (one camera, no force plate).\n"
    + "One virtual plate; centre of pressure at the midfoot; moments unknown (0). Not a measurement." });
}

/** -> [{ name, data }] relative to the session folder. */
export function buildLabTrial({ res, frames, fps, trial, video = null, massKg = null }) {
  const files = [], exp = `2_experimental/${trial}/`;
  if (frames && frames.length) {
    const trc = writeTrc("marker_experimental.trc", frames, { pxPerM: res.pxPerM, fps });
    if (trc) files.push({ name: exp + "marker_experimental.trc", data: trc });
    const grf = grfMot(res, frames, fps);
    if (grf) files.push({ name: exp + "grf.mot", data: grf });
  }
  if (video) files.push({ name: exp + video.name, data: video.data });
  const r = res.whole && res.whole.times ? res.whole : res.reps[0];
  if (r && r.times && r.times.length) {
    const all = trialFiles(`3_iterations/${ITERATION}/${trial}`, r, { columns: res.columns, osimModel: res.osimModel, massKg });
    files.push(...all.filter((f) => f.name.includes("/external_biomechanics/")));   // angles + planar ID; the muscle surrogate stays out of a trial
  }
  files.push({ name: exp + "README.txt", data: `${trial}: recorded with BioScout Web (${res.activity}, ${fps.toFixed(1)} fps, camera view ${res.view?.view ?? "?"}).\n`
    + "marker_experimental.trc: pose landmarks in metres (OpenSim frame, y up; depth is the pose model's guess).\n"
    + "grf.mot: ESTIMATED ground reaction, not measured.\n"
    + `3_iterations/${ITERATION}/${trial}/external_biomechanics: joint angles from the video and a planar inverse dynamics.\n` });
  return files;
}

export function trialZip(files) { return makeZip(files); }

/** Into the open session folder (Batch mode); -> the trial name. */
export async function saveTrialToSession(files, trial) {
  if (!session.root || !session.session) throw new Error("no session open in Batch mode");
  await writeTrial(trial, files);
  return `${session.name}/${session.ses}/2_experimental/${trial}`;
}
