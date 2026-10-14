/**
 * simsession.js -- Batch mode of Simulate: the per-step page working inside a
 * bioscout PROJECT folder, in the layout the Python bioscout reads
 * (bioscout/session/config.py, e.g. Charite_Data/tests/_data):
 *
 *   <project>/models/generic/<family>/<model>.osim           models_dir
 *   <project>/models/personalised/<subject>/<session>/<iteration>_scaled.osim
 *   <project>/setupFiles/markers_*.xml, setup_scale.xml ...   setup_dir
 *   <project>/simulations/<subject>/<session>/session.yaml
 *       1_c3dfiles/*.c3d · 2_experimental/<trial>/ · 3_iterations/<iteration>/<trial>/external_biomechanics/
 *
 * session.yaml: `models_dir` / `setup_dir` (relative to project_dir) root the
 * iteration file keys (`./generic/...`, `./personalised/<subject>/<session>/...`,
 * `./markers.xml`); without them a key is relative to the iteration folder.
 * Only the keys this page needs are read; the rest of the file is left as it
 * is (blocks are added as text, never by rewriting the file).
 */
import { c3dToOpenSim } from "./c3dexport.js";

let T = (k) => k;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const S = {           // the one open project + session
  root: null, name: "", simDir: "simulations", subjects: [], subject: "", sessions: [], session: "", ses: "",   // ses = simDir/subject/session
  yaml: "", cfg: null, trials: [], iterations: [], iteration: "", trial: "",
  c3dDir: "1_c3dfiles", c3ds: [], msg: "", busy: false, runLog: [], newIt: null, weight: null,
  skip: new Set(["rra", "ceinms_cal", "ceinms"]),   // the steps' skip ticks, as in Quick run
  exportSkip: false,                                 // step 0: 1_c3dfiles -> 2_experimental (only trials not exported yet)
  pick: null,                                        // ticked trials (Set); null = every non-static trial
};
const sp = (rel) => `${S.ses}/${rel}`;                       // session-relative -> project-relative
const hasRoot = (key) => (["model_generic", "model_scaled"].includes(key) ? S.cfg.top.models_dir : S.cfg.top.setup_dir) || "";
/** An iteration file key -> project-relative path (models_dir / setup_dir when set, else the iteration folder). */
export function itPath(it, key, val) {
  if (!val) return null;
  const v = String(val).replace(/<subject>/g, S.subject).replace(/<session>/g, S.session).replace(/<iteration>/g, it);
  if (/^[a-zA-Z]:|^\//.test(v)) return null;                 // absolute: not reachable from the folder handle
  const root = hasRoot(key);
  if (root) return `${root}/${v.replace(/^\.\//, "")}`;
  return sp(`3_iterations/${it}/${v}`);
}

// ------------------------------------------------------------------ folder helpers
async function dirAt(root, path, create = false) {
  let d = root;
  for (const p of path.split("/").filter((x) => x && x !== ".")) d = await d.getDirectoryHandle(p, { create });
  return d;
}
async function listDirs(root, path) {
  try { const d = await dirAt(root, path); const out = []; for await (const [n, h] of d.entries()) if (h.kind === "directory" && !n.startsWith(".")) out.push(n); return out.sort(); }
  catch { return []; }
}
async function listFiles(root, path, re) {
  try { const d = await dirAt(root, path); const out = []; for await (const [n, h] of d.entries()) if (h.kind === "file" && re.test(n)) out.push(n); return out.sort(); }
  catch { return []; }
}
const C3D_DIRS = ["1_c3dfiles", "c3dfiles"];
async function c3dDir(root) { for (const d of C3D_DIRS) { try { await dirAt(root, d); return d; } catch { /* next */ } } return C3D_DIRS[0]; }
async function readFile(root, path) {
  try { const parts = path.split("/"); const d = await dirAt(root, parts.slice(0, -1).join("/")); return await (await d.getFileHandle(parts[parts.length - 1])).getFile(); }
  catch { return null; }
}
async function writeFile(root, path, data) {
  const parts = path.split("/"); const d = await dirAt(root, parts.slice(0, -1).join("/"), true);
  const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable(); await w.write(data); await w.close();
}

// ------------------------------------------------------------------ session.yaml (the subset this page needs)
export function parseYaml(text) {
  const cfg = { top: {}, trials: {}, iterations: {} };
  let section = null, item = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const ind = line.search(/\S/), m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim(), val = m[2].replace(/^['"]|['"]$/g, "");
    if (ind === 0) { section = key === "trials" || key === "iterations" ? key : null; item = null; if (!section && val !== "") cfg.top[key] = val; }
    else if (ind === 2 && section) { item = key; cfg[section][key] = cfg[section][key] || {}; }
    else if (ind === 4 && section && item && val !== "") cfg[section][item][key] = val;
  }
  return cfg;
}
/** As bioscout.session.config.scaffold_session_yaml: trials from the c3d names, no guessed
 *  trial type, body_mass only when known, project_dir relative (<project>/simulations/<subject>/<session>). */
export function scaffoldYaml({ subject, session, bodyMass, staticTrial, trials, modelsDir = "", setupDir = "" }) {
  const lines = [`subject: ${subject || "subject"}`, `session: '${session}'`, `project_dir: ../../..`];
  if (modelsDir) lines.push(`models_dir: ${modelsDir}`);
  if (setupDir) lines.push(`setup_dir: ${setupDir}`);
  if (bodyMass) lines.push(`body_mass: ${bodyMass}`);
  if (staticTrial) lines.push(`static_trial: ${staticTrial}`);
  lines.push(`trials:`);
  for (const t of trials) lines.push(`  ${t}: {}`);
  lines.push(`iterations: {}`);
  return lines.join("\n") + "\n";
}
/** Set one top-level scalar in the yaml text (replace the line, or insert it after `session:`). */
export function setTopKey(text, key, value) {
  const L = text.split(/\r?\n/), re = new RegExp(`^${key}:`);
  const i = L.findIndex((l) => re.test(l));
  const line = `${key}: ${value}`;
  if (i >= 0) L[i] = line;
  else { let j = L.findIndex((l) => /^project_dir:/.test(l)); if (j < 0) j = L.findIndex((l) => /^session:/.test(l)); if (j < 0) j = L.findIndex((l) => /^subject:/.test(l)); L.splice(j >= 0 ? j + 1 : 0, 0, line); }
  return L.join("\n");
}
export function addIterationYaml(text, name, fields) {
  const block = [`  ${name}:`, `    # files: relative to this iteration's folder (3_iterations/${name})`,
    ...Object.entries(fields).map(([k, v]) => `    ${k}: ${v}`)].join("\n") + "\n";
  const L = text.split(/\r?\n/);
  const e = L.findIndex((l) => /^iterations:\s*\{\s*\}\s*$/.test(l));
  if (e >= 0) L[e] = "iterations:";
  const i = L.findIndex((l) => /^iterations:\s*$/.test(l));
  if (i < 0) return text.replace(/\s*$/, "\n") + "iterations:\n" + block;
  let j = i + 1; while (j < L.length && (!L[j].trim() || /^\s/.test(L[j]))) j++;   // end of the iterations section
  while (j > i + 1 && !L[j - 1].trim()) j--;                                          // but before trailing blank lines
  L.splice(j, 0, ...block.replace(/\n$/, "").split("\n"));
  return L.join("\n");
}

// ------------------------------------------------------------------ open / refresh
async function firstDir(root, names) { for (const d of names) { try { await dirAt(root, d); return d; } catch { /* next */ } } return null; }
export async function openProject(root) {
  S.root = root; S.name = root.name; S.msg = "";
  S.simDir = await firstDir(root, ["simulations", "Simulations"]) || "simulations";
  S.subjects = await listDirs(root, S.simDir);
  if (!S.subjects.includes(S.subject)) S.subject = S.subjects[0] || "";
  await openSubject();
}
export async function openSubject() {
  S.sessions = S.subject ? await listDirs(S.root, `${S.simDir}/${S.subject}`) : [];
  if (!S.sessions.includes(S.session)) S.session = S.sessions[0] || "";
  await openSession();
}
export async function openSession() {
  S.ses = `${S.simDir}/${S.subject}/${S.session}`;
  S.yaml = ""; S.cfg = { top: {}, trials: {}, iterations: {} }; S.trials = []; S.iterations = []; S.c3ds = [];
  if (!S.subject || !S.session) return;
  const root = S.root;
  const f = await readFile(root, sp("session.yaml"));
  S.yaml = f ? await f.text() : "";
  S.trials = await listDirs(root, sp("2_experimental"));
  S.iterations = await listDirs(root, sp("3_iterations"));
  S.c3dDir = await firstDir(root, C3D_DIRS.map(sp)) ? (await firstDir(root, C3D_DIRS.map(sp))).slice(S.ses.length + 1) : C3D_DIRS[0];
  S.c3ds = await listFiles(root, sp(S.c3dDir), /\.c3d$/i);
  if (!S.yaml) {
    const names = S.c3ds.length ? S.c3ds.map((n) => n.replace(/\.c3d$/i, "")) : S.trials;
    S.yaml = scaffoldYaml({ subject: S.subject, session: S.session, staticTrial: names.find((t) => /^static/i.test(t)) || "", trials: names,
      modelsDir: await firstDir(root, ["models"]) || "", setupDir: await firstDir(root, ["setupFiles", "setup_files"]) || "" });
    await writeFile(root, sp("session.yaml"), S.yaml);
    S.msg = T("ss_scaffolded");
  }
  S.cfg = parseYaml(S.yaml);
  if (!S.iterations.includes(S.iteration)) S.iteration = S.iterations[0] || "";
  if (!S.trials.includes(S.trial)) S.trial = "";
}
async function refresh() { if (S.root) await openSession(); }

/** Create 3_iterations/<name>, its yaml block, and copy the marker set in. */
/** The iteration keys of bioscout.session.config.IterationKeys this page lets you set, with defaults
 *  in the project layout (models_dir / setup_dir) when the session has one, else iteration-relative. */
export function iterationDefaults(name, genericName) {
  const g = genericName || "GPK_v4_016.osim", md = S.cfg && S.cfg.top.models_dir, sd = S.cfg && S.cfg.top.setup_dir;
  const fam = /^GPK/i.test(g) ? "GPK" : /catelli/i.test(g) ? "Catelli" : g.replace(/\.osim$/i, "");
  return {
    model_generic: md ? `./generic/${fam}/${g}` : g,
    model_scaled: md ? `./personalised/<subject>/<session>/${name || "<iteration>"}_scaled.osim` : g.replace(/\.osim$/i, "") + "_scaled.osim",
    markerset: sd ? "./markers_pyCGM.xml" : "markers.xml",
    scale_tool: sd ? "./setup_scale.xml" : "",
    so_actuators: sd ? "./actuators_so.xml" : "",
    linear_scaling: "true", marker_placer: "true", preserve_mass_distribution: "true", muscle_opt: "false", mvic_factor: "1.0",
    fmax_scaling: "", label: "", color: "black", group: "generic",
  };
}
/** Write a bundled app file (model / setup template) to a project path when it is not there yet. */
async function ensureFile(path, url, blob) {
  if (await readFile(S.root, path)) return;
  let data = blob || null;
  if (!data) { try { const r = await fetch(url); if (r.ok) data = await r.blob(); } catch { /* none */ } }
  if (data) await writeFile(S.root, path, data);
}
export async function createIteration(name, fields, { genericFile, markersetFile }) {
  if (!S.root || !name) return;
  await dirAt(S.root, sp("3_iterations/" + name), true);
  fields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== "" && v != null));
  fields.model_scaled = (fields.model_scaled || "").replace(/<iteration>/g, name);
  // the generic model, marker set and setup files go where the yaml says, so the Python bioscout finds them too
  const gp = itPath(name, "model_generic", fields.model_generic);
  if (gp) await ensureFile(gp, new URL("../data/opensim/models/" + gp.split("/").pop(), import.meta.url), genericFile && genericFile.name === gp.split("/").pop() ? genericFile : null);
  const mp = itPath(name, "markerset", fields.markerset);
  if (mp) await ensureFile(mp, new URL("../data/opensim/setup_files/" + mp.split("/").pop(), import.meta.url), markersetFile);
  for (const k of ["scale_tool", "so_actuators"]) { const pth = itPath(name, k, fields[k]); if (pth) await ensureFile(pth, new URL("../data/opensim/setup_files/" + pth.split("/").pop(), import.meta.url)); }
  S.yaml = addIterationYaml(S.yaml, name, fields);
  await writeFile(S.root, sp("session.yaml"), S.yaml);
  S.iteration = name;
  await refresh();
}

/** Picked C3D files are copied into 1_c3dfiles/ first (the session's raw captures), then exported. */
export async function addC3d(files, log) {
  for (const f of files) { await writeFile(S.root, sp(`${S.c3dDir}/${f.name}`), f); log(`${f.name} → ${S.c3dDir}/`); }
  await refresh();
}
/** 1_c3dfiles/*.c3d -> 2_experimental/<stem>/ (marker_experimental.trc, grf.mot, emg.mot), as bioscout's export. */
export async function exportC3d(log, { onlyMissing = true } = {}) {
  let n = 0;
  for (const name of S.c3ds) {
    const stem = name.replace(/\.c3d$/i, "");
    if (onlyMissing && await readFile(S.root, sp(`2_experimental/${stem}/marker_experimental.trc`))) { log(`${stem}: already exported`); continue; }
    const f = await readFile(S.root, sp(`${S.c3dDir}/${name}`)); if (!f) continue;
    log(`${stem}: reading ${(f.size / 1e6).toFixed(1)} MB`);
    const out = c3dToOpenSim(await f.arrayBuffer(), f.name);
    for (const [fn, text] of Object.entries(out)) await writeFile(S.root, sp(`2_experimental/${stem}/${fn}`), text);
    log(`${stem}: ${Object.keys(out).join(", ")} → 2_experimental/${stem}`); n++;
    // a trial exported for the first time gets its yaml entry
    if (!(S.cfg.trials || {})[stem]) { S.yaml = addTrialYaml(S.yaml, stem); await writeFile(S.root, sp("session.yaml"), S.yaml); S.cfg = parseYaml(S.yaml); }
  }
  if (!S.c3ds.length) log(T("ss_noC3d", { dir: S.c3dDir }));
  await refresh();
  return n;
}
export function addTrialYaml(text, name) {
  const L = text.split(/\r?\n/);
  const e = L.findIndex((l) => /^trials:\s*\{\s*\}\s*$/.test(l)); if (e >= 0) L[e] = "trials:";
  const i = L.findIndex((l) => /^trials:\s*$/.test(l));
  if (i < 0) return text.replace(/\s*$/, "\n") + `trials:\n  ${name}: {}\n`;
  let j = i + 1; while (j < L.length && (!L[j].trim() || /^\s/.test(L[j]))) j++;
  while (j > i + 1 && !L[j - 1].trim()) j--;
  L.splice(j, 0, `  ${name}: {}`);
  return L.join("\n");
}
/** Files of one trial ([{name, data}] relative to the session) into the open session + its yaml entry. */
export async function writeTrial(trial, files) {
  for (const f of files) await writeFile(S.root, sp(f.name), f.data);
  if (!(S.cfg.trials || {})[trial]) { S.yaml = addTrialYaml(S.yaml, trial); await writeFile(S.root, sp("session.yaml"), S.yaml); S.cfg = parseYaml(S.yaml); }
  await refresh();
}
/** Mean vertical GRF of the static trial -> body mass (kg). */
export async function weightFromStatic() {
  const st = S.cfg.top.static_trial; if (!st) throw new Error(T("ss_noStatic"));
  const f = await readFile(S.root, sp(`2_experimental/${st}/grf.mot`)); if (!f) throw new Error(`2_experimental/${st}/grf.mot`);
  const L = (await f.text()).split(/\r?\n/), h = L.findIndex((l) => l.trim().toLowerCase() === "endheader");
  const cols = L[h + 1].trim().split(/[\t ]+/), rows = L.slice(h + 2).filter((l) => l.trim()).map((l) => l.trim().split(/[\t ]+/).map(Number));
  const vy = cols.map((c, i) => (/force.*vy$/i.test(c) ? i : -1)).filter((i) => i >= 0);
  if (!vy.length) throw new Error("no ground_force_*_vy columns");
  const tot = rows.map((r) => vy.reduce((a, i) => a + (r[i] || 0), 0));
  const on = tot.filter((v) => v > 100);
  const mean = (on.length ? on : tot).reduce((a, b) => a + b, 0) / Math.max(1, (on.length ? on : tot).length);
  return { trial: st, plates: vy.length, frames: rows.length, meanN: mean, kg: mean / 9.80665 };
}
export async function setBodyMass(kg) {
  S.yaml = setTopKey(S.yaml, "body_mass", (+kg).toFixed(2)); await writeFile(S.root, sp("session.yaml"), S.yaml); S.cfg = parseYaml(S.yaml);
}
export async function setSubject(name) {
  S.yaml = setTopKey(S.yaml, "subject", name); await writeFile(S.root, sp("session.yaml"), S.yaml); S.cfg = parseYaml(S.yaml);
}
export async function setStaticTrial(name) {
  S.yaml = setTopKey(S.yaml, "static_trial", name); await writeFile(S.root, sp("session.yaml"), S.yaml); S.cfg = parseYaml(S.yaml);
}

/** Put the chosen iteration + trial into the step sections. hooks: send(key, file), setDir(tool, handle), setGeneric(file), setScaled(file) */
export async function applySelection(hooks) {
  if (!S.root || !S.session) return;
  const it = S.iteration, cfg = (S.cfg.iterations || {})[it] || {};
  if (it) {
    // Scale writes the scaled model where the yaml says (models/personalised/<subject>/<session>/<it>_scaled.osim)
    const scaled = itPath(it, "model_scaled", cfg.model_scaled);
    const outDir = scaled ? scaled.split("/").slice(0, -1).join("/") : sp("3_iterations/" + it);
    hooks.setDir("scale", await dirAt(S.root, outDir, true));
    const gp = itPath(it, "model_generic", cfg.model_generic);
    const gname = gp ? gp.split("/").pop() : null;
    hooks.setRenames("scale", scaled && gname ? { [gname.replace(/\.osim$/i, "") + "_scaled.osim"]: scaled.split("/").pop(),
      [gname.replace(/\.osim$/i, "") + "_scaled_scale_factors.xml"]: scaled.split("/").pop().replace(/\.osim$/i, "") + "_scale_factors.xml" } : {});
    const mp = itPath(it, "markerset", cfg.markerset); if (mp) { const f = await readFile(S.root, mp); if (f) hooks.send("scale:markerset", f); }
    const stp = itPath(it, "scale_tool", cfg.scale_tool); if (stp) { const f = await readFile(S.root, stp); if (f) hooks.send("scale:scale_setup", f); }
    if (gp) { const f = await readFile(S.root, gp); if (f) hooks.setGeneric(f); }
    if (scaled) { const f = await readFile(S.root, scaled); hooks.setScaled(f || null); }
  }
  const st = S.cfg.top.static_trial;
  if (st) { const f = await readFile(S.root, sp(`2_experimental/${st}/marker_experimental.trc`)); if (f) hooks.send("scale:static_trc", f); }
  if (S.cfg.top.body_mass) hooks.setOption("scale", "mass", String(+S.cfg.top.body_mass));
  if (S.trial) {
    const base = sp(`2_experimental/${S.trial}/`);
    const trc = await readFile(S.root, base + "marker_experimental.trc"), grf = await readFile(S.root, base + "grf.mot"), xml = await readFile(S.root, base + "GRF.xml");
    if (trc) hooks.send("ik:motion_trc", trc);
    if (grf) hooks.send("id:grf_mot", grf);
    if (xml) hooks.send("id:grf_xml", xml);
    if (it) { const out = await dirAt(S.root, sp(`3_iterations/${it}/${S.trial}/external_biomechanics`), true); hooks.setDir("ik", out); hooks.setDir("id", out); }
    const tr = ((S.cfg.trials || {})[S.trial] || {}).time_range;
    if (tr) { const m = String(tr).match(/[-\d.]+/g); if (m && m.length === 2) { hooks.setOption("ik", "t0", m[0]); hooks.setOption("ik", "t1", m[1]); } }
  }
}

// ------------------------------------------------------------------ running the iteration
/* Per trial, the bioscout layout (as Charite_Data/.../3_iterations/<it>/<trial>/):
 *   external_biomechanics/  IK + ID (+ body_positions.sto, the task figures)
 *   muscle_analysis/        _MuscleAnalysis_*.sto
 *   static_optimisation/    SO forces / activations + muscle_groups / muscle_moments_*.png
 *   joint_contact_forces/   jra_so.sto, jra_ceinms.sto + jrf_*.png
 *   ceinms/                 CEINMS execution (Python version) + ceinms_*.png
 * and per iteration: 3_iterations/<it>/ceinms_calibration/ (calibrated model, calibration.json). */
const STEP_ORDER = ["scale", "ik", "id", "ma", "rra", "so", "ceinms_cal", "ceinms"];
const SUB = { ik: "external_biomechanics", id: "external_biomechanics", ma: "muscle_analysis", so: "static_optimisation", ceinms: "ceinms" };
function folderOf(tool, name) {
  if (/^(jra_|jrf_)/.test(name)) return "joint_contact_forces";
  if (name === "body_positions.sto" || /^(ik_|_ik_|inverse_dynamics|kinematics_moments|residuals)/.test(name)) return "external_biomechanics";
  if (/^ceinms_|^CEINMS/.test(name)) return "ceinms";
  if (/^muscle_(groups|moments)/.test(name) || /^SO_/.test(name)) return "static_optimisation";
  if (/^_MuscleAnalysis/.test(name)) return "muscle_analysis";
  return SUB[tool] || "external_biomechanics";
}
export const pickedTrials = () => S.trials.filter((t) => t !== S.cfg.top.static_trial && (!S.pick || S.pick.has(t)));
const trialDir = (it, t, sub) => sp(`3_iterations/${it}/${t}${sub ? "/" + sub : ""}`);
async function fileIn(path) { return readFile(S.root, path); }
async function textIn(path) { const f = await readFile(S.root, path); return f ? f.text() : null; }
/** The inputs a later step needs, from the folders, when the step that makes them is skipped. */
const STALE = ["id:ik_mot", "so:ik_mot", "ma:ik_mot", "ceinms_cal:ik_mot", "ceinms:ik_mot", "so:id_sto", "ceinms_cal:id_sto", "ceinms:id_sto",
  "ma:so_force", "so:bodies", "ceinms_cal:emg_mot", "ceinms:emg_mot", "id:grf_xml", "so:grf_mot", "so:grf_xml"];

/** The ticked steps for every ticked trial of the iteration, written into the bioscout layout. */
export async function runAll(ctx, hooks) {
  const { client, job } = ctx, id = job.id, it = S.iteration;
  const have = new Set((ctx.health && ctx.health.tools) || STEP_ORDER);
  S.busy = true; S.runLog = [];
  const log = (s) => { S.runLog.push(s); hooks.repaint(); };
  const wait = async (tool) => { for (;;) { await new Promise((r) => setTimeout(r, 1000)); const st = (await client.status(id)).tools[tool]; if (st.state === "done" || st.state === "error") return st; } };
  const run = async (tool, label) => {
    log(`${label}: ${tool} …`);
    await client.toolRun(id, tool);
    const st = await wait(tool);
    if (st.state === "error") { log(`${label}: ${tool} failed — ${st.error}`); return false; }
    log(`${label}: ${tool} done in ${st.seconds} s`); return true;
  };
  const store = async (tool, trial) => {                 // every output into its bioscout folder
    for (const o of await hooks.outputs(tool)) {
      const path = tool === "ceinms_cal" ? sp(`3_iterations/${it}/ceinms_calibration/${o.path}`) : `${trialDir(it, trial, folderOf(tool, o.path))}/${o.path}`;
      await writeFile(S.root, path, new Blob([o.data]));
    }
  };
  try {
    if (!it) throw new Error(T("ss_noIteration"));
    // 0. c3d export (only the trials not exported yet)
    if (!S.exportSkip && S.c3ds.length) await exportC3d(log);
    const trials = pickedTrials();
    if (!trials.length) throw new Error(T("ss_noTrials"));
    // 1. scale, once for the iteration
    await applySelection(hooks); await new Promise((r) => setTimeout(r, 300));
    if (!S.skip.has("scale")) { if (await run("scale", it)) await hooks.save("scale"); else throw new Error("scale failed"); }
    else log(`${it}: scale ${T("sq_skipped")} — ${T("ss_usingScaled")}`);
    let calibrated = false;
    for (const trial of trials) {
      S.trial = trial;
      for (const k of STALE) { const [tl, slot] = k.split(":"); hooks.clear(tl, slot); }
      await applySelection(hooks); await new Promise((r) => setTimeout(r, 300));
      const eb = trialDir(it, trial, "external_biomechanics"), exp = sp(`2_experimental/${trial}`);
      // inputs every later step can use
      const emg = await fileIn(`${exp}/emg.mot`); if (emg) { hooks.send("ceinms_cal:emg_mot", emg); hooks.send("ceinms:emg_mot", emg); }
      const bp = await fileIn(`${eb}/body_positions.sto`); if (bp) hooks.send("so:bodies", bp);
      let ok = true;
      for (const tool of STEP_ORDER.slice(1)) {
        if (S.skip.has(tool)) {
          // a skipped step's results already in the trial folder stand in for it
          if (tool === "ik") { const f = await fileIn(`${eb}/ik.mot`) || await fileIn(`${eb}/joint_angles.mot`); if (f) { for (const k of ["id", "so", "ma", "ceinms_cal", "ceinms"]) hooks.send(`${k}:ik_mot`, f); } else { log(`${trial}: no ik.mot in ${eb} — trial skipped`); ok = false; break; } }
          if (tool === "id") { const f = await fileIn(`${eb}/inverse_dynamics.sto`); if (f) for (const k of ["so", "ceinms_cal", "ceinms"]) hooks.send(`${k}:id_sto`, f); }
          if (tool === "so") { const f = await fileIn(`${trialDir(it, trial, "static_optimisation")}/SO_StaticOptimization_force.sto`); if (f) hooks.send("ma:so_force", f); }
          if (tool === "ceinms_cal" && !calibrated) {
            const cd = sp(`3_iterations/${it}/ceinms_calibration`), cj = await fileIn(`${cd}/calibration.json`);
            if (cj) { hooks.send("ceinms:calibration", cj); try { for await (const [n, h] of (await dirAt(S.root, cd)).entries()) if (/_calibrated\.osim$/i.test(n)) hooks.send("ceinms:model", await h.getFile()); } catch { /* none */ } }
          }
          continue;
        }
        if (!have.has(tool)) { log(`${trial}: ${tool} ${T("sq_needsEngine")}`); continue; }
        if (tool === "ceinms_cal" && calibrated) continue;   // one calibration per iteration (the first trial)
        const done = await run(tool, trial);
        if (!done) { if (tool === "ik") { ok = false; break; } continue; }
        await store(tool, trial);
        if (tool === "ceinms_cal") calibrated = true;
      }
      if (ok) log(`${trial}: ✓ → ${trialDir(it, trial)}`);
    }
    log(T("ss_allDone"));
  } catch (e) { log("✗ " + e.message); }
  finally { S.busy = false; hooks.repaint(); }
}

/** Every figure of the ticked trials again from their folders; nothing re-run. */
export async function redoFiguresAll(ctx, hooks) {
  const it = S.iteration; S.busy = true; S.runLog = [];
  const log = (s) => { S.runLog.push(s); hooks.repaint(); };
  try {
    if (!it) throw new Error(T("ss_noIteration"));
    if (!ctx.client.figuresOnly) throw new Error("figures need the in-browser engine");
    const cfg = (S.cfg.iterations || {})[it] || {}, scaled = itPath(it, "model_scaled", cfg.model_scaled);
    const model = scaled ? await fileIn(scaled) : null;
    for (const trial of pickedTrials()) {
      const f = {};
      for (const sub of ["external_biomechanics", "muscle_analysis", "static_optimisation", "joint_contact_forces", "ceinms"]) {
        let d; try { d = await dirAt(S.root, trialDir(it, trial, sub)); } catch { continue; }
        for await (const [n, h] of d.entries()) if (h.kind === "file" && /\.(sto|mot)$/i.test(n) && !/^_MuscleAnalysis/.test(n)) f[n] = await (await h.getFile()).text();
      }
      if (!f["ik.mot"] && f["joint_angles.mot"]) f["ik.mot"] = f["joint_angles.mot"];
      for (const n of ["grf.mot", "GRF.xml"]) { const x = await textIn(sp(`2_experimental/${trial}/${n}`)); if (x) f[n] = x; }
      if (!f["ik.mot"]) { log(`${trial}: no ik.mot — skipped`); continue; }
      log(`${trial}:`);
      const figs = await ctx.client.figuresOnly(f, model, log);
      for (const [n, v] of Object.entries(figs)) await writeFile(S.root, `${trialDir(it, trial, folderOf(/^ceinms_|^jrf_ceinms/.test(n) ? "ceinms" : "so", n))}/${n}`, v instanceof Blob ? v : new Blob([v]));
    }
    log(T("ss_allDone"));
  } catch (e) { log("✗ " + e.message); }
  finally { S.busy = false; hooks.repaint(); }
}

// ------------------------------------------------------------------ the panel
export function sessionHTML(ctx) {
  T = ctx.t;
  const t = ctx.t, top = S.cfg ? S.cfg.top : {};
  const opt = (list, cur, none) => `<option value="">${esc(none)}</option>` + list.map((x) => `<option value="${esc(x)}"${x === cur ? " selected" : ""}>${esc(x)}</option>`).join("");
  const itForm = S.newIt ? `<div class="card" style="margin-top:8px;padding:10px">
      <b>${t("ss_newIteration")}</b> <span class="sub">${t("ss_itNote")}</span>
      <div class="simOpts" style="margin-top:6px">
        <label class="simOpt">name <input type="text" data-it="name" value="${esc(S.newIt.name || "")}" placeholder="gpk"></label>
        ${Object.entries(S.newIt.fields).map(([k, v]) => `<label class="simOpt">${esc(k)} <input type="text" data-it="${esc(k)}" value="${esc(v)}"></label>`).join("")}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px"><button type="button" data-ss-itsave>${t("ss_create")}</button><button type="button" class="ghost" data-ss-itcancel>${t("pr_remove").replace(/^Remove$/, "Cancel")}</button></div>
    </div>` : "";
  const weight = S.weight ? `<div class="card" style="margin-top:8px;padding:10px">
      <b>${t("ss_weightTitle")}</b>
      <p class="note" style="margin:4px 0 8px">${t("ss_weightNote", { trial: S.weight.trial, plates: S.weight.plates, n: S.weight.meanN.toFixed(1), kg: S.weight.kg.toFixed(2) })}</p>
      <div class="simOpts"><label class="simOpt">${t("sim_opt_mass")} <input type="text" data-ss-kg value="${S.weight.kg.toFixed(2)}"></label>
        <button type="button" data-ss-kgsave>${t("ss_weightApply")}</button><button type="button" class="ghost" data-ss-kgcancel>Cancel</button></div>
    </div>` : "";
  return `<div class="card" id="simSession" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${t("ss_title")}</b>
      <button type="button" class="ghost" data-ss-pick style="margin:0;width:auto;padding:6px 12px">${S.root ? esc(S.name) : t("ss_pick")}</button></div>
    <p class="note" style="margin:4px 0 8px">${t("ss_intro")}</p>
    ${S.root ? `
    <div class="simOpts">
      <label class="simOpt">${t("ss_subjectSel")} <select data-ss-subjsel>${opt(S.subjects, S.subject, t("ss_none"))}</select></label>
      <label class="simOpt">${t("ss_session")} <select data-ss-sessel>${opt(S.sessions, S.session, t("ss_none"))}</select></label>
      <span class="sub">${esc(S.ses)}${top.models_dir ? ` · models_dir ${esc(top.models_dir)}` : ""}${top.setup_dir ? ` · setup_dir ${esc(top.setup_dir)}` : ""}</span>
    </div>` : ""}
    ${S.root && S.session ? `
    <div class="simOpts">
      <label class="simOpt">${t("ss_subject")} <input type="text" data-ss-subject value="${esc(top.subject || "")}"></label>
      <label class="simOpt">${t("ss_static")} <select data-ss-static>${opt(S.trials, top.static_trial || "", t("ss_none"))}</select></label>
      <label class="simOpt">${t("sim_opt_mass")} <input type="text" data-ss-mass value="${esc(top.body_mass || "")}" style="width:90px"></label>
      <button type="button" class="ghost" data-ss-weight>${t("ss_weightBtn")}</button>
    </div>
    ${weight}
    <div class="simOpts" style="margin-top:6px">
      <span class="sub">${esc(S.c3dDir)}: ${S.c3ds.length} .c3d · 2_experimental: ${S.trials.length}</span>
      <button type="button" class="ghost" data-ss-addc3d>${t("ss_addC3d")}</button><input type="file" accept=".c3d" multiple data-ss-c3dfile hidden>
      <button type="button" class="ghost" data-ss-export${S.busy ? " disabled" : ""}>${t("ss_exportC3d", { dir: S.c3dDir })}</button>
    </div>
    <div class="simOpts" style="margin-top:6px">
      <label class="simOpt">${t("ss_iteration")} <select data-ss-iteration>${opt(S.iterations, S.iteration, t("ss_none"))}</select></label>
      <button type="button" class="ghost" data-ss-itnew>${t("ss_newIteration")}…</button>
      <label class="simOpt">${t("ss_trial")} <select data-ss-trial>${opt(S.trials, S.trial, t("ss_none"))}</select></label>
    </div>
    ${itForm}
    <div style="margin-top:8px"><span class="sub">${t("ss_runTrials")}</span>
      <div style="display:flex;gap:4px 14px;flex-wrap:wrap;margin-top:4px">${S.trials.filter((x) => x !== top.static_trial).map((x) => `<label class="simOpt" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" data-ss-tick="${esc(x)}"${!S.pick || S.pick.has(x) ? " checked" : ""}> ${esc(x)}</label>`).join("") || `<span class="sub">—</span>`}</div>
      <label class="simOpt" style="display:inline-flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" data-ss-exportskip${S.exportSkip ? " checked" : ""}> ${t("ss_exportSkip")}</label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
      <button type="button" data-ss-runall${S.busy || !S.iteration ? " disabled" : ""}>${t("ss_runAll")}</button>
      <button type="button" class="ghost" data-ss-figs${S.busy || !S.iteration ? " disabled" : ""}>${t("sq_figs")}</button>
      ${S.msg ? `<span class="sub">${esc(S.msg)}</span>` : ""}
    </div>
    ${S.runLog.length ? `<div class="osimLog" style="margin-top:8px">${S.runLog.map(esc).join("\n")}</div>` : ""}` : ""}
  </div>`;
}

export function sessionWire(box, ctx, hooks) {
  const q = (s) => box.querySelector(s);
  const busy = async (fn) => { S.busy = true; S.runLog = []; hooks.repaint(); try { await fn((s) => { S.runLog.push(s); hooks.repaint(); }); } catch (e) { S.runLog.push("✗ " + e.message); } finally { S.busy = false; hooks.repaint(); } };
  const pick = q("[data-ss-pick]");
  if (pick) pick.onclick = async () => {
    if (!window.showDirectoryPicker) { alert(ctx.t("sim_outdir_unsupported")); return; }
    let h; try { h = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return; }
    await openProject(h); await applySelection(hooks); hooks.repaint();
  };
  const on = (sel, ev, fn) => { const el = q(sel); if (el) el[ev] = fn; };
  on("[data-ss-subjsel]", "onchange", async (e) => { S.subject = e.target.value; S.session = ""; await openSubject(); await applySelection(hooks); hooks.repaint(); });
  on("[data-ss-sessel]", "onchange", async (e) => { S.session = e.target.value; await openSession(); await applySelection(hooks); hooks.repaint(); });
  on("[data-ss-subject]", "onchange", async (e) => { await setSubject(e.target.value.trim()); });
  on("[data-ss-static]", "onchange", async (e) => { await setStaticTrial(e.target.value); await applySelection(hooks); hooks.repaint(); });
  on("[data-ss-mass]", "onchange", async (e) => { const v = parseFloat(e.target.value); if (v > 0) { await setBodyMass(v); hooks.setOption("scale", "mass", String(v)); } });
  on("[data-ss-weight]", "onclick", async () => { try { S.weight = await weightFromStatic(); } catch (e) { S.msg = "✗ " + e.message; } hooks.repaint(); });
  on("[data-ss-kgsave]", "onclick", async () => { const v = parseFloat(q("[data-ss-kg]").value); if (v > 0) { await setBodyMass(v); hooks.setOption("scale", "mass", String(v)); } S.weight = null; hooks.repaint(); });
  on("[data-ss-kgcancel]", "onclick", () => { S.weight = null; hooks.repaint(); });
  on("[data-ss-iteration]", "onchange", async (e) => { S.iteration = e.target.value; await applySelection(hooks); hooks.repaint(); });
  on("[data-ss-trial]", "onchange", async (e) => { S.trial = e.target.value; await applySelection(hooks); hooks.repaint(); });
  on("[data-ss-itnew]", "onclick", () => { S.newIt = { name: "", fields: iterationDefaults("", hooks.genericName()) }; hooks.repaint(); });
  on("[data-ss-itcancel]", "onclick", () => { S.newIt = null; hooks.repaint(); });
  on("[data-ss-itsave]", "onclick", async () => {
    const fields = {}; let name = "";
    box.querySelectorAll("[data-it]").forEach((el) => { if (el.dataset.it === "name") name = el.value; else fields[el.dataset.it] = el.value.trim(); });
    name = name.trim().replace(/[^\w-]+/g, "_"); if (!name) return;
    if (!fields.label) fields.label = name;
    await createIteration(name, fields, { genericFile: hooks.genericFile(), markersetFile: hooks.markersetFile() });
    S.newIt = null; await applySelection(hooks); hooks.repaint();
  });
  const c3 = q("[data-ss-c3dfile]");
  if (c3) { on("[data-ss-addc3d]", "onclick", () => c3.click()); c3.onchange = () => { const files = [...c3.files]; if (files.length) busy(async (log) => { await addC3d(files, log); await exportC3d(log); }); }; }
  on("[data-ss-export]", "onclick", () => busy((log) => exportC3d(log)));
  on("[data-ss-runall]", "onclick", () => runAll(ctx, hooks));
  on("[data-ss-figs]", "onclick", () => redoFiguresAll(ctx, hooks));
  on("[data-ss-exportskip]", "onchange", (e) => { S.exportSkip = e.target.checked; });
  box.querySelectorAll("[data-ss-tick]").forEach((cb) => {
    cb.onchange = () => {
      if (!S.pick) S.pick = new Set(S.trials.filter((x) => x !== S.cfg.top.static_trial));
      cb.checked ? S.pick.add(cb.dataset.ssTick) : S.pick.delete(cb.dataset.ssTick);
    };
  });
}
