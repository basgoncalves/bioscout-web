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
    const slots = tl.slots.map((sl) => {
      const got = have[sl.id];
      return `<label class="simDrop${got ? " has" : ""}" data-drop="${tl.id}:${sl.id}">
        <input type="file" accept="${sl.ext.join(",")}" data-file="${tl.id}:${sl.id}" hidden>
        <span class="simSlot">${esc(slotLabel(tl.id, sl))}${sl.required ? " *" : ""}</span>
        <span class="sub">${got ? `✓ ${t("sim_dropped")} (${sizeText(got)}) <a href="#" data-clear="${tl.id}:${sl.id}">${t("pr_remove")}</a>`
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
      ${slots}${opts ? `<div class="simOpts">${opts}</div>` : ""}
      <button type="button" data-run="${tl.id}" style="margin-top:10px"${!job.model || busy ? " disabled" : ""}>${esc(t("sim_run", { tool: t("sim_tool_" + tl.id) }))}</button>
      ${stateLine(sp)}${outHTML}
    </details>`;
  }).join("");
  return `<div class="simModel">
      <label for="simModel">${t("sim_model")}</label>
      <select id="simModel"><option value="">${t("sim_chooseModel")}</option>${models.map((m) => `<option value="${esc(m)}"${m === job.model ? " selected" : ""}>${esc(m)}</option>`).join("")}</select>
      <p class="note" style="margin:6px 0 0">${t("sim_modelNote")}</p>
    </div>
    ${ctx.err ? `<p class="note banner" style="margin:8px 0 0">${esc(ctx.err)}</p>` : ""}
    <div class="simTools">${sections}</div>
    <p class="note" style="margin:10px 0 0">${t("sim_templatesNote")}</p>`;
}

/** A slot's label: a tool-specific key first (sim_slot_id_grf_mot), then the slot's, then the engine's English. */
function slotLabel(tool, sl) {
  for (const k of [`sim_slot_${tool}_${sl.id}`, `sim_slot_${sl.id}`]) { const v = T(k); if (v !== k) return v; }
  return sl.label;
}
let T = (k) => k;

/** Wire the drawn page. */
export function simWire(box, ctx) {
  const { client, job } = ctx, id = job.id;
  const sel = box.querySelector("#simModel");
  if (sel) sel.onchange = () => sel.value && ctx.act(() => client.setModel(id, sel.value));
  box.querySelectorAll("details.simTool").forEach((d) => { d.ontoggle = () => { d.open ? ctx.open.add(d.dataset.tool) : ctx.open.delete(d.dataset.tool); }; });
  const send = (key, file) => { const [tool, slot] = key.split(":"); ctx.act(() => client.toolUpload(id, tool, slot, file)); };
  box.querySelectorAll("[data-file]").forEach((inp) => { inp.onchange = () => inp.files[0] && send(inp.dataset.file, inp.files[0]); });
  box.querySelectorAll("[data-drop]").forEach((z) => {
    z.ondragover = (e) => { e.preventDefault(); z.classList.add("over"); };
    z.ondragleave = () => z.classList.remove("over");
    z.ondrop = (e) => { e.preventDefault(); z.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) send(z.dataset.drop, f); };
  });
  box.querySelectorAll("[data-clear]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); const [tool, slot] = a.dataset.clear.split(":"); ctx.act(() => client.toolClear(id, tool, slot)); }; });
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
