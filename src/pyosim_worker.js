/* pyosim_worker.js -- runs the pure-Python OpenSim tools (py/pyosim) in Pyodide,
 * off the page's thread. Messages: {id, cmd:"ik", files:{name: ArrayBuffer}, args}
 * -> {id, log:[...]} while running, then {id, done:true, outputs:{name: text}} or {id, error}. */
/* global importScripts, loadPyodide */
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const PY_FILES = ["__init__.py", "model.py", "io.py", "ik.py", "scale.py", "id.py"];
let ready = null;

function boot(base) {
  if (ready) return ready;
  ready = (async () => {
    self.importScripts(PYODIDE + "pyodide.js");
    const py = await self.loadPyodide({ indexURL: PYODIDE });
    await py.loadPackage(["numpy", "scipy"]);
    py.FS.mkdirTree("/lib/pyosim");
    for (const f of PY_FILES) {
      const r = await fetch(base + "py/pyosim/" + f, { cache: "no-cache" });
      if (!r.ok) throw new Error("missing py/pyosim/" + f);
      py.FS.writeFile("/lib/pyosim/" + f, await r.text());
    }
    py.runPython("import sys; sys.path.insert(0, '/lib')");
    return py;
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

self.onmessage = async (e) => {
  const { id, cmd, files, args, base } = e.data;
  const log = (s) => self.postMessage({ id, log: String(s) });
  try {
    log("[browser] loading Python (first time ~20 s, then cached)...");
    const py = await boot(base);
    py.FS.mkdirTree("/job");
    for (const [n, buf] of Object.entries(files)) py.FS.writeFile("/job/" + n, new Uint8Array(buf));
    py.globals.set("js_log", log);
    py.globals.set("args", py.toPy(args || {}));
    if (cmd === "ik") {
      py.runPython(`
from pyosim import ik
a = dict(args)
tr = (float(a["t0"]), float(a["t1"])) if a.get("t0") not in (None, "") and a.get("t1") not in (None, "") else None
ik.run("/job/" + a["model"], "/job/" + a["trc"], ("/job/" + a["tasks"]) if a.get("tasks") else None,
       "/job/ik.mot", tr, log=js_log, markerset=("/job/" + a["markerset"]) if a.get("markerset") else None,
       errors_path="/job/ik_marker_errors.sto", setup_path="/job/setup_ik.xml")
`);
      const outputs = {};
      for (const f of ["setup_ik.xml", "ik.mot", "ik_marker_errors.sto", "ik_marker_errors_all.sto"]) {
        try { outputs[f] = py.FS.readFile("/job/" + f, { encoding: "utf8" }); } catch { /* optional */ }
      }
      self.postMessage({ id, done: true, outputs });
    } else if (cmd === "scale") {
      py.runPython(`
from pyosim import scale
a = dict(args)
al = {}
for pair in str(a.get("aliases") or "").replace(",", " ").split():
    if "=" in pair:
        k, v = pair.split("=", 1); al[k.strip()] = v.strip()
mass = float(a["mass"]) if a.get("mass") not in (None, "") else None
scale.run("/job/" + a["model"], "/job/" + a["trc"], "/job/" + a["out"], setup_path="/job/" + a["setup"], mass=mass,
          markerset=("/job/" + a["markerset"]) if a.get("markerset") else None, aliases=al or None, log=js_log)
`);
      const base = args.out.replace(/\.osim$/, "");
      const outputs = {};
      for (const f of [args.setup, args.out, base + "_scale_factors.xml", "static_pose.mot"]) {
        try { outputs[f] = py.FS.readFile("/job/" + f, { encoding: "utf8" }); } catch { /* optional */ }
      }
      self.postMessage({ id, done: true, outputs });
    } else if (cmd === "id") {
      py.runPython(`
from pyosim import id as idtool
from pyosim.model import Model
a = dict(args)
model = Model("/job/" + a["model"])
loads = ("/job/" + a["loads"]) if a.get("loads") else None
if not loads and a.get("grf"):
    loads = idtool.make_grf_xml(model, "/job/" + a["grf"], "/job/" + a["ik"], "/job/GRF.xml", log=js_log)
tr = (float(a["t0"]), float(a["t1"])) if a.get("t0") not in (None, "") and a.get("t1") not in (None, "") else None
idtool.run(model, "/job/" + a["ik"], loads, "/job/inverse_dynamics.sto", loads_mot=("/job/" + a["grf"]) if a.get("grf") else None,
           t_range=tr, cutoff=float(a.get("cutoff") or 6), log=js_log, setup_path="/job/setup_id.xml")
`);
      const outputs = {};
      for (const f of ["setup_id.xml", "inverse_dynamics.sto", "GRF.xml"]) {
        try { outputs[f] = py.FS.readFile("/job/" + f, { encoding: "utf8" }); } catch { /* optional */ }
      }
      self.postMessage({ id, done: true, outputs });
    } else throw new Error("unknown command " + cmd);
  } catch (err) {
    const msg = String(err && err.message || err).split("\n").filter(Boolean);
    self.postMessage({ id, error: msg.slice(-1)[0] || "failed", log: msg.slice(-12).join("\n") });
  }
};
