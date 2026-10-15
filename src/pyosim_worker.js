/* pyosim_worker.js -- runs the pure-Python OpenSim tools (py/pyosim) in Pyodide,
 * off the page's thread. Messages: {id, cmd:"ik", files:{name: ArrayBuffer}, args}
 * -> {id, log:[...]} while running, then {id, done:true, outputs:{name: text}} or {id, error}. */
/* global importScripts, loadPyodide */
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const PY_FILES = ["__init__.py", "model.py", "io.py", "ik.py", "scale.py", "id.py", "muscles.py", "so.py", "ma.py", "jra.py", "ceinms.py"];
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
try:
    from pyosim import id as idtool
    idtool.write_body_positions("/job/" + a["model"], "/job/ik.mot", "/job/body_positions.sto")
except Exception as e:
    js_log("[ik] body positions not written: " + str(e))
`);
      const outputs = {};
      for (const f of ["setup_ik.xml", "ik.mot", "ik_marker_errors.sto", "ik_marker_errors_all.sto", "body_positions.sto"]) {
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
      for (const f of ["setup_id.xml", "inverse_dynamics.sto", "GRF.xml", "body_positions.sto"]) {
        try { outputs[f] = py.FS.readFile("/job/" + f, { encoding: "utf8" }); } catch { /* optional */ }
      }
      self.postMessage({ id, done: true, outputs });
    } else if (cmd === "so") {
      py.runPython(`
from pyosim import so
from pyosim.model import Model
a = dict(args)
tr = (float(a["t0"]), float(a["t1"])) if a.get("t0") not in (None, "") and a.get("t1") not in (None, "") else None
so.run(Model("/job/" + a["model"]), "/job/" + a["ik"], "/job/" + a["id"], "/job/so", actuators=("/job/" + a["actuators"]) if a.get("actuators") else None,
       t_range=tr, log=js_log)
`);
      const outputs = {};
      for (const f of ["SO_StaticOptimization_force.sto", "SO_StaticOptimization_activation.sto"]) {
        try { outputs[f] = py.FS.readFile("/job/so/" + f, { encoding: "utf8" }); } catch { /* optional */ }
      }
      self.postMessage({ id, done: true, outputs });
    } else if (cmd === "ma") {
      py.runPython(`
from pyosim import ma
from pyosim.model import Model
a = dict(args)
ma.run(Model("/job/" + a["model"]), "/job/" + a["ik"], "/job/ma", forces_sto=("/job/" + a["forces"]) if a.get("forces") else None, log=js_log)
`);
      const outputs = {};
      for (const f of py.FS.readdir("/job/ma")) if (f.endsWith(".sto")) outputs[f] = py.FS.readFile("/job/ma/" + f, { encoding: "utf8" });
      self.postMessage({ id, done: true, outputs });
    } else if (cmd === "bodies") {
      py.runPython(`
from pyosim import id as idtool
a = dict(args)
idtool.write_body_positions("/job/" + a["model"], "/job/" + a["ik"], "/job/body_positions.sto")
`);
      self.postMessage({ id, done: true, outputs: { "body_positions.sto": py.FS.readFile("/job/body_positions.sto", { encoding: "utf8" }) } });
    } else if (cmd === "jra") {
      py.runPython(`
from pyosim import jra
from pyosim import id as idtool
from pyosim.model import Model
a = dict(args)
loads = ("/job/" + a["loads"]) if a.get("loads") else None
if not loads:
    loads = idtool.make_grf_xml(Model("/job/" + a["model"]), "/job/" + a["grf"], "/job/" + a["ik"], "/job/GRF.xml", log=js_log)
jra.run("/job/" + a["model"], "/job/" + a["ik"], "/job/" + a["forces"], loads, "/job/" + a["out"],
        loads_mot=("/job/" + a["grf"]) if a.get("grf") else None, log=js_log)
`);
      const outputs = { [args.out]: py.FS.readFile("/job/" + args.out, { encoding: "utf8" }) };
      const cn = args.out.replace(/\.sto$/, "_contrib.sto");
      try { outputs[cn] = py.FS.readFile("/job/" + cn, { encoding: "utf8" }); } catch { /* optional */ }
      self.postMessage({ id, done: true, outputs });
    } else if (cmd === "ceinms_cal" || cmd === "ceinms") {
      py.runPython(`
from pyosim import ceinms
a = dict(args)
num = lambda k: float(a[k]) if a.get(k) not in (None, "") else None
tr = (float(a["t0"]), float(a["t1"])) if a.get("t0") not in (None, "") and a.get("t1") not in (None, "") else None
emg = ("/job/" + a["emg"]) if a.get("emg") else None
if a["cmd"] == "ceinms_cal":
    ceinms.calibrate("/job/" + a["model"], "/job/" + a["ik"], "/job/" + a["id"], emg, "/job/out", approach=a.get("approach") or "hybrid",
                     alpha=num("alpha"), beta=num("beta"), gamma=num("gamma"), t_range=tr, log=js_log)
else:
    gs = [float(x) for x in str(a.get("gammas") or "").replace(",", " ").split()] or [1, 10, 30, 100, 300]
    ceinms.execute("/job/" + a["model"], "/job/" + a["ik"], "/job/" + a["id"], "/job/out", emg_mot=emg, approach=a.get("approach") or "hybrid",
                   mode=(a.get("mode") or "execution").strip().lower(), alpha=num("alpha"), beta=num("beta"), gamma=num("gamma"),
                   gammas=gs, tol=num("tol"), calibration=("/job/" + a["calibration"]) if a.get("calibration") else None, t_range=tr, log=js_log)
`);
      const outputs = {};
      for (const f of py.FS.readdir("/job/out")) if (!f.startsWith(".")) outputs[f] = py.FS.readFile("/job/out/" + f, { encoding: "utf8" });
      py.runPython("import shutil; shutil.rmtree('/job/out', ignore_errors=True)");
      self.postMessage({ id, done: true, outputs });
    } else throw new Error("unknown command " + cmd);
  } catch (err) {
    const msg = String(err && err.message || err).split("\n").filter(Boolean);
    self.postMessage({ id, error: msg.slice(-1)[0] || "failed", log: msg.slice(-12).join("\n") });
  }
};
