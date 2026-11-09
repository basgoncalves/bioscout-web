import { makeZip } from "./zip.js";
// Visualise — load a BioScout session folder (or individual OpenSim result files) and show it the way the
// running playground does: stick figure + GRF, hip/knee/ankle angle and moment with stacked muscle-group
// moment contributions (force x moment arm) and reserves, group activations over time, bars at this frame.
// Everything is read in the browser; nothing is uploaded.

const DOFS = ["hip_flexion", "knee_angle", "ankle_angle"];
export const GROUPS = [                                 // sagittal summary groups, base muscle names (Rajagopal / gait2392 style)
  ["Gluteus max", /^glmax|^glut_max/, "#e63946"], ["Gluteus med+min", /^glmed|^glmin|^glut_med|^glut_min/, "#f4a6a6"],
  ["Hamstrings", /^bflh|^semimem|^semiten|^bifemlh/, "#90be6d"], ["Biceps fem. short", /^bfsh|^bifemsh/, "#43aa8b"],
  ["Adductors", /^add|^grac/, "#2ec4b6"], ["Iliopsoas", /^iliacus|^psoas/, "#e9c46a"], ["Rectus femoris", /^recfem|^rect_fem/, "#57cc99"],
  ["Vasti", /^vas/, "#48cae4"], ["Gastrocnemius", /^gas|^lat_gas|^med_gas/, "#4361ee"], ["Soleus", /^soleus|^soleus/, "#8e44ec"],
  ["Dorsiflexors", /^tibant|^edl|^ehl|^tib_ant|^ext_dig|^ext_hal/, "#e056c1"],
];
const OTHER = ["Other muscles", null, "#9aa0a6"];
const RCOL = "#ff8a65";

// ---------- parsing ----------
export function parseSto(text) {                       // OpenSim .mot/.sto -> { names, cols: {name: Float64Array}, n, inDeg }
  const L = text.split(/\r?\n/), h = L.findIndex((l) => l.trim().toLowerCase() === "endheader");
  if (h < 0) throw new Error("no endheader");
  const inDeg = !/inDegrees\s*=\s*no/i.test(L.slice(0, h).join("\n"));
  let r = h + 1; while (r < L.length && !L[r].trim()) r++;
  const names = L[r].trim().split(/\s+/), rows = [];
  for (let i = r + 1; i < L.length; i++) { const l = L[i].trim(); if (l) rows.push(l.split(/\s+/)); }
  const cols = {}; names.forEach((k, j) => { const a = new Float64Array(rows.length); for (let i = 0; i < rows.length; i++) a[i] = +rows[i][j]; cols[k] = a; });
  const bw = (L.slice(0, h).join("\n").match(/body_weight_N\s*=\s*([\d.eE+-]+)/) || [])[1];
  return { names, cols, n: rows.length, inDeg, bw: bw ? +bw : null };
}
export function parseCycles(yaml) {                    // movement_detection.yaml -> [{name, side, t0, t1}] (only the "cycles:" list)
  const out = [], L = yaml.split(/\r?\n/); let on = false, cur = null, tr = null;
  for (const l of L) {
    if (/^cycles:/.test(l)) { on = true; continue; }
    if (!on) continue;
    if (/^\S/.test(l) && !/^-/.test(l)) break;
    let m;
    if ((m = l.match(/^- name:\s*(\S+)/))) { cur = { name: m[1] }; out.push(cur); tr = null; continue; }
    if (!cur) continue;
    if ((m = l.match(/^  side:\s*(\w+)/))) cur.side = m[1][0];
    if (/^  time_range:/.test(l)) { tr = []; continue; }
    if (tr && (m = l.match(/^  - ([-\d.eE]+)/))) { tr.push(+m[1]); if (tr.length === 2) { cur.t0 = tr[0]; cur.t1 = tr[1]; tr = null; } continue; }
    if (!/^  - /.test(l)) tr = null;
  }
  return out.filter((c) => Number.isFinite(c.t0));
}
const JRF_GROUPS = [[/glut.*max/i, 0], [/glut.*(med|min)/i, 1], [/semimem|semiten|biceps_fem|hamstring/i, 2], [/adduct/i, 4], [/iliopsoas|iliacus|psoas/i, 5],
  [/rectus_fem/i, 6], [/vast/i, 7], [/triceps_surae|gastro|soleus/i, 9], [/tibialis_anterior|dorsi/i, 10]];
function jrfLabel(sname) {                             // contribution source -> legend label (muscle groups share the moment-view names)
  if (/reserve/i.test(sname)) return "Reserve";
  if (/non-muscle|intersegmental/i.test(sname)) return "Non-muscle (gravity, GRF, residuals)";
  if (/total/i.test(sname)) return "Total";
  const g = JRF_GROUPS.find(([re]) => re.test(sname)); if (g) return /triceps_surae/i.test(sname) ? "Triceps surae" : GROUPS[g[1]][0];
  return OTHER[0];
}
function jrfCol(sname) {
  if (/reserve/i.test(sname)) return RCOL; if (/non-muscle|intersegmental/i.test(sname)) return "#5c636a";
  const g = JRF_GROUPS.find(([re]) => re.test(sname)); return g ? GROUPS[g[1]][2] : OTHER[2];
}
// ---------- cropping a session to a time window ----------
export function cropText(name, text, t0, t1) {           // OpenSim .mot/.sto and .trc keep their header; only the rows in [t0, t1] stay
  const L = text.split(/\r?\n/), nl = text.includes("\r\n") ? "\r\n" : "\n", inside = (t) => t >= t0 - 1e-9 && t <= t1 + 1e-9;
  if (/\.trc$/i.test(name)) {
    const keep = L.slice(5).filter((l) => l.trim() && inside(+l.split("\t")[1]));
    const keys = (L[1] || "").split("\t"), vals = (L[2] || "").split("\t"), k = keys.findIndex((x) => x.trim() === "NumFrames");
    if (k >= 0) { vals[k] = String(keep.length); L[2] = vals.join("\t"); }
    return L.slice(0, 5).concat(keep).join(nl) + nl;
  }
  const h = L.findIndex((l) => l.trim().toLowerCase() === "endheader"); if (h < 0) return null;
  let r = h + 1; while (r < L.length && !L[r].trim()) r++;
  const cols = L[r].trim().split(/\s+/), ti = Math.max(0, cols.indexOf("time"));
  const keep = L.slice(r + 1).filter((l) => l.trim() && inside(+l.trim().split(/\s+/)[ti]));
  const head = L.slice(0, r + 1).map((l) => l.replace(/^(nRows\s*=\s*)\d+/, `$1${keep.length}`).replace(/^(datarows\s+)\d+/, `$1${keep.length}`)
    .replace(/^(range\s+)\S+\s+\S+/, `$1${t0} ${t1}`));
  return head.concat(keep).join(nl) + nl;
}
export function cropSessionYaml(yaml, trial, t0, t1) {    // trials: <trial>: time_range: [t0, t1]
  const L = yaml.split(/\r?\n/); let inT = false, tr = -1;
  for (let i = 0; i < L.length; i++) {
    if (/^trials:/.test(L[i])) { inT = true; continue; }
    if (inT && /^\S/.test(L[i])) break;
    if (inT && new RegExp(`^  ${trial.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\s*$`).test(L[i])) { tr = i; continue; }
    if (tr >= 0 && /^  \S/.test(L[i])) break;
    if (tr >= 0 && /^\s+time_range:/.test(L[i]) && /^\s+-/.test(L[i + 1] || "") && /^\s+-/.test(L[i + 2] || "")) {
      L[i + 1] = L[i + 1].replace(/-\s*\S+/, `- ${t0}`); L[i + 2] = L[i + 2].replace(/-\s*\S+/, `- ${t1}`); break;
    }
  }
  return L.join("\n");
}
export function parseEmgMap(yaml) {                    // session.yaml "emg_map:" -> { channel: [muscle, ...] }
  const out = {}, L = yaml.split(/\r?\n/); let on = false, cur = null;
  for (const l of L) {
    if (/^emg_map:/.test(l)) { on = true; continue; }
    if (!on) continue;
    if (/^\S/.test(l)) break;
    let m;
    if ((m = l.match(/^  ([^\s:-][^:]*):\s*$/))) { cur = m[1].trim(); out[cur] = []; continue; }
    if (cur && (m = l.match(/^\s+-\s*(\S+)/))) out[cur].push(m[1]);
  }
  return out;
}
function interp(t, x, y) {                             // y(x) sampled at t; NaN outside
  const out = new Float64Array(t.length); let j = 0;
  for (let i = 0; i < t.length; i++) {
    const v = t[i]; if (v < x[0] - 1e-9 || v > x[x.length - 1] + 1e-9) { out[i] = NaN; continue; }
    while (j < x.length - 2 && x[j + 1] < v) j++;
    const d = x[j + 1] - x[j]; out[i] = d > 0 ? y[j] + (y[j + 1] - y[j]) * (v - x[j]) / d : y[j];
  }
  return out;
}

// ---------- build one view model from parsed files ----------
// F: { ik, id, act, force, ma: {hip_flexion, knee_angle, ankle_angle}, mk, grf }  (parsed .sto objects; any but ik may be missing)
export function buildModel(F, side, win) {
  const tAll = F.ik.cols.time, keep = []; for (let i = 0; i < tAll.length; i++) if (!win || (tAll[i] >= win[0] - 1e-9 && tAll[i] <= win[1] + 1e-9)) keep.push(i);
  if (keep.length < 3) throw new Error("no frames in this window");
  const t = Float64Array.from(keep, (i) => tAll[i]), N = t.length, at = (p, k) => (p && p.cols[k] ? interp(t, p.cols.time, p.cols[k]) : null);
  const conv = F.ik.inDeg ? 1 : 180 / Math.PI;
  const ang = DOFS.map((d) => { const a = at(F.ik, `${d}_${side}`); return a ? a.map((v) => v * conv) : new Float64Array(N).fill(NaN); });
  const mom = DOFS.map((d) => at(F.id, `${d}_${side}_moment`) || new Float64Array(N).fill(NaN));
  const res = DOFS.map((d) => at(F.force, `${d}_${side}_reserve`));
  const muscles = (F.force || F.act) ? (F.force || F.act).names.filter((n) => new RegExp(`_${side}$`).test(n)) : [];
  const groups = GROUPS.concat([OTHER]).map(([n, re, col]) => ({ n, re, col, mem: [] }));
  for (const m of muscles) { const b = m.replace(/_[lr]$/, ""); (groups.find((g) => g.re && g.re.test(b)) || groups[groups.length - 1]).mem.push(m); }
  const G = groups.filter((g) => g.mem.length).map((g) => {
    const act = new Float64Array(N), contrib = DOFS.map(() => new Float64Array(N));
    for (const m of g.mem) {
      const a = at(F.act, m); if (a) for (let i = 0; i < N; i++) act[i] += a[i] / g.mem.length;
      const f = at(F.force, m);
      if (f) DOFS.forEach((d, k) => { const r = F.ma && F.ma[d] ? at(F.ma[d], m) : null; if (r) for (let i = 0; i < N; i++) contrib[k][i] += (f[i] * r[i]) || 0; });
    }
    return { n: g.n, col: g.col, act: F.act ? act : null, contrib, mem: g.mem };
  });
  // stick figure from model marker locations (sagittal: x forward, y up)
  const stickFor = (sd) => {
    const S = sd.toUpperCase(), P = (m) => { const x = at(F.mk, `${m}_tx`), y = at(F.mk, `${m}_ty`); return x && y ? { x, y } : null; };
    const mids = (a, b) => (a && b ? { x: a.x.map((v, i) => (v + b.x[i]) / 2), y: a.y.map((v, i) => (v + b.y[i]) / 2) } : a || b);
    const names = F.mk.names.filter((k) => k.endsWith("_tx")).map((k) => k.slice(0, -3));
    const asis = P(S + "ASIS") || P(S + "ASI"), psis = P(S + "PSIS") || P(S + "PSI");
    return {
      pelvis: [asis, psis], knee: mids(P(S + "MCO") || P(S + "KNEM"), P(S + "LCO") || P(S + "KNE")),
      ankle: mids(P(S + "MMA") || P(S + "ANKM"), P(S + "LMA") || P(S + "ANK")), heel: P(S + "HEEL") || P(S + "HEE"),
      toe: P(S + "MET01") || P(S + "TOE") || P(S + "METP"), met5: P(S + "MET05"),
      all: names.filter((m) => m[0] === S || !/^[LR][A-Z]/.test(m)).map((m) => ({ m, ...P(m) })),
    };
  };
  const stick = F.mk ? stickFor(side) : null, stick2 = F.mk ? stickFor(side === "r" ? "l" : "r") : null;
  const grf = [];
  if (F.grf) for (let k = 1; k <= 4; k++) { const fx = at(F.grf, `ground_force_${k}_vx`), fy = at(F.grf, `ground_force_${k}_vy`), px = at(F.grf, `ground_force_${k}_px`); if (fx && fy && px) grf.push({ fx, fy, px }); }
  const actM = {}; if (F.act) for (const m of F.act.names) { if (m === "time") continue; const a = at(F.act, m); if (a) actM[m] = a; }   // both sides: EMG may be on either leg
  let emg = null;
  if (F.emg && F.emgMap) { emg = {}; for (const [ch, mus] of Object.entries(F.emgMap)) { const e = at(F.emg, ch), mm = mus.filter((m) => actM[m]); if (e && mm.length) emg[ch] = { v: e, mus: mm }; } }
  // joint reaction forces (BW): each source's component along the total, which sums to the total magnitude
  let jrf = null;
  if (F.jrc) {
    const bw = F.jrc.bw || F.bodyWeightN || 1, J = ["hip", "knee", "ankle"].map((j) => `${j}_${side}`);
    const pipe = F.jrc.names.some((n) => n.includes("|"));
    const col = (j, sname) => at(F.jrc, pipe ? `${j}|${sname}` : `${j}/${sname}/along`);
    const srcs = pipe ? [...new Set(F.jrc.names.filter((n) => J.some((j) => n.startsWith(j + "|"))).map((n) => n.split("|").slice(1).join("|")))]
      : [...new Set(F.jrc.names.filter((n) => n.endsWith("/along") && n.startsWith(J[0] + "/")).map((n) => n.slice(J[0].length + 1, -6)))];
    const mine = srcs.filter((sname) => !/total/i.test(sname));   // every source the file attributes to this joint; together they sum to the total
    const src = mine.map((sname) => ({ n: jrfLabel(sname), col: jrfCol(sname), res: /reserve|non-muscle|intersegmental/i.test(sname), v: J.map((j) => (col(j, sname) || new Float64Array(N)).map((x) => x / bw)) }));
    jrf = { bw, src,
      total: J.map((j, k) => { const a = pipe ? null : at(F.jrc, `${j}/total_mag`) || at(F.jrc, `${j}/total_mag/along`); if (a) return a.map((x) => x / bw);
        if (!pipe) return null; const t = new Float64Array(N); for (const x of src) for (let i = 0; i < N; i++) t[i] += x.v[k][i] || 0; return t; }),
      invivo: ["hip", "knee", "ankle"].map((j) => (F.invivo && (!F.measuredSide || F.measuredSide === side) ? at(F.invivo, `${j}_measured_f_BW`) : null)) };
    // merge sources that share a label (e.g. the small deep rotators all go to "Other muscles")
    const by = new Map(); for (const sObj of jrf.src) { const o = by.get(sObj.n); if (!o) by.set(sObj.n, sObj); else o.v = o.v.map((arr, k) => arr.map((x, i) => x + sObj.v[k][i])); }
    jrf.src = [...by.values()].filter((sObj) => sObj.v.some((arr) => arr.some((x) => Math.abs(x) > 1e-6)));
    // the file lumps gastrocnemius and soleus as "Triceps surae": split it back. Soleus does not cross the knee, so the knee part is all
    // gastrocnemius; elsewhere it is shared by the two muscles' SO forces at each frame.
    const ts = jrf.src.find((x) => x.n === "Triceps surae");
    if (ts) {
      const sumF = (re) => { const out = new Float64Array(N); if (F.force) for (const m of F.force.names) if (re.test(m) && m.endsWith("_" + side)) { const a = at(F.force, m); for (let i = 0; i < N; i++) out[i] += a[i] || 0; } return out; };
      const fg = sumF(/^(gas|lat_gas|med_gas)/), fsol = sumF(/^soleus/);
      const share = Array.from(fg, (g, i) => (g + fsol[i] > 1e-9 ? g / (g + fsol[i]) : 0.5));
      const gas = { n: GROUPS[8][0], col: GROUPS[8][2], v: ts.v.map((arr, k) => arr.map((x, i) => (k === 1 ? x : x * share[i]))) };
      const sol = { n: GROUPS[9][0], col: GROUPS[9][2], v: ts.v.map((arr, k) => arr.map((x, i) => (k === 1 ? 0 : x * (1 - share[i])))) };
      jrf.src.splice(jrf.src.indexOf(ts), 1, gas, sol);
    }
  }
  return { t, N, ang, mom, res, G, stick, stick2, grf, side, actM, emg, jrf };
}

// ---------- UI ----------
export function initVisualise({ host, tr }) {
  const S = { src: "so", crop: null, view: "mom", speed: 0.25, emgFile: "", emgMap: {}, E: null, mode: "session", side: "r", fr: 0, play: false, files: null, sess: null, iter: "", trial: "", cycle: "", M: null, err: "" };
  const hide = new Set(), hideA = new Set(), css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  const f = (x, n = 1) => (Number.isFinite(x) ? x.toFixed(n) : "–");
  let raf = 0, last = 0;
  const ROLES = [["ik", "vi_fIK"], ["id", "vi_fID"], ["force", "vi_fForce"], ["act", "vi_fAct"], ["mk", "vi_fMk"], ["grf", "vi_fGrf"]];
  const MA = DOFS.flatMap((d, k) => ["r", "l"].map((sd) => [`ma_${d}_${sd}`, ["vi_fMAhip", "vi_fMAknee", "vi_fMAankle"][k], sd]));
  const single = {};                                   // role -> File (individual mode)

  // session folder: index the picked files by their path inside the session
  function indexSession(list) {
    const byPath = new Map(); let root = null;
    for (const fl of list) { const p = (fl.webkitRelativePath || fl.name).replace(/\\/g, "/"); byPath.set(p, fl); }
    const iters = {}, exp = {};
    for (const p of byPath.keys()) {
      let m = p.match(/^(.*?)3_iterations\/([^/]+)\/([^/]+)\/external_biomechanics\/(?:joint_angles|ik)\.mot$/);
      if (m) { root = m[1]; (iters[m[2]] = iters[m[2]] || []).push(m[3]); }
      m = p.match(/^(.*?)2_experimental\/([^/]+)\//); if (m) exp[m[2]] = true;
    }
    if (root == null) throw new Error(tr("vi_noSession"));
    return { byPath, root, iters };
  }
  const sessFile = (rel) => S.sess.byPath.get(S.sess.root + rel);
  const read = async (fl) => {                       // one unreadable file (changed or locked after picking, e.g. by cloud sync) must not sink the rest
    if (!fl) return null;
    try { return parseSto(await fl.text()); } catch (e) { (S.unread = S.unread || []).push(`${fl.webkitRelativePath || fl.name}: ${e.message}`); return null; }
  };
  const findIn = (dir, re) => { const pre = S.sess.root + dir; for (const [p, fl] of S.sess.byPath) if (p.startsWith(pre) && re.test(p.slice(pre.length))) return fl; return null; };
  const hasCeinms = () => !!(S.sess && S.iter && S.trial && findIn(`3_iterations/${S.iter}/${S.trial}/ceinms/`, /^CEINMS_forces\.sto$/));
  async function loadSession() {
    if (S.src === "ceinms" && !hasCeinms()) S.src = "so";
    const it = S.iter, tl = S.trial, b = `3_iterations/${it}/${tl}/`, side = S.side;
    const F = {
      ik: await read(sessFile(b + "external_biomechanics/joint_angles.mot") || sessFile(b + "external_biomechanics/ik.mot")), id: await read(sessFile(b + "external_biomechanics/inverse_dynamics.sto")),
      ...(S.src === "ceinms" ? {
        act: await read(findIn(b + "ceinms/", /^CEINMS_activations\.sto$/)), force: await read(findIn(b + "ceinms/", /^CEINMS_forces\.sto$/)),
        jrc: await read(sessFile(b + "joint_contact_forces/contributions_ceinms.sto") || sessFile(b + "joint_contact_forces/jra_ceinms_contrib.sto")) } : {
        act: await read(sessFile(b + "static_optimisation/StaticOptimization_activation.sto") || findIn(b + "static_optimisation/", /^[^/]*StaticOptimization_activation\.sto$/)),
        force: await read(sessFile(b + "static_optimisation/StaticOptimization_force.sto") || findIn(b + "static_optimisation/", /^[^/]*StaticOptimization_force\.sto$/)),
        jrc: await read(sessFile(b + "joint_contact_forces/contributions_so.sto") || sessFile(b + "joint_contact_forces/jra_so_contrib.sto")) }), invivo: await read(sessFile(`2_experimental/${tl}/invivo_jcf.mot`)),
      mk: await read(sessFile(b + "external_biomechanics/_ik_model_marker_locations.sto")), grf: await read(sessFile(`2_experimental/${tl}/grf.mot`)), ma: {},
    };
    for (const d of DOFS) F.ma[d] = await read(sessFile(`${b}muscle_analysis/_MuscleAnalysis_MomentArm_${d}_${side}.sto`));
    const sy = sessFile("session.yaml");
    const syText = sy ? await sy.text() : "";
    const bm = syText.match(/^body_mass:\s*['"]?([\d.]+)/m); F.bodyWeightN = bm ? +bm[1] * 9.81 : null;   // for contributions saved in N
    S.emgMap = parseEmgMap(syText);
    const ms = syText.match(/^measured_side:\s*['"]?([lr])/mi);       // instrumented-implant side; in vivo data belong to that leg only
    F.measuredSide = ms ? ms[1].toLowerCase() : null;
    const y = sessFile(`2_experimental/${tl}/movement_detection.yaml`);
    S.cycles = y ? parseCycles(await y.text()) : [];
    return F;
  }
  async function loadSingle() {
    const F = { ma: {} };
    for (const [k] of ROLES) F[k] = await read(single[k]);
    for (const d of DOFS) F.ma[d] = await read(single[`ma_${d}_${S.side}`]);   // moment arms of the side being shown
    if (!F.ik) throw new Error(tr("vi_needIK"));
    return F;
  }
  async function refresh() {
    const prevT = S.M ? S.M.t[Math.round(S.fr)] : NaN;
    S.err = ""; S.M = null; S.unread = [];
    try {
      const F = S.mode === "session" ? (S.sess && S.iter && S.trial ? await loadSession() : null) : await loadSingle();
      if (F && !F.ik) throw new Error(tr("vi_needIK"));
      if (F) { const c = (S.cycles || []).find((x) => x.name === S.cycle); const tNow = prevT; S.M = buildModel(F, S.side, S.crop || (c ? [c.t0, c.t1] : null)); S.fr = 0;
        if (Number.isFinite(tNow)) { let b = 0; for (let i = 0; i < S.M.N; i++) if (Math.abs(S.M.t[i] - tNow) < Math.abs(S.M.t[b] - tNow)) b = i; S.fr = b; }   // stay at the same time when the side or iteration changes
        if (!extraFiles().includes(S.extra)) S.extra = ""; await loadExtra(); if (!extraFiles().includes(S.emgFile)) S.emgFile = ""; await loadEmg(); }
    } catch (e) { S.err = e.message || String(e); }
    if (S.unread.length) S.err = (S.err ? S.err + " · " : "") + tr("vi_unread") + " " + S.unread.join("; ");
    render();
  }

  function controls() {
    const fileIn = ([k, lab, sd]) => `<label class="phSl">${tr(lab)}${sd ? ` — ${tr(sd === "r" ? "vi_right" : "vi_left")}` : ""}<input type="file" accept=".mot,.sto,.txt" data-role="${k}"><small>${single[k] ? single[k].name : ""}</small></label>`;
    if (S.mode === "single") return `<div class="viMA">${MA.map(fileIn).join("")}</div><div class="phCtl">${ROLES.map(([k, lab]) => `<label class="phSl">${tr(lab)}<input type="file" accept=".mot,.sto,.txt" data-role="${k}"><small>${single[k] ? single[k].name : ""}</small></label>`).join("")}
      <label class="phSl">${tr("vi_side")}<select data-vs="side"><option value="r"${S.side === "r" ? " selected" : ""}>${tr("vi_right")}</option><option value="l"${S.side === "l" ? " selected" : ""}>${tr("vi_left")}</option></select></label></div>`;
    const it = S.sess ? Object.keys(S.sess.iters) : [], trials = S.sess && S.iter ? S.sess.iters[S.iter] || [] : [];
    const opt = (arr, v) => arr.map((a) => `<option value="${a}"${a === v ? " selected" : ""}>${a}</option>`).join("");
    return `<div class="phSl"><span>${tr("vi_pick")}</span><div class="row"><button type="button" class="ghost" data-pickdir style="width:auto">${tr("vi_chooseDir")}</button><span class="note">${S.dirName || tr("vi_noDir")}</span></div><input type="file" webkitdirectory directory multiple data-dir hidden></div>
      ${S.sess ? `<div class="phCtl"><label class="phSl">${tr("vi_iter")}<select data-vs="iter">${opt(it, S.iter)}</select></label>
      <label class="phSl">${tr("vi_trial")}<select data-vs="trial">${opt(trials, S.trial)}</select></label>
      <label class="phSl">${tr("vi_cycle")}<select data-vs="cycle"><option value="">${tr("vi_whole")}</option>${(S.cycles || []).map((c) => `<option value="${c.name}"${c.name === S.cycle ? " selected" : ""}>${c.name} (${c.side || "?"}, ${f(c.t0, 2)}–${f(c.t1, 2)} s)</option>`).join("")}</select></label>
      <label class="phSl">${tr("vi_side")}<select data-vs="side"><option value="r"${S.side === "r" ? " selected" : ""}>${tr("vi_right")}</option><option value="l"${S.side === "l" ? " selected" : ""}>${tr("vi_left")}</option></select></label>
      ${hasCeinms() ? `<label class="phSl">${tr("vi_src")}<select data-vs="src"><option value="so"${S.src === "so" ? " selected" : ""}>${tr("vi_srcSo")}</option><option value="ceinms"${S.src === "ceinms" ? " selected" : ""}>CEINMS</option></select></label>` : ""}</div>` : ""}`;
  }
  const chip = (key, n, col, set, dash) => `<button type="button" class="ghost${set.has(n) ? " off" : ""}" data-${key}="${n}"><i style="background:${col}${dash ? ";height:2px" : ""}"></i>${n}</button>`;
  const legendT = () => !S.M ? "" : chip("mu", tr("vi_angle"), css("--accent"), hide) + chip("mu", tr("vi_idMom"), "#f4a261", hide).replace(`>${tr("vi_idMom")}<`, `>${S.view === "jrf" ? tr("vi_jrfTot") : tr("vi_idMom")}<`) + (S.view === "jrf" && S.M.jrf && S.M.jrf.invivo.some(Boolean) ? `<span class="note">- - ${tr("vi_invivo")}</span>` : "");
  const legendJ = () => !S.M ? "" : S.view === "jrf" && S.M.jrf ? S.M.jrf.src.map((x) => chip("mu", x.n, x.col, hide)).join("") + (S.M.G.some((g) => g.act) ? S.M.G.filter((g) => g.act && !S.M.jrf.src.some((x) => x.n === g.n)).map((g) => chip("mu", g.n, g.col, hide)).join("") : "") + `<span class="note">${tr("rm_legTap")}</span>` : [].concat(S.M.G.filter((g) => g.act || g.contrib.some((a) => a.some((v) => v))).map((g) => chip("mu", g.n, g.col, hide)))
    .concat(S.M.res.some(Boolean) ? [chip("mu", tr("vi_reserve"), RCOL, hide)] : []).join("") + `<span class="note">${tr("rm_legTap")}</span>`;
  const legendA = () => !S.M || !S.X ? "" : S.X.cols.map((c) => chip("ma", c.n, c.col, hideA)).join("");
  function extraFiles() {                             // every .sto/.mot of this trial in the chosen iteration (and its experimental folder)
    if (S.mode !== "session" || !S.sess) return [];
    const a = `3_iterations/${S.iter}/${S.trial}/`, b = `2_experimental/${S.trial}/`, out = [];
    for (const p of S.sess.byPath.keys()) { const r = p.slice(S.sess.root.length); if ((r.startsWith(a) || r.startsWith(b)) && /\.(sto|mot)$/i.test(r)) out.push(r); }
    return out.sort();
  }
  async function loadExtra() {
    S.X = null; if (!S.extra || !S.M) return;
    try {
      const d = parseSto(await sessFile(S.extra).text()), side = S.side, M = S.M;
      let names = d.names.filter((n) => n !== "time"); const sided = names.filter((n) => new RegExp(`_${side}($|_)`).test(n)); if (sided.length) names = sided;
      let cols = names.map((n) => ({ n, v: interp(M.t, d.cols.time, d.cols[n]) })).filter((c) => c.v.some(Number.isFinite));
      const rng = (v) => { let lo = Infinity, hi = -Infinity; for (const x of v) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } return hi - lo; };
      cols.sort((x, y) => rng(y.v) - rng(x.v)); cols = cols.slice(0, 24);
      cols.forEach((c, i) => { c.col = `hsl(${(i * 137.5) % 360}, 70%, 60%)`; });
      S.X = { cols, name: S.extra.split("/").pop() };
    } catch (e) { S.err = e.message; }
  }
  function render() {
    const ex = extraFiles(), act = "static_optimisation/StaticOptimization_activation.sto";
    host.innerHTML = `<div class="rmWrap"><div class="rmSide">
      <div class="chips phTabs"><button type="button" class="ghost${S.mode === "session" ? " on" : ""}" data-mode="session">${tr("vi_tSession")}</button><button type="button" class="ghost${S.mode === "single" ? " on" : ""}" data-mode="single">${tr("vi_tSingle")}</button></div>
      ${controls()}${S.err ? `<p class="warn">${S.err}</p>` : ""}<details class="note"><summary>${tr("vi_about")}</summary>${tr("vi_note")}</details></div>
      ${S.M ? `<div class="rmMain">
      <div class="row bfbRow viBar"><button type="button" id="viPlay" style="width:auto">${tr(S.play ? "ph_pause" : "ph_play")}</button>
        <div class="viSpeed" title="${tr("vi_speed")}"><button type="button" class="ghost" data-sp="-1" aria-label="slower">−</button><b data-spv>${S.speed}×</b><button type="button" class="ghost" data-sp="1" aria-label="faster">+</button></div>
        <div class="phSl" style="flex:1"><span>${tr("vi_time")} <b data-vv>${f(S.M.t[Math.round(S.fr)], 3)} s</b></span><div class="viStep"><button type="button" class="ghost" data-step="-1" aria-label="previous frame">◀</button><input type="range" min="0" max="${S.M.N - 1}" step="1" value="${Math.round(S.fr)}" data-vfr><button type="button" class="ghost" data-step="1" aria-label="next frame">▶</button></div></div></div>
      <div class="viCrop"><span>${tr("vi_crop")}</span><input type="number" step="0.001" data-c0 value="${f(S.M.t[0], 3)}"><span>–</span><input type="number" step="0.001" data-c1 value="${f(S.M.t[S.M.N - 1], 3)}"><span>s</span>
        <button type="button" class="ghost" data-cset="0">${tr("vi_cStart")}</button><button type="button" class="ghost" data-cset="1">${tr("vi_cEnd")}</button>
        ${S.crop ? `<button type="button" class="ghost" data-creset>${tr("vi_cReset")}</button>` : ""}
        ${S.mode === "session" ? `<button type="button" data-csave>${tr("vi_cSave")}</button>` : ""}<span class="note" data-cmsg></span></div>
      <div class="viAWrap"><canvas class="phCv viCvA" id="viCvA"></canvas><div class="viViews" id="viViews"><button type="button" class="ghost${S.view === "mom" ? " on" : ""}" data-view="mom">${tr("vi_vMom")}</button><button type="button" class="ghost${S.view === "jrf" ? " on" : ""}" data-view="jrf"${S.M.jrf ? "" : " disabled title=\"" + tr("vi_noJrf") + "\""}>${tr("vi_vJrf")}</button>${S.mode === "session" && hasCeinms() ? `<span style="width:12px"></span><button type="button" class="ghost${S.src === "so" ? " on" : ""}" data-src="so">SO</button><button type="button" class="ghost${S.src === "ceinms" ? " on" : ""}" data-src="ceinms">CEINMS</button>` : ""}</div></div><div class="rmLeg">${legendT()}</div>
      <div class="viSelRow"><select data-extra class="viTitleSel"><option value="">${tr("vi_actDefault")}</option>${ex.filter((r) => !r.endsWith(act)).map((r) => `<option value="${r}"${r === S.extra ? " selected" : ""}>${r.replace(/^3_iterations\/[^/]+\/[^/]+\//, "").replace(/^2_experimental\/[^/]+\//, "exp / ")}</option>`).join("")}</select>${!S.extra && S.mode === "session" ? `<select data-emg class="viTitleSel" style="margin-left:8px"><option value="">${tr("vi_noEmg")}</option>${ex.filter((r) => r.startsWith(`2_experimental/${S.trial}/`)).sort((a, b) => (/emg/i.test(b) ? 1 : 0) - (/emg/i.test(a) ? 1 : 0)).map((r) => `<option value="${r}"${r === S.emgFile ? " selected" : ""}>${tr("vi_emgVs")} ${r.split("/").pop()}</option>`).join("")}</select>` : ""}</div>
      <canvas class="phCv viCvB" id="viCvB"></canvas>${S.X ? `<div class="rmLeg">${legendA()}</div>` : ""}<div class="rmLeg">${legendJ()}</div></div>` : ""}</div>`;
    draw();
  }
  function fit(cv) {
    const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1, w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext("2d"); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, r.width, r.height); return [c, r.width, r.height];
  }
  function axes(c, x0, y0, w, h, ser, side) {
    let lo = Infinity, hi = -Infinity; for (const s of ser) for (const v of s.v) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    lo = Math.min(lo, 0); hi = Math.max(hi, 0); if (hi - lo < 1e-6) hi = lo + 1; const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const Y = (v) => y0 + h - h * (v - lo) / (hi - lo);
    c.font = "11px system-ui"; c.fillStyle = ser[0].col || css("--muted");
    for (const v of [hi, (hi + lo) / 2, lo]) { const t = f(v, Math.abs(hi - lo) < 5 ? 1 : 0), tw = c.measureText(t).width; c.fillText(t, side < 0 ? x0 - tw - 4 : x0 + w + 4, Math.min(y0 + h, Math.max(y0 + 10, Y(v) + 4))); }
    return Y;
  }
  function panel(c, x0, y0, w, h, title, L, R, fr, stack, N) {
    const line = css("--line"), X = (i) => x0 + w * i / (N - 1);
    c.fillStyle = css("--card"); c.fillRect(x0, y0, w, h); c.strokeStyle = line; c.lineWidth = 1; c.strokeRect(x0, y0, w, h);
    for (let g = 1; g < 4; g++) { c.globalAlpha = 0.35; c.beginPath(); c.moveTo(x0 + w * g / 4, y0); c.lineTo(x0 + w * g / 4, y0 + h); c.stroke(); c.globalAlpha = 1; }
    const draw1 = (ser, Y) => { c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x0 + w, Y(0)); c.strokeStyle = line; c.stroke();
      for (const s of ser) { if (s.hide) continue; c.setLineDash(s.dash ? [6, 4] : []); c.strokeStyle = s.col; c.lineWidth = s.lw || 2.5; c.beginPath(); let pen = false;
        s.v.forEach((v, i) => { if (!Number.isFinite(v)) { pen = false; return; } pen ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)); pen = true; }); c.stroke(); }
      c.setLineDash([]); };
    if (L && L.s.length) draw1(L.s, axes(c, x0, y0, w, h, L.s, -1));
    if (R && R.s.length) {
      const Y = axes(c, x0, y0, w, h, R.s, 1);
      if (stack) { const up = new Array(N).fill(0), dn = new Array(N).fill(0);
        for (const it of stack) for (const sg of [1, -1]) { const base = sg > 0 ? up : dn, top = Array.from(it.v, (v, i) => base[i] + (sg > 0 ? Math.max(v || 0, 0) : Math.min(v || 0, 0)));
          if (top.every((v, i) => Math.abs(v - base[i]) < 1e-9)) continue;
          c.fillStyle = it.col; c.globalAlpha = it.res ? 0.45 : 0.8; c.beginPath(); top.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
          for (let i = N - 1; i >= 0; i--) c.lineTo(X(i), Y(base[i])); c.closePath(); c.fill(); c.globalAlpha = 1; for (let i = 0; i < N; i++) base[i] = top[i]; } }
      draw1(R.s, Y);
    }
    c.strokeStyle = "#e76f51"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(fr), y0); c.lineTo(X(fr), y0 + h); c.stroke();
    if (title) {                                       // readable title: a solid label in the top-left corner
      c.font = "bold 13px system-ui"; let tw = c.measureText(title).width + 14; c.font = "11px system-ui";
      const labs = [L, R].filter((a) => a && a.lab); for (const a of labs) tw += c.measureText(a.lab).width + 12;
      c.fillStyle = css("--bg") || "#111"; c.globalAlpha = 0.92; c.fillRect(x0 + 1, y0 + 1, tw, 22); c.globalAlpha = 1;
      c.font = "bold 13px system-ui"; c.fillStyle = css("--ink"); c.fillText(title, x0 + 7, y0 + 16);
      let tx = x0 + 14 + c.measureText(title).width; c.font = "bold 11px system-ui";
      for (const a of labs) { c.fillStyle = a.s[0].col; c.fillText(a.lab, tx, y0 + 16); tx += c.measureText(a.lab).width + 12; }
    }
  }
  function draw() { drawA(); drawB(); }
  function drawA() {
    const cv = host.querySelector("#viCvA"), M = S.M; if (!cv || !M) return;
    const [c, W, H] = fit(cv), mut = css("--muted"), acc = css("--accent"), mom = "#f4a261", N = M.N, fr = Math.round(S.fr);
    const fh = Math.round(H * 0.27), px = 44, py = fh + 6, pw = W - 88, ph = H - py - 2;
    const st = M.stick;
    if (st) {
      const pv = st.pelvis[0] || st.knee, cx = pv ? pv.x[fr] : 0, sc = (fh - 44) / 1.1, X = (x) => W / 2 + (x - cx) * sc, Y = (y) => fh - 36 - y * sc   /* room for the view buttons below the feet */, P = (p) => (p ? [X(p.x[fr]), Y(p.y[fr])] : null);
      c.strokeStyle = css("--line"); c.lineWidth = 1; c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(W, Y(0)); c.stroke();
      c.lineCap = "round"; c.lineJoin = "round";
      const chain = (pts) => { const q = pts.filter(Boolean); if (q.length < 2) return; c.beginPath(); q.forEach((p, i) => (i ? c.lineTo(...p) : c.moveTo(...p))); c.stroke(); };
      const legOf = (s2, col, lw) => { if (!s2) return; const pm2 = s2.pelvis[0] && s2.pelvis[1] ? [(P(s2.pelvis[0])[0] + P(s2.pelvis[1])[0]) / 2, (P(s2.pelvis[0])[1] + P(s2.pelvis[1])[1]) / 2] : null;
        c.strokeStyle = col; c.lineWidth = lw; chain([P(s2.pelvis[1]), pm2, P(s2.pelvis[0])]); chain([pm2, P(s2.knee), P(s2.ankle), P(s2.heel), P(s2.toe), P(s2.ankle)]); };
      legOf(M.stick2, mut, 3); legOf(st, acc, 4);
      c.fillStyle = mut; for (const m of st.all) if (m.x) { const p = P(m); c.beginPath(); c.arc(p[0], p[1], 2, 0, 7); c.fill(); }
      const k = 0.3 / 1000;
      for (const g of M.grf) { const fy = g.fy[fr]; if (!(fy > 20)) continue; const x0 = X(g.px[fr]);
        c.strokeStyle = "#e76f51"; c.lineWidth = 3; c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x0 + g.fx[fr] * k * sc, Y(fy * k)); c.stroke(); }
    } else { c.fillStyle = mut; c.font = "12px system-ui"; c.fillText(tr("vi_noStick"), 10, 20); }
    const gap = 6, jh = (ph - 2 * gap - 14) / 3, JN = [tr("rm_hip"), tr("rm_knee"), tr("rm_ankle")], hA = hide.has(tr("vi_angle")), hM = hide.has(tr("vi_idMom"));
    const vv = host.querySelector("#viViews"); if (vv) vv.style.top = (cv.getBoundingClientRect().top - vv.parentElement.getBoundingClientRect().top + fh - 30) + "px";   // just under the feet, above the plots
    if (S.view === "jrf" && M.jrf) {
      for (let d = 0; d < 3; d++) {
        const items = M.jrf.src.filter((x) => !hide.has(x.n)).map((x) => ({ col: x.col, res: x.res, v: x.v[d] }));
        const pos = Array.from({ length: N }, (_, i) => items.reduce((a, it) => a + Math.max(0, it.v[i] || 0), 0)), neg = Array.from({ length: N }, (_, i) => items.reduce((a, it) => a + Math.min(0, it.v[i] || 0), 0));
        const tot = M.jrf.total[d], iv = M.jrf.invivo[d], y0 = py + d * (jh + gap);
        const R = [{ v: tot || pos, col: "#f4a261", lw: 3, hide: hM }, { v: pos, hide: true }, { v: neg, hide: true }]; if (iv) R.push({ v: iv, col: css("--ink"), lw: 2.5, dash: true });
        panel(c, px, y0, pw, jh, JN[d], { lab: tr("vi_angAx"), s: [{ v: M.ang[d], col: acc, hide: hA }] }, { lab: tr("vi_jrfAx"), s: R }, fr, items, N);
        if (iv && items.length) {                        // agreement of the ticked sources' sum with the in vivo (instrumented implant) force
          const sm = pos.map((v, i) => v + neg[i]);
          let n = 0, mu = 0, ssr = 0, sst = 0; for (let i = 0; i < N; i++) if (Number.isFinite(iv[i])) { n++; mu += iv[i]; } mu /= n || 1;
          for (let i = 0; i < N; i++) if (Number.isFinite(iv[i])) { ssr += (iv[i] - sm[i]) ** 2; sst += (iv[i] - mu) ** 2; }
          const txt = `${tr("vi_invivo")}: RMSE ${f(Math.sqrt(ssr / (n || 1)), 2)} BW · R² ${f(1 - ssr / (sst || 1), 2)} · ${tr("vi_nowJ")} ${f(sm[fr] - iv[fr], 2)} BW`;
          c.font = "bold 11px system-ui"; const tw = c.measureText(txt).width + 12;
          c.fillStyle = css("--bg") || "#111"; c.globalAlpha = 0.92; c.fillRect(px + pw - tw - 2, y0 + 2, tw, 20); c.globalAlpha = 1; c.fillStyle = css("--ink"); c.fillText(txt, px + pw - tw + 4, y0 + 16);
        }
      }
      c.font = "11px system-ui"; c.fillStyle = mut; c.fillText(`${f(M.t[0], 2)} s`, px, H - 2); const te2 = `${f(M.t[N - 1], 2)} s`; c.fillText(te2, px + pw - c.measureText(te2).width, H - 2);
      return;
    }
    for (let d = 0; d < 3; d++) {
      const items = M.G.filter((g) => !hide.has(g.n) && g.contrib[d].some((v) => v)).map((g) => ({ col: g.col, v: g.contrib[d] }));
      if (M.res[d] && !hide.has(tr("vi_reserve"))) items.push({ col: RCOL, res: true, v: M.res[d] });
      const pos = Array.from({ length: N }, (_, i) => items.reduce((s2, it) => s2 + Math.max(0, it.v[i] || 0), 0)), neg = Array.from({ length: N }, (_, i) => items.reduce((s2, it) => s2 + Math.min(0, it.v[i] || 0), 0));
      panel(c, px, py + d * (jh + gap), pw, jh, JN[d], { lab: tr("vi_angAx"), s: [{ v: M.ang[d], col: acc, hide: hA }] },
        { lab: tr("vi_momAx"), s: [{ v: M.mom[d], col: mom, lw: 3, hide: hM }, { v: pos, hide: true }, { v: neg, hide: true }] }, fr, items, N);
      // fit of the ticked contributions to the ID moment: R², RMSE over the window and the gap at this frame
      if (items.length) {
        const sum = pos.map((v, i) => v + neg[i]), id = M.mom[d]; let n = 0, mu = 0, ssr = 0, sst = 0;
        for (let i = 0; i < N; i++) if (Number.isFinite(id[i])) { n++; mu += id[i]; } mu /= n || 1;
        for (let i = 0; i < N; i++) if (Number.isFinite(id[i])) { ssr += (id[i] - sum[i]) ** 2; sst += (id[i] - mu) ** 2; }
        const txt = `R² ${f(1 - ssr / (sst || 1), 2)} · RMSE ${f(Math.sqrt(ssr / (n || 1)), 1)} N·m · ${tr("vi_now")} ${f(id[fr] - sum[fr], 1)} N·m`;
        const y0 = py + d * (jh + gap); c.font = "bold 11px system-ui"; const tw = c.measureText(txt).width + 12;
        c.fillStyle = css("--bg") || "#111"; c.globalAlpha = 0.92; c.fillRect(px + pw - tw - 2, y0 + 2, tw, 20); c.globalAlpha = 1;
        c.fillStyle = css("--ink"); c.fillText(txt, px + pw - tw + 4, y0 + 16);
      }
    }
    c.font = "11px system-ui"; c.fillStyle = mut; c.fillText(`${f(M.t[0], 2)} s`, px, H - 2); const te = `${f(M.t[N - 1], 2)} s`; c.fillText(te, px + pw - c.measureText(te).width, H - 2);
  }
  function drawB() {
    const cv = host.querySelector("#viCvB"), M = S.M; if (!cv || !M) return;
    const [c, W, H] = fit(cv), ink = css("--ink"), N = M.N, fr = Math.round(S.fr), px = 44, pw = W - 88;
    if (S.X) {
      const ser = S.X.cols.filter((x) => !hideA.has(x.n)).map((x) => ({ v: x.v, col: x.col, lw: 1.8 }));
      if (ser.length) panel(c, px, 2, pw, H - 6, "", { s: ser }, null, fr, null, N);
      return;
    }
    const ah = H * 0.55, bh = H - ah - 8, al = M.G.filter((g) => g.act && !hide.has(g.n)).map((g) => ({ v: Array.from(g.act, (v) => v * 100), col: g.col, lw: 2 }));
    // EMG (dashed) on the same plot, coloured like the group of the muscles it is mapped to
    const gOf = (m) => (GROUPS.find(([, re]) => re.test(m.replace(/_[lr]$/, ""))) || OTHER), em = [];
    if (S.E) for (const e of S.E) { const g = e.mus.length ? gOf(e.mus[0]) : OTHER; if (hide.has(g[0])) continue;
      const mx = Math.max(...Array.from(e.v).filter(Number.isFinite)), sc = mx <= 1.5 ? 100 : 100 / (mx || 1);
      em.push({ v: Array.from(e.v, (v) => v * sc), col: g[2], lw: 2.2, dash: true, ch: e.ch }); }
    const all = al.concat(em);
    if (all.length) panel(c, px, 2, pw, ah, "", { lab: "%", s: all.concat([{ v: [0, 100], hide: true }]) }, null, fr, null, N);
    if (em.length) { c.font = "bold 11px system-ui"; const bw2 = Math.max(...em.map((e) => c.measureText("- - " + e.ch).width)) + 12;
      c.fillStyle = css("--bg") || "#111"; c.globalAlpha = 0.9; c.fillRect(px + pw - bw2 - 4, 4, bw2, 6 + 14 * em.length); c.globalAlpha = 1;
      em.forEach((e, i) => { c.fillStyle = e.col; c.fillText("- - " + e.ch, px + pw - bw2 + 2, 17 + i * 14); }); }
    const by = ah + 8, items = M.G.filter((g) => g.act && !hide.has(g.n));
    c.fillStyle = css("--card"); c.fillRect(px, by, pw, bh); c.strokeStyle = css("--line"); c.strokeRect(px, by, pw, bh);
    const bw = pw / Math.max(1, items.length), base = by + bh - 30, top = by + 18;
    items.forEach((g, i) => { const v = g.act[fr] * 100, x = px + i * bw + bw * 0.15, w = bw * 0.7, h = (base - top) * Math.min(1, Math.max(0, v / 100));
      c.fillStyle = g.col; c.fillRect(x, base - h, w, h); c.fillStyle = ink; c.font = "11px system-ui";
      const vt = f(v, 0); c.fillText(vt, x + w / 2 - c.measureText(vt).width / 2, base - h - 4);
      c.font = "10px system-ui"; g.n.split(" ").forEach((wd, j) => c.fillText(wd, x + w / 2 - c.measureText(wd).width / 2, base + 12 + j * 11)); });
  }
  async function loadEmg() {                          // EMG file from 2_experimental -> each mapped channel with its muscles' SO activations
    S.E = null; if (!S.emgFile || !S.M) return;
    try {
      const d = parseSto(await sessFile(S.emgFile).text()), M = S.M, chans = d.names.filter((n) => n !== "time"), out = [];
      for (const ch of chans) {
        const key = Object.keys(S.emgMap).find((k) => k === ch || k.endsWith(ch) || ch.endsWith(k));
        const mus = key ? S.emgMap[key].filter((m) => M.actM[m]) : [];
        const v = interp(M.t, d.cols.time, d.cols[ch]); if (!v.some(Number.isFinite)) continue;
        out.push({ ch: ch.replace(/^EMG_Channels_/, ""), v, mus });
      }
      const mapped = out.filter((o) => o.mus.length);
      S.E = (mapped.length ? mapped : out).slice(0, 12);
    } catch (e) { S.err = e.message; }
  }
  async function saveCropped() {                    // the trial's files, cropped, in the same session layout, as one .zip
    if (!S.sess || !S.M) return;
    const msg = host.querySelector("[data-cmsg]"), t0 = +S.M.t[0].toFixed(5), t1 = +S.M.t[S.M.N - 1].toFixed(5), top = S.dirName || "session";
    if (msg) msg.textContent = tr("vi_cWorking");
    const pre = [`2_experimental/${S.trial}/`, `3_iterations/${S.iter}/${S.trial}/`], files = [], skipped = [];
    for (const [p, fl] of S.sess.byPath) {
      const r = p.slice(S.sess.root.length);
      const isIterTop = r.startsWith(`3_iterations/${S.iter}/`) && r.split("/").length === 3;
      if (!(r === "session.yaml" || isIterTop || pre.some((x) => r.startsWith(x)))) continue;
      if (/\.(png|jpe?g|gif|bmp|mp4|avi)$/i.test(r) || fl.size > 60e6) continue;
      try {
        if (/\.(mot|sto|trc)$/i.test(r)) { const txt = cropText(r, await fl.text(), t0, t1); files.push({ name: `${top}/${r}`, data: txt == null ? new Uint8Array(await fl.arrayBuffer()) : txt }); }
        else if (r === "session.yaml") files.push({ name: `${top}/${r}`, data: cropSessionYaml(await fl.text(), S.trial, t0, t1) });
        else files.push({ name: `${top}/${r}`, data: new Uint8Array(await fl.arrayBuffer()) });
      } catch (e) { skipped.push(r); }
    }
    const blob = makeZip(files), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${top}_${S.trial}_${t0.toFixed(2)}-${t1.toFixed(2)}s.zip`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (msg) msg.textContent = `${files.length} ${tr("vi_cSaved")}` + (skipped.length ? ` · ${tr("vi_unread")} ${skipped.join(", ")}` : "");
  }
  function loop(ts) {
    if (!S.play || !S.M) { raf = 0; return; }
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
    const span = S.M.t[S.M.N - 1] - S.M.t[0]; S.fr = (S.fr + dt * S.speed * (S.M.N - 1) / Math.max(span, 1e-3)) % (S.M.N - 1);   // S.speed x real time
    const sl = host.querySelector("[data-vfr]"), o = host.querySelector("[data-vv]"); if (sl) sl.value = Math.round(S.fr); if (o) o.textContent = f(S.M.t[Math.round(S.fr)], 3) + " s";
    draw(); raf = requestAnimationFrame(loop);
  }
  function play(on) { S.play = on; const b = host.querySelector("#viPlay"); if (b) b.textContent = tr(on ? "ph_pause" : "ph_play"); if (on && !raf) { last = 0; raf = requestAnimationFrame(loop); } }

  host.addEventListener("click", (e) => {
    const md = e.target.closest("[data-mode]"); if (md) { S.mode = md.dataset.mode; play(false); refresh(); return; }
    if (e.target.id === "viPlay") { play(!S.play); return; }
    const stp = e.target.closest("[data-step]"); if (stp) { play(false); S.fr = Math.max(0, Math.min(S.M.N - 1, Math.round(S.fr) + +stp.dataset.step)); const sl = host.querySelector("[data-vfr]"), o = host.querySelector("[data-vv]"); if (sl) sl.value = S.fr; if (o) o.textContent = f(S.M.t[S.fr], 3) + " s"; draw(); return; }
    const cs = e.target.closest("[data-cset]"); if (cs) { const t = S.M.t[Math.round(S.fr)], w = S.crop || [S.M.t[0], S.M.t[S.M.N - 1]]; const nw = cs.dataset.cset === "0" ? [t, w[1]] : [w[0], t]; if (nw[1] - nw[0] > 0.02) { S.crop = nw; refresh(); } return; }
    if (e.target.closest("[data-creset]")) { S.crop = null; refresh(); return; }
    if (e.target.closest("[data-csave]")) { saveCropped(); return; }
    const vw = e.target.closest("[data-view]"); if (vw && !vw.disabled) { S.view = vw.dataset.view; render(); return; }
    const sb = e.target.closest("[data-src]"); if (sb) { S.src = sb.dataset.src; refresh(); return; }
    const sp = e.target.closest("[data-sp]"); if (sp) { const L = [0.1, 0.25, 0.5, 1, 2, 5], i = Math.max(0, Math.min(L.length - 1, L.indexOf(S.speed) + +sp.dataset.sp)); S.speed = L[i]; host.querySelector("[data-spv]").textContent = S.speed + "×"; return; }
    if (e.target.closest("[data-pickdir]")) { host.querySelector("[data-dir]").click(); return; }
    const ma = e.target.closest("[data-ma]"); if (ma) { const n = ma.dataset.ma; hideA.has(n) ? hideA.delete(n) : hideA.add(n); ma.classList.toggle("off", hideA.has(n)); drawB(); return; }
    const mu = e.target.closest("[data-mu]"); if (mu) { const n = mu.dataset.mu; hide.has(n) ? hide.delete(n) : hide.add(n); mu.classList.toggle("off", hide.has(n)); draw(); }
  });
  host.addEventListener("input", (e) => { if ("vfr" in e.target.dataset) { S.fr = +e.target.value; const o = host.querySelector("[data-vv]"); if (o) o.textContent = f(S.M.t[S.fr], 3) + " s"; draw(); } });
  host.addEventListener("change", async (e) => {
    const el = e.target;
    if ("dir" in el.dataset) {
      S.dirName = el.files.length ? String(el.files[0].webkitRelativePath || "").split("/")[0] : "";
      try { S.sess = indexSession(el.files); S.iter = Object.keys(S.sess.iters)[0]; S.trial = S.sess.iters[S.iter][0]; S.cycle = ""; } catch (err) { S.sess = null; S.err = err.message; render(); return; }
      return refresh();
    }
    if ("c0" in el.dataset || "c1" in el.dataset) { const a = +host.querySelector("[data-c0]").value, b = +host.querySelector("[data-c1]").value; if (b - a > 0.02) { S.crop = [a, b]; refresh(); } return; }
    if ("speed" in el.dataset) { S.speed = +el.value; return; }
    if ("emg" in el.dataset) { S.emgFile = el.value; await loadEmg(); render(); return; }
    if ("extra" in el.dataset) { S.extra = el.value; hideA.clear(); await loadExtra(); if (S.extra) S.E = null; else await loadEmg(); render(); return; }
    if (el.dataset.role) { single[el.dataset.role] = el.files[0]; return refresh(); }
    const k = el.dataset.vs; if (!k) return;
    S[k] = el.value;
    if (k === "iter") { const ts = S.sess.iters[S.iter] || []; if (!ts.includes(S.trial)) { S.trial = ts[0]; S.cycle = ""; } }   // keep trial (and cycle) when the new iteration has it
    if (k === "trial") S.cycle = "";
    if (k === "trial" || k === "cycle") S.crop = null;
    if (k === "cycle") { const c = (S.cycles || []).find((x) => x.name === S.cycle); if (c && c.side) S.side = c.side; }
    refresh();
  });
  window.addEventListener("resize", () => { if (!host.closest(".hidden")) draw(); });
  render();                                          // fill the page now, so it is never blank however the view was reached
  return {
    open() { render(); },
    /** Show a session handed over as File objects carrying their path in `webkitRelativePath` (e.g. from Simulate). */
    async loadFiles(list, dirName) {
      S.mode = "session"; S.dirName = dirName || "session"; S.cycle = ""; S.crop = null;
      try { S.sess = indexSession(list); S.iter = Object.keys(S.sess.iters)[0]; S.trial = S.sess.iters[S.iter][0]; } catch (err) { S.sess = null; S.err = err.message; render(); return; }
      await refresh();
    },
    leave() { play(false); },
  };
}
