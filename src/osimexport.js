/**
 * osimexport.js -- a BioScout Web set written out the way the Python bioscout
 * pipeline lays out a lab session, so a phone trial and a Vicon trial of the
 * same movement sit side by side in the same folders, file for file:
 *
 *   <Athlete>/<YY_MM_DD>/
 *     session.yaml
 *     2_experimental/<Trial>/            video, pose landmarks (marker_experimental.trc)
 *     3_iterations/bioscout_web/<Trial>/
 *       external_biomechanics/  joint_angles.mot, inverse_dynamics.sto
 *       static_optimisation/    StaticOptimization_force.sto, StaticOptimization_activation.sto
 *       joint_contact_forces/   output_so.sto
 *     4_outputs/                summary figures, every chart, training session
 *
 * Every .mot/.sto is a plain OpenSim storage file (header, endheader, tab-
 * separated columns, OpenSim's own column names) that the OpenSim GUI plots
 * directly. What sits behind the numbers is NOT OpenSim: the angles are the
 * camera's, and the forces, activations, moments and joint loads come from the
 * static-optimisation surrogate (forces.js). Each file's header says so.
 *
 * Pure: data in, [{ name, data }] out. tests/test_osimexport.mjs checks it.
 */

export const ITERATION = "bioscout_web";

/** An OpenSim storage file. `rows[i]` is one frame's values for `columns`. */
export function writeSto(title, columns, times, rows, { inDegrees = false, note = "" } = {}) {
  const lines = [title, "version=1", `nRows=${times.length}`, `nColumns=${columns.length + 1}`,
                 `inDegrees=${inDegrees ? "yes" : "no"}`];
  if (note) lines.push("", ...String(note).split("\n").map((l) => l.replace(/endheader/gi, "end header")), "");
  lines.push("endheader", ["time", ...columns].join("\t"));
  for (let i = 0; i < times.length; i++) {
    const r = rows[i] || [];
    lines.push([times[i], ...columns.map((_, j) => r[j])]
      .map((v) => (Number.isFinite(+v) ? (+v).toFixed(8) : "0.00000000").padStart(16)).join("\t"));
  }
  return lines.join("\n") + "\n";
}

/** Column-major {name: [..]} to row-major for writeSto. */
const rowsOf = (cols, get, n) => Array.from({ length: n }, (_, i) => cols.map((c) => get(c, i)));

/** "Squat_03" from the activity and the set number. */
export function trialName(activity, setIndex) {
  const a = String(activity || "trial").replace(/[^A-Za-z0-9]+/g, "_");
  return `${a.charAt(0).toUpperCase()}${a.slice(1)}_${String(setIndex || 1).padStart(2, "0")}`;
}

/** Session folder name the Python pipeline uses: YY_MM_DD. */
export function sessionName(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}_${p(d.getMonth() + 1)}_${p(d.getDate())}`;
}

const safe = (s) => String(s || "athlete").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "athlete";

/** Pose landmarks as a TRC (metres, OpenSim's frame: y up), so the camera's
 *  "markers" can be laid over the Vicon markers in the OpenSim GUI. */
export function writeTrc(name, frames, { pxPerM, fps, floorY = null }) {
  const names = [...new Set(frames.flatMap((f) => Object.keys(f.lm || {})))];
  if (!names.length || !(pxPerM > 0)) return null;
  const fy = floorY ?? Math.max(...frames.flatMap((f) => Object.values(f.lm).map((p) => p[1])));
  const t0 = frames[0].t;
  const head = [
    `PathFileType\t4\t(X/Y/Z)\t${name}`,
    "DataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\tOrigDataRate\tOrigDataStartFrame\tOrigNumFrames",
    `${fps.toFixed(2)}\t${fps.toFixed(2)}\t${frames.length}\t${names.length}\tm\t${fps.toFixed(2)}\t1\t${frames.length}`,
    ["Frame#", "Time", ...names.flatMap((n) => [n, "", ""])].join("\t"),
    ["", "", ...names.flatMap((_, i) => [`X${i + 1}`, `Y${i + 1}`, `Z${i + 1}`])].join("\t"),
    "",
  ];
  const body = frames.map((f, k) => [k + 1, ((f.t - t0) / 1000).toFixed(5), ...names.flatMap((n) => {
    const p = f.lm[n];
    if (!p) return ["", "", ""];
    // Image x -> OpenSim x (forward in a side view), image y down -> y up,
    // the pose model's relative depth -> z. Depth is a guess; say so in README.
    return [(p[0] / pxPerM).toFixed(5), ((fy - p[1]) / pxPerM).toFixed(5),
            (Number.isFinite(p[2]) ? p[2] / pxPerM : 0).toFixed(5)];
  })].join("\t"));
  return head.join("\n") + "\n" + body.join("\n") + "\n";
}

const SURROGATE_NOTE = "BioScout Web: predicted by a static-optimisation surrogate from phone-video\n"
  + "kinematics (Rajagopal muscle names). An estimate, not an OpenSim solve.";

/** One trial's model-dependent files: angles, moments, SO forces/activations, JRF. */
export function trialFiles(base, r, { columns, osimModel = "gpk", massKg = null }) {
  const out = [], n = r.times.length;
  const eb = `${base}/external_biomechanics/`, so = `${base}/static_optimisation/`;
  out.push({ name: eb + "joint_angles.mot", data: writeSto("Coordinates", columns, r.times,
    rowsOf(columns, (c, i) => (r.coords[c] ? r.coords[c][i] : 0), n),
    { inDegrees: true, note: `BioScout Web: joint angles from phone video, signed for ${osimModel}.\n`
      + "pelvis_ty is an absolute height above the floor." }) });
  const o = r.osimOut || {};
  if (o.moments) {
    out.push({ name: eb + "inverse_dynamics.sto", data: writeSto("Inverse Dynamics Generalized Forces",
      o.momentNames, r.times, o.moments.map((row) => Array.from(row)),
      { note: SURROGATE_NOTE + "\nNet joint moments in N.m." }) });
  }
  if (r.dyn) {
    const dc = ["hip_moment", "knee_moment", "ankle_moment", "grf_vertical", "grf_horizontal"]
      .filter((k) => Array.isArray(r.dyn[k]) && r.dyn[k].length === n);
    if (dc.length) {
      out.push({ name: eb + "inverse_dynamics_2d.sto", data: writeSto("Inverse Dynamics (sagittal, 2D)", dc, r.times,
        rowsOf(dc, (c, i) => r.dyn[c][i], n),
        { note: "BioScout Web: planar inverse dynamics from video and body mass.\n"
          + `Moments in N.m, extension positive; ground reaction in N${massKg ? ` (body mass ${massKg} kg)` : ""}.` }) });
    }
  }
  if (r.forces && r.forceNames) {
    const cols = [...r.forceNames];
    const rows = r.forces.map((row) => Array.from(row));
    if (o.grf) { cols.push(...o.grfNames); o.grf.forEach((g, i) => rows[i].push(...g)); }
    out.push({ name: so + "StaticOptimization_force.sto", data: writeSto("Static Optimization", cols, r.times, rows,
      { note: SURROGATE_NOTE + "\nMuscle forces in N" + (o.grf ? "; grf_* is the predicted ground reaction in N." : ".") }) });
  }
  if (o.activations) {
    out.push({ name: so + "StaticOptimization_activation.sto", data: writeSto("Static Optimization",
      o.activationNames, r.times, o.activations.map((row) => Array.from(row)),
      { note: SURROGATE_NOTE + "\nActivations, 0 to 1." }) });
  }
  if (o.jrfComp || r.jrf) {
    const cols = [], rows = Array.from({ length: n }, () => []);
    if (o.jrfComp) { cols.push(...o.jrfCompNames); o.jrfComp.forEach((v, i) => rows[i].push(...v)); }
    if (r.jrf && r.jrfNames && massKg) {
      const bw = massKg * 9.80665;
      cols.push(...r.jrfNames.map((k) => k.replace(/_mag$/, "_resultant")));
      r.jrf.forEach((v, i) => rows[i].push(...Array.from(v, (x) => x * bw)));
    }
    out.push({ name: `${base}/joint_contact_forces/output_so.sto`, data: writeSto("Joint Reaction Loads", cols, r.times, rows,
      { note: SURROGATE_NOTE + "\nJoint reaction forces in N, in the child body's frame (femur, tibia, talus)." }) });
  }
  return out;
}

/** session.yaml in the shape bioscout's Session reads. */
export function sessionYaml({ athlete, session, massKg, trials, osimModel, generated }) {
  const y = [
    `# Written by BioScout Web ${generated}. Phone-video trials, laid out like a lab session`,
    `# so they can be compared with the same movement measured in the lab.`,
    `subject: ${athlete}`, `session: '${session}'`,
    `body_mass: ${massKg ?? "null"}`, "static_trial: null", "trials:"];
  for (const t of trials) {
    y.push(`  ${t.name}:`, "    calibration: false", "    emg_normalisation: false",
           `    type: ${t.activity}`, "    side: both", "    source: bioscout_web");
    if (t.timeRange) y.push(`    time_range: [${t.timeRange[0].toFixed(3)}, ${t.timeRange[1].toFixed(3)}]`);
  }
  y.push("iterations:", `  ${ITERATION}:`, `    label: BioScout Web (phone video, ${osimModel} angles)`,
         "    color: teal", "    group: video");
  return y.join("\n") + "\n";
}

/**
 * The whole export. `set`: { res, fps, setIndex, frames, video: {name, data} | null }.
 * Returns { root, files } with every path under root.
 */
export function buildSessionFiles({ athlete, date, massKg, set, extra = [] }) {
  const root = `${safe(athlete)}/${sessionName(date)}`;
  const { res, fps } = set;
  const trial = trialName(res.activity, set.setIndex);
  const iter = `${root}/3_iterations/${ITERATION}`;
  const files = [];
  const trials = [];
  const items = [...res.reps.map((r, k) => ({ r, name: res.reps.length > 1 ? `${trial}_rep${String(r.rep ?? k + 1).padStart(2, "0")}` : trial }))];
  if (res.whole && res.whole.times) items.unshift({ r: res.whole, name: trial });
  for (const { r, name } of items) {
    if (!r.times || !r.times.length) continue;
    files.push(...trialFiles(`${iter}/${name}`, r, { columns: res.columns, osimModel: res.osimModel, massKg }));
    trials.push({ name, activity: res.activity, timeRange: [r.times[0], r.times[r.times.length - 1]] });
  }
  const exp = `${root}/2_experimental/${trial}`;
  if (set.frames && set.frames.length) {
    const trc = writeTrc("marker_experimental.trc", set.frames, { pxPerM: res.pxPerM, fps });
    if (trc) files.push({ name: `${exp}/marker_experimental.trc`, data: trc });
  }
  if (set.video) files.push({ name: `${exp}/${set.video.name}`, data: set.video.data });
  files.push({ name: `${root}/session.yaml`, data: sessionYaml({ athlete: safe(athlete), session: sessionName(date),
    massKg, trials, osimModel: res.osimModel, generated: new Date().toISOString().slice(0, 10) }) });
  for (const f of extra) files.push({ name: `${root}/4_outputs/${f.name}`, data: f.data });
  return { root, files, trial };
}
