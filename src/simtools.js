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
import { parseTrc, editTaskWeights, viewTrc } from "./trcview.js";
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
        <input type="file" accept="${sl.ext.join(",")}" data-file="${tl.id}:${sl.id}" hidden>
        <span class="simSlot">${esc(slotLabel(tl.id, sl))}${sl.required ? " *" : ""}</span>
        <span class="sub">${got ? `✓ ${fname ? `<b class="simFname">${esc(fname)}</b>` : t("sim_dropped")} (${sizeText(got)}) <a href="#" data-clear="${tl.id}:${sl.id}">${t("pr_remove")}</a>`
          : `${t("sim_dropHere")} ${sl.ext.join(" ")}${sl.template ? ` · ${t("sim_default")}: <a href="${TPL}${esc(sl.template)}" download>${esc(sl.template)}</a>` : ""}`}</span>
      </label>`;
    }).join("");
    const opts = Object.entries(tl.options || {}).map(([k, lbl]) => {
      const v = ((job.options || {})[tl.id] || {})[k] ?? "";
      return `<label class="simOpt">${esc(t("sim_opt_" + k) !== "sim_opt_" + k ? t("sim_opt_" + k) : lbl)} <input type="text" data-opt="${tl.id}:${k}" value="${esc(v)}"></label>`;
    }).join("");
    const busy = sp.state === "queued" || sp.state === "running";
    const outs = ctx.outputs[tl.id];
    const outHTML = sp.state === "done" && outs ? `<div class="simOuts"><b>${t("sim_outputs")}</b>${outs.length ? outs.map((f) => `<div class="simOut">
        <a href="${esc(ctx.client.toolFileUrl(job.id, tl.id, f.path))}" download>${esc(f.path)}</a> <span class="sub">${sizeText(f.size)}</span>
        ${/\.(mot|sto|trc)$/i.test(f.path) ? `<button type="button" class="ghost" data-openproc="${tl.id}:${esc(f.path)}">${t("sim_openProcess")}</button>` : ""}</div>`).join("") : `<p class="note">${t("sim_noOutputs")}</p>`}</div>` : "";
    return `<details class="simTool"${ctx.open.has(tl.id) ? " open" : ""} data-tool="${tl.id}">
      <summary><b>${i + 1} · ${esc(t("sim_tool_" + tl.id))}</b> ${badge(sp)}</summary>
      <p class="note" style="margin:4px 0 8px">${t("sim_note_" + tl.id)}</p>
      ${slots}${opts ? `<div class="simOpts">${opts}${tl.id === "ik" ? `<button type="button" class="ghost" data-view${trcIK ? "" : " disabled"}>${esc(t("sim_v_btn"))}</button>` : ""}</div>` : ""}
      ${tl.id === "ik" ? `<button type="button" class="ghost" data-tw style="margin-top:8px">${esc(t("sim_tw_btn"))}</button>` : ""}
      <button type="button" data-run="${tl.id}" style="margin-top:10px"${(!job.model && !(scaledName && tl.id !== "scale")) || busy ? " disabled" : ""}>${esc(t("sim_run", { tool: t("sim_tool_" + tl.id) }))}</button>
      ${stateLine(sp)}${outHTML}
      <div class="simOutDir"><span class="sub">${esc(t("sim_outdir"))}:</span>
        <input type="text" readonly value="${esc(dirName(tl.id) || t("sim_outdir_none"))}">
        <button type="button" class="ghost" data-dir="${tl.id}" title="${esc(t("sim_outdir_pick"))}">📁</button>
        ${sp.state === "done" && outs && outs.length && dirFor(tl.id) ? `<button type="button" class="ghost" data-save="${tl.id}">${esc(t("sim_outdir_save"))}</button>` : ""}
        ${saved[tl.id] ? `<span class="sub">✓ ${esc(saved[tl.id])}</span>` : ""}</div>
    </details>`;
  });
  const si = spec.tools.findIndex((tl) => tl.id === "scale");
  const scaledHTML = `<div class="simModel"><label for="simScaled">${t("sim_scaled")}</label>
      <div class="simPick"><input id="simScaled" type="text" readonly placeholder="${esc(t("sim_scaled_none"))}" value="${esc(scaledName || "")}">
        <button type="button" class="ghost" data-scaledpick title="${esc(t("sim_scaled_pick"))}">🔍</button>
        ${scaledName ? `<button type="button" class="ghost" data-scaledclear>${t("pr_remove")}</button>` : ""}
        <input type="file" accept=".osim" data-scaledfile hidden></div>
      <p class="note" style="margin:6px 0 0">${t("sim_scaled_note")}</p></div>`;
  sections.splice(si + 1, 0, scaledHTML);
  const sectionsHTML = sections.join("");
  return `<div class="simModel">
      <div class="simOutDir" style="margin:0 0 8px"><span class="sub">${esc(t("sim_outdir_all"))}:</span>
        <input type="text" readonly value="${esc(dirName("*") || t("sim_outdir_none"))}">
        <button type="button" class="ghost" data-dir="*" title="${esc(t("sim_outdir_pick"))}">📁</button></div>
      <label for="simModel">${t("sim_generic")}</label>
      <select id="simModel"><option value="">${t("sim_chooseModel")}</option>${models.map((m) => `<option value="${esc(m)}"${m === job.model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>
      <p class="note" style="margin:6px 0 0">${t("sim_modelNote")}</p>
    </div>
    ${ctx.err ? `<p class="note banner" style="margin:8px 0 0">${esc(ctx.err)}</p>` : ""}
    <div class="simTools">${sectionsHTML}</div>
    <p class="note" style="margin:10px 0 0">${t("sim_templatesNote")}</p>`;
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
const dirs = {};             // tool or "*" -> FileSystemDirectoryHandle (Chrome / Edge)
const saved = {};            // tool -> "n files -> folder"
const autoSaved = {};        // tool -> run start time already written
const dirFor = (tool) => dirs[tool] || dirs["*"] || null;
const dirName = (tool) => (dirs[tool] ? dirs[tool].name : tool !== "*" && dirs["*"] ? dirs["*"].name + " (all)" : "");
async function saveOutputs(ctx, tool) {
  const dir = dirFor(tool), files = ctx.outputs[tool] || [];
  if (!dir || !files.length) return;
  let n = 0;
  for (const f of files) {
    let blob = ctx.client.toolBlob ? ctx.client.toolBlob(ctx.job.id, tool, f.path) : null;
    if (!blob) blob = await (await fetch(ctx.client.toolFileUrl(ctx.job.id, tool, f.path))).blob();
    const parts = f.path.split("/"); let d = dir;
    for (const sub of parts.slice(0, -1)) d = await d.getDirectoryHandle(sub, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close(); n++;
  }
  saved[tool] = `${n} → ${dir.name}`;
}

/** Wire the drawn page. */
export function simWire(box, ctx) {
  const { client, job } = ctx, id = job.id;
  const sel = box.querySelector("#simModel");
  if (sel) sel.onchange = () => sel.value && ctx.act(() => client.setModel(id, sel.value));
  box.querySelectorAll("details.simTool").forEach((d) => { d.ontoggle = () => { d.open ? ctx.open.add(d.dataset.tool) : ctx.open.delete(d.dataset.tool); }; });
  const ikOpts = () => ({ ...((job.options || {}).ik || {}) });
  const send = (key, file) => {
    dropNames[key] = file.name; dropFiles[key] = file;
    const [tool, slot] = key.split(":");
    if (key === "ik:motion_trc") {
      // the time range defaults to the whole trial
      file.text().then((txt) => {
        try { trcIK = parseTrc(txt); } catch { trcIK = null; }
        ctx.act(async () => {
          await client.toolUpload(id, tool, slot, file);
          if (!trcIK) return client.status(id);
          const T = trcIK.t;
          return client.toolOptions(id, "ik", { ...ikOpts(), t0: String(+T[0].toFixed(5)), t1: String(+T[T.length - 1].toFixed(5)) });
        });
      });
      return;
    }
    ctx.act(() => client.toolUpload(id, tool, slot, file));
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
      const tool = inp.dataset.opt.split(":")[0], o = {};
      box.querySelectorAll(`[data-opt^="${tool}:"]`).forEach((x) => { o[x.dataset.opt.split(":")[1]] = x.value; });
      ctx.act(() => client.toolOptions(id, tool, o));
    };
  });
  box.querySelectorAll("[data-run]").forEach((b) => { b.onclick = () => { ctx.open.add(b.dataset.run); ctx.act(() => client.toolRun(id, b.dataset.run)); }; });
  box.querySelectorAll("[data-openproc]").forEach((b) => {
    b.onclick = async () => {
      const [tool, ...rest] = b.dataset.openproc.split(":"), path = rest.join(":");
      const r = await fetch(client.toolFileUrl(id, tool, path));
      const blob = await r.blob();
      ctx.openInProcess(new File([blob], `${tool}_${path.split("/").pop()}`));
    };
  });
}
