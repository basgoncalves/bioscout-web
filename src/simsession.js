/**
 * simsession.js -- Batch mode of Simulate: the per-step page working inside a
 * bioscout session folder, in the layout the Python bioscout reads
 * (bioscout/session/config.py):
 *
 *   <session>/session.yaml
 *   <session>/2_experimental/<trial>/marker_experimental.trc, grf.mot, GRF.xml, emg.mot
 *   <session>/3_iterations/<iteration>/<model_scaled>.osim, markers.xml
 *   <session>/3_iterations/<iteration>/<trial>/external_biomechanics/ik.mot, inverse_dynamics.sto, figures ...
 *
 * One iteration = one scaled model. Iteration file keys are iteration-relative.
 * Only the keys this page needs are read; anything else in session.yaml is left
 * untouched (an iteration is added as a text block, never by rewriting the file).
 */
import { c3dToOpenSim } from "./c3dexport.js";

let T = (k) => k;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const S = {           // the one open session
  root: null, name: "", yaml: "", cfg: null, trials: [], iterations: [], iteration: "", trial: "",
  msg: "", busy: false, runLog: [],
};

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
export function scaffoldYaml({ subject, session, bodyMass, staticTrial, trials }) {
  const lines = [`subject: ${subject}`, `session: '${session}'`, `project_dir: ../../..                # relative to this file`,
    `body_mass: ${bodyMass || 70}`, `static_trial: ${staticTrial || ""}`, `emg_map: {}`, `trials:`];
  for (const t of trials) lines.push(`  ${t}:`, `    type: ${t === staticTrial ? "static" : "walking"}`, `    side: both`);
  lines.push(`iterations:`);
  return lines.join("\n") + "\n";
}
export function addIterationYaml(text, name, fields) {
  const block = [`  ${name}:`, `    # files: relative to this iteration's folder (3_iterations/${name})`,
    ...Object.entries(fields).map(([k, v]) => `    ${k}: ${v}`)].join("\n") + "\n";
  const L = text.split(/\r?\n/);
  const i = L.findIndex((l) => /^iterations:\s*$/.test(l));
  if (i < 0) return text.replace(/\s*$/, "\n") + "iterations:\n" + block;
  let j = i + 1; while (j < L.length && (!L[j].trim() || /^\s/.test(L[j]))) j++;   // end of the iterations section
  L.splice(j, 0, ...block.replace(/\n$/, "").split("\n"));
  return L.join("\n");
}

// ------------------------------------------------------------------ open / refresh
export async function openSession(root) {
  S.root = root; S.name = root.name; S.msg = "";
  const f = await readFile(root, "session.yaml");
  S.yaml = f ? await f.text() : "";
  S.trials = await listDirs(root, "2_experimental");
  S.iterations = await listDirs(root, "3_iterations");
  if (!S.yaml) {
    S.yaml = scaffoldYaml({ subject: "subject", session: root.name, staticTrial: S.trials.find((t) => /static/i.test(t)) || "", trials: S.trials });
    await writeFile(root, "session.yaml", S.yaml);
    S.msg = T("ss_scaffolded");
  }
  S.cfg = parseYaml(S.yaml);
  if (!S.iterations.includes(S.iteration)) S.iteration = S.iterations[0] || "";
  if (!S.trials.includes(S.trial)) S.trial = "";
}
async function refresh() { if (S.root) await openSession(S.root); }

/** Create 3_iterations/<name>, its yaml block, and copy the marker set in. */
export async function createIteration(name, { genericName, genericFile, markersetFile }) {
  if (!S.root || !name) return;
  await dirAt(S.root, "3_iterations/" + name, true);
  const gname = (genericFile && genericFile.name) || genericName || "GPK_v4_016.osim";
  // the generic model goes into the iteration folder, so the yaml's iteration-relative path holds for the Python bioscout too
  let gblob = genericFile || null;
  if (!gblob) { try { const r = await fetch(new URL("../data/opensim/models/" + gname, import.meta.url)); if (r.ok) gblob = await r.blob(); } catch { /* keep the name only */ } }
  if (gblob) await writeFile(S.root, `3_iterations/${name}/${gname}`, gblob);
  const fields = { model_generic: gname, model_scaled: gname.replace(/\.osim$/i, "") + "_scaled.osim",
    linear_scaling: "true", marker_placer: "true", label: name, color: "black" };
  if (markersetFile) { await writeFile(S.root, `3_iterations/${name}/markers.xml`, markersetFile); fields.markerset = "markers.xml"; }
  S.yaml = addIterationYaml(S.yaml, name, fields);
  await writeFile(S.root, "session.yaml", S.yaml);
  S.iteration = name;
  await refresh();
}

/** C3D files -> 2_experimental/<stem>/ (marker_experimental.trc, grf.mot, emg.mot). */
export async function importC3d(files, log) {
  for (const f of files) {
    const stem = f.name.replace(/\.c3d$/i, "");
    log(`${stem}: reading ${(f.size / 1e6).toFixed(1)} MB`);
    const out = c3dToOpenSim(await f.arrayBuffer(), f.name);
    for (const [name, text] of Object.entries(out)) await writeFile(S.root, `2_experimental/${stem}/${name}`, text);
    log(`${stem}: ${Object.keys(out).join(", ")} → 2_experimental/${stem}`);
  }
  await refresh();
}

/** Put the chosen iteration + trial into the step sections. hooks: send(key, file), setDir(tool, handle), setGeneric(file), setScaled(file) */
export async function applySelection(hooks) {
  if (!S.root) return;
  const it = S.iteration, cfg = (S.cfg.iterations || {})[it] || {};
  if (it) {
    const itDir = await dirAt(S.root, "3_iterations/" + it, true);
    hooks.setDir("scale", itDir);
    const relOk = (p) => p && !p.startsWith("..") && !/^[a-zA-Z]:/.test(p);
    if (relOk(cfg.markerset)) { const f = await readFile(S.root, `3_iterations/${it}/${cfg.markerset}`); if (f) hooks.send("scale:markerset", f); }
    if (relOk(cfg.model_generic)) { const f = await readFile(S.root, `3_iterations/${it}/${cfg.model_generic}`); if (f) hooks.setGeneric(f); }
    if (relOk(cfg.model_scaled)) { const f = await readFile(S.root, `3_iterations/${it}/${cfg.model_scaled}`); hooks.setScaled(f || null); }
  }
  const st = S.cfg.top.static_trial;
  if (st) { const f = await readFile(S.root, `2_experimental/${st}/marker_experimental.trc`); if (f) hooks.send("scale:static_trc", f); }
  if (S.trial) {
    const base = `2_experimental/${S.trial}/`;
    const trc = await readFile(S.root, base + "marker_experimental.trc"), grf = await readFile(S.root, base + "grf.mot"), xml = await readFile(S.root, base + "GRF.xml");
    if (trc) hooks.send("ik:motion_trc", trc);
    if (grf) hooks.send("id:grf_mot", grf);
    if (xml) hooks.send("id:grf_xml", xml);
    if (it) { const out = await dirAt(S.root, `3_iterations/${it}/${S.trial}/external_biomechanics`, true); hooks.setDir("ik", out); hooks.setDir("id", out); }
  }
}

/** IK then ID for every non-static trial of the iteration. */
export async function runAll(ctx, hooks) {
  const { client, job } = ctx, id = job.id;
  const trials = S.trials.filter((t) => t !== S.cfg.top.static_trial);
  S.busy = true; S.runLog = [];
  const log = (s) => { S.runLog.push(s); hooks.repaint(); };
  const wait = async (tool) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await client.status(id); const sp = st.tools[tool];
      if (sp.state === "done" || sp.state === "error") return sp;
    }
  };
  try {
    for (const t of trials) {
      S.trial = t; await applySelection(hooks); await new Promise((r) => setTimeout(r, 300));
      for (const tool of ["ik", "id"]) {
        log(`${t}: ${tool} …`);
        await client.toolRun(id, tool);
        const sp = await wait(tool);
        if (sp.state === "error") { log(`${t}: ${tool} failed — ${sp.error}`); break; }
        await hooks.save(tool);
        log(`${t}: ${tool} done in ${sp.seconds} s`);
      }
    }
    log(T("ss_allDone"));
  } finally { S.busy = false; hooks.repaint(); }
}

// ------------------------------------------------------------------ the panel
export function sessionHTML(ctx) {
  T = ctx.t;
  const t = ctx.t;
  const opt = (list, cur, none) => `<option value="">${esc(none)}</option>` + list.map((x) => `<option value="${esc(x)}"${x === cur ? " selected" : ""}>${esc(x)}</option>`).join("");
  return `<div class="card" id="simSession" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${t("ss_title")}</b>
      <button type="button" class="ghost" data-ss-pick style="margin:0;width:auto;padding:6px 12px">${S.root ? esc(S.name) : t("ss_pick")}</button></div>
    <p class="note" style="margin:4px 0 8px">${t("ss_intro")}</p>
    ${S.root ? `
    <div class="simOpts">
      <label class="simOpt">${t("ss_iteration")} <select data-ss-iteration>${opt(S.iterations, S.iteration, t("ss_none"))}</select></label>
      <label class="simOpt">${t("ss_newIteration")} <input type="text" data-ss-newname placeholder="gpk"></label>
      <button type="button" class="ghost" data-ss-create>${t("ss_create")}</button>
    </div>
    <div class="simOpts" style="margin-top:6px">
      <label class="simOpt">${t("ss_trial")} <select data-ss-trial>${opt(S.trials, S.trial, t("ss_none"))}</select></label>
      <span class="sub">${t("ss_static")}: ${esc(S.cfg.top.static_trial || "—")}</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
      <button type="button" class="ghost" data-ss-c3d>${t("ss_importC3d")}</button><input type="file" accept=".c3d" multiple data-ss-c3dfile hidden>
      <button type="button" data-ss-runall${S.busy || !S.iteration ? " disabled" : ""}>${t("ss_runAll")}</button>
      ${S.msg ? `<span class="sub">${esc(S.msg)}</span>` : ""}
    </div>
    ${S.runLog.length ? `<div class="osimLog" style="margin-top:8px">${S.runLog.map(esc).join("\n")}</div>` : ""}` : ""}
  </div>`;
}

export function sessionWire(box, ctx, hooks) {
  const q = (s) => box.querySelector(s);
  const pick = q("[data-ss-pick]");
  if (pick) pick.onclick = async () => {
    if (!window.showDirectoryPicker) { alert(ctx.t("sim_outdir_unsupported")); return; }
    let h; try { h = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return; }
    await openSession(h); await applySelection(hooks); hooks.repaint();
  };
  const its = q("[data-ss-iteration]");
  if (its) its.onchange = async () => { S.iteration = its.value; await applySelection(hooks); hooks.repaint(); };
  const tr = q("[data-ss-trial]");
  if (tr) tr.onchange = async () => { S.trial = tr.value; await applySelection(hooks); hooks.repaint(); };
  const cr = q("[data-ss-create]");
  if (cr) cr.onclick = async () => {
    const name = (q("[data-ss-newname]").value || "").trim().replace(/[^\w-]+/g, "_");
    if (!name) return;
    await createIteration(name, { genericName: hooks.genericName(), genericFile: hooks.genericFile(), markersetFile: hooks.markersetFile() });
    await applySelection(hooks); hooks.repaint();
  };
  const c3 = q("[data-ss-c3dfile]");
  if (c3) {
    q("[data-ss-c3d]").onclick = () => c3.click();
    c3.onchange = async () => {
      const files = [...c3.files]; if (!files.length) return;
      S.busy = true; S.runLog = []; hooks.repaint();
      try { await importC3d(files, (s) => { S.runLog.push(s); hooks.repaint(); }); }
      catch (e) { S.runLog.push("✗ " + e.message); }
      finally { S.busy = false; hooks.repaint(); }
    };
  }
  const ra = q("[data-ss-runall]");
  if (ra) ra.onclick = () => runAll(ctx, hooks);
}
