/**
 * localengine.js -- Simulate without a server: the same client API as the lab
 * engine (osimlab.js makeEngineClient), but the files stay in this browser and
 * the tools run in a Web Worker with Pyodide + py/pyosim (pure-Python OpenSim).
 * For now: inverse kinematics only; the other sections say they need the engine.
 */
const LOCAL_TOOLS = new Set(["ik"]);
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
    const own = files[`${tool}:model`];
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

  async function runIK() {
    const sp = job.tools.ik, o = job.options.ik || {};
    const trc = files["ik:motion_trc"] || fail("bad_request", "drop the motion trial markers (.trc)");
    const model = await modelFile("ik");
    const payload = { [model.name]: await model.arrayBuffer(), "motion.trc": await trc.arrayBuffer() };
    const args = { model: model.name, trc: "motion.trc", t0: o.t0, t1: o.t1 };
    if (files["ik:taskset"]) { payload["tasks.xml"] = await files["ik:taskset"].arrayBuffer(); args.tasks = "tasks.xml"; }
    // a marker set dropped in Scale is put on the model, as Scale would
    if (files["scale:markerset"]) { payload["markers.xml"] = await files["scale:markerset"].arrayBuffer(); args.markerset = "markers.xml"; }
    sp.log = [];
    const t0 = Date.now();
    try {
      outs.ik = await runWorker("ik", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
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
      if (!LOCAL_TOOLS.has(tool)) fail("bad_request", "this step still needs the lab engine; only inverse kinematics runs in the browser so far");
      Object.assign(job.tools[tool], { state: "running", started: Date.now() / 1000, error: null });
      runIK();                                   // in the background; the page polls status()
      return snap();
    },
    toolOutputs: async (_id, tool) => ({ files: Object.entries(outs[tool] || {}).map(([path, txt]) => ({ path, size: txt.length })) }),
    toolFileUrl: (_id, tool, path) => {
      const k = tool + "/" + path;
      if (!urls[k] && outs[tool] && outs[tool][path]) urls[k] = URL.createObjectURL(new Blob([outs[tool][path]], { type: "text/plain" }));
      return urls[k] || "#";
    },
    result: async () => null,
  };
}
