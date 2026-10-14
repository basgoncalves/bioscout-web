/**
 * localengine.js -- Simulate without a server: the same client API as the lab
 * engine (osimlab.js makeEngineClient), but the files stay in this browser and
 * the tools run in a Web Worker with Pyodide + py/pyosim (pure-Python OpenSim).
 * Scale, IK, ID, MA, SO + JRA and a Python version of CEINMS; RRA says it needs the engine.
 */
import { markerErrorsFigure, kinematicsMomentsFigure, inverseDynamicsFigure, residualsFigure, taskFigure } from "./simfigs.js";
import { muscleGroupsFigure, muscleMomentsFigure, jrfFigure, jrfCoverageFigure, bodyWeight } from "./simstack.js";
const LOCAL_TOOLS = new Set(["scale", "ik", "id", "so", "ma", "ceinms_cal", "ceinms"]);
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

  const txt = async (f) => (f ? (typeof f === "string" ? f : await f.text()) : null);
  const ikFile = (tool) => files[`${tool}:ik_mot`] || (outs.ik && outs.ik["ik.mot"] ? new File([outs.ik["ik.mot"]], "ik.mot") : null) || files["so:ik_mot"];
  const idFile = (tool) => files[`${tool}:id_sto`] || (outs.id && outs.id["inverse_dynamics.sto"] ? new File([outs.id["inverse_dynamics.sto"]], "inverse_dynamics.sto") : null) || files["so:id_sto"];
  /** What the pose / GRF header of the figures needs, from ID's results or the files given. */
  async function header() {
    const grf = files["so:grf_mot"] || files["id:grf_mot"] || null;
    const xml = (outs.id && outs.id["GRF.xml"]) || await txt(files["so:grf_xml"] || files["id:grf_xml"]);
    const bodies = (outs.id && outs.id["body_positions.sto"]) || await txt(files["so:bodies"]);
    return { grf, xml, hdr: { grfText: await txt(grf), grfXml: xml, bodiesText: bodies } };
  }
  /** Muscle figures + joint reactions (JRA) for a set of muscle forces. tag: "so" | "ceinms". */
  async function forcesFollowUp(sp, out, tag, model, ikf, forcesName, extra) {
    const { grf, xml, hdr } = await header();
    if (!hdr.bodiesText) {                     // ID skipped: the skeleton row from the model and ik.mot
      try {
        const r = await runWorker("bodies", { [model.name]: await model.arrayBuffer(), "ik.mot": await ikf.arrayBuffer() }, { model: model.name, ik: "ik.mot" }, () => {});
        hdr.bodiesText = r["body_positions.sto"]; out["body_positions.sto"] = hdr.bodiesText;
      } catch (e) { sp.log.push("skeleton poses: " + e.message); }
    }
    const ikTxt = await ikf.text(), idf = idFile(tag === "so" ? "so" : "ceinms"), idTxt = idf ? await idf.text() : null;
    const figs = { "muscle_groups.png": () => muscleGroupsFigure({ forceText: out[forcesName], actText: out[extra.act], emgText: extra.emg && out[extra.emg], hdr }) };
    if (idTxt) for (const sd of ["r", "l"]) figs[`muscle_moments_${sd}.png`] = () => muscleMomentsFigure({ side: sd, idText: idTxt, ikText: ikTxt, forceText: tag === "so" ? out[forcesName] : null, musclesText: extra.moments && out[extra.moments], hdr });
    for (const [n, f] of Object.entries(figs)) { try { out[n] = await f(); } catch (e) { sp.log.push(`${n}: ${e.message}`); } }
    const want = String(((job.options || {})[tag] || {}).jra ?? "1").trim() !== "0";
    if (!want) return;
    if (!grf) { sp.log.push("joint reactions: no ground reaction forces (run ID or drop grf.mot)"); return; }
    sp.log.push("joint reactions (JRA) …");
    const payload = { [model.name]: await model.arrayBuffer(), "ik.mot": await ikf.arrayBuffer(), "forces.sto": new TextEncoder().encode(out[forcesName]).buffer, "grf.mot": await grf.arrayBuffer() };
    const args = { model: model.name, ik: "ik.mot", forces: "forces.sto", grf: "grf.mot", out: `jra_${tag}.sto` };
    if (xml) { payload["loads.xml"] = new TextEncoder().encode(xml).buffer; args.loads = "loads.xml"; }
    try {
      const r = await runWorker("jra", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      Object.assign(out, r);
      const bw = bodyWeight(await model.text()), label = tag === "so" ? "SO" : "CEINMS", jraText = r[args.out];
      const jf = { [`jrf_${tag}.png`]: () => jrfFigure({ jraText, bw, label, hdr }),
        [`jrf_${tag}_coverage_frontal.png`]: () => jrfCoverageFigure({ jraText, bw, plane: "frontal", label, hdr }),
        [`jrf_${tag}_coverage_sagittal.png`]: () => jrfCoverageFigure({ jraText, bw, plane: "sagittal", label, hdr }) };
      for (const [n, f] of Object.entries(jf)) { try { out[n] = await f(); } catch (e) { sp.log.push(`${n}: ${e.message}`); } }
    } catch (e) { sp.log.push("joint reactions failed: " + e.message); }
  }

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
      await forcesFollowUp(sp, outs.so, "so", model, ikf, "SO_StaticOptimization_force.sto", { act: "SO_StaticOptimization_activation.sto" });
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      Object.assign(sp, { state: "error", error: e.message });
    }
  }

  async function runMA() {
    const sp = job.tools.ma;
    const ikf = files["ma:ik_mot"] || (outs.ik && outs.ik["ik.mot"] ? new File([outs.ik["ik.mot"]], "ik.mot") : null)
      || fail("bad_request", "drop the joint angles (.mot) or run inverse kinematics first");
    const model = await modelFile("ma");
    const payload = { [model.name]: await model.arrayBuffer(), "ik.mot": await ikf.arrayBuffer() };
    const args = { model: model.name, ik: "ik.mot" };
    // muscle moments (moment arm x force) when static optimisation has run or its forces were dropped
    const fs = files["ma:so_force"] || (outs.so && outs.so["SO_StaticOptimization_force.sto"] ? new File([outs.so["SO_StaticOptimization_force.sto"]], "so_force.sto") : null);
    if (fs) { payload["so_force.sto"] = await fs.arrayBuffer(); args.forces = "so_force.sto"; }
    sp.log = [];
    const t0 = Date.now();
    try {
      outs.ma = await runWorker("ma", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      Object.assign(sp, { state: "error", error: e.message });
    }
  }

  // CEINMS, the Python version (pyosim/ceinms.py): calibration, then execution
  async function ceinmsInputs(tool) {
    const ikf = ikFile(tool) || fail("bad_request", "drop the joint angles (.mot) or run inverse kinematics first");
    const idf = idFile(tool) || fail("bad_request", "run inverse dynamics first (or drop its .sto)");
    const emg = files[`${tool}:emg_mot`] || files["ceinms_cal:emg_mot"] || files["ceinms:emg_mot"] || null;
    const o = { ...((job.options || {})[tool] || {}) };
    const payload = { "ik.mot": await ikf.arrayBuffer(), "id.sto": await idf.arrayBuffer() };
    const args = { cmd: tool, ik: "ik.mot", id: "id.sto", approach: o.approach, alpha: o.alpha, beta: o.beta, gamma: o.gamma, mode: o.mode, gammas: o.gammas, tol: o.tol };
    if (emg) { payload["emg.mot"] = await emg.arrayBuffer(); args.emg = "emg.mot"; }
    return { ikf, payload, args };
  }
  async function runCeinmsCal() {
    const sp = job.tools.ceinms_cal;
    const { payload, args } = await ceinmsInputs("ceinms_cal");
    const model = await modelFile("ceinms_cal");
    payload[model.name] = await model.arrayBuffer(); args.model = model.name;
    sp.log = ["Python version of CEINMS calibration (not CEINMS.exe)"];
    const t0 = Date.now();
    try {
      outs.ceinms_cal = await runWorker("ceinms_cal", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      const cm = Object.keys(outs.ceinms_cal).find((n) => n.endsWith("_calibrated.osim"));
      if (cm) files["*:calibrated"] = new File([outs.ceinms_cal[cm]], cm);
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) { Object.assign(sp, { state: "error", error: e.message }); }
  }
  async function runCeinms() {
    const sp = job.tools.ceinms;
    const { ikf, payload, args } = await ceinmsInputs("ceinms");
    const model = files["ceinms:model"] || files["*:calibrated"] || await modelFile("ceinms");
    payload[model.name] = await model.arrayBuffer(); args.model = model.name;
    const cal = files["ceinms:calibration"] || (outs.ceinms_cal && outs.ceinms_cal["calibration.json"] ? new File([outs.ceinms_cal["calibration.json"]], "calibration.json") : null);
    if (cal) { payload["calibration.json"] = await cal.arrayBuffer(); args.calibration = "calibration.json"; }
    sp.log = ["Python version of CEINMS execution (not CEINMS.exe)" + (files["*:calibrated"] && model === files["*:calibrated"] ? ", on the calibrated model" : ", on the uncalibrated model")];
    const t0 = Date.now();
    try {
      outs.ceinms = await runWorker("ceinms", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      await forcesFollowUp(sp, outs.ceinms, "ceinms", model, ikf, "CEINMS_forces.sto", { act: "CEINMS_activations.sto", emg: "CEINMS_emg_activations.sto", moments: "CEINMS_moments.sto" });
      Object.assign(sp, { state: "done", seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) { Object.assign(sp, { state: "error", error: e.message }); }
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
      if (!LOCAL_TOOLS.has(tool)) fail("bad_request", "this step is not in the browser yet; scale, inverse kinematics, inverse dynamics, muscle analysis, static optimisation (+ joint reactions) and CEINMS (Python version) are");
      Object.assign(job.tools[tool], { state: "running", started: Date.now() / 1000, error: null });
      ({ scale: runScale, id: runID, so: runSO, ma: runMA, ceinms_cal: runCeinmsCal, ceinms: runCeinms }[tool] || runIK)().catch((e) => Object.assign(job.tools[tool], { state: "error", error: e.message }));
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
