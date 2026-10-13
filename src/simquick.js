/**
 * simquick.js -- Quick run of Simulate: ONE c3d file, everything the engine can
 * do with it, written next to the file in <trial>_simulations/:
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

let T = (k) => k;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const Q = { root: null, name: "", c3ds: [], trial: "", static: "", staticSeconds: 1.0, busy: false, log: [], done: null };

async function listC3d(root) { const out = []; for await (const [n, h] of root.entries()) if (h.kind === "file" && /\.c3d$/i.test(n)) out.push(n); return out.sort(); }
async function writeText(dir, name, data) { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close(); }

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
  Q.busy = true; Q.log = []; Q.done = null;
  try {
    const stem = Q.trial.replace(/\.c3d$/i, "");
    const out = await Q.root.getDirectoryHandle(`${stem}_simulations`, { create: true });
    const file = async (n) => (await Q.root.getFileHandle(n)).getFile();
    for (const t of STEPS) hooks.setDir(t, out);
    // 1. the c3d -> OpenSim files
    log(`${Q.trial}: export`);
    const f = await file(Q.trial);
    const ex = c3dToOpenSim(await f.arrayBuffer(), f.name);
    for (const [n, text] of Object.entries(ex)) await writeText(out, n, text);
    log(`  → ${Object.keys(ex).join(", ")}`);
    if (!ex["marker_experimental.trc"]) throw new Error("no markers in the c3d");
    // 2. the static trial: its own c3d, or the first seconds of this one
    let staticTrc;
    if (Q.static && Q.static !== Q.trial) {
      const sf = await file(Q.static); const sx = c3dToOpenSim(await sf.arrayBuffer(), sf.name);
      staticTrc = sx["marker_experimental.trc"]; log(`${Q.static}: static trial`);
    } else { staticTrc = cropTrc(ex["marker_experimental.trc"], Q.staticSeconds); log(`static: the first ${Q.staticSeconds} s of ${Q.trial}`); }
    await writeText(out, "static_marker_experimental.trc", staticTrc);
    hooks.send("scale:static_trc", new File([staticTrc], "static_marker_experimental.trc"));
    hooks.send("ik:motion_trc", new File([ex["marker_experimental.trc"]], "marker_experimental.trc"));
    if (ex["grf.mot"]) hooks.send("id:grf_mot", new File([ex["grf.mot"]], "grf.mot"));
    await new Promise((r) => setTimeout(r, 400));
    // 3. the steps, in order, each waiting for the last
    const order = ["scale", "ik", ...(ex["grf.mot"] ? ["id", "ma", "so", "jra"] : [])];
    for (const tool of order) {
      if (!have.has(tool)) { log(`${tool}: ${T("sq_needsEngine")}`); continue; }
      log(`${tool} …`);
      await client.toolRun(id, tool);
      const sp = await wait(tool);
      if (sp.state === "error") { log(`${tool}: failed — ${sp.error}`); if (tool === "scale" || tool === "ik") break; continue; }
      await hooks.save(tool);
      log(`${tool}: done in ${sp.seconds} s`);
    }
    Q.done = `${Q.name}/${stem}_simulations`;
    log(T("sq_done", { dir: Q.done }));
  } catch (e) { log("✗ " + e.message); }
  finally { Q.busy = false; hooks.repaint(); }
}

export function quickHTML(ctx) {
  T = ctx.t; const t = ctx.t;
  const opt = (list, cur, none) => `<option value="">${esc(none)}</option>` + list.map((x) => `<option value="${esc(x)}"${x === cur ? " selected" : ""}>${esc(x)}</option>`).join("");
  return `<div class="card" id="simQuick" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${t("sq_title")}</b>
      <button type="button" class="ghost" data-sq-pick style="margin:0;width:auto;padding:6px 12px">${Q.root ? esc(Q.name) : t("sq_pick")}</button></div>
    <p class="note" style="margin:4px 0 8px">${t("sq_intro")}</p>
    ${Q.root ? `
    <div class="simOpts">
      <label class="simOpt">${t("sq_trial")} <select data-sq-trial>${opt(Q.c3ds, Q.trial, t("ss_none"))}</select></label>
      <label class="simOpt">${t("sq_static")} <select data-sq-static>${opt(Q.c3ds, Q.static, t("sq_staticNone"))}</select></label>
      <label class="simOpt">${t("sq_staticSeconds")} <input type="text" data-sq-sec value="${Q.staticSeconds}" style="width:70px"></label>
    </div>
    <p class="note" style="margin:6px 0 0">${t("sq_massNote")}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
      <button type="button" data-sq-run${Q.busy || !Q.trial ? " disabled" : ""}>${t("sq_run")}</button>
    </div>
    ${Q.log.length ? `<div class="osimLog" style="margin-top:8px">${Q.log.map(esc).join("\n")}</div>` : ""}` : ""}
  </div>`;
}

export function quickWire(box, ctx, hooks) {
  const q = (s) => box.querySelector(s), on = (sel, ev, fn) => { const el = q(sel); if (el) el[ev] = fn; };
  on("[data-sq-pick]", "onclick", async () => {
    if (!window.showDirectoryPicker) { alert(ctx.t("sim_outdir_unsupported")); return; }
    let h; try { h = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return; }
    Q.root = h; Q.name = h.name; Q.c3ds = await listC3d(h); Q.log = [];
    if (!Q.c3ds.includes(Q.trial)) Q.trial = Q.c3ds.find((n) => !/static/i.test(n)) || Q.c3ds[0] || "";
    if (!Q.c3ds.includes(Q.static)) Q.static = Q.c3ds.find((n) => /static/i.test(n)) || "";
    hooks.repaint();
  });
  on("[data-sq-trial]", "onchange", (e) => { Q.trial = e.target.value; hooks.repaint(); });
  on("[data-sq-static]", "onchange", (e) => { Q.static = e.target.value; });
  on("[data-sq-sec]", "onchange", (e) => { const v = parseFloat(e.target.value); if (v > 0) Q.staticSeconds = v; });
  on("[data-sq-run]", "onclick", () => runQuick(ctx, hooks));
}
