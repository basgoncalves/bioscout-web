/**
 * localengine.js -- Simulate without a server: the same client API as the lab
 * engine (osimlab.js makeEngineClient), but the files stay in this browser and
 * the tools run in a Web Worker with Pyodide + py/pyosim (pure-Python OpenSim).
 * Scale, inverse kinematics and inverse dynamics; the other sections say they need the engine.
 */
import { markerErrorsFigure, kinematicsMomentsFigure, inverseDynamicsFigure, residualsFigure, taskFigure } from "./simfigs.js";
const LOCAL_TOOLS = new Set(["scale", "ik", "id", "so"]);
const BASE = new URL("../", import.meta.url).href;

export function makeLocalClient(spec) {
  const job = { id: "local", model: null, steps: {}, tools: {}, options: {}, local: true };
  const files = {};      // "tool:slot" -> File
  const outs = {};       // tool -> {name: text}
  const urls = {};
  for (const t of spec.tools) job.tools[t.id] = { state: "idle", inputs: {} };
  let worker = null, seq = 0;
  const snap = () => JSON.parse(JSON.stringify(job));
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };

  async function modelFile(tool) {
    const own = files[`${tool}:model`] || files["*:scaled"] || files["*:generic"];
    if (own) return own;
    if (!job.model) fail("bad_request", "choose a model first");
    const r = await fetch(BASE + "data/opensim/models/" + job.model);
    if (!r.ok) fail("bad_request", `${job.model} is not available in the browser yet`);
    return new File([await r.blob()], job.model.split("/").pop());
  }

  function runWorker(cmd, payload, args, onLog) {
    worker = worker || new Worker(new URL("./pyosim_worker.js", import.meta.url));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const h = (e) => {
        if (e.data.id !== id) return;
        if (e.data.log) onLog(e.data.log);
        if (e.data.done) { worker.removeEventListener("message", h); resolve(e.data.outputs); }
        else if (e.data.error) { worker.removeEventListener("message", h); reject(new Error(e.data.error)); }
      };
      worker.addEventListener("message", h);
      worker.postMessage({ id, cmd, files: payload, args, base: BASE }, Object.values(payload));
    });
  }

  async function runScale() {
    const sp = job.tools.scale, o = job.options.scale || {};
    const trc = files["scale:static_trc"] || fail("bad_request", "drop the static trial markers (.trc)");
    let model = files["*:generic"] || null;              // a generic .osim dropped by the user wins
    if (!model) {
      if (!job.model) fail("bad_request", "choose the generic model first");
      const r = await fetch(BASE + "data/opensim/models/" + job.model);
      if (!r.ok) fail("bad_request", `${job.model} is not available in the browser yet`);
      model = new File([await r.blob()], job.model.split("/").pop());
    }
    const setup = files["scale:scale_setup"] || new File([await (await fetch(BASE + "data/opensim/setup_files/setup_scale.xml")).blob()], "setup_scale.xml");
    const trcName = /\.trc$/i.test(trc.name) ? trc.name : "static.trc";
    const setupName = "setup_scale.xml";
    const out = model.name.replace(/\.osim$/i, "") + "_scaled.osim";
    const payload = { [model.name]: await model.arrayBuffer(), [trcName]: await trc.arrayBuffer(), [setupName]: await setup.arrayBuffer() };
    const args = { model: model.name, trc: trcName, setup: setupName, out, mass: o.mass, aliases: o.aliases };
    if (files["scale:markerset"]) { payload["markers.xml"] = await files["scale:markerset"].arrayBuffer(); args.markerset = "markers.xml"; }
    sp.log = [];
    const t0 = Date.now();
    try {
      outs.scale = await runWorker("scale", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      // the steps below use the new scaled model unless another one is chosen
      if (outs.scale[out]) files["*:scaled"] = new File([outs.scale[out]], out);
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      Object.assign(sp, { state: "error", error: e.message });
    }
  }

  async function runID() {
    const sp = job.tools.id, o = job.options.id || {};
    const grf = files["id:grf_mot"] || fail("bad_request", "drop the ground reaction forces (.mot)");
    // joint angles: dropped here, or the ik.mot this browser made
    const ikf = files["id:ik_mot"] || (outs.ik && outs.ik["ik.mot"] ? new File([outs.ik["ik.mot"]], "ik.mot") : null)
      || fail("bad_request", "drop the joint angles (.mot) or run inverse kinematics first");
    const model = await modelFile("id");
    const grfName = /\.(mot|sto)$/i.test(grf.name) ? grf.name : "grf.mot", ikName = /\.(mot|sto)$/i.test(ikf.name) ? ikf.name : "ik.mot";
    const payload = { [model.name]: await model.arrayBuffer(), [grfName]: await grf.arrayBuffer(), [ikName]: await ikf.arrayBuffer() };
    const args = { model: model.name, grf: grfName, ik: ikName, t0: o.t0, t1: o.t1, cutoff: o.cutoff };
    if (files["id:grf_xml"]) { payload["loads.xml"] = await files["id:grf_xml"].arrayBuffer(); args.loads = "loads.xml"; }
    sp.log = [];
    const t0 = Date.now();
    try {
      outs.id = await runWorker("id", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      // the figures bioscout writes next to its ID results
      const ikTxt = await ikf.text(), idTxt = outs.id["inverse_dynamics.sto"], grfTxt = await grf.text();
      try { outs.id["inverse_dynamics.png"] = await inverseDynamicsFigure(idTxt); } catch { /* optional */ }
      try {
        const xml = outs.id["GRF.xml"] || (files["id:grf_xml"] ? await files["id:grf_xml"].text() : null);
        outs.id["kinematics_moments.png"] = await taskFigure({ ikText: ikTxt, idText: idTxt, errAllText: outs.ik && outs.ik["ik_marker_errors_all.sto"],
          grfText: grfTxt, grfXml: xml, bodiesText: outs.id["body_positions.sto"] });
      } catch (e) { sp.log.push("figure: " + e.message); }
      try { outs.id["residuals.png"] = await residualsFigure(idTxt, grfTxt); } catch { /* optional */ }
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      Object.assign(sp, { state: "error", error: e.message });
    }
  }

  async function runSO() {
    const sp = job.tools.so;
    // joint angles and moments: dropped here, or what IK and ID made in this browser
    const ikf = files["so:ik_mot"] || (outs.ik && outs.ik["ik.mot"] ? new File([outs.ik["ik.mot"]], "ik.mot") : null)
      || fail("bad_request", "drop the joint angles (.mot) or run inverse kinematics first");
    const idf = files["so:id_sto"] || (outs.id && outs.id["inverse_dynamics.sto"] ? new File([outs.id["inverse_dynamics.sto"]], "inverse_dynamics.sto") : null)
      || fail("bad_request", "run inverse dynamics first");
    const model = await modelFile("so");
    let actu = files["so:actuators"] || null;
    if (!actu) { try { const r = await fetch(BASE + "data/opensim/setup_files/actuators_so.xml"); if (r.ok) actu = new File([await r.blob()], "actuators_so.xml"); } catch { /* model actuators only */ } }
    const payload = { [model.name]: await model.arrayBuffer(), "ik.mot": await ikf.arrayBuffer(), "id.sto": await idf.arrayBuffer() };
    const args = { model: model.name, ik: "ik.mot", id: "id.sto" };
    if (actu) { payload["actuators.xml"] = await actu.arrayBuffer(); args.actuators = "actuators.xml"; }
    sp.log = [];
    const t0 = Date.now();
    try {
      outs.so = await runWorker("so", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      Object.assign(sp, { state: "error", error: e.message });
    }
  }

  async function runIK() {
    const sp = job.tools.ik, o = job.options.ik || {};
    const trc = files["ik:motion_trc"] || fail("bad_request", "drop the motion trial markers (.trc)");
    const model = await modelFile("ik");
    const trcName = /\.trc$/i.test(trc.name) ? trc.name : "motion.trc";
    const payload = { [model.name]: await model.arrayBuffer(), [trcName]: await trc.arrayBuffer() };
    const args = { model: model.name, trc: trcName, t0: o.t0, t1: o.t1 };
    if (files["ik:taskset"]) { payload["tasks.xml"] = await files["ik:taskset"].arrayBuffer(); args.tasks = "tasks.xml"; }
    // a marker set dropped in Scale is put on the model, as Scale would
    // a scaled model already carries its (placed) markers; only the generic one needs the marker set
    if (files["scale:markerset"] && !files["ik:model"] && !files["*:scaled"]) { payload["markers.xml"] = await files["scale:markerset"].arrayBuffer(); args.markerset = "markers.xml"; }
    sp.log = [];
    const t0 = Date.now();
    try {
      outs.ik = await runWorker("ik", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      // the figures bioscout writes next to its IK results
      try { outs.ik["ik_joint_angles.png"] = await kinematicsMomentsFigure(outs.ik["ik.mot"], null, outs.ik["ik_marker_errors_all.sto"]); } catch { /* figure is optional */ }
      try { if (outs.ik["ik_marker_errors_all.sto"]) outs.ik["_ik_marker_errors_plot.png"] = await markerErrorsFigure(outs.ik["ik_marker_errors_all.sto"]); } catch { /* optional */ }
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      Object.assign(sp, { state: "error", error: e.message });
    }
  }

  return {
    local: true,
    health: async () => ({ name: "bioscout-lab-engine", authed: true, local: true, models: ["GPK_v4_016.osim"], tools: [...LOCAL_TOOLS] }),
    newJob: async () => snap(),
    status: async () => snap(),
    setModel: async (_id, name) => { job.model = name; return snap(); },
    toolUpload: async (_id, tool, slot, file) => { files[`${tool}:${slot}`] = file; job.tools[tool].inputs[slot] = file.size; return snap(); },
    toolClear: async (_id, tool, slot) => { delete files[`${tool}:${slot}`]; delete job.tools[tool].inputs[slot]; return snap(); },
    toolOptions: async (_id, tool, o) => { job.options[tool] = o; return snap(); },
    toolRun: async (_id, tool) => {
      if (!LOCAL_TOOLS.has(tool)) fail("bad_request", "this step is not in the browser yet; scale, inverse kinematics, inverse dynamics and static optimisation are");
      Object.assign(job.tools[tool], { state: "running", started: Date.now() / 1000, error: null });
      (tool === "scale" ? runScale : tool === "id" ? runID : tool === "so" ? runSO : runIK)().catch((e) => Object.assign(job.tools[tool], { state: "error", error: e.message }));
      return snap();
    },
    toolOutputs: async (_id, tool) => ({ files: Object.entries(outs[tool] || {}).map(([path, v]) => ({ path, size: v.size ?? v.length })) }),
    toolBlob: (_id, tool, path) => { const v = (outs[tool] || {})[path]; return v == null ? null : v instanceof Blob ? v : new Blob([v], { type: "text/plain" }); },
    getGeneric: () => files["*:generic"] || null,
    setGeneric: (file) => { if (file) files["*:generic"] = file; else delete files["*:generic"]; },
    getScaled: () => files["*:scaled"] || null,
    setScaled: (file) => { if (file) files["*:scaled"] = file; else delete files["*:scaled"]; },
    toolFileUrl: (_id, tool, path) => {
      const k = tool + "/" + path;
      const v = outs[tool] && outs[tool][path];
      if (!urls[k] && v != null) urls[k] = URL.createObjectURL(v instanceof Blob ? v : new Blob([v], { type: "text/plain" }));
      return urls[k] || "#";
    },
    result: async () => null,
  };
}
