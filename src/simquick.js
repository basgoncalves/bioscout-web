/**
 * simquick.js -- Quick run of Simulate: ONE c3d file, everything the engine can
 * do with it, written next to the file in <trial>_simulation/:
 *
 *   marker_experimental.trc, grf.mot, emg.mot      the c3d exported (c3dexport.js)
 *   static_marker_experimental.trc                  the static c3d, or the first seconds of the trial
 *   <model>_scaled.osim, setup_scale.xml, ...        Scale
 *   ik.mot, setup_ik.xml, ik_marker_errors*.sto, figures   IK
 *   GRF.xml, inverse_dynamics.sto, setup_id.xml, figures   ID
 *   muscle analysis / static optimisation / joint reaction  when the connected engine has them
 *
 * The steps are the page's own sections: this only feeds them in order and
 * waits for each. Nothing is kept in the browser; the folder is the result.
 */
import { c3dToOpenSim } from "./c3dexport.js";
import { makeZip } from "./zip.js";

let T = (k) => k;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const Q = { file: null, staticFile: null, root: null, staticSeconds: 1.0, busy: false, log: [], done: null, skip: new Set(["ceinms_cal", "ceinms", "rra"]), export: true, setupDir: null, setupLoaded: false, c3ds: [] };
Object.defineProperty(Q, "trial", { get: () => (Q.file && Q.file.file ? Q.file.file.name : "") });

async function writeText(dir, name, data) { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close(); }

/** A .c3d through an ordinary file input: showOpenFilePicker hangs without a dialog in embedded
 *  browsers (the Claude pane, automation), so it is not used. -> { handle: null, file } or null. */
function pickC3d() {
  return new Promise((res) => {
    const i = document.createElement("input"); i.type = "file"; i.accept = ".c3d,.C3D"; i.style.display = "none";
    document.body.appendChild(i);
    let done = false; const finish = (v) => { if (done) return; done = true; i.remove(); res(v); };
    i.onchange = () => finish(i.files && i.files[0] ? { handle: null, file: i.files[0] } : null);
    i.oncancel = () => finish(null);
    window.addEventListener("focus", () => setTimeout(() => finish(i.files && i.files[0] ? { handle: null, file: i.files[0] } : null), 800), { once: true });
    i.click();
  });
}
// ---- folders granted before, kept in IndexedDB (handles survive reloads; Chrome keeps the
// permission when "Allow on every visit" was chosen, else one click re-grants it)
const IDB = "bioscout-quick", STORE = "dirs";
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function savedDirs() { try { const db = await idb(); return await new Promise((res) => { const out = []; const c = db.transaction(STORE).objectStore(STORE).openCursor(); c.onsuccess = () => { const k = c.result; if (!k) return res(out); out.push(k.value); k.continue(); }; c.onerror = () => res(out); }); } catch { return []; } }
async function rememberDir(h) { try { const db = await idb(); const all = await savedDirs(); for (const d of all) if (await d.isSameEntry(h)) return; db.transaction(STORE, "readwrite").objectStore(STORE).put(h, Date.now()); } catch { /* not kept */ } }
/** A granted folder that holds this very file (same name and size), without any dialog. */
async function knownFolderFor(file) {
  for (const d of (await savedDirs()).reverse()) {
    try {
      const perm = await d.queryPermission({ mode: "readwrite" });
      if (perm === "denied") continue;
      const f = await (await d.getFileHandle(file.name)).getFile();
      if (f.size !== file.size || f.lastModified !== file.lastModified) continue;
      if (perm !== "granted" && (await d.requestPermission({ mode: "readwrite" })) !== "granted") continue;   // a one-click re-grant, no folder browsing
      return d;
    } catch { /* not this one */ }
  }
  return null;
}

/** The project's setup-files folder (marker set, IK task set, scale setup), kept across visits. */
async function loadSetupDir() {
  if (Q.setupLoaded) return; Q.setupLoaded = true;
  try { const db = await idb(); Q.setupDir = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get("setup"); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); } catch { /* none */ }
}
async function saveSetupDir(h) { try { const db = await idb(); const tx = db.transaction(STORE, "readwrite").objectStore(STORE); h ? tx.put(h, "setup") : tx.delete("setup"); } catch { /* not kept */ } }
const trcNames = (trc) => (trc.split(/\r?\n/)[3] || "").split("\t").slice(2).map((x) => x.trim()).filter((x) => x && !/^\*\d+$/.test(x));
/** From the setup folder: the marker set, IK task set and scale setup whose marker names best match the trial. */
async function pickSetupFiles(dir, names, log) {
  if ((await dir.queryPermission({ mode: "read" })) !== "granted" && (await dir.requestPermission({ mode: "read" })) !== "granted") { log("setup files: no permission for " + dir.name); return {}; }
  const have = new Set(names), best = {};
  for await (const [n, h] of dir.entries()) {
    if (h.kind !== "file" || !/\.xml$/i.test(n)) continue;
    const file = await h.getFile(), txt = await file.text();
    const kind = /<ScaleTool/.test(txt) ? "scale_setup" : /<IKTaskSet/.test(txt) && !/<IKTool/.test(txt) ? "taskset" : /<MarkerSet/.test(txt) ? "markerset" : null;
    if (!kind) continue;
    const re = kind === "taskset" ? /<IKMarkerTask\s+name="([^"]+)"/g : kind === "scale_setup" ? /<(?:MarkerPair|IKMarkerTask)[^>]*>|<markers>\s*([^<]+)<\/markers>|<IKMarkerTask\s+name="([^"]+)"/g : /<Marker\s+name="([^"]+)"/g;
    const got = new Set(); for (const m of txt.matchAll(re)) for (const g of [m[1], m[2]]) if (g) g.trim().split(/\s+/).forEach((x) => got.add(x));
    const hit = [...got].filter((x) => have.has(x)).length;
    if (hit && (!best[kind] || hit > best[kind].hit)) best[kind] = { hit, of: got.size, file };
  }
  for (const [k, v] of Object.entries(best)) log(`setup files: ${v.file.name} as the ${k === "taskset" ? "IK task set" : k === "scale_setup" ? "scale setup" : "marker set"} (${v.hit} of ${v.of} names in the trial)`);
  return best;
}

/** The c3d's folder chosen first: one permission covers reading the trials and writing the results next to them. */
async function pickC3dFolder() {
  if (!window.showDirectoryPicker) return false;
  let d; try { d = await window.showDirectoryPicker({ mode: "readwrite", id: "bioscout-c3d" }); } catch { return false; }
  Q.root = d; await rememberDir(d); try { const db = await idb(); db.transaction(STORE, "readwrite").objectStore(STORE).put(d, "lastc3d"); } catch { /* not kept */ }
  await listC3ds(d);
  return true;
}
/** The last c3d folder, if the browser still grants it (no dialog). */
async function restoreC3dFolder() {
  if (Q.root || Q.restored) return false; Q.restored = true;
  try {
    const db = await idb(); const d = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get("lastc3d"); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
    if (!d || (await d.queryPermission({ mode: "readwrite" })) !== "granted") return false;
    Q.root = d; await listC3ds(d); return true;
  } catch { return false; }
}
async function listC3ds(d) {
  Q.c3ds = []; for await (const [n, h] of d.entries()) if (h.kind === "file" && /\.c3d$/i.test(n)) Q.c3ds.push(n);
  Q.c3ds.sort();
  const motion = Q.c3ds.filter((n) => !/^static/i.test(n)), st = Q.c3ds.find((n) => /^static/i.test(n));
  if (!Q.file || !Q.c3ds.includes(Q.trial)) await chooseTrial(motion[0] || Q.c3ds[0] || "");
  if (st && !Q.staticFile) Q.staticFile = { handle: null, file: await (await d.getFileHandle(st)).getFile() };
}
async function chooseTrial(name) { Q.file = name ? { handle: null, file: await (await Q.root.getFileHandle(name)).getFile() } : null; Q.log = []; }

/** The folder the results go to: asked once, opening in the c3d's own folder so it is one click. null -> a .zip instead. */
async function resultsFolder() {
  if (Q.root) return Q.root;
  if (!window.showDirectoryPicker) return null;
  Q.root = await knownFolderFor(Q.file.file);
  if (Q.root) return Q.root;
  try { Q.root = await window.showDirectoryPicker({ mode: "readwrite" }); await rememberDir(Q.root); return Q.root; } catch { return null; }
}

/** The first `seconds` of a .trc as a static trial (the subject usually stands still before moving). */
function cropTrc(text, seconds) {
  const L = text.split(/\r?\n/), head = L.slice(0, 5), rows = L.slice(5).filter((l) => l.trim());
  const keep = rows.filter((l) => +l.split("\t")[1] <= seconds);
  head[2] = head[2].split("\t").map((v, i) => (i === 2 || i === 7 ? String(keep.length) : v)).join("\t");
  return head.join("\n") + "\n" + keep.join("\n") + "\n";
}

const STEPS = ["scale", "ik", "id", "ma", "so", "ceinms_cal", "ceinms"];

export async function runQuick(ctx, hooks) {
  const { client, job } = ctx, id = job.id;
  const log = (s) => { Q.log.push(s); hooks.repaint(); };
  const wait = async (tool) => { for (;;) { await new Promise((r) => setTimeout(r, 1000)); const sp = (await client.status(id)).tools[tool]; if (sp.state === "done" || sp.state === "error") return sp; } };
  const have = new Set((ctx.health && ctx.health.tools) || STEPS);
  const out = await resultsFolder();                 // before anything runs, while the click is fresh
  Q.busy = true; Q.log = []; Q.done = null;
  const zipFiles = [];                               // when no folder: everything collected for one .zip
  const stem = Q.trial.replace(/\.c3d$/i, ""), outName = `${stem}_simulation`;
  const started = new Date();
  let logDir = null;                                 // out.log goes here at the end, whatever happened
  try {
    let dir = null;
    if (out) {
      try { dir = await out.getDirectoryHandle(outName, { create: true }); logDir = dir; for (const t of STEPS) hooks.setDir(t, dir); }
      catch (e) { log(`${outName}: ${e.message} — ${T("sq_zipMode")}`); }
    } else log(T("sq_zipMode"));
    if (!dir) for (const t of STEPS) hooks.setDir(t, null);
    // a folder just created inside a cloud-synced directory (ucloud / OneDrive "files on demand") can refuse
    // the first write with NotFoundError: re-open the folder and retry, and fall back to the .zip if it keeps refusing
    const put = async (n, text) => {
      if (!dir) { zipFiles.push({ name: `${outName}/${n}`, data: text }); return; }
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await writeText(dir, n, text); return; }
        catch (e) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          try { dir = await out.getDirectoryHandle(outName, { create: true }); } catch { /* keep the old handle */ }
          if (attempt === 2) { log(`${n}: ${e.message} — ${T("sq_zipMode")}`); dir = null; for (const t of STEPS) hooks.setDir(t, null); zipFiles.push({ name: `${outName}/${n}`, data: text }); }
        }
      }
    };
    // 1. the c3d -> OpenSim files (or, with export unticked, the ones already in the folder)
    const f = Q.file.file;
    let ex = null;
    if (!Q.export && dir) {
      ex = {};
      for (const n of ["marker_experimental.trc", "grf.mot", "emg.mot"]) { try { ex[n] = await (await (await dir.getFileHandle(n)).getFile()).text(); } catch { /* absent */ } }
      if (ex["marker_experimental.trc"]) log(`export: skipped — using ${Object.keys(ex).join(", ")} from the folder`);
      else { log("export: nothing in the folder yet — exporting"); ex = null; }
    }
    if (!ex) {
      log(`${Q.trial}: export`);
      ex = c3dToOpenSim(await f.arrayBuffer(), f.name);
      for (const [n, text] of Object.entries(ex)) await put(n, text);
      log(`  → ${Object.keys(ex).join(", ")}`);
    }
    if (!ex["marker_experimental.trc"]) throw new Error("no markers in the c3d");
    // 2. the static trial: its own c3d, or the first seconds of this one
    let staticTrc;
    if (Q.staticFile) {
      const sf = Q.staticFile.file; const sx = c3dToOpenSim(await sf.arrayBuffer(), sf.name);
      staticTrc = sx["marker_experimental.trc"]; log(`${sf.name}: static trial`);
    } else { staticTrc = cropTrc(ex["marker_experimental.trc"], Q.staticSeconds); log(`static: the first ${Q.staticSeconds} s of ${Q.trial}`); }
    await put("static_marker_experimental.trc", staticTrc);
    hooks.send("scale:static_trc", new File([staticTrc], "static_marker_experimental.trc"));
    hooks.send("ik:motion_trc", new File([ex["marker_experimental.trc"]], "marker_experimental.trc"));
    await loadSetupDir();
    if (Q.setupDir) {
      const b = await pickSetupFiles(Q.setupDir, trcNames(ex["marker_experimental.trc"]), log);
      if (b.markerset) hooks.send("scale:markerset", b.markerset.file);
      if (b.taskset) hooks.send("ik:taskset", b.taskset.file);
      if (b.scale_setup) hooks.send("scale:scale_setup", b.scale_setup.file);
    }
    if (ex["grf.mot"]) hooks.send("id:grf_mot", new File([ex["grf.mot"]], "grf.mot"));
    if (ex["emg.mot"]) for (const tl of ["ceinms_cal", "ceinms"]) hooks.send(`${tl}:emg_mot`, new File([ex["emg.mot"]], "emg.mot"));
    // a skipped step's earlier results in the folder stand in for it (scaled model, ik.mot, inverse_dynamics.sto)
    if (dir) {
      const have = async (n) => { try { return await (await dir.getFileHandle(n)).getFile(); } catch { return null; } };
      if (Q.skip.has("scale")) {
        let scaled = null;
        for await (const [n, h] of dir.entries()) if (h.kind === "file" && /_scaled\.osim$/i.test(n)) scaled = await h.getFile();
        if (scaled) { hooks.setScaled(scaled); log(`scale: using ${scaled.name} from the folder`); }
      }
      if (Q.skip.has("ik")) { const f = await have("ik.mot"); if (f) { hooks.send("id:ik_mot", f); hooks.send("so:ik_mot", f); hooks.send("ma:ik_mot", f); log("ik: using ik.mot from the folder"); } }
      { const f = await have("SO_StaticOptimization_force.sto"); if (f) hooks.send("ma:so_force", f); }   // muscle moments from an earlier SO run
      if (Q.skip.has("id")) { const f = await have("inverse_dynamics.sto"); if (f) { hooks.send("so:id_sto", f); log("id: using inverse_dynamics.sto from the folder"); } }
      const gx = await have("GRF.xml"); if (gx) hooks.send("id:grf_xml", gx);
      const bp = await have("body_positions.sto"); if (bp) hooks.send("so:bodies", bp);          // the poses on the SO / JRA figures
      if (Q.skip.has("ceinms_cal")) { const cj = await have("calibration.json"); if (cj) { hooks.send("ceinms:calibration", cj); log("ceinms calibration: using calibration.json from the folder"); }
        for await (const [n, h] of dir.entries()) if (h.kind === "file" && /_calibrated\.osim$/i.test(n)) { hooks.send("ceinms:model", await h.getFile()); log(`ceinms: using ${n} from the folder`); } }
    }
    await new Promise((r) => setTimeout(r, 400));
    // 3. the steps, in order, each waiting for the last
    const order = ["scale", "ik", ...(ex["grf.mot"] ? ["id", "ma", "rra", "so", "ceinms_cal", "ceinms"] : ["ma"])];   // the order of the sections
    for (const tool of order) {
      if (Q.skip.has(tool)) { log(`${tool}: ${T("sq_skipped")}`); continue; }
      if (!have.has(tool)) { log(`${tool}: ${T("sq_needsEngine")}`); continue; }
      log(`${tool} …`);
      await client.toolRun(id, tool);
      const sp = await wait(tool);
      if (sp.state === "error") { log(`${tool}: failed — ${sp.error}`); if (tool === "scale" || tool === "ik") break; continue; }
      if (dir) { try { await hooks.save(tool); } catch (e) { log(`${tool}: ${e.message} — ${T("sq_zipMode")}`); dir = null; for (const t of STEPS) hooks.setDir(t, null); } }
      if (!dir) for (const o of await hooks.outputs(tool)) zipFiles.push({ name: `${outName}/${o.path}`, data: o.data });
      log(`${tool}: done in ${sp.seconds} s`);
      if (tool === "ik") {
        try {
          const e = (await hooks.outputs("ik")).find((o) => o.path === "ik_marker_errors_all.sto");
          const n = e ? String(e.data).split(/\r?\n/).find((l) => l.startsWith("time")).split(/\s+/).length - 1 : 0, of = trcNames(ex["marker_experimental.trc"]).length;
          if (n && n < 0.5 * of) log(`⚠ ${T("sq_fewMarkers", { n, of })}`);
        } catch { /* only a warning */ }
      }
    }
    if (dir) { Q.done = `${out.name}/${outName}`; log(T("sq_done", { dir: Q.done })); }
    else if (zipFiles.length) {
      const blob = makeZip(zipFiles), url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = `${outName}.zip`; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
      log(T("sq_zipped", { name: `${outName}.zip`, mb: (blob.size / 1e6).toFixed(1) }));
    }
  } catch (e) { log("✗ " + e.message); }
  finally {
    // out.log: this run's lines, then every step's own log (the failed ones say why)
    try {
      const st = await client.status(id), lines = [`BioScout Web ${window.RELEASE || ""} build ${window.BUILD || ""} — Quick run`, `trial: ${Q.trial}`, `started: ${started.toLocaleString()}`, `finished: ${new Date().toLocaleString()}`, "", ...Q.log, ""];
      for (const t of STEPS) { const sp = st.tools[t]; if (sp && sp.log && sp.log.length && (sp.started || 0) * 1000 >= started.getTime() - 2000) lines.push(`---- ${t} (${sp.state}${sp.error ? ": " + sp.error : ""})`, ...sp.log, ""); }
      if (logDir) await writeText(logDir, "out.log", lines.join("\n"));
    } catch { /* the log is a convenience */ }
    Q.busy = false; hooks.repaint();
  }
}

/** Every figure of the trial again from the files already in <trial>_simulation/ -- no analysis re-run
 *  (body_positions.sto is made from the model + ik.mot when it is missing). */
export async function redoFigures(ctx, hooks) {
  const log = (s) => { Q.log.push(s); hooks.repaint(); };
  Q.busy = true; Q.log = []; hooks.repaint();
  try {
    const out = await resultsFolder();
    if (!out) throw new Error(T("sq_figsNoFolder"));
    const outName = `${Q.trial.replace(/\.c3d$/i, "")}_simulation`;
    const dir = await out.getDirectoryHandle(outName);
    const f = {}; let model = null;
    for await (const [n, h] of dir.entries()) {
      if (h.kind !== "file") continue;
      if (/\.(sto|mot|xml)$/i.test(n)) f[n] = await (await h.getFile()).text();
      if (/_scaled\.osim$/i.test(n) && !/_calibrated/.test(n)) model = await h.getFile();
    }
    if (!model && ctx.client.getScaled) model = ctx.client.getScaled();
    log(`${outName}: ${T("sq_figsRunning")}`);
    const figs = await ctx.client.figuresOnly(f, model, log);
    for (const [n, v] of Object.entries(figs)) await writeText(dir, n, v);
    log(T("sq_figsDone", { n: Object.keys(figs).length, dir: `${out.name}/${outName}` }));
  } catch (e) { log("✗ " + e.message); }
  finally { Q.busy = false; hooks.repaint(); }
}

export function quickHTML(ctx) {
  T = ctx.t; const t = ctx.t;
  return `<div class="simModel" id="simQuick">
    <label>${t("sq_title")}</label>
    <div class="simPick">${Q.c3ds.length && Q.root
      ? `<select data-sq-trialsel>${Q.c3ds.map((n) => `<option value="${esc(n)}"${n === Q.trial ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`
      : `<input type="text" readonly placeholder="${esc(t("sq_pickFile"))}" value="${esc(Q.trial)}">`}
      ${window.showDirectoryPicker ? `<button type="button" class="ghost" data-sq-pickdir title="${esc(t("sq_pickDir"))}">📁</button>`
        : `<button type="button" class="ghost" data-sq-pick title="${esc(t("sq_pickFile"))}">🔍</button>`}</div>
    <div class="simOpts" style="margin-top:6px">
      <label class="simOpt">${t("sq_static")} <span class="simPick" style="display:inline-flex"><input type="text" readonly style="width:180px" placeholder="${esc(t("sq_staticNone"))}" value="${esc(Q.staticFile ? Q.staticFile.file.name : "")}">
        ${Q.c3ds.length && Q.root ? `<select data-sq-staticsel style="width:auto"><option value="">—</option>${Q.c3ds.map((n) => `<option value="${esc(n)}"${Q.staticFile && n === Q.staticFile.file.name ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>` : ""}
        <button type="button" class="ghost" data-sq-static>🔍</button>${Q.staticFile ? `<button type="button" class="ghost" data-sq-staticclear>${t("pr_remove")}</button>` : ""}</span></label>
      ${Q.staticFile ? "" : `<label class="simOpt">${t("sq_staticSeconds")} <input type="text" data-sq-sec value="${Q.staticSeconds}" style="width:70px"></label>`}
    </div>
    <div class="simOpts" style="margin-top:6px"><label class="simOpt">${t("sq_setup")} <span class="simPick" style="display:inline-flex"><input type="text" readonly style="width:180px" placeholder="${esc(t("sq_setupNone"))}" value="${esc(Q.setupDir ? Q.setupDir.name : "")}">
      <button type="button" class="ghost" data-sq-setup title="${esc(t("sq_setupPick"))}">📁</button>${Q.setupDir ? `<button type="button" class="ghost" data-sq-setupclear>${t("pr_remove")}</button>` : ""}</span></label></div>
    <p class="note" style="margin:6px 0 0">${Q.file ? (Q.root ? t("sq_where", { dir: Q.root.name + "/" + Q.trial.replace(/\.c3d$/i, "") + "_simulation" }) : t("sq_noFolder", { dir: Q.trial.replace(/\.c3d$/i, "") + "_simulation" })) : t("sq_intro")}</p>

  </div>
  <details class="simTool${Q.export ? "" : " skipped"}" data-tool="c3d">
    <summary><b>0 · ${t("sq_exportTitle")}</b> <label class="simSkip" onclick="event.stopPropagation()"><input type="checkbox" data-sq-export${Q.export ? "" : " checked"}> ${esc(t("sq_skip"))}</label></summary>
    <p class="note" style="margin:4px 0 8px">${t("sq_export")}</p>
  </details>`;
}

export function quickFooterHTML(ctx) {
  const t = ctx.t;
  return `<div style="margin-top:12px">
    <button type="button" data-sq-run class="simGo"${Q.busy || !Q.trial ? " disabled" : ""}>${Q.busy ? t("sq_running") : t("sq_simulate")}</button>
    <button type="button" data-sq-figs class="ghost" style="margin-top:8px;width:100%"${Q.busy || !Q.trial ? " disabled" : ""} title="${esc(t("sq_figsTitle"))}">${t("sq_figs")}</button>
    ${Q.log.length ? `<div class="osimLog" style="margin-top:8px">${Q.log.map(esc).join("\n")}</div>` : ""}
  </div>`;
}

export function quickWire(box, ctx, hooks) {
  const q = (s) => box.querySelector(s), on = (sel, ev, fn) => { const el = q(sel); if (el) el[ev] = fn; };
  on("[data-sq-pick]", "onclick", async () => {
    const r = await pickC3d(); if (!r) return;
    Q.file = r; Q.root = null; Q.c3ds = []; Q.log = []; hooks.repaint();
    // a folder granted before is found by itself; only a new folder needs the one-time confirmation
    await resultsFolder(); hooks.repaint();
  });
  on("[data-sq-pickdir]", "onclick", async () => { if (await pickC3dFolder()) hooks.repaint(); });
  on("[data-sq-trialsel]", "onchange", async (e) => { await chooseTrial(e.target.value); hooks.repaint(); });
  on("[data-sq-staticsel]", "onchange", async (e) => { Q.staticFile = e.target.value ? { handle: null, file: await (await Q.root.getFileHandle(e.target.value)).getFile() } : null; hooks.repaint(); });
  on("[data-sq-static]", "onclick", async () => { const r = await pickC3d(); if (!r) return; Q.staticFile = r; hooks.repaint(); });
  on("[data-sq-staticclear]", "onclick", () => { Q.staticFile = null; hooks.repaint(); });
  on("[data-sq-folder]", "onclick", async () => { await resultsFolder(); hooks.repaint(); });
  on("[data-sq-export]", "onchange", (e) => { Q.export = !e.target.checked; hooks.repaint(); });
  on("[data-sq-sec]", "onchange", (e) => { const v = parseFloat(e.target.value); if (v > 0) Q.staticSeconds = v; });
  if (!Q.setupLoaded) loadSetupDir().then(() => Q.setupDir && hooks.repaint());
  if (!Q.restored) restoreC3dFolder().then((ok) => ok && hooks.repaint());
  on("[data-sq-setup]", "onclick", async () => { try { Q.setupDir = await window.showDirectoryPicker({ mode: "read" }); await saveSetupDir(Q.setupDir); hooks.repaint(); } catch { /* cancelled */ } });
  on("[data-sq-setupclear]", "onclick", async () => { Q.setupDir = null; await saveSetupDir(null); hooks.repaint(); });
  on("[data-sq-run]", "onclick", () => runQuick(ctx, hooks));
  on("[data-sq-figs]", "onclick", () => redoFigures(ctx, hooks));
}
