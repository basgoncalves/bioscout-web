/**
 * localengine.js -- Simulate without a server: the same client API as the lab
 * engine (osimlab.js makeEngineClient), but the files stay in this browser and
 * the tools run in a Web Worker with Pyodide + py/pyosim (pure-Python OpenSim).
 * For now: inverse kinematics only; the other sections say they need the engine.
 */
const LOCAL_TOOLS = new Set(["ik"]);
const BASE = new URL("../", import.meta.url).href;

/** A PNG of the main joint angles from an ik.mot (left vs right, like the course figures). */
async function anglesFigure(mot) {
  const L = mot.split(/\r?\n/), h = L.findIndex((l) => l.trim().toLowerCase() === "endheader");
  const cols = L[h + 1].split("\t"), rows = L.slice(h + 2).filter((l) => l.trim()).map((l) => l.split("\t").map(Number));
  const col = (n) => { const i = cols.indexOf(n); return i < 0 ? null : rows.map((r) => r[i]); };
  const t = col("time");
  const panels = [["pelvis_tilt", "pelvis_list", "pelvis_rotation"], ["hip_flexion_r", "hip_flexion_l"], ["hip_adduction_r", "hip_adduction_l"],
    ["knee_angle_r", "knee_angle_l"], ["ankle_angle_r", "ankle_angle_l"], ["lumbar_extension", "lumbar_bending", "lumbar_rotation"]]
    .map((ns) => ns.filter((n) => col(n))).filter((ns) => ns.length);
  const W = 1200, ph = 260, H = 40 + Math.ceil(panels.length / 2) * ph;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#111"; g.font = "bold 18px sans-serif"; g.fillText("Inverse kinematics - joint angles (deg)", 20, 26);
  const COL = ["#d1495b", "#2e86ab", "#3a7d44"];
  panels.forEach((ns, pi) => {
    const x0 = (pi % 2) * (W / 2) + 60, y0 = 40 + Math.floor(pi / 2) * ph + 20, w = W / 2 - 90, hh = ph - 60;
    const ys = ns.flatMap((n) => col(n)).filter(isFinite);
    let lo = Math.min(...ys), hi = Math.max(...ys); if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const X = (v) => x0 + (v - t[0]) / (t[t.length - 1] - t[0] || 1) * w, Y = (v) => y0 + hh - (v - lo) / (hi - lo) * hh;
    g.strokeStyle = "#999"; g.lineWidth = 1; g.strokeRect(x0, y0, w, hh);
    g.fillStyle = "#333"; g.font = "12px sans-serif";
    g.fillText(hi.toFixed(0), x0 - 40, y0 + 10); g.fillText(lo.toFixed(0), x0 - 40, y0 + hh);
    g.fillText(t[0].toFixed(2) + " s", x0, y0 + hh + 16); g.fillText(t[t.length - 1].toFixed(2) + " s", x0 + w - 40, y0 + hh + 16);
    ns.forEach((n, k) => {
      const v = col(n); g.strokeStyle = COL[k % 3]; g.lineWidth = 2; g.beginPath();
      v.forEach((y, i) => (i ? g.lineTo(X(t[i]), Y(y)) : g.moveTo(X(t[i]), Y(y)))); g.stroke();
      g.fillStyle = COL[k % 3]; g.fillText(n, x0 + 8 + k * 150, y0 - 6);
    });
  });
  return await new Promise((r) => c.toBlob(r, "image/png"));
}

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
    const own = files[`${tool}:model`] || files["*:scaled"];
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
    const trcName = /\.trc$/i.test(trc.name) ? trc.name : "motion.trc";
    const payload = { [model.name]: await model.arrayBuffer(), [trcName]: await trc.arrayBuffer() };
    const args = { model: model.name, trc: trcName, t0: o.t0, t1: o.t1 };
    if (files["ik:taskset"]) { payload["tasks.xml"] = await files["ik:taskset"].arrayBuffer(); args.tasks = "tasks.xml"; }
    // a marker set dropped in Scale is put on the model, as Scale would
    if (files["scale:markerset"]) { payload["markers.xml"] = await files["scale:markerset"].arrayBuffer(); args.markerset = "markers.xml"; }
    sp.log = [];
    const t0 = Date.now();
    try {
      outs.ik = await runWorker("ik", payload, args, (l) => { sp.log.push(...String(l).split("\n")); });
      try { outs.ik["ik_joint_angles.png"] = await anglesFigure(outs.ik["ik.mot"]); } catch { /* figure is optional */ }
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
    toolOutputs: async (_id, tool) => ({ files: Object.entries(outs[tool] || {}).map(([path, v]) => ({ path, size: v.size ?? v.length })) }),
    toolBlob: (_id, tool, path) => { const v = (outs[tool] || {})[path]; return v == null ? null : v instanceof Blob ? v : new Blob([v], { type: "text/plain" }); },
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
