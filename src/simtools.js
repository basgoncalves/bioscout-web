/**
 * simtools.js -- the Simulate page: one OpenSim / CEINMS tool per section.
 *
 *   Scale · Inverse kinematics · Inverse dynamics · Muscle analysis ·
 *   Residual reduction analysis · Static optimisation · CEINMS
 *
 * The model is chosen once from the engine's list. Each section has a drop
 * area per input file; a file not dropped is taken from an earlier section
 * (scaled model, IK angles, GRF.xml ...) or from the template setup files,
 * which this app also carries (data/opensim/setup_files, the same files as
 * bioscout/setup_files) so they can be read and downloaded without the engine.
 *
 * OpenSim runs in the lab engine on a PC (bioscout/lab/web_engine.py +
 * tools.py); this module only draws the page and talks to it.
 */
import { parseTrc, parseGrfMot, editTaskWeights, viewTrc } from "./trcview.js";
import { buildSetup, downloadText } from "./simsetup.js";
import { makeZip } from "./zip.js";
import { readC3d } from "./proc_io.js";
import { sessionHTML, sessionWire, S as session, openSingleSession, exportC3d, runAll, applySelection, createIteration, iterationDefaults, setStaticTrial, setTrialFlag, trialFlag, setT as sessionT, readActuators, saveActuators, emgMapInfo, saveEmgMap, timeRanges, saveTimeRanges, trialData, eventWindow, setSubject, weightFromStatic, setBodyMass } from "./simsession.js";
import { quickHTML, quickWire, quickFooterHTML, Q as quick } from "./simquick.js";
const SETUP_TOOLS = new Set(["scale", "ik", "id", "ma", "so"]);   // steps whose OpenSim setup .xml can be written before running
const TPL = "./data/opensim/setup_files/";
let spec = null;
export async function loadSpec() {
  if (spec) return spec;
  try { spec = await (await fetch(new URL("../data/opensim/tools.json", import.meta.url))).json(); } catch { spec = { tools: [], models: [] }; }
  return spec;
}

const sizeText = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

/**
 * Draw the connected Simulate page into `box`.
 * ctx: { t, esc, client, health, job, outputs: {tool: files|null}, open: Set, err,
 *        act(fn) -> runs an engine request and repaints, openInProcess(file) }
 */
/* Android and iOS pickers grey out every file whose MIME type they do not know,
 * and .trc / .mot / .sto / .osim / .c3d are unknown to them -- the slots could
 * not be filled from a phone (Bas, 2026-10-15). On a phone, no filter at all. */
const PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
const acceptAttr = (exts) => (PHONE ? "" : `accept="${exts}"`);
export function simHTML(ctx) {
  const { t, esc, health, job } = ctx;
  T = t;
  const models = (health.models && health.models.length ? health.models : spec.models) || [];
  const stateLine = (sp) => {
    if (!sp || !sp.state || sp.state === "idle") return "";
    const text = sp.state === "queued" ? t("osimQueued", { n: sp.ahead || 0 })
      : sp.state === "running" ? t("osimRunning", { s: Math.max(0, Math.round(Date.now() / 1000 - sp.started)) })
      : sp.state === "done" ? t("osimDone", { s: sp.seconds ?? 0 }) : t("osimFailed", { err: sp.error || "" });
    const log = sp.log && sp.log.length ? `<details><summary class="sub" style="cursor:pointer">${t("osimLog")}</summary><div class="osimLog">${sp.log.map(esc).join("\n")}</div></details>` : "";
    return `<p class="osimState${sp.state === "error" ? " err" : ""}">${esc(text)}</p>${sp.state === "error" || sp.state === "done" ? log : ""}`;
  };
  const badge = (sp) => (!sp || !sp.state || sp.state === "idle" ? "" : `<span class="simBadge ${sp.state}">${esc(t("sim_st_" + sp.state))}</span>`);
  const sections = spec.tools.map((tl, i) => {
    const sp = (job.tools || {})[tl.id] || { state: "idle" }, have = sp.inputs || {};
    const slots = tl.slots.filter((sl) => sl.id !== "model").map((sl) => {
      const got = have[sl.id], fname = dropNames[`${tl.id}:${sl.id}`];
      return `<label class="simDrop${got ? " has" : ""}" data-drop="${tl.id}:${sl.id}">
        <input type="file" ${acceptAttr(sl.ext.join(","))} data-file="${tl.id}:${sl.id}" hidden>
        <span class="simSlot">${esc(slotLabel(tl.id, sl))}${sl.required ? " *" : ""}</span>
        <span class="sub">${got ? `✓ ${fname ? `<b class="simFname">${esc(fname)}</b>` : t("sim_dropped")} (${sizeText(got)}) <a href="#" data-clear="${tl.id}:${sl.id}">${t("pr_remove")}</a>`
          : `${t("sim_dropHere")} ${sl.ext.join(" ")}${sl.template ? ` · ${t("sim_default")}: <a href="${TPL}${esc(sl.template)}" download>${esc(sl.template)}</a>` : ""}`}</span>
      </label>`;
    }).join("");
    const autoMode = (!ctx.quick && !ctx.batch && session.single && session.root) || (ctx.batch && session.root && session.session);
    const ceMode = (((job.options || {}).ceinms || {}).mode || (tl.defaults || {}).mode || "execution");
    const CE_SHOW = { execution: ["alpha", "beta", "gamma"], loop: ["alphas", "betas", "gammas"], optimise: ["alpha", "beta", "tol"] };
    const opts = Object.entries(tl.options || {}).filter(([k]) => !(autoMode && tl.id === "ik" && (k === "t0" || k === "t1")))
      .filter(([k]) => tl.id !== "ceinms" || ["mode", "approach", "jra"].includes(k) || (CE_SHOW[ceMode] || CE_SHOW.execution).includes(k)).map(([k, lbl]) => {
      const v = ((job.options || {})[tl.id] || {})[k] ?? (tl.defaults || {})[k] ?? "";
      const ch = (tl.choices || {})[k];
      const field = ch ? `<select data-opt="${tl.id}:${k}">${ch.map((c) => `<option value="${esc(c)}"${c === v ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`
        : `<input type="text" data-opt="${tl.id}:${k}" value="${esc(v)}">`;
      return `<label class="simOpt">${esc(t("sim_opt_" + k) !== "sim_opt_" + k ? t("sim_opt_" + k) : lbl)} ${field}</label>${k === "approach" ? `<span style="flex-basis:100%;height:0"></span>` : ""}`;
    }).join("");
    const busy = sp.state === "queued" || sp.state === "running";
    const outs = ctx.outputs[tl.id];
    const outHTML = sp.state === "done" && outs ? `<div class="simOuts"><b>${t("sim_outputs")}</b>${outs.length ? outs.map((f) => `<div class="simOut">
        <a href="${esc(ctx.client.toolFileUrl(job.id, tl.id, f.path))}" download>${esc(f.path)}</a> <span class="sub">${sizeText(f.size)}</span>
        ${/\.(mot|sto|trc)$/i.test(f.path) ? `<button type="button" class="ghost" data-openproc="${tl.id}:${esc(f.path)}">${t("sim_openProcess")}</button>` : ""}</div>`).join("") : `<p class="note">${t("sim_noOutputs")}</p>`}</div>` : "";
    const step = !ctx.quick && !ctx.batch;
    const auto = (step && session.single && session.root) || (ctx.batch && session.root && session.session);   // inputs come from the session
    const skipSet = ctx.quick ? quick.skip : ctx.batch || step ? session.skip : null;
    const skipped = !!skipSet && skipSet.has(tl.id);
    const skipBox = step ? `<input type="checkbox" class="simIncl" data-incl="${tl.id}"${skipped ? "" : " checked"} title="${esc(t("sim_inRunAll"))}" aria-label="${esc(t("sim_inRunAll"))}" onclick="event.stopPropagation()">`
      : skipSet ? `<label class="simSkip" onclick="event.stopPropagation()"><input type="checkbox" data-skip="${tl.id}"${skipped ? " checked" : ""}> ${esc(t("sq_skip"))}</label>` : "";
    return `<details class="simTool${skipped ? " skipped" : ""}"${ctx.open.has(tl.id) && (step || !skipped) ? " open" : ""} data-tool="${tl.id}">
      ${""}
      <summary>${step ? skipBox : ""}<b>${i + 1} · ${esc(t("sim_tool_" + tl.id))}</b> ${badge(sp)}${step ? "" : skipBox}</summary>
      <p class="note" style="margin:4px 0 8px">${t("sim_note_" + tl.id)}</p>
      ${step && tl.id === "ceinms_cal" && session.single && session.root ? trialTicks(ctx, "cal", t("sim_calTrials"), (x) => trialFlag(x, "calibration")) : ""}
      ${auto ? "" : slots}${auto && tl.id === "so" ? actuHTML(ctx) : ""}${auto && tl.id === "ceinms_cal" ? `<button type="button" class="ghost" data-emgmap style="margin:6px 0">${esc(t("sim_map_btn"))}</button>` : ""}${auto && tl.id === "ik" ? `<button type="button" class="ghost" data-trange style="margin-top:4px">${esc(t("sim_tr_btn"))}</button>` : ""}${opts ? `<div class="simOpts">${opts}${tl.id === "ik" && !auto ? `<button type="button" class="ghost" data-view${trcIK ? "" : " disabled"}>${esc(t("sim_v_btn"))}</button>` : ""}</div>` : ""}
      ${tl.id === "ik" ? `<button type="button" class="ghost" data-tw style="margin-top:8px">${esc(t("sim_tw_btn"))}</button>` : ""}
      ${ctx.quick ? "" : `<div class="simRunRow" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
      <button type="button" data-run="${tl.id}"${(!job.model && !genericName && !(scaledName && tl.id !== "scale")) || busy ? " disabled" : ""}>${esc(t("sim_run", { tool: t("sim_tool_" + tl.id) }))}</button>
      ${SETUP_TOOLS.has(tl.id) ? `<button type="button" class="ghost" data-setup="${tl.id}" title="${esc(t("sim_setup_title"))}">${esc(t("sim_setup_btn"))}</button>` : ""}
      ${setupMsg[tl.id] ? `<span class="sub">${esc(setupMsg[tl.id])}</span>` : ""}</div>`}
      ${stateLine(sp)}${outHTML}
      ${ctx.quick || (step && session.single && session.root) ? "" : `<div class="simOutDir"><span class="sub">${esc(t("sim_outdir"))}:</span>
        <input type="text" readonly value="${esc(dirName(tl.id) || t("sim_outdir_none"))}">
        <button type="button" class="ghost" data-dir="${tl.id}" title="${esc(t("sim_outdir_pick"))}">📁</button>
        ${sp.state === "done" && outs && outs.length && dirFor(tl.id) ? `<button type="button" class="ghost" data-save="${tl.id}">${esc(t("sim_outdir_save"))}</button>` : ""}
        ${saved[tl.id] ? `<span class="sub">✓ ${esc(saved[tl.id])}</span>` : ""}</div>`}
    </details>`;
  });
  // a model made by Scale in this browser becomes the scaled model by itself
  const made = ctx.client && ctx.client.getScaled ? ctx.client.getScaled() : null;
  if (made && made !== scaledFile) { scaledFile = made; scaledName = made.name; }
  if (!made && ctx.client && ctx.client.getScaled && scaledFile) { scaledFile = null; scaledName = ""; }
  const si = spec.tools.findIndex((tl) => tl.id === "scale");
  const scaledHTML = `<div class="simModel"><label for="simScaled">${t("sim_scaled")}</label>
      <div class="simPick"><input id="simScaled" type="text" readonly placeholder="${esc(t("sim_scaled_none"))}" value="${esc(scaledName || "")}">
        <button type="button" class="ghost" data-scaledpick title="${esc(t("sim_scaled_pick"))}">🔍</button>
        ${scaledName ? `<button type="button" class="ghost" data-scaledclear>${t("pr_remove")}</button>` : ""}
        <input type="file" ${acceptAttr(".osim")} data-scaledfile hidden></div>
      <p class="note" style="margin:6px 0 0">${t("sim_scaled_note")}</p></div>`;
  if (!ctx.quick) sections.splice(si + 1, 0, scaledHTML);
  const sectionsHTML = sections.join("");
  return `${ctx.batch ? sessionHTML(ctx) : ""}<div class="simModel">
      <label for="simModel">${t("sim_generic")}</label>
      ${genericName
        ? `<div class="simPick"><input type="text" readonly value="${esc(genericName)}"><button type="button" class="ghost" data-genericclear>${t("pr_remove")}</button></div>`
        : `<div class="simPick"><select id="simModel"><option value="">${t("sim_chooseModel")}</option>${models.map((m) => `<option value="${esc(m)}"${m === job.model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>
        <button type="button" class="ghost" data-genericpick title="${esc(t("sim_generic_pick"))}">🔍</button></div>`}
      <input type="file" ${acceptAttr(".osim")} data-genericfile hidden>
      <p class="note" style="margin:6px 0 0">${t("sim_modelNote")} ${t("sim_generic_own")}</p>
    </div>
    ${ctx.quick ? quickHTML(ctx) : ""}
    ${ctx.err ? `<p class="note banner" style="margin:8px 0 0">${esc(ctx.err)}</p>` : ""}
    <div class="simTools">${!ctx.quick && !ctx.batch ? section0(ctx) + yamlHTML(ctx) : ""}${sectionsHTML}</div>
    ${!ctx.quick && !ctx.batch ? runAllHTML(ctx) : ""}
    ${ctx.quick ? quickFooterHTML(ctx) : ""}
    <p class="note" style="margin:10px 0 0">${t("sim_templatesNote")}</p>`;
}

/* Step-by-step, section 0: the folder with the .c3d files becomes the session folder (1_c3dfiles, session.yaml,
 * 2_experimental, one iteration in 3_iterations); its trials then feed every section and Run all. */
function section0(ctx) {
  sessionT(ctx.t);
  const t = ctx.t, esc = ctx.esc, open = !!session.root && session.single, top = open && session.cfg ? session.cfg.top : {};
  const others = open ? session.trials.filter((x) => x !== top.static_trial) : [];
  const opt = (list, cur, none) => (none != null ? `<option value="">${esc(none)}</option>` : "") + list.map((x) => `<option value="${esc(x)}"${x === cur ? " selected" : ""}>${esc(x)}</option>`).join("");
  return `<details class="simTool${session.exportSkip ? " skipped" : ""}" data-tool="c3d"${ctx.open.has("c3d") || !open ? " open" : ""}>
    <summary><input type="checkbox" class="simIncl" data-incl0${session.exportSkip ? "" : " checked"} title="${esc(t("sim_inRunAll"))}" aria-label="${esc(t("sim_inRunAll"))}" onclick="event.stopPropagation()"><b>0 · ${esc(t("sim_tool_c3d"))}</b> ${open ? `<span class="simBadge done">${esc(session.name)}</span>` : ""}</summary>
    <p class="note" style="margin:4px 0 8px">${t("sim_note_c3d")}</p>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" data-sesspick>${esc(t("sim_pickC3dDir"))}</button><input type="file" webkitdirectory directory multiple data-sessdir hidden>
      <span class="sub">${open ? esc(session.name) : esc(t("sim_noC3dDir"))}</span></div>
    ${open ? `<p class="sub" style="margin:8px 0 0">${esc(t("sim_c3dSummary", { c3d: session.c3ds.length, exp: (session.exported || []).length, it: session.iteration || "–" }))}</p>
      <div class="simOpts" style="margin-top:6px">
        <label class="simOpt">${esc(t("sim_s0subject"))}<input type="text" data-s0subject value="${esc(top.subject || session.subject || "")}"></label>
        <label class="simOpt">${esc(t("sim_s0session"))}<input type="text" data-s0session value="${esc(session.sessionName || session.session || "")}"></label>
        <label class="simOpt" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-s0events${session.useEvents ? " checked" : ""} style="width:auto;margin:0"> ${esc(t("sim_s0events"))}</label>
        <label class="simOpt">${esc(t("sim_s0static"))}<select data-s0static>${opt(session.trials, top.static_trial || "", "–")}</select></label>
        </div>
      ${trialTicks(ctx, "pick", t("sim_s0trials"), (x) => !session.pick || session.pick.has(x))}
      ${trialTicks(ctx, "emg", t("sim_emgTrials"), (x) => trialFlag(x, "emg_normalisation"))}
      <div class="simRunRow" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <button type="button" data-s0convert${session.busy ? " disabled" : ""}>${esc(t("sim_s0convert"))}</button></div>` : ""}
  </details>`;
}
/* A tick list over the session's trials (the static one left out). */
function trialTicks(ctx, kind, title, isOn) {
  const esc = ctx.esc, top = session.cfg ? session.cfg.top : {}, list = session.trials.filter((x) => x !== top.static_trial);
  return `<div class="simTrials"><div class="simTrialsHead"><b>${esc(title)}</b>
      <a href="#" data-tall="${kind}:1">${esc(ctx.t("sim_all"))}</a> · <a href="#" data-tall="${kind}:0">${esc(ctx.t("sim_none"))}</a></div>
    <div class="simTrialsList">${list.map((x) => `<span class="simTrialRow"><label><input type="checkbox" data-tick="${kind}" value="${esc(x)}"${isOn(x) ? " checked" : ""}> ${esc(x)}</label>${kind === "pick" ? `<a href="#" class="simInspect" data-inspect="${esc(x)}" title="${esc(ctx.t("sim_inspect"))}">🔍</a>` : ""}</span>`).join("")}</div></div>`;
}
let yamlOpen = false, actuOpen = false, actuText = "";
function actuHTML(ctx) {
  const t = ctx.t, esc = ctx.esc;
  return `<div style="margin:6px 0"><button type="button" class="ghost" data-actuedit>${esc(t(actuOpen ? "sim_actuClose" : "sim_actuEdit"))}</button>
    ${actuOpen ? `<textarea data-actutext spellcheck="false" style="width:100%;min-height:260px;margin-top:8px;font-family:ui-monospace,monospace;font-size:12px">${esc(actuText)}</textarea>
      <div style="display:flex;gap:8px;margin-top:6px"><button type="button" data-actusave>${esc(t("sim_actuSave"))}</button><span class="sub">${esc(t("sim_actuNote"))}</span></div>` : ""}</div>`;
}
function yamlHTML(ctx) {
  if (!session.single || !session.root) return "";
  const t = ctx.t, esc = ctx.esc;
  return `<div class="simModel" style="margin-top:10px"><button type="button" class="ghost" data-yamledit>${esc(t(yamlOpen ? "sim_yamlClose" : "sim_yamlEdit"))}</button>
    ${yamlOpen ? `<textarea data-yamltext spellcheck="false" style="width:100%;min-height:320px;margin-top:8px;font-family:ui-monospace,monospace;font-size:12px">${esc(session.yaml)}</textarea>
      <div style="display:flex;gap:8px;margin-top:6px"><button type="button" data-yamlsave>${esc(t("sim_yamlSave"))}</button><span class="sub">${esc(t("sim_yamlNote"))}</span></div>` : ""}</div>`;
}
function runAllHTML(ctx) {
  const t = ctx.t, esc = ctx.esc, ok = !!session.root && session.single && !!session.iteration;
  return `<div class="simModel" style="margin-top:10px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button type="button" data-runall${!ok || session.busy ? " disabled" : ""}>${esc(t("sim_runAll"))}</button>
      ${session.busy ? `<button type="button" class="ghost" data-simcancel${session.cancel ? " disabled" : ""}>${esc(t(session.cancel ? "sim_cancelling" : "sim_cancel"))}</button>` : ""}
      <button type="button" class="ghost" data-simvis${!ok || session.busy ? " disabled" : ""}>${esc(t("sim_visualise"))}</button>
      <button type="button" class="ghost" data-simreset${session.busy ? " disabled" : ""}>${esc(t("sim_reset"))}</button>
      <span class="sub">${esc(t(ok ? "sim_runAllNote" : "sim_runAllNeed"))}</span></div>
    ${session.single && session.progress && (session.busy || session.progress.done) ? `<div class="simProg"><div class="simProgBar"><i style="width:${Math.round(100 * Math.min(1, session.progress.done / session.progress.total))}%"></i></div>
      <span class="sub">${session.progress.done}/${session.progress.total}${session.busy && session.progress.label ? ` · ${esc(session.progress.label)} …` : session.busy ? "" : " ✓"}</span></div>` : ""}
    ${session.single && session.runLog.length ? `<div class="osimLog" style="margin-top:8px">${session.runLog.map(esc).join("\n")}</div>` : ""}</div>`;
}
/** A slot's label: a tool-specific key first (sim_slot_id_grf_mot), then the slot's, then the engine's English. */
function slotLabel(tool, sl) {
  for (const k of [`sim_slot_${tool}_${sl.id}`, `sim_slot_${sl.id}`]) { const v = T(k); if (v !== k) return v; }
  return sl.label;
}
let T = (k) => k;
/* Browsers never reveal a file's folder, only its name: keep the name of
 * every file dropped this session so the slot can show what is in it. */
const dropNames = {};
const dropFiles = {};
let trcIK = null;            // the parsed motion .trc of the IK section
let scaledName = "", scaledFile = null;
let genericName = "", genericFile = null;
const setupMsg = {};         // per tool: what the last "Setup .xml" click did
const dirs = {};             // tool or "*" -> FileSystemDirectoryHandle (Chrome / Edge)
const saved = {};            // tool -> "n files -> folder"
const autoSaved = {};        // tool -> run start time already written
const renames = {};          // tool -> {output name: name to write} (batch mode: <generic>_scaled.osim -> <iteration>_scaled.osim)
const dirFor = (tool) => dirs[tool] || dirs["*"] || null;
const dirName = (tool) => (dirs[tool] ? dirs[tool].name : tool !== "*" && dirs["*"] ? dirs["*"].name + " (all)" : "");
async function saveOutputs(ctx, tool) {
  const dir = dirFor(tool), files = ctx.outputs[tool] || [];
  if (!dir || !files.length) return;
  let n = 0;
  for (const f of files) {
    let blob = ctx.client.toolBlob ? ctx.client.toolBlob(ctx.job.id, tool, f.path) : null;
    if (!blob) blob = await (await fetch(ctx.client.toolFileUrl(ctx.job.id, tool, f.path))).blob();
    const parts = ((renames[tool] || {})[f.path] || f.path).split("/"); let d = dir;
    for (const sub of parts.slice(0, -1)) d = await d.getDirectoryHandle(sub, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close(); n++;
  }
  saved[tool] = `${n} → ${dir.name}`;
}

/** Wire the drawn page. */
/* The page is redrawn on every status poll while a step runs, which put every log box back at
 * its top and closed the log <details>. Keep each one where the reader left it: a log that was
 * scrolled to the bottom (or never touched) follows the newest line; one scrolled up stays put. */
const logView = {};
function keepLogs(box) {
  box.querySelectorAll(".osimLog").forEach((el, i) => {
    const holder = el.closest("[data-tool]"), key = (holder ? holder.dataset.tool : el.closest("#simSession") ? "batch" : el.closest("#simQuick, .simQuickFoot") ? "quick" : "page") + ":" + i;
    const v = logView[key];
    if (!v || v.bottom) el.scrollTop = el.scrollHeight; else el.scrollTop = v.top;
    el.onscroll = () => { logView[key] = { top: el.scrollTop, bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4 }; };
    const det = el.closest("details:not(.simTool)");
    if (det) {
      if (logView[key + ":open"]) det.open = true;
      det.ontoggle = () => { logView[key + ":open"] = det.open; if (det.open) el.scrollTop = el.scrollHeight; };
    }
  });
}

export function simWire(box, ctx) {
  keepLogs(box);
  const { client, job } = ctx, id = job.id;
  const osimOutputsRefresh = ctx.refreshOutputs || null;
  const sel = box.querySelector("#simModel");
  if (sel) sel.onchange = () => sel.value && ctx.act(() => client.setModel(id, sel.value));
  box.querySelectorAll("details.simTool").forEach((d) => { d.ontoggle = () => { d.open ? ctx.open.add(d.dataset.tool) : ctx.open.delete(d.dataset.tool); }; });
  const ikOpts = () => ({ ...((job.options || {}).ik || {}) });
  const send = (key, file) => {
    dropNames[key] = file.name; dropFiles[key] = file;
    const [tool, slot] = key.split(":");
    if (key === "ik:motion_trc") {
      // the time range defaults to the whole trial; the returned promise settles once the engine has the file
      return file.text().then((txt) => {
        try { trcIK = parseTrc(txt); } catch { trcIK = null; }
        return ctx.act(async () => {
          await client.toolUpload(id, tool, slot, file);
          if (!trcIK) return client.status(id);
          const T = trcIK.t;
          return client.toolOptions(id, "ik", { ...ikOpts(), t0: String(+T[0].toFixed(5)), t1: String(+T[T.length - 1].toFixed(5)) });
        });
      });
    }
    return ctx.act(() => client.toolUpload(id, tool, slot, file));
  };
  box.querySelectorAll("[data-dir]").forEach((b) => {
    b.onclick = async () => {
      if (!window.showDirectoryPicker) { alert(ctx.t("sim_outdir_unsupported")); return; }
      try { dirs[b.dataset.dir] = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return; }
      ctx.act(() => client.status(id));
    };
  });
  box.querySelectorAll("[data-save]").forEach((b) => {
    b.onclick = async () => { try { await saveOutputs(ctx, b.dataset.save); } catch (e) { saved[b.dataset.save] = "✗ " + e.message; } ctx.act(() => client.status(id)); };
  });
  // finished runs go to their output folder by themselves, once per run
  for (const [tool, sp] of Object.entries(job.tools || {})) {
    if (sp.state === "done" && dirFor(tool) && (ctx.outputs[tool] || []).length && autoSaved[tool] !== sp.started) {
      autoSaved[tool] = sp.started;
      saveOutputs(ctx, tool).catch((e) => { saved[tool] = "✗ " + e.message; }).then(() => ctx.act(() => client.status(id)));
    }
  }
  const gf = box.querySelector("[data-genericfile]");
  if (gf) {
    const uploadGeneric = (f) => ctx.act(async () => {
      // the lab engine: Scale starts from it, and so do the later steps unless a scaled model is set
      let st = null;
      for (const tl of spec.tools) if (tl.slots.some((x) => x.id === "model") && (tl.id === "scale" || !scaledFile)) st = f ? await client.toolUpload(id, tl.id, "model", f) : await client.toolClear(id, tl.id, "model");
      return st || client.status(id);
    });
    const gp = box.querySelector("[data-genericpick]");
    if (gp) gp.onclick = () => gf.click();
    gf.onchange = () => {
      const f = gf.files[0]; if (!f) return;
      genericName = f.name; genericFile = f;
      if (client.setGeneric) { client.setGeneric(f); ctx.act(() => client.status(id)); return; }
      uploadGeneric(f);
    };
    const gc = box.querySelector("[data-genericclear]");
    if (gc) gc.onclick = () => {
      genericName = ""; genericFile = null;
      if (client.setGeneric) { client.setGeneric(null); ctx.act(() => client.status(id)); return; }
      uploadGeneric(null);
    };
  }
  const sf = box.querySelector("[data-scaledfile]");
  if (sf) {
    box.querySelector("[data-scaledpick]").onclick = () => sf.click();
    sf.onchange = () => {
      const f = sf.files[0]; if (!f) return;
      scaledName = f.name; scaledFile = f;
      if (client.setScaled) { client.setScaled(f); ctx.act(() => client.status(id)); return; }
      // the lab engine: the same model goes to every section after Scale
      ctx.act(async () => {
        let st = null;
        for (const tl of spec.tools) if (tl.id !== "scale" && tl.slots.some((x) => x.id === "model")) st = await client.toolUpload(id, tl.id, "model", f);
        return st || client.status(id);
      });
    };
    const sc = box.querySelector("[data-scaledclear]");
    if (sc) sc.onclick = () => {
      scaledName = ""; scaledFile = null;
      if (client.setScaled) { client.setScaled(null); ctx.act(() => client.status(id)); return; }
      ctx.act(async () => {
        let st = null;
        for (const tl of spec.tools) if (tl.id !== "scale" && tl.slots.some((x) => x.id === "model")) st = await client.toolClear(id, tl.id, "model");
        return st || client.status(id);
      });
    };
  }
  const vb = box.querySelector("[data-view]");
  if (vb) vb.onclick = async () => {
    const o = ikOpts();
    const r = await viewTrc(ctx.t, trcIK, [o.t0 === "" || o.t0 == null ? NaN : +o.t0, o.t1 === "" || o.t1 == null ? NaN : +o.t1]);
    if (r) ctx.act(() => client.toolOptions(id, "ik", { ...o, t0: String(r.t0), t1: String(r.t1) }));
  };
  const tw = box.querySelector("[data-tw]");
  if (tw) tw.onclick = async () => {
    let xml = null;
    try {
      xml = dropFiles["ik:taskset"] ? await dropFiles["ik:taskset"].text()
        : await (await fetch(new URL("../data/opensim/setup_files/IK_task_set.xml", import.meta.url))).text();
    } catch { xml = null; }
    const out = await editTaskWeights(ctx.t, { names: trcIK ? trcIK.names : [], xml });
    if (out) send("ik:taskset", new File([out], "IK_task_set_edited.xml", { type: "text/xml" }));
  };
  box.querySelectorAll("[data-file]").forEach((inp) => { inp.onchange = () => inp.files[0] && send(inp.dataset.file, inp.files[0]); });
  box.querySelectorAll("[data-drop]").forEach((z) => {
    z.ondragover = (e) => { e.preventDefault(); z.classList.add("over"); };
    z.ondragleave = () => z.classList.remove("over");
    z.ondrop = (e) => { e.preventDefault(); z.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) send(z.dataset.drop, f); };
  });
  box.querySelectorAll("[data-clear]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); delete dropNames[a.dataset.clear]; delete dropFiles[a.dataset.clear]; if (a.dataset.clear === "ik:motion_trc") trcIK = null; const [tool, slot] = a.dataset.clear.split(":"); ctx.act(() => client.toolClear(id, tool, slot)); }; });
  box.querySelectorAll("[data-opt]").forEach((inp) => {
    inp.onchange = () => {
      const [tool, key] = inp.dataset.opt.split(":"), o = { ...((job.options || {})[tool] || {}) };
      // an approach (CEINMS) fills in its alpha / beta / gamma; they stay editable
      const pre = (((spec.tools.find((x) => x.id === tool) || {}).presets || {})[key] || {})[inp.value];
      if (pre) for (const [pk, pv] of Object.entries(pre)) { const el = box.querySelector(`[data-opt="${tool}:${pk}"]`); if (el) el.value = pv; }
      box.querySelectorAll(`[data-opt^="${tool}:"]`).forEach((x) => { o[x.dataset.opt.split(":")[1]] = x.value; });
      ctx.act(() => client.toolOptions(id, tool, o));
    };
  });
  // the ik.mot a later step would use: dropped here, or the one IK made in this session
  const motTextFor = async (filesOf) => {
    if (filesOf.ik_mot) return filesOf.ik_mot.text();
    try {
      if ((ctx.outputs.ik || []).some((f) => f.path === "ik.mot")) {
        const blob = client.toolBlob ? client.toolBlob(id, "ik", "ik.mot") : await (await fetch(client.toolFileUrl(id, "ik", "ik.mot"))).blob();
        if (blob) return blob.text();
      }
    } catch { /* no time range then */ }
    return null;
  };
  box.querySelectorAll("[data-setup]").forEach((b) => {
    b.onclick = async () => {
      const tool = b.dataset.setup;
      const names = {}, filesOf = {};
      for (const [k, v] of Object.entries(dropNames)) if (k.startsWith(tool + ":")) names[k.slice(tool.length + 1)] = v;
      for (const [k, v] of Object.entries(dropFiles)) if (k.startsWith(tool + ":")) filesOf[k.slice(tool.length + 1)] = v;
      // files not dropped here come from earlier steps, as the run itself would take them
      if (!names.ik_mot && (ctx.outputs.ik || []).some((f) => f.path === "ik.mot")) names.ik_mot = "ik.mot";
      const model = tool === "scale" ? (genericName || job.model) : (names.model || scaledName || genericName || job.model);
      const setupFile = filesOf.scale_setup || filesOf.so_setup || null;
      const trcFile = filesOf.static_trc || filesOf.motion_trc || null;
      try {
        const r = await buildSetup({ tool, names, files: filesOf, options: (job.options || {})[tool] || {}, model, setupFile,
          trcText: trcFile ? await trcFile.text() : null, motText: await motTextFor(filesOf) });
        if (!r) throw new Error("no template for this step");
        downloadText(r.name, r.xml);
        setupMsg[tool] = "✓ " + r.name;
      } catch (e) { setupMsg[tool] = "✗ " + e.message; }
      ctx.act(() => client.status(id));
    };
  });
  box.querySelectorAll("[data-run]").forEach((b) => { b.onclick = () => { ctx.open.add(b.dataset.run); ctx.act(() => client.toolRun(id, b.dataset.run)); }; });
  // batch mode: the project folder feeds the sections and takes their outputs; quick run: one c3d does
  const modeHooks = {
    send,
    setDir: (tool, h) => { if (h) dirs[tool] = h; else delete dirs[tool]; },
    setRenames: (tool, map) => { renames[tool] = map || {}; },
    clear: (tool, slot) => { delete dropNames[`${tool}:${slot}`]; delete dropFiles[`${tool}:${slot}`]; return client.toolClear(id, tool, slot).catch(() => {}); },
    // every output of a finished step as {path, data} (for a .zip when no folder was granted)
    outputs: async (tool) => {
      const list = (await client.toolOutputs(id, tool)).files || [], out = [];
      for (const f of list) { let blob = client.toolBlob ? client.toolBlob(id, tool, f.path) : null; if (!blob) blob = await (await fetch(client.toolFileUrl(id, tool, f.path))).blob(); out.push({ path: f.path, data: new Uint8Array(await blob.arrayBuffer()) }); }
      return out;
    },
    setOption: (tool, key, val) => ctx.act(() => client.toolOptions(id, tool, { ...((job.options || {})[tool] || {}), [key]: val })),
    setGeneric: (f) => { genericName = f ? f.name : ""; genericFile = f; if (client.setGeneric) client.setGeneric(f); },
    setScaled: (f) => { scaledName = f ? f.name : ""; scaledFile = f; if (client.setScaled) client.setScaled(f); },
    genericName: () => genericName || job.model || "",
    genericFile: () => genericFile,
    markersetFile: () => dropFiles["scale:markerset"] || null,
    save: (tool) => ctx.act(async () => { osimOutputsRefresh && await osimOutputsRefresh(); await saveOutputs(ctx, tool); return client.status(id); }),
    repaint: () => ctx.act(() => client.status(id)),
  };
  box.querySelectorAll("[data-skip]").forEach((cb) => { cb.onchange = () => { const set = ctx.quick ? quick.skip : session.skip; cb.checked ? set.add(cb.dataset.skip) : set.delete(cb.dataset.skip); ctx.act(() => client.status(id)); }; });
  { const ae = box.querySelector("[data-actuedit]"); if (ae) ae.onclick = async () => { if (actuOpen) actuOpen = false; else { actuText = (await readActuators()) || ""; actuOpen = true; } modeHooks.repaint(); }; }
  { const as = box.querySelector("[data-actusave]"); if (as) as.onclick = async () => { await saveActuators(box.querySelector("[data-actutext]").value); actuOpen = false; await applySelection(modeHooks); modeHooks.repaint(); }; }
  { const mb = box.querySelector("[data-emgmap]"); if (mb) mb.onclick = () => editEmgMap(ctx, modeHooks); }
  { const tb = box.querySelector("[data-trange]"); if (tb) tb.onclick = () => editTimeRanges(ctx, modeHooks); }
  if (ctx.batch) sessionWire(box, ctx, modeHooks);
  if (!ctx.batch && !ctx.quick) stepWire(box, ctx, modeHooks);
  if (ctx.quick) quickWire(box, ctx, modeHooks);
  box.querySelectorAll("[data-openproc]").forEach((b) => {
    b.onclick = async () => {
      const [tool, ...rest] = b.dataset.openproc.split(":"), path = rest.join(":");
      const r = await fetch(client.toolFileUrl(id, tool, path));
      const blob = await r.blob();
      ctx.openInProcess(new File([blob], `${tool}_${path.split("/").pop()}`));
    };
  });
}

/* Step-by-step: section 0 (the c3d folder as the session), the "include in Run all" ticks, Run all. */
function stepWire(box, ctx, hooks) {
  const log = (m) => { session.runLog.push(m); hooks.repaint(); };
  const busy = async (fn) => { session.busy = true; session.runLog = []; hooks.repaint(); try { await fn(); } catch (e) { log("✗ " + e.message); console.error(e); } finally { session.busy = false; hooks.repaint(); } };
  const on = (sel, ev, fn) => { const el = box.querySelector(sel); if (el) el[ev] = fn; };
  // the picked folder is only READ (the browser's file input asks for no write access); the session is built in
  // the browser's private storage and handed over as a .zip -- nothing is written into the user's folders
  const dirIn = box.querySelector("[data-sessdir]");
  on("[data-sesspick]", "onclick", () => dirIn && dirIn.click());
  if (dirIn) dirIn.onchange = () => busy(async () => {
    // a folder of .c3d files, or a session folder (1_c3dfiles/, session.yaml, 2_experimental/ already exported)
    const rel = (f) => (f.webkitRelativePath || f.name).split("/");
    const c3ds = [...dirIn.files].filter((f) => { const r = rel(f); return /\.c3d$/i.test(f.name) && (r.length === 2 || (r.length === 3 && /^1?_?c3d_?files$/i.test(r[1]))); });
    const extra = [...dirIn.files].filter((f) => { const r = rel(f); return (r.length === 2 && r[1] === "session.yaml") || (r.length > 2 && r[1] === "2_experimental"); });
    if (!c3ds.length && !extra.some((f) => rel(f)[1] === "2_experimental")) throw new Error(ctx.t("sim_noC3dIn"));
    let name = rel(c3ds[0] || extra[0])[0] || "session";
    if (/^1?_?c3d_?files$/i.test(name)) name = "session";
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error(ctx.t("sim_outdir_unsupported"));
    const opfs = await navigator.storage.getDirectory(), area = await opfs.getDirectoryHandle("bioscout_sessions", { create: true });
    // every pick starts a fresh session: nothing from earlier sessions is kept in the browser
    for await (const [n] of area.entries()) { try { await area.removeEntry(n, { recursive: true }); } catch { /* in use */ } }
    const keepG = genericFile, keepLog = session.runLog;            // the chosen generic model stays; everything else starts over
    await resetSim(); if (keepG) hooks.setGeneric(keepG); session.busy = true; session.runLog = keepLog;
    const root = await area.getDirectoryHandle(name, { create: true }), cd = await root.getDirectoryHandle("1_c3dfiles", { create: true });
    for (const f of c3ds) {
      let had = null; try { had = await (await cd.getFileHandle(f.name)).getFile(); } catch { /* new */ }
      if (had && had.size === f.size) continue;
      const w = await (await cd.getFileHandle(f.name, { create: true })).createWritable(); await w.write(f); await w.close(); log(`${f.name} → 1_c3dfiles/`);
    }
    if (extra.length) {
      for (const f of extra) {
        const r = rel(f).slice(1); let d = root;
        for (const part of r.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
        const w = await (await d.getFileHandle(r[r.length - 1], { create: true })).createWritable(); await w.write(f); await w.close();
      }
      log(`${extra.length} files of 2_experimental${extra.some((f) => rel(f)[1] === "session.yaml") ? " + session.yaml" : ""} copied`);
    }
    ctx.open.add("c3d");
    await openSingleSession(root, log);
    // the marker set that fits these captures: the bundled one sharing most marker names with the static trial
    let ms = hooks.markersetFile();
    if (!ms || (MARKERSETS.includes(ms.name) && !ms.fitted)) {   // nothing dropped, or a bundled set picked earlier: choose (again) and fit it
      const best = await bestMarkerset(root, log);
      if (best) { ms = best; hooks.send("scale:markerset", best); }
    }
    if (ms && ms.available && ms.available.size) {
      try {
        const tpl = await (await fetch(new URL("../data/opensim/setup_files/setup_scale.xml", import.meta.url))).text();
        const r = filterScaleSetup(tpl, ms.available), f = new File([r.xml], "setup_scale.xml", { type: "text/xml" });
        hooks.send("scale:scale_setup", f); ms.scaleSetup = f;
        log(`setup_scale.xml: ${r.dropped.length} marker pairs without markers dropped${r.off.length ? `, ${r.off.join(", ")} not scaled from markers` : ""}, ${r.tasks} fitting tasks off`);
      } catch (e) { log(`setup_scale.xml: ${e.message}`); }
    }
    if (session.iteration && ms) {               // an existing iteration takes the better marker set too
      const it0 = session.iteration, re = new RegExp(`(\n  ${it0}:[\\s\\S]*?\n    markerset:\\s*)(\\S+)`);
      const m = session.yaml.match(re);
      if (m && m[2] !== ms.name) {
        session.yaml = session.yaml.replace(re, `$1${ms.name}`);
        const itd = await (await root.getDirectoryHandle("3_iterations", { create: true })).getDirectoryHandle(it0, { create: true });
        const w1 = await (await itd.getFileHandle(ms.name, { create: true })).createWritable(); await w1.write(ms); await w1.close();
        const w2 = await (await root.getFileHandle("session.yaml", { create: true })).createWritable(); await w2.write(session.yaml); await w2.close();
        log(`${it0}: markerset ${m[2]} → ${ms.name} (re-run Scale and IK)`);
        if (ms.scaleSetup) { const w3 = await (await itd.getFileHandle("setup_scale.xml", { create: true })).createWritable(); await w3.write(ms.scaleSetup); await w3.close(); }
        await openSingleSession(root, () => {});
      }
    }
    if (session.iteration && ms && ms.fitted) {
      const itd = await (await root.getDirectoryHandle("3_iterations", { create: true })).getDirectoryHandle(session.iteration, { create: true });
      for (const f of [ms, ms.scaleSetup].filter(Boolean)) { const w = await (await itd.getFileHandle(f.name, { create: true })).createWritable(); await w.write(f); await w.close(); }
    }
    if (!session.iteration) {                     // one iteration, named after the generic model
      const g = hooks.genericName() || "GPK_v4_016.osim", it = (g.replace(/\.osim$/i, "").replace(/[^\w-]+/g, "_").toLowerCase()) || "bioscout_web";
      const fields = { ...iterationDefaults(it, g), markerset: ms ? ms.name : "markers_pyCGM.xml", scale_tool: "setup_scale.xml", so_actuators: "actuators_so.xml" };
      await createIteration(it, fields, { genericFile: hooks.genericFile(), markersetFile: ms });
      if (ms && ms.fitted) { const itd = await (await root.getDirectoryHandle("3_iterations", { create: true })).getDirectoryHandle(it, { create: true });
        for (const f of [ms, ms.scaleSetup].filter(Boolean)) { const w = await (await itd.getFileHandle(f.name, { create: true })).createWritable(); await w.write(f); await w.close(); } }
      log(`3_iterations/${it}/ ${ctx.t("sim_itMade")}`);
    }
    if (!session.cfg.top.body_mass) {            // body mass from the static trial's force plates (Scale needs it)
      try { const w = await weightFromStatic(); if (w.kg > 20 && w.kg < 250) { await setBodyMass(w.kg); log(`body_mass ${w.kg.toFixed(1)} kg (${w.trial}, ${w.plates} plates)`); } }
      catch (e) { log(`body_mass: ${e.message}`); }
    }
    log(ctx.t("sim_c3dSummary", { c3d: session.c3ds.length, exp: (session.exported || []).length, it: session.iteration }));
    await applySelection(hooks);
  });
  on("[data-yamledit]", "onclick", () => { yamlOpen = !yamlOpen; hooks.repaint(); });
  on("[data-yamlsave]", "onclick", () => busy(async () => {
    const txt = box.querySelector("[data-yamltext]").value;
    const w = await (await session.root.getFileHandle("session.yaml", { create: true })).createWritable(); await w.write(txt); await w.close();
    await openSingleSession(session.root, () => {}); await applySelection(hooks); yamlOpen = false; log(ctx.t("sim_yamlSaved"));
  }));
  on("[data-incl0]", "onchange", (e) => { session.exportSkip = !e.target.checked; hooks.repaint(); });
  box.querySelectorAll("[data-incl]").forEach((cb) => { cb.onchange = () => { cb.checked ? session.skip.delete(cb.dataset.incl) : session.skip.add(cb.dataset.incl); hooks.repaint(); }; });
  on("[data-s0static]", "onchange", async (e) => { await setStaticTrial(e.target.value); await applySelection(hooks); hooks.repaint(); });
  // trials: which ones Run all processes (the first is also the one the sections show), EMG normalisation, CEINMS calibration
  const others = () => session.trials.filter((x) => x !== (session.cfg.top || {}).static_trial);
  const setPick = async (set) => { session.pick = set; const first = others().find((x) => set.has(x)); session.trial = first || ""; await applySelection(hooks); };
  const flag = { emg: "emg_normalisation", cal: "calibration" };
  box.querySelectorAll("[data-tick]").forEach((cb) => { cb.onchange = () => busy(async () => {
    const k = cb.dataset.tick, x = cb.value;
    if (k === "pick") { const set = new Set(session.pick || others()); cb.checked ? set.add(x) : set.delete(x); await setPick(set); }
    else await setTrialFlag(x, flag[k], cb.checked);
  }); });
  box.querySelectorAll("[data-tall]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); const [k, v] = a.dataset.tall.split(":"); busy(async () => {
    if (k === "pick") await setPick(new Set(v === "1" ? others() : []));
    else for (const x of others()) if (trialFlag(x, flag[k]) !== (v === "1")) await setTrialFlag(x, flag[k], v === "1");
  }); }; });
  const ticked = () => new Set([(session.cfg.top || {}).static_trial, ...others().filter((x) => !session.pick || session.pick.has(x)), ...others().filter((x) => trialFlag(x, "calibration"))].filter(Boolean));
  on("[data-s0events]", "onchange", (e) => busy(async () => { session.useEvents = e.target.checked; for (const x of ticked()) await eventWindow(x, null, log); await applySelection(hooks); }));
  on("[data-s0subject]", "onchange", (e) => busy(async () => { const v = e.target.value.trim().replace(/[^\w.-]+/g, "_"); if (v) { await setSubject(v); session.subject = v; } }));
  on("[data-s0session]", "onchange", (e) => { session.sessionName = e.target.value.trim().replace(/[^\w.-]+/g, "_"); hooks.repaint(); });
  on("[data-s0convert]", "onclick", () => busy(async () => { await exportC3d(log, { onlyMissing: false, only: ticked() }); await applySelection(hooks); }));
  // inspect a trial in Process (converting it first if needed) before running anything on it
  box.querySelectorAll("[data-inspect]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); busy(async () => {
    const x = a.dataset.inspect, base = `2_experimental/${x}`;
    const get = async (n) => { try { let d = session.root; for (const p of base.split("/")) d = await d.getDirectoryHandle(p); return await (await d.getFileHandle(n)).getFile(); } catch { return null; } };
    if (!(await get("grf.mot")) && !(await get("marker_experimental.trc"))) await exportC3d(log, { onlyMissing: false, only: new Set([x]) });
    const files = []; for (const n of ["marker_experimental.trc", "grf.mot", "emg.mot"]) { const f = await get(n); if (f) files.push(new File([f], `${x}_${n}`)); }
    if (!files.length) throw new Error(`${x}: ${ctx.t("sim_noTrialFiles")}`);
    log(`${x}: ${files.map((f) => f.name).join(", ")} → Process`);
    ctx.openInProcess(files);
  }); }; });
  on("[data-runall]", "onclick", async () => { await runAll(ctx, hooks); if (!session.cancel) await zipSession(log); });
  // the session as it is now, straight into Visualise (no download): every file with its path inside the session
  on("[data-simvis]", "onclick", () => busy(async () => {
    const top = session.name || "session", list = [];
    const walk = async (d, pre) => { for await (const [n, h] of d.entries()) {
      if (h.kind === "directory") { if (pre === "" && n === "1_c3dfiles") continue; await walk(h, `${pre}${n}/`); continue; }
      const f = await h.getFile(); Object.defineProperty(f, "webkitRelativePath", { value: `${top}/${pre}${n}` }); list.push(f); } };
    await walk(session.root, "");
    if (!ctx.openInVisualise) throw new Error("Visualise is not available");
    ctx.openInVisualise(list, top);
  }));
  on("[data-simcancel]", "onclick", () => { session.cancel = true; hooks.repaint(); });
  on("[data-simreset]", "onclick", async () => { await resetSim({ wipeStore: true }); if (ctx.reset) ctx.reset(); else hooks.repaint(); });
}

/** The bundled marker set (markers_*.xml) sharing the most marker names with the static trial's C3D. */
const MARKERSETS = ["markers_FAIS.xml", "markers_pyCGM.xml"];
async function bestMarkerset(root, log) {
  const st = (session.cfg && session.cfg.top.static_trial) || "", name = (session.c3ds.find((n) => n.replace(/\.c3d$/i, "") === st) || session.c3ds[0]);
  if (!name) return null;
  let labels;
  try { const f = await (await (await root.getDirectoryHandle("1_c3dfiles")).getFileHandle(name)).getFile(); const mk = readC3d(await f.arrayBuffer(), name).find((d) => d.meta.markers); labels = new Set(mk ? mk.meta.markers : []); }
  catch { return null; }
  let best = null;
  for (const ms of MARKERSETS) {
    let xml; try { xml = await (await fetch(new URL("../data/opensim/setup_files/" + ms, import.meta.url))).text(); } catch { continue; }
    const names = [...xml.matchAll(/<Marker\s+name="([^"]+)"/g)].map((m) => m[1]), hit = names.filter((n) => labels.has(n)).length;
    log(`${ms}: ${hit}/${names.length} markers in ${name}`);
    if (!best || hit > best.hit) best = { ms, xml, hit, of: names.length };
  }
  if (!best || !best.hit) return null;
  log(`→ marker set ${best.ms}`);
  // markers on bodies the model does not have (arms on a lower-body model) would stop Scale: leave them out
  try {
    const gf = genericFile, osim = gf ? await gf.text() : await (await fetch(new URL("../data/opensim/models/" + (genericName || "GPK_v4_016.osim"), import.meta.url))).text();
    const bodies = new Set([...osim.matchAll(/<Body\s+name="([^"]+)"/g)].map((m) => m[1]).concat(["ground"]));
    if (bodies.size > 1) {
      const gone = [];
      best.xml = best.xml.replace(/<Marker\s+name="([^"]+)"[\s\S]*?<\/Marker>/g, (blk, nm) => {
        const b = (blk.match(/socket_parent_frame>\s*\/?(?:bodyset\/)?([^<\s]+)/) || [])[1];
        if (!b || bodies.has(b)) return blk; gone.push(`${nm} (${b})`); return "";
      });
      if (gone.length) log(`${best.ms}: ${gone.length} markers on bodies the model lacks left out — ${gone.join(", ")}`);
    }
  } catch { /* keep the set as it is */ }
  const file = new File([best.xml], best.ms, { type: "text/xml" });
  file.fitted = true;
  file.available = new Set([...best.xml.matchAll(/<Marker\s+name="([^"]+)"/g)].map((m) => m[1]).filter((n) => labels.has(n)));
  return file;
}
/** setup_scale.xml keeping only what the markers allow: a marker pair with a marker not in `have` is dropped,
 *  a measurement left without pairs is switched off, and so is a fitting task on a missing marker. */
export function filterScaleSetup(xml, have) {
  const dropped = [], off = [];
  xml = xml.replace(/<MarkerPair>[\s\S]*?<\/MarkerPair>/g, (blk) => {
    const m = blk.match(/<markers>\s*([^<]*?)\s*<\/markers>/), names = m ? m[1].split(/\s+/) : [];
    if (names.every((n) => have.has(n))) return blk; dropped.push(names.join("-")); return "";
  });
  xml = xml.replace(/<Measurement\s+name="([^"]+)"[\s\S]*?<\/Measurement>/g, (blk, name) => {
    if (/<MarkerPair>/.test(blk)) return blk; off.push(name); return blk.replace(/<apply>\s*true\s*<\/apply>/, "<apply>false</apply>");
  });
  let tasks = 0;
  xml = xml.replace(/<IKMarkerTask\s+name="([^"]+)"[\s\S]*?<\/IKMarkerTask>/g, (blk, name) => {
    if (have.has(name)) return blk; tasks++; return blk.replace(/<apply>\s*true\s*<\/apply>/, "<apply>false</apply>");
  });
  return { xml, dropped, off, tasks };
}
/** The session as a whole bioscout PROJECT -> <project>.zip in Downloads:
 *   <project>/project.yaml · models/generic/<model>.osim · models/personalised/<subject>/<session>/*_scaled*.osim
 *   setupFiles/*.xml · simulations/<subject>/<session>/{session.yaml, 1_c3dfiles, 2_experimental, 3_iterations} */
async function zipSession(log) {
  if (!session.root) return;
  const subject = ((session.cfg && session.cfg.top.subject) || session.subject || "subject").replace(/[^\w.-]+/g, "_");
  const ses = (session.sessionName || session.session || "session").replace(/[^\w.-]+/g, "_");
  const proj = `bioscout_${subject}`, simPre = `${proj}/simulations/${subject}/${ses}/`, files = [], seen = new Set();
  const add = (name, data) => { if (!seen.has(name)) { seen.add(name); files.push({ name, data }); } };
  const walk = async (d, pre) => {
    for await (const [n, h] of d.entries()) {
      if (h.kind === "directory") { await walk(h, `${pre}${n}/`); continue; }
      let data = new Uint8Array(await (await h.getFile()).arrayBuffer());
      const rel = `${pre}${n}`;
      if (rel === "session.yaml") data = new TextEncoder().encode(new TextDecoder().decode(data).replace(/^project_dir:.*$/m, "project_dir: ../../..").replace(/^session:.*$/m, `session: '${ses}'`));
      add(simPre + rel, data);
      // the project's own folders, as bioscout keeps them (copies; the session keeps its iteration-relative files too)
      const top = /^3_iterations\/[^/]+\/[^/]+$/.test(rel);
      if (top && /\.osim$/i.test(n)) add(/_scaled/i.test(n) ? `${proj}/models/personalised/${subject}/${ses}/${n}` : `${proj}/models/generic/${n}`, data);
      if (top && /\.xml$/i.test(n)) add(`${proj}/setupFiles/${n}`, data);
    }
  };
  await walk(session.root, "");
  add(`${proj}/project.yaml`, `# project.yaml -- written by BioScout Web (Simulate, step-by-step)\nschema: 1\nname: ${proj}\n`);
  for (const d of ["logs", "results"]) add(`${proj}/${d}/.keep`, "");
  const a = document.createElement("a"); a.href = URL.createObjectURL(makeZip(files));
  const d = new Date(), pad = (k) => String(k).padStart(2, "0"), stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  a.download = `${proj}_${ses}_${stamp}.zip`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  log(`${a.download}: ${files.length} files → Downloads`);
}

/** Start Simulate from nothing: every dropped file, model, output folder and the step-by-step session.
 *  wipeStore also deletes the sessions kept in this browser's private storage (downloaded zips are not touched). */
export async function resetSim({ wipeStore = false } = {}) {
  for (const o of [dropNames, dropFiles, setupMsg, dirs, saved, autoSaved, renames]) for (const k of Object.keys(o)) delete o[k];
  trcIK = null; scaledName = ""; scaledFile = null; genericName = ""; genericFile = null;
  Object.assign(session, { root: null, single: false, name: "", subject: "", session: "", sessionName: "", ses: "", yaml: "", cfg: null, trials: [], iterations: [],
    iteration: "", trial: "", c3ds: [], exported: [], msg: "", busy: false, runLog: [], progress: null, pick: null, useEvents: false, exportSkip: false,
    skip: new Set(["rra", "ceinms_cal", "ceinms"]) });
  if (wipeStore) { try { const opfs = await navigator.storage.getDirectory(); await opfs.removeEntry("bioscout_sessions", { recursive: true }); } catch { /* nothing kept */ } }
}

/** Dialog: every trial's time_range from session.yaml, editable; 🔍 shows its markers in 3D and the GRF with crop sliders. */
async function editTimeRanges(ctx, hooks) {
  const t = ctx.t, esc = ctx.esc, rows = timeRanges();
  const d = document.createElement("dialog"); d.className = "trcDlg";
  const f = (v) => (v == null ? "" : String(+(+v).toFixed(4)));
  d.innerHTML = `<h3 style="margin:0 0 4px">${esc(t("sim_tr_title"))}</h3><p class="note" style="margin:0 0 8px">${esc(t("sim_tr_note"))}</p>
    <table style="width:100%;border-collapse:collapse">${rows.map((r) => `<tr data-row="${esc(r.trial)}"><td style="padding:3px 6px"><b>${esc(r.trial)}</b></td>
      <td><input type="text" inputmode="decimal" data-a value="${f(r.range && r.range[0])}" placeholder="${esc(t("sim_tr_start"))}" style="width:90px"></td>
      <td><input type="text" inputmode="decimal" data-b value="${f(r.range && r.range[1])}" placeholder="${esc(t("sim_tr_end"))}" style="width:90px"></td>
      <td><button type="button" class="ghost" data-insp title="${esc(t("sim_tr_inspect"))}">🔍</button>
        <button type="button" class="ghost" data-whole title="${esc(t("sim_tr_whole"))}">✕</button></td></tr>`).join("")}</table>
    <div class="twBar" style="justify-content:flex-end;margin-top:10px"><button type="button" class="ghost" data-x>${esc(t("cancel"))}</button><button type="button" data-ok>${esc(t("sim_yamlSave"))}</button></div>`;
  document.body.appendChild(d); d.addEventListener("close", () => setTimeout(() => d.remove(), 0)); d.showModal();
  d.querySelectorAll("[data-row]").forEach((tr) => {
    const trial = tr.dataset.row, a = tr.querySelector("[data-a]"), b = tr.querySelector("[data-b]");
    tr.querySelector("[data-whole]").onclick = () => { a.value = ""; b.value = ""; };
    tr.querySelector("[data-insp]").onclick = async () => {
      const { trc, grf } = await trialData(trial);
      if (!trc) { alert(t("sim_tr_noTrc", { trial })); return; }
      let grfD = null; try { if (grf) grfD = parseGrfMot(grf); } catch { /* markers only */ }
      d.close();
      const r = await viewTrc(t, parseTrc(trc), [a.value === "" ? NaN : +a.value, b.value === "" ? NaN : +b.value], grfD);
      document.body.appendChild(d); d.showModal();
      if (r) { a.value = f(r.t0); b.value = f(r.t1); }
    };
  });
  d.querySelector("[data-x]").onclick = () => d.close();
  d.querySelector("[data-ok]").onclick = async () => {
    const map = {};
    d.querySelectorAll("[data-row]").forEach((tr) => {
      const a = parseFloat(tr.querySelector("[data-a]").value), b = parseFloat(tr.querySelector("[data-b]").value);
      map[tr.dataset.row] = isFinite(a) && isFinite(b) && b - a >= 0.05 ? [a, b] : null;
    });
    await saveTimeRanges(map); d.close(); await applySelection(hooks); hooks.repaint();
  };
}

/** Dialog: which model muscles each EMG channel drives (CEINMS calibration and execution). */
async function editEmgMap(ctx, hooks) {
  const t = ctx.t, esc = ctx.esc, info = await emgMapInfo();
  if (!info.channels.length) { alert(t("sim_map_noEmg")); return; }
  let map = info.map;
  const d = document.createElement("dialog"); d.className = "trcDlg";
  const rows = () => info.channels.map((ch) => `<tr><td style="padding:3px 6px;white-space:nowrap"><b>${esc(ch)}</b></td>
      <td style="width:100%"><input type="text" data-ch="${esc(ch)}" list="emgMus" value="${esc((map[ch] || []).join(" "))}" style="width:100%" placeholder="—"></td></tr>`).join("");
  const paint = () => {
    d.innerHTML = `<h3 style="margin:0 0 4px">${esc(t("sim_map_title"))}</h3><p class="note" style="margin:0 0 8px">${esc(t("sim_map_note", { trial: info.trial }))}</p>
      <datalist id="emgMus">${info.muscles.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
      <table style="width:100%;border-collapse:collapse">${rows()}</table>
      <p class="sub" style="margin:6px 0 0">${esc(t("sim_map_muscles", { n: info.muscles.length }))}</p>
      <div class="twBar" style="justify-content:space-between;margin-top:10px"><span><button type="button" class="ghost" data-auto>${esc(t("sim_map_auto"))}</button></span>
        <span><button type="button" class="ghost" data-x>${esc(t("cancel"))}</button> <button type="button" data-ok>${esc(t("sim_yamlSave"))}</button></span></div>`;
    d.querySelector("[data-auto]").onclick = () => { map = info.auto; paint(); };
    d.querySelector("[data-x]").onclick = () => d.close();
    d.querySelector("[data-ok]").onclick = async () => {
      const out = {};
      d.querySelectorAll("[data-ch]").forEach((x) => { const m = x.value.split(/[\s,;]+/).filter(Boolean); if (m.length) out[x.dataset.ch] = m; });
      await saveEmgMap(out); d.close(); await applySelection(hooks); hooks.repaint();
    };
  };
  paint();
  document.body.appendChild(d); d.addEventListener("close", () => setTimeout(() => d.remove(), 0)); d.showModal();
}
