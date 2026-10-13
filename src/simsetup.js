/**
 * simsetup.js -- the OpenSim setup .xml of a Simulate step, built in the
 * browser from what is dropped and typed, BEFORE the step runs.
 *
 * It starts from the same template the step itself reads
 * (data/opensim/setup_files/setup_<step>.xml, or the setup file the user
 * dropped) and only fills in file names, time range and mass, so the result
 * is an ordinary OpenSim setup that the desktop GUI or `opensim-cmd run-tool`
 * accepts as it is. All paths are bare file names: put the .xml next to the
 * .osim / .trc / .mot it names.
 */
const TPL = new URL("../data/opensim/setup_files/", import.meta.url).href;
const TEMPLATE = { scale: "setup_scale.xml", ik: "setup_IK.xml", id: "setup_ID.xml", ma: "setup_MA.xml", so: "setup_SO.xml", jra: "setup_JRA.xml" };

/** First and last time of a .trc or .mot/.sto text (null when unreadable). */
export function timeSpan(text) {
  const L = text.split(/\r?\n/);
  let i = L.findIndex((l) => l.trim().toLowerCase() === "endheader");
  if (i < 0) i = 4;                           // .trc: 5 header lines
  const rows = L.slice(i + 1).map((l) => l.trim()).filter((l) => /^[-\d.]/.test(l));
  if (!rows.length) return null;
  const col = i === 4 ? 1 : 0;                // .trc has Frame# first
  const t0 = +rows[0].split(/\s+/)[col], t1 = +rows[rows.length - 1].split(/\s+/)[col];
  return Number.isFinite(t0) && Number.isFinite(t1) ? [t0, t1] : null;
}

const setText = (doc, path, value) => {
  // path "A/B/C" from the tool element; missing elements are created in order
  let el = doc.documentElement.firstElementChild;  // the *Tool element
  for (const name of path.split("/")) {
    let c = [...el.children].find((x) => x.tagName === name);
    if (!c) { c = doc.createElement(name); el.appendChild(c); }
    el = c;
  }
  el.textContent = value;
};
const setAll = (doc, name, value) => { doc.querySelectorAll(name).forEach((el) => { el.textContent = value; }); };
const base = (n) => (n || "").split(/[\\/]/).pop();

/**
 * in: { tool, files: {slotId: File|null}, names: {slotId: fileName}, options: {},
 *       model: fileName, setupFile: File|null, trcText: string|null, motText: string|null }
 * -> { name, xml }
 */
export async function buildSetup(inp) {
  const { tool, names = {}, options = {} } = inp;
  const tplName = TEMPLATE[tool];
  if (!tplName && !inp.setupFile) return null;
  const src = inp.setupFile ? await inp.setupFile.text() : await (await fetch(TPL + tplName)).text();
  const doc = new DOMParser().parseFromString(src, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("the setup template is not valid XML");
  const model = base(inp.model) || "model.osim";
  const span = inp.trcText ? timeSpan(inp.trcText) : inp.motText ? timeSpan(inp.motText) : null;
  const tr = (a, b) => `${(+a).toFixed(6)} ${(+b).toFixed(6)}`;
  const has = (k) => options[k] !== "" && options[k] != null;
  const t0 = has("t0") ? +options.t0 : span ? span[0] : null, t1 = has("t1") ? +options.t1 : span ? span[1] : null;
  const timed = t0 != null && t1 != null;

  if (tool === "scale") {
    const out = model.replace(/\.osim$/i, "") + "_scaled.osim";
    const trc = base(names.static_trc) || "static.trc";
    doc.documentElement.firstElementChild.setAttribute("name", out.replace(/\.osim$/i, ""));
    if (has("mass")) setText(doc, "mass", String(+options.mass));
    setText(doc, "GenericModelMaker/model_file", model);
    setText(doc, "GenericModelMaker/marker_set_file", base(names.markerset) || "markers_pyCGM.xml");
    setText(doc, "ModelScaler/marker_file", trc);
    setText(doc, "ModelScaler/output_model_file", out);
    setText(doc, "ModelScaler/output_scale_file", out.replace(/\.osim$/i, "_scale_factors.xml"));
    setText(doc, "MarkerPlacer/marker_file", trc);
    setText(doc, "MarkerPlacer/output_model_file", out);
    setText(doc, "MarkerPlacer/output_motion_file", "static_pose.mot");
    if (timed) { setText(doc, "ModelScaler/time_range", tr(t0, t1)); setText(doc, "MarkerPlacer/time_range", tr(t0, t1)); }
  } else if (tool === "ik") {
    setText(doc, "model_file", model);
    setText(doc, "marker_file", base(names.motion_trc) || "motion.trc");
    setText(doc, "output_motion_file", "ik.mot");
    const ts = doc.querySelector("IKTaskSet");
    if (ts && names.taskset) { ts.setAttribute("file", base(names.taskset)); [...ts.children].forEach((c) => c.remove()); }
    if (timed) setText(doc, "time_range", tr(t0, t1));
  } else if (tool === "id") {
    setText(doc, "results_directory", ".");
    setText(doc, "model_file", model);
    setText(doc, "coordinates_file", base(names.ik_mot) || "ik.mot");
    setText(doc, "external_loads_file", base(names.grf_xml) || "externalloads.xml");
    setText(doc, "output_gen_force_file", "inverse_dynamics.sto");
    if (timed) setText(doc, "time_range", tr(t0, t1));
  } else {                                    // AnalyzeTool family: ma, so, jra
    setText(doc, "results_directory", ".");
    setText(doc, "model_file", model);
    setText(doc, "coordinates_file", base(names.ik_mot) || "ik.mot");
    setText(doc, "external_loads_file", base(names.grf_xml) || "externalloads.xml");
    if (tool === "so" && names.actuators) setText(doc, "force_set_files", base(names.actuators));
    if (timed) { setText(doc, "initial_time", String(t0)); setText(doc, "final_time", String(t1)); setAll(doc, "start_time", String(t0)); setAll(doc, "end_time", String(t1)); }
  }
  const xml = new XMLSerializer().serializeToString(doc);
  return { name: `setup_${tool}.xml`, xml: (xml.startsWith("<?xml") ? "" : '<?xml version="1.0" encoding="UTF-8" ?>\n') + xml + "\n" };
}

export function downloadText(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/xml" })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
