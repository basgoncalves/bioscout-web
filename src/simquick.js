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

export const Q = { file: null, staticFile: null, root: null, staticSeconds: 1.0, busy: false, log: [], done: null, skip: new Set(["ceinms", "rra"]) };
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
/** The folder the results go to: asked once, opening in the c3d's own folder so it is one click. null -> a .zip instead. */
async function resultsFolder() {
  if (Q.root) return Q.root;
  if (!window.showDirectoryPicker) return null;
  try { Q.root = await window.showDirectoryPicker({ mode: "readwrite" }); return Q.root; } catch { return null; }
}

/** The first `seconds` of a .trc as a static trial (the subject usually stands still before moving). */
function cropTrc(text, seconds) {
  const L = text.split(/\r?\n/), head = L.slice(0, 5), rows = L.slice(5).filter((l) => l.trim());
  const keep = rows.filter((l) => +l.split("\t")[1] <= seconds);
  head[2] = head[2].split("\t").map((v, i) => (i === 2 || i === 7 ? String(keep.length) : v)).join("\t");
  return head.join("\n") + "\n" + keep.join("\n") + "\n";
}

const STEPS = ["scale", "ik", "id", "ma", "so", "jra", "ceinms"];

export async function runQuick(ctx, hooks) {
  const { client, job } = ctx, id = job.id;
  const log = (s) => { Q.log.push(s); hooks.repaint(); };
  const wait = async (tool) => { for (;;) { await new Promise((r) => setTimeout(r, 1000)); const sp = (await client.status(id)).tools[tool]; if (sp.state === "done" || sp.state === "error") return sp; } };
  const have = new Set((ctx.health && ctx.health.tools) || STEPS);
  const out = await resultsFolder();                 // before anything runs, while the click is fresh
  Q.busy = true; Q.log = []; Q.done = null;
  const zipFiles = [];                               // when no folder: everything collected for one .zip
  const stem = Q.trial.replace(/\.c3d$/i, ""), outName = `${stem}_simulation`;
  try {
    let dir = null;
    if (out) { dir = await out.getDirectoryHandle(outName, { create: true }); for (const t of STEPS) hooks.setDir(t, dir); }
    else { log(T("sq_zipMode")); for (const t of STEPS) hooks.setDir(t, null); }
    const put = async (n, text) => { if (dir) await writeText(dir, n, text); else zipFiles.push({ name: `${outName}/${n}`, data: text }); };
    // 1. the c3d -> OpenSim files
    log(`${Q.trial}: export`);
    const f = Q.file.file;
    const ex = c3dToOpenSim(await f.arrayBuffer(), f.name);
    for (const [n, text] of Object.entries(ex)) await put(n, text);
    log(`  → ${Object.keys(ex).join(", ")}`);
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
    if (ex["grf.mot"]) hooks.send("id:grf_mot", new File([ex["grf.mot"]], "grf.mot"));
    await new Promise((r) => setTimeout(r, 400));
    // 3. the steps, in order, each waiting for the last
    const order = ["scale", "ik", ...(ex["grf.mot"] ? ["id", "ma", "rra", "so", "ceinms"] : [])];
    for (const tool of order) {
      if (Q.skip.has(tool)) { log(`${tool}: ${T("sq_skipped")}`); continue; }
      if (!have.has(tool)) { log(`${tool}: ${T("sq_needsEngine")}`); continue; }
      log(`${tool} …`);
      await client.toolRun(id, tool);
      const sp = await wait(tool);
      if (sp.state === "error") { log(`${tool}: failed — ${sp.error}`); if (tool === "scale" || tool === "ik") break; continue; }
      if (dir) await hooks.save(tool);
      else for (const o of await hooks.outputs(tool)) zipFiles.push({ name: `${outName}/${o.path}`, data: o.data });
      log(`${tool}: done in ${sp.seconds} s`);
    }
    if (dir) { Q.done = `${out.name}/${outName}`; log(T("sq_done", { dir: Q.done })); }
    else {
      const blob = makeZip(zipFiles), url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = `${outName}.zip`; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
      log(T("sq_zipped", { name: `${outName}.zip`, mb: (blob.size / 1e6).toFixed(1) }));
    }
  } catch (e) { log("✗ " + e.message); }
  finally { Q.busy = false; hooks.repaint(); }
}

export function quickHTML(ctx) {
  T = ctx.t; const t = ctx.t;
  return `<div class="simModel" id="simQuick">
    <label>${t("sq_title")}</label>
    <div class="simPick"><input type="text" readonly placeholder="${esc(t("sq_pickFile"))}" value="${esc(Q.trial)}">
      <button type="button" class="ghost" data-sq-pick title="${esc(t("sq_pickFile"))}">🔍</button></div>
    <div class="simOpts" style="margin-top:6px">
      <label class="simOpt">${t("sq_static")} <span class="simPick" style="display:inline-flex"><input type="text" readonly style="width:180px" placeholder="${esc(t("sq_staticNone"))}" value="${esc(Q.staticFile ? Q.staticFile.file.name : "")}">
        <button type="button" class="ghost" data-sq-static>🔍</button>${Q.staticFile ? `<button type="button" class="ghost" data-sq-staticclear>${t("pr_remove")}</button>` : ""}</span></label>
      ${Q.staticFile ? "" : `<label class="simOpt">${t("sq_staticSeconds")} <input type="text" data-sq-sec value="${Q.staticSeconds}" style="width:70px"></label>`}
    </div>
    <p class="note" style="margin:6px 0 0">${Q.file ? (Q.root ? t("sq_where", { dir: Q.root.name + "/" + Q.trial.replace(/\.c3d$/i, "") + "_simulation" }) : t("sq_noFolder", { dir: Q.trial.replace(/\.c3d$/i, "") + "_simulation" })) : t("sq_intro")}</p>
    ${Q.file && !Q.root ? `<button type="button" class="ghost" data-sq-folder style="margin-top:6px">${t("sq_confirmFolder")}</button>` : ""}
  </div>`;
}

export function quickFooterHTML(ctx) {
  const t = ctx.t;
  return `<div style="margin-top:12px">
    <button type="button" data-sq-run class="simGo"${Q.busy || !Q.trial ? " disabled" : ""}>${Q.busy ? t("sq_running") : t("sq_simulate")}</button>
    ${Q.log.length ? `<div class="osimLog" style="margin-top:8px">${Q.log.map(esc).join("\n")}</div>` : ""}
  </div>`;
}

export function quickWire(box, ctx, hooks) {
  const q = (s) => box.querySelector(s), on = (sel, ev, fn) => { const el = q(sel); if (el) el[ev] = fn; };
  on("[data-sq-pick]", "onclick", async () => {
    const r = await pickC3d(); if (!r) return;
    Q.file = r; Q.root = null; Q.log = []; hooks.repaint();
    // the folder right away, so Simulate itself needs no dialog: the browser can only write where you confirmed once
    await resultsFolder(); hooks.repaint();
  });
  on("[data-sq-static]", "onclick", async () => { const r = await pickC3d(); if (!r) return; Q.staticFile = r; hooks.repaint(); });
  on("[data-sq-staticclear]", "onclick", () => { Q.staticFile = null; hooks.repaint(); });
  on("[data-sq-folder]", "onclick", async () => { await resultsFolder(); hooks.repaint(); });
  on("[data-sq-sec]", "onchange", (e) => { const v = parseFloat(e.target.value); if (v > 0) Q.staticSeconds = v; });
  on("[data-sq-run]", "onclick", () => runQuick(ctx, hooks));
}
