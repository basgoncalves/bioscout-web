/**
 * summaryhtml.js -- 3_iterations/<it>/<trial>/summary.html: one interactive page with every output of a
 * trial (Plotly, loaded from cdnjs when the page opens):
 *
 *   1. vertical GRF + hip / knee / ankle angles (with the IK marker RMSE of the markers around each joint)
 *   2. pelvis residual forces and moments + total joint contact force of hip / knee / ankle
 *   3. joint moments: inverse dynamics vs the muscles' moment (force x moment arm), split by muscle group
 *   4. muscle-group contributions to each joint contact force
 *
 * Buttons on top pick SO, CEINMS or MOCO (a method whose files are missing is greyed out), or Compare,
 * which turns them into ticks to overlay. Right / left side switch.
 *
 * files: {name: text} -- the trial's .sto/.mot by file name, plus "grf.mot", and per method the force,
 * jra and jra_contrib files under the names listed in METHODS.
 */
import { readSto, emgEnvelope, emgColumn } from "./simfigs.js";

export const METHODS = [
  { key: "so", label: "SO", act: "SO_StaticOptimization_activation.sto", force: "SO_StaticOptimization_force.sto", jra: "jra_so.sto", contrib: "jra_so_contrib.sto", mom: "SO_StaticOptimization_moments_contrib.sto" },
  { key: "ceinms", label: "CEINMS", act: "CEINMS_activations.sto", force: "CEINMS_forces.sto", jra: "jra_ceinms.sto", contrib: "jra_ceinms_contrib.sto" },
  { key: "moco", label: "MOCO", act: "MOCO_activations.sto", force: "MOCO_forces.sto", jra: "jra_moco.sto", contrib: "jra_moco_contrib.sto" },
  // the Python bioscout's other solvers (its live results page, bioscout.plot.live); greyed out when absent
  { key: "mew", label: "MEW", act: "MEW_activations.sto", force: "MEW_forces.sto", jra: "jra_mew.sto", contrib: "jra_mew_contrib.sto" },
  { key: "cmc", label: "CMC", act: "CMC_activations.sto", force: "CMC_forces.sto", jra: "jra_cmc.sto", contrib: "jra_cmc_contrib.sto" },
];
// muscle groups, named as the jra_*_contrib.sto columns
const GROUPS = [
  ["Gluteus_maximus", /^glmax/], ["Gluteus_med+min", /^gl(med|min)/], ["Iliopsoas", /^(iliacus|psoas)/], ["Adductors", /^add|^grac/],
  ["Hamstrings", /^(bflh|bfsh|semimem|semiten)/], ["Rectus_femoris", /^recfem/], ["Vasti", /^vas/], ["Triceps_surae", /^(gas|soleus)/],
  ["Tibialis_anterior", /^tibant/], ["Other_muscles", /./],
];
const groupOf = (m) => GROUPS.find(([, re]) => re.test(m.replace(/_[rl]$/, "")))[0];
const JOINTS = [
  { key: "hip", coord: "hip_flexion", jra: (s) => new RegExp(`^hip_${s}_on_femur_${s}_in_femur_${s}_f[xyz]$`), mk: ["ASI", "PSI", "SACR", "THI"] },
  { key: "knee", coord: "knee_angle", jra: (s) => new RegExp(`^(tibial_plat_weld|walker_knee|knee)_${s}_on_.*_f[xyz]$|^Lerner_knee_${s}_on_.*_f[xyz]$`), mk: ["THI", "FC", "KNE", "TIB"] },
  { key: "ankle", coord: "ankle_angle", jra: (s) => new RegExp(`^ankle_${s}_on_talus_${s}_in_talus_${s}_f[xyz]$`), mk: ["TIB", "MAL", "HEE", "MT", "TOE"] },
];
const interp = (tx, ty, t) => { const out = new Array(t.length); let k = 0;
  for (let i = 0; i < t.length; i++) { while (k < tx.length - 2 && tx[k + 1] < t[i]) k++; const a = tx[k], b = tx[k + 1] ?? a, f = b > a ? Math.min(1, Math.max(0, (t[i] - a) / (b - a))) : 0; out[i] = ty[k] + f * ((ty[k + 1] ?? ty[k]) - ty[k]); }
  return out; };
const r3 = (a) => a.map((v) => (Number.isFinite(v) ? +v.toFixed(3) : null));

/** -> the data the page draws (both sides), or null without IK. */
const KEY_MUSCLES = ["glmax1", "glmed1", "iliacus", "addlong", "recfem", "vaslat", "vasmed", "bflh", "semiten", "gasmed", "soleus", "tibant"];
export function summaryData(files, { mass = 0, emgMap = {} } = {}) {
  const S = (n) => (files[n] ? readSto(files[n]) : null);
  const ik = S("joint_angles.mot") || S("ik.mot"); if (!ik) return null;
  const id = S("inverse_dynamics.sto"), grf = S("grf.mot"), err = S("ik_marker_errors_all.sto");
  // the analysed window: inverse kinematics may carry a margin either side of what inverse dynamics kept
  const tk = ik.t, inWin = id && id.t.length > 2 ? (x) => x >= id.t[0] - 1e-9 && x <= id.t[id.t.length - 1] + 1e-9 : () => true;
  const t = tk.filter(inWin).length > 2 ? tk.filter(inWin) : tk, t0 = t[0], t1 = t[t.length - 1], bw = mass ? mass * 9.81 : 0;
  const D = { t: r3(t), mass, sides: {}, methods: {} };
  if (grf) {
    const keep = grf.t.map((x, i) => (x >= t0 && x <= t1 ? i : -1)).filter((i) => i >= 0), step = Math.max(1, Math.ceil(keep.length / 600)), idx = keep.filter((_, j) => j % step === 0);
    D.grf = { t: r3(idx.map((i) => grf.t[i])), plates: grf.cols.filter((c) => /_vy$/.test(c) && !/moment/.test(c))
      .map((c) => ({ name: c.replace(/^ground_force_/, "plate ").replace(/_vy$/, ""), y: r3(idx.map((i) => grf.col(c)[i] / (bw || 1))) })).filter((p) => p.y.some((v) => Math.abs(v) > (bw ? 0.05 : 20))) };
  }
  if (id) {
    const f = ["pelvis_tx_force", "pelvis_ty_force", "pelvis_tz_force"].filter((c) => id.col(c)), m = ["pelvis_tilt_moment", "pelvis_list_moment", "pelvis_rotation_moment"].filter((c) => id.col(c));
    D.res = { t: r3(id.t), F: f.map((c) => ({ name: c.replace(/^pelvis_|_force$/g, ""), y: r3(id.col(c).map((v) => (bw ? 100 * v / bw : v))) })), M: m.map((c) => ({ name: c.replace(/^pelvis_|_moment$/g, ""), y: r3(id.col(c)) })) };
  }
  const methods = METHODS.map((me) => ({ ...me, F: S(me.force), J: S(me.jra), C: S(me.contrib), Mc: me.mom ? S(me.mom) : null }));
  for (const me of methods) D.methods[me.key] = { label: me.label, ok: !!(me.F || me.J) };
  const bp = S("body_positions.sto");
  if (bp) {                                                      // body origins in ground, for the 3D view
    const names = [...new Set(bp.cols.filter((c) => /_x$/.test(c)).map((c) => c.slice(0, -2)))].filter((b) => bp.col(b + "_y") && bp.col(b + "_z"));
    D.bodies = Object.fromEntries(names.map((b) => [b, ["x", "y", "z"].map((a) => r3(interp(bp.t, bp.col(`${b}_${a}`), t)))]));
  }
  if (grf) {
    D.grf3 = grf.cols.filter((c) => /_vy$/.test(c) && !/moment/.test(c)).map((c) => { const k = c.slice(0, -3), pk = k.replace(/_v?$/, "").replace(/force/, "force") ;
      const f = ["x", "y", "z"].map((a) => grf.col(`${k}_v${a}`)), pp = ["x", "y", "z"].map((a) => grf.col(`${k}_p${a}`));
      return f.every(Boolean) && pp.every(Boolean) ? { F: f.map((v) => r3(interp(grf.t, v, t))), P: pp.map((v) => r3(interp(grf.t, v, t))) } : null; })
      .filter((x) => x && x.F[1].some((v) => v > 20));
  }
  for (const s of ["r", "l"]) {
    const side = { joints: {} };
    for (const J of JOINTS) {
      const q = `${J.coord}_${s}`, o = {};
      if (ik.col(q)) o.angle = r3(interp(tk, ik.col(q), t));
      if (err) {                                                  // RMSE of the markers around this joint (mm)
        const L = s.toUpperCase(), mk = err.cols.filter((c) => c !== "time" && J.mk.some((p) => c.toUpperCase().includes(p)) && (c.toUpperCase().startsWith(L) || (J.key === "hip" && /SACR/i.test(c))));
        const v = mk.flatMap((c) => err.col(c).filter((_, i) => inWin(err.t[i]))).filter(Number.isFinite);
        if (v.length) { o.rmse = +(1000 * Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length)).toFixed(1); o.markers = mk;
          o.markerErr = Object.fromEntries(mk.map((c) => [c, r3(interp(err.t, err.col(c), t).map((e) => 1000 * e))])); }
      }
      if (id && id.col(`${q}_moment`)) o.idMoment = r3(interp(id.t, id.col(`${q}_moment`), t).map((v) => (mass ? v / mass : v)));
      const ma = S(`_MuscleAnalysis_MomentArm_${q}.sto`);
      o.m = {};
      for (const me of methods) {
        const r = {};
        if (me.Mc && me.Mc.cols.some((c) => c.startsWith(q + "|"))) {   // the solver's own moments: they add up to ID
          const grp = {};
          for (const c of me.Mc.cols.filter((x) => x.startsWith(q + "|") && !x.endsWith("|ID"))) {
            const mu = c.slice(q.length + 1), g = mu === "reserve" ? "Reserve_actuators" : groupOf(mu), y = interp(me.Mc.t, me.Mc.col(c), t);
            grp[g] = grp[g] || t.map(() => 0); y.forEach((v, i) => { grp[g][i] += v / (mass || 1); });
          }
          r.momGroups = Object.fromEntries(Object.entries(grp).map(([g, y]) => [g, r3(y)]));
          r.momTotal = r3(t.map((_, i) => Object.values(grp).reduce((a, y) => a + y[i], 0)));
          const idc = me.Mc.col(q + "|ID"); if (idc) r.idMoment = r3(interp(me.Mc.t, idc, t).map((v) => v / (mass || 1)));
        } else if (me.F && ma) {                                 // older runs: force x moment arm from the muscle analysis
          const grp = {};
          for (const mu of me.F.cols.filter((c) => c !== "time" && ma.col(c))) {
            const F = interp(me.F.t, me.F.col(mu), t), A = interp(ma.t, ma.col(mu), t);
            if (!A.some((a) => Math.abs(a) > 1e-4)) continue;
            const g = groupOf(mu); grp[g] = grp[g] || t.map(() => 0);
            F.forEach((f, i) => { grp[g][i] += (f * A[i]) / (mass || 1); });
          }
          const rs = me.F.col(`${q}_reserve`); if (rs) grp.Reserve_actuators = interp(me.F.t, rs, t).map((v) => v / (mass || 1));
          r.momGroups = Object.fromEntries(Object.entries(grp).map(([g, y]) => [g, r3(y)]));
          r.momTotal = r3(t.map((_, i) => Object.values(grp).reduce((a, y) => a + y[i], 0)));
        }
        if (me.J) {
          const cs = me.J.cols.filter((c) => J.jra(s).test(c)).slice(0, 3);
          if (cs.length === 3) r.jcf = r3(interp(me.J.t, me.J.t.map((_, i) => Math.hypot(...cs.map((c) => me.J.col(c)[i]))), t).map((v) => (bw ? v / bw : v)));
        }
        if (me.C) {
          const pre = `${J.key}_${s}|`, cs = me.C.cols.filter((c) => c.startsWith(pre));
          if (cs.length) r.jcfGroups = Object.fromEntries(cs.map((c) => [c.slice(pre.length), r3(interp(me.C.t, me.C.col(c), t).map((v) => (bw ? v / bw : v)))]));
        }
        o.m[me.key] = r;
      }
      side.joints[J.key] = o;
    }
    // muscles: the EMG-mapped ones first, then the key muscles of each group (12 at most)
    const nfl = S("_MuscleAnalysis_NormalizedFiberLength.sto"), emg = S("emg.mot");
    const acts = Object.fromEntries(methods.map((me) => [me.key, me.act ? S(me.act) : null]));
    const chOf = {}; for (const [ch, mus] of Object.entries(emgMap || {})) for (const m of mus || []) if (m.endsWith("_" + s)) chOf[m] = chOf[m] || ch;
    const have = (m) => Object.values(acts).some((a) => a && a.col(m)) || (nfl && nfl.col(m));
    const list = [...new Set([...Object.keys(chOf), ...KEY_MUSCLES.map((k) => k + "_" + s)])].filter(have).slice(0, 12);
    const envCache = {};
    side.muscles = list.map((m) => {
      const o = { name: m, act: {} };
      for (const [k, a] of Object.entries(acts)) if (a && a.col(m)) o.act[k] = r3(interp(a.t, a.col(m), t));
      if (nfl && nfl.col(m)) {
        const L = interp(nfl.t, nfl.col(m), t); o.nfl = r3(L);
        // fibre velocity (optimal lengths / s, + = lengthening) from the normalised length; light 5-point smoothing
        const v = L.map((_, i) => { const a = Math.max(0, i - 1), b = Math.min(L.length - 1, i + 1); return (L[b] - L[a]) / ((t[b] - t[a]) || 1); });
        o.vel = r3(v.map((_, i) => { let s2 = 0, n = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < v.length) { s2 += v[k]; n++; } return s2 / n; }));
      }
      o.force = {}; o.passive = {};
      for (const me of methods) {
        if (!(me.F && me.F.col(m))) continue;
        o.force[me.key] = r3(interp(me.F.t, me.F.col(m), t));
        // passive share of the total fibre force, from the force-length-velocity curves (as so.py):
        // fp / (a fl fv + fp) -- no maximal force needed
        const A = acts[me.key] && acts[me.key].col(m) ? interp(acts[me.key].t, acts[me.key].col(m), t) : null;
        if (A && o.nfl) o.passive[me.key] = r3(o.nfl.map((l, i) => {
          const fl = Math.exp(-((l - 1) ** 2) / 0.45), lc = Math.min(l, 1.4), fp = l > 1 ? (Math.exp(4 * (lc - 1) / 0.6) - 1) / (Math.exp(4) - 1) : 0;
          const vv = Math.max(-0.999, Math.min(1, (o.vel[i] || 0) / 10)), fv = vv <= 0 ? (1 + vv) / (1 - vv / 0.25) : 1.8 - 0.8 / (1 + vv * 7.56);
          const tot = A[i] * fl * fv + fp; return tot > 1e-6 ? 100 * fp / tot : 0; }));
      }
      const ch = chOf[m], col = emg && ch ? emgColumn(emg.cols, ch) : null;
      if (col) {
        if (!envCache[col]) { const e = emgEnvelope(emg.col(col), emg.t); const srt = Array.from(e).sort((x, y) => x - y), top = srt[Math.floor(0.995 * (srt.length - 1))] || 1; envCache[col] = Array.from(e, (v) => Math.min(1, v / top)); }
        o.emg = r3(interp(emg.t, envCache[col], t)); o.channel = ch;
      }
      return o;
    });
    D.sides[s] = side;
  }
  return D;
}

/** assets/vendor/plotly-2.35.2.min.js as text (cached), to put inside the page so it works offline. */
let plotlyText = null;
export async function plotlyInline() {
  if (plotlyText == null) { try { const r = await fetch(new URL("../assets/vendor/plotly-2.35.2.min.js", import.meta.url)); plotlyText = r.ok ? await r.text() : ""; } catch { plotlyText = ""; } }
  return plotlyText;
}
/** The page: the data inline; Plotly inline when `plotly` (its source) is given, else from cdnjs. */
export function summaryHtml(D, { title = "BioScout summary", side = "r", plotly = "" } = {}) {
  const json = JSON.stringify(D).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<&]/g, "")}</title>
${plotly ? `<script>${plotly.replace(/<\/script/gi, "<\\/script")}</script>` : `<script src="https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.35.2/plotly.min.js"></script>`}
<style>
:root{--bg:#fff;--fg:#1d1d1f;--sub:#6b6b70;--line:#d8d8dc;--card:#f6f6f8;--acc:#0b63ce}
@media (prefers-color-scheme:dark){:root{--bg:#141518;--fg:#e8e8ea;--sub:#9a9aa2;--line:#33343a;--card:#1c1d21;--acc:#5aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
h1{font-size:17px;margin:0 12px 0 0}.grp{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
button{font:inherit;padding:5px 12px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;cursor:pointer}
button.on{background:var(--acc);border-color:var(--acc);color:#fff}button:disabled{opacity:.4;cursor:not-allowed}
label.tick{display:inline-flex;gap:4px;align-items:center;padding:0 6px}.sub{color:var(--sub);font-size:12px}
main{padding:8px 16px 40px;max-width:1700px;margin:auto}h2{font-size:15px;margin:22px 0 4px}
.row{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.p{height:300px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.tall .p{height:380px}.p{position:relative}
details.sec>summary{list-style:none;cursor:pointer;user-select:none}details.sec>summary::-webkit-details-marker{display:none}
details.sec>summary h2{display:inline}details.sec>summary:before{content:"▾ ";color:var(--sub)}details.sec:not([open])>summary:before{content:"▸ "}
details.sec>summary{margin:22px 0 4px}details.sec h2{margin:0}
.small .p{height:220px}
#v3d{position:fixed;left:0;right:0;bottom:0;top:0;z-index:9;background:var(--bg);display:none;flex-direction:column}
#v3d .bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
#v3d .main{flex:1;display:flex;min-height:0}#v3d .scene{flex:1.25;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--line)}
#v3d canvas{flex:1;width:100%;min-height:0;cursor:grab;touch-action:none}#v3d .ctl{display:flex;gap:8px;align-items:center;padding:6px 10px;border-top:1px solid var(--line)}
#v3d .ctl input[type=range]{flex:1}#v3d .side{flex:1;min-width:320px;display:flex;flex-direction:column}
#v3d .tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--line);flex-wrap:wrap}#v3d .tabc{flex:1;overflow:auto;padding:8px;display:grid;gap:8px;align-content:start}
#v3d .tabc .p{height:230px}@media (max-width:800px){#v3d .main{flex-direction:column}#v3d .scene{border-right:0;min-height:45vh}}@media (min-width:900px){.dyn{grid-template-columns:repeat(4,minmax(0,1fr))}}.vcur{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--sub);pointer-events:none;z-index:2;display:none}
.badge{position:absolute;top:6px;left:8px;z-index:3;font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
.badge.hi{border-color:#d9534f;color:#ff8a80}.badge:hover{border-color:var(--acc)}
#pop{position:fixed;z-index:20;width:min(560px,92vw);height:340px;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);display:none;padding:6px}
#pop:before{content:"";position:absolute;top:-8px;left:30px;border:8px solid transparent;border-top:0;border-bottom-color:var(--line)}
#pop .x{position:absolute;right:6px;top:4px;z-index:4;padding:0 8px}#popPlot{width:100%;height:100%}@media (min-width:1200px){.r4{grid-template-columns:repeat(4,minmax(0,1fr))}.r5{grid-template-columns:repeat(5,minmax(0,1fr))}.r3{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (min-width:800px){.r2{grid-template-columns:repeat(2,minmax(0,1fr))}}#err{color:#c33;padding:20px;display:none}
</style></head><body>
<header><h1>${title.replace(/[<&]/g, "")}</h1>
<div class="grp" id="meth"></div><div class="grp" id="ticks"></div>
<div class="grp"><button id="v3open" title="the model in 3D with the plots beside it">3D view</button></div>
<div class="grp"><span class="sub">side</span><button data-side="r">Right</button><button data-side="l">Left</button></div>
<span class="sub" id="info"></span></header>
<div id="v3d"><div class="bar"><b id="v3title">3D view</b><span class="sub">drag to rotate · scroll to zoom · the plots on the right follow the frame</span><span style="flex:1"></span><button id="v3close">✕ Close 3D</button></div>
  <div class="main"><div class="scene"><canvas id="v3c"></canvas>
    <div class="ctl"><button id="v3play">▶</button><input type="range" id="v3fr" min="0" value="0"><span class="sub" id="v3t" style="width:70px;text-align:right"></span>
      <select id="v3speed"><option value="0.1">0.1x</option><option value="0.25" selected>0.25x</option><option value="0.5">0.5x</option><option value="1">1x</option></select>
      <label class="tick sub"><input type="checkbox" id="v3grf" checked>GRF</label><label class="tick sub"><input type="checkbox" id="v3trail">trail</label></div></div>
    <div class="side"><div class="tabs" id="v3tabs"></div><div class="tabc" id="v3tabc"></div></div></div></div>
<div id="pop"><button class="x" onclick="document.getElementById('pop').style.display='none'">✕</button><div id="popPlot"></div></div>
<div id="err">Plotly could not be loaded (it comes from cdnjs.cloudflare.com): open this page with an internet connection.</div>
<main>
<details class="sec" open><summary><h2>1 · Ground reaction force</h2></summary>
<div class="row"><div class="p" id="grf" style="height:240px"></div></div></details>
<details class="sec" open><summary><h2>2 · Joint angles <span class="sub">(marker RMSE = inverse-kinematics error of the markers around each joint)</span></h2></summary>
<div class="row r3"><div class="p" id="ang_hip"></div><div class="p" id="ang_knee"></div><div class="p" id="ang_ankle"></div></div></details>
<details class="sec" open><summary><h2>3 · Pelvis residuals <span class="sub">(what the model could not explain; forces ideally within ±5 % BW)</span></h2></summary>
<div class="row r2"><div class="p" id="resF"></div><div class="p" id="resM"></div></div></details>
<details class="sec" open><summary><h2>4 · Total joint contact force</h2></summary>
<div class="row r3"><div class="p" id="jcf_hip"></div><div class="p" id="jcf_knee"></div><div class="p" id="jcf_ankle"></div></div></details>
<details class="sec" open><summary><h2>5 · Muscle contributions <span class="sub" id="contribNote"></span></h2></summary>
<div class="row r2 tall"><div class="p" id="mom_hip"></div><div class="p" id="con_hip"></div><div class="p" id="mom_knee"></div><div class="p" id="con_knee"></div><div class="p" id="mom_ankle"></div><div class="p" id="con_ankle"></div></div></details>
<details class="sec" open><summary><h2>6 · Muscle dynamics <span class="sub">(per muscle: activation vs measured EMG (grey) · normalised fibre length · fibre velocity · force, with the passive share as % of total)</span></h2></summary>
<div class="row dyn small" id="dynGrid"></div></details>
</main>
<script>
let D = ${json};
const GC = {"Intersegmental":"#b5a07a","Adductors":"#2bb5c4","Gluteus_maximus":"#a464b0","Gluteus_med+min":"#5b8db8","Hamstrings":"#6b2f6e","Iliopsoas":"#e0703a","Rectus_femoris":"#2e6b44","Triceps_surae":"#a51f24","Vasti":"#6abf6a","Tibialis_anterior":"#e8c547","Other_muscles":"#c8c8c8","Reserve_actuators":"#4a4a4a"};
const ORDER = Object.keys(GC);
const MC = {so:"#1f77b4", ceinms:"#ff7f0e", moco:"#2ca02c", mew:"#9467bd", cmc:"#8c564b"}, DASH = {so:"solid", ceinms:"dash", moco:"dot", mew:"dashdot", cmc:"longdash"};
let keys = Object.keys(D.methods).filter((k) => D.methods[k].ok);
const st = { side: ${JSON.stringify(side)}, mode: keys[0] || "so", pick: new Set(keys) };
// live: BioScout Web posts new data after every step of a run (the page is then shown inside it)
window.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "bioscout-summary" || !window.Plotly) return;
  const had = new Set(keys); D = e.data.D; keys = Object.keys(D.methods).filter((k) => D.methods[k].ok);
  for (const k of keys) if (!had.has(k) && !st.touched) st.pick.add(k);   // new results join the comparison until you tick by hand
  if (st.mode !== "compare" && !keys.includes(st.mode)) st.mode = keys[0] || st.mode;
  if (e.data.title) document.querySelector("h1").textContent = e.data.title;
  ui(); draw();
});
const dark = matchMedia("(prefers-color-scheme: dark)").matches, FG = dark ? "#e8e8ea" : "#1d1d1f", GR = dark ? "#33343a" : "#e3e3e6";
const U = { get f() { return D.mass ? "BW" : "N"; }, get m() { return D.mass ? "N·m/kg" : "N·m"; } };
function lay(title, y, extra = {}) { return { title: { text: title, font: { size: 13 } }, margin: { l: 52, r: 10, t: 34, b: 36 }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: FG, size: 11 }, xaxis: { title: { text: "time (s)" }, gridcolor: GR, zerolinecolor: GR }, yaxis: { title: { text: y }, gridcolor: GR, zerolinecolor: GR },
  legend: { orientation: "h", y: -0.22, font: { size: 10 } }, hovermode: "x unified",
  hoverlabel: { bgcolor: "#000", bordercolor: "#555", font: { color: "#fff", size: 11 } }, ...extra }; }
// a stacked-area pair per group: positive parts stacked up from 0, negative parts stacked down (they pull against)
function stack(t, groups, key) {
  const tr = [], names = Object.keys(groups).sort((a, b) => (ORDER.indexOf(a) + 99 * (ORDER.indexOf(a) < 0)) - (ORDER.indexOf(b) + 99 * (ORDER.indexOf(b) < 0)));
  for (const g of names) { const y = groups[g], col = GC[g] || "#999", nm = g.replace(/_/g, " ");
    tr.push({ x: t, y: y.map((v) => Math.max(0, v || 0)), name: nm, legendgroup: key + g, stackgroup: key + "pos", mode: "none", fillcolor: col, line: { width: 0 }, hovertemplate: nm + ": %{customdata:.2f}<extra></extra>", customdata: y });
    tr.push({ x: t, y: y.map((v) => Math.min(0, v || 0)), name: nm, legendgroup: key + g, showlegend: false, stackgroup: key + "neg", mode: "none", fillcolor: col, line: { width: 0 }, hoverinfo: "skip" }); }
  return tr; }
const P = (id, tr, l) => { Plotly.react(id, tr, l, { responsive: true, displaylogo: false }); hookCursor(id); };
const methods = () => (st.mode === "compare" ? keys.filter((k) => st.pick.has(k)) : [st.mode]);
function ui() { if (V.open) setTimeout(v3tabs, 0);
  const m = document.getElementById("meth");
  m.innerHTML = Object.entries(D.methods).map(([k, v]) => \`<button data-m="\${k}" \${v.ok ? "" : "disabled title='not run for this trial'"}>\${v.label}</button>\`).join("") + '<button data-m="compare">Compare</button>';
  m.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.m === st.mode); b.onclick = () => {
    // Compare is a toggle: clicking it again goes back to one method (the first ticked one that has results)
    if (b.dataset.m === "compare" && st.mode === "compare") st.mode = keys.find((k) => st.pick.has(k)) || keys[0] || "so";
    else st.mode = b.dataset.m;
    ui(); draw(); }; });
  const tk = document.getElementById("ticks");
  tk.innerHTML = st.mode === "compare" ? Object.entries(D.methods).map(([k, v]) => \`<label class="tick"><input type="checkbox" data-k="\${k}" \${v.ok ? "" : "disabled"} \${st.pick.has(k) && v.ok ? "checked" : ""}>\${v.label}</label>\`).join("") : "";
  tk.querySelectorAll("input").forEach((c) => { c.onchange = () => { c.checked ? st.pick.add(c.dataset.k) : st.pick.delete(c.dataset.k); st.touched = true; draw(); }; });
  document.querySelectorAll("[data-side]").forEach((b) => { b.classList.toggle("on", b.dataset.side === st.side); b.onclick = () => { st.side = b.dataset.side; ui(); draw(); }; });
}
// the marker-RMSE badge on each angle plot; a click shows every marker's error over time in a balloon
function badge(id, o, j) {
  const host = document.getElementById(id); let b = host.querySelector(".badge");
  if (o.rmse == null) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement("button"); b.className = "badge"; host.appendChild(b); }
  b.textContent = \`marker RMSE \${o.rmse} mm ▾\`; b.classList.toggle("hi", o.rmse > 20); b.title = "show each marker's error";
  b.onclick = (e) => {
    e.stopPropagation(); const pop = document.getElementById("pop"), r = b.getBoundingClientRect();
    pop.style.display = "block"; pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left - 20)) + "px"; pop.style.top = Math.min(innerHeight - 350, r.bottom + 10) + "px";
    const tr = Object.entries(o.markerErr || {}).map(([m, y]) => ({ x: D.t, y, name: m, mode: "lines" }));
    Plotly.react("popPlot", tr, lay(\`\${j}: marker errors (RMSE \${o.rmse} mm)\`, "mm", { shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 20, y1: 20, line: { dash: "dot", color: "#c33", width: 1 } }], legend: { font: { size: 10 } } }), { displaylogo: false, responsive: true });
  };
}
// one time cursor on every plot: the hovered time drawn as a dashed line on all the others too
function cursor(x) {
  document.querySelectorAll(".p").forEach((gd) => {
    let v = gd.querySelector(":scope > .vcur"); if (!v) { v = document.createElement("div"); v.className = "vcur"; gd.appendChild(v); }
    const xa = gd._fullLayout && gd._fullLayout.xaxis;
    if (x == null || !xa || !gd.offsetWidth || x < xa.range[0] || x > xa.range[1]) { v.style.display = "none"; return; }
    v.style.left = (xa._offset + xa.l2p(x)) + "px"; const ya = gd._fullLayout.yaxis; v.style.top = ya._offset + "px"; v.style.bottom = "auto"; v.style.height = ya._length + "px"; v.style.display = "block";
  });
}
function hookCursor(id) { const gd = document.getElementById(id); if (!gd || gd._cur) return; gd._cur = 1;
  gd.on("plotly_hover", (e) => cursor(e.points && e.points[0] ? e.points[0].x : null)); gd.on("plotly_unhover", () => cursor(null)); }
// folded sections: plots inside get their size back when opened
document.querySelectorAll("details.sec").forEach((d) => d.addEventListener("toggle", () => { if (d.open) d.querySelectorAll(".p").forEach((gd) => { try { Plotly.Plots.resize(gd); } catch {} }); }));
document.addEventListener("click", (e) => { const pop = document.getElementById("pop"); if (pop.style.display === "block" && !pop.contains(e.target)) pop.style.display = "none"; });
function draw() {
  const t = D.t, S = D.sides[st.side], ms = methods();
  document.getElementById("info").textContent = \`\${D.mass ? D.mass + " kg · " : ""}\${t[0]}–\${t[t.length - 1]} s\`;
  // 1
  P("grf", D.grf ? D.grf.plates.map((p) => ({ x: D.grf.t, y: p.y, name: p.name, mode: "lines" })) : [], lay("Vertical GRF", U.f));
  for (const j of ["hip", "knee", "ankle"]) { const o = S.joints[j];
    P("ang_" + j, o.angle ? [{ x: t, y: o.angle, name: j, mode: "lines", line: { color: FG } }] : [], lay(\`\${j} flexion\`, "deg", { showlegend: false }));
    badge("ang_" + j, o, j); }
  // 2
  if (D.res) { P("resF", D.res.F.map((s) => ({ x: D.res.t, y: s.y, name: s.name, mode: "lines" })), lay("Pelvis residual forces", D.mass ? "% BW" : "N", { shapes: D.mass ? [-5, 5].map((v) => ({ type: "line", xref: "paper", x0: 0, x1: 1, y0: v, y1: v, line: { dash: "dot", color: "#c33", width: 1 } })) : [] }));
    P("resM", D.res.M.map((s) => ({ x: D.res.t, y: s.y, name: s.name, mode: "lines" })), lay("Pelvis residual moments", "N·m")); }
  for (const j of ["hip", "knee", "ankle"]) { const o = S.joints[j];
    P("jcf_" + j, ms.filter((k) => o.m[k] && o.m[k].jcf).map((k) => ({ x: t, y: o.m[k].jcf, name: D.methods[k].label, mode: "lines", line: { color: MC[k], width: 2 } })), lay(\`\${j} contact force (resultant)\`, U.f)); }
  // 5: per joint, moment (left) and contact force (right); one method = stacked groups + total, compare = totals
  document.getElementById("contribNote").textContent = ms.length > 1 ? "(compare: the totals of each method; pick one method for the muscle groups stacked)" : "(stacked by muscle group; below 0 = acts against; black = inverse dynamics / |JCF|)";
  for (const j of ["hip", "knee", "ankle"]) { const o = S.joints[j]; let tr = [];
    if (ms.length === 1) { const r = o.m[ms[0]] || {}; tr = stack(t, r.momGroups || {}, "m"); }
    else for (const k of ms) { const r = o.m[k] || {}; if (r.momTotal) tr.push({ x: t, y: r.momTotal, name: D.methods[k].label + " muscles", mode: "lines", line: { color: MC[k], width: 2.5, dash: DASH[k] } }); }
    if (o.idMoment) tr.push({ x: t, y: o.idMoment, name: "inverse dynamics", mode: "lines", line: { color: FG, width: 2.5 } });
    P("mom_" + j, tr, lay(\`\${j} flexion moment by muscle group\${ms.length === 1 ? " · " + (D.methods[ms[0]] || {}).label : ""}\`, U.m));
    tr = [];
    if (ms.length === 1) { const r = o.m[ms[0]] || {}; tr = stack(t, r.jcfGroups || {}, "c"); if (r.jcf) tr.push({ x: t, y: r.jcf, name: "|JCF|", mode: "lines", line: { color: FG, width: 2.5 } }); }
    else for (const k of ms) { const r = o.m[k] || {}; if (r.jcf) tr.push({ x: t, y: r.jcf, name: "|JCF| " + D.methods[k].label, mode: "lines", line: { color: MC[k], width: 2.5, dash: DASH[k] } }); }
    P("con_" + j, tr, lay(\`\${j} contact force by muscle group\${ms.length === 1 ? " · " + (D.methods[ms[0]] || {}).label : ""}\`, U.f)); }
  // 6: muscle dynamics, one row per muscle
  const mus = S.muscles || [], c = document.getElementById("dynGrid"), K = ["act", "nfl", "vel", "frc"];
  const want = mus.flatMap((m) => K.map((k) => \`dyn_\${k}_\${m.name}\`));
  [...c.children].forEach((d) => { if (!want.includes(d.id)) { try { Plotly.purge(d); } catch {} d.remove(); } });
  want.forEach((id, i) => { let d = document.getElementById(id); if (!d) { d = document.createElement("div"); d.className = "p"; d.id = id; } if (c.children[i] !== d) c.insertBefore(d, c.children[i] || null); });
  const sm = (extra) => ({ showlegend: false, margin: { l: 44, r: 10, t: 30, b: 30 }, xaxis: { gridcolor: GR }, ...extra });
  for (const m of mus) {
    let tr = [];
    if (m.emg) tr.push({ x: t, y: m.emg, name: "EMG " + m.channel, mode: "lines", fill: "tozeroy", line: { color: "#9a9a9a", width: 1 }, fillcolor: "rgba(150,150,150,.25)" });
    for (const k of ms) if (m.act[k]) tr.push({ x: t, y: m.act[k], name: D.methods[k].label, mode: "lines", line: { color: MC[k], width: 2, dash: ms.length > 1 ? DASH[k] : "solid" } });
    P("dyn_act_" + m.name, tr, lay(\`\${m.name} · activation\${m.emg ? "" : " (no EMG)"}\`, "0–1", sm({ yaxis: { range: [0, 1.05], gridcolor: GR, zerolinecolor: GR } })));
    P("dyn_nfl_" + m.name, m.nfl ? [{ x: t, y: m.nfl, name: "l/l₀", mode: "lines", line: { color: FG, width: 2 } }] : [],
      lay(\`\${m.name} · fibre length\`, "l / l₀", sm({ shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 1, y1: 1, line: { dash: "dot", color: "#888", width: 1 } }] })));
    P("dyn_vel_" + m.name, m.vel ? [{ x: t, y: m.vel, name: "v", mode: "lines", line: { color: FG, width: 2 } }] : [],
      lay(\`\${m.name} · fibre velocity\`, "l₀/s (+ lengthening)", sm({})));
    tr = [];
    for (const k of ms) if (m.force[k]) tr.push({ x: t, y: m.force[k], name: D.methods[k].label + " force", mode: "lines", line: { color: MC[k], width: 2, dash: ms.length > 1 ? DASH[k] : "solid" } });
    for (const k of ms) if (m.passive[k]) tr.push({ x: t, y: m.passive[k], name: D.methods[k].label + " passive %", yaxis: "y2", mode: "lines", line: { color: MC[k], width: 1.2, dash: "dot" } });
    P("dyn_frc_" + m.name, tr, lay(\`\${m.name} · force (dotted: passive %)\`, "N", sm({ yaxis2: { overlaying: "y", side: "right", range: [0, 100], showgrid: false, ticksuffix: "%", tickfont: { size: 9 } }, margin: { l: 48, r: 36, t: 30, b: 30 } })));
  }
}
// ---------------- 3D view: the skeleton (body origins) + ground reaction vectors, the plots in tabs beside it
const V = { open: false, fr: 0, yaw: -0.9, pitch: 0.25, zoom: 1, play: false, tab: "Kinematics", last: 0 };
const CHAIN = (sd) => ["pelvis", "femur_" + sd, "tibia_" + sd, "talus_" + sd, "calcn_" + sd, "toes_" + sd];
function v3draw() {
  const c = document.getElementById("v3c"); if (!V.open || !D.bodies) return;
  const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight; if (!W || !H) return;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const B = D.bodies, i = Math.min(V.fr, D.t.length - 1), at = (b, k = i) => (B[b] ? [B[b][0][k], B[b][1][k], B[b][2][k]] : null);
  const pel = at("pelvis") || [0, 1, 0], cx = pel[0], cz = pel[2], sc = Math.min(W, H) / 2.3 * V.zoom;
  const cy = Math.cos(V.yaw), sy = Math.sin(V.yaw), cp = Math.cos(V.pitch), sp = Math.sin(V.pitch);
  const pr = (p) => { const x = p[0] - cx, y = p[1] - 0.85, z = p[2] - cz, X = cy * x + sy * z, Z = -sy * x + cy * z; return [W / 2 + X * sc, H / 2 - (cp * y - sp * Z) * sc, sp * y + cp * Z]; };
  const line = (a, b, col, w) => { if (!a || !b) return; const p = pr(a), q = pr(b); g.strokeStyle = col; g.lineWidth = w; g.lineCap = "round"; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); };
  // floor grid, fixed in the lab
  g.globalAlpha = 0.35; const gx = Math.round(cx), gz = Math.round(cz);
  for (let u = -3; u <= 3; u += 0.5) { line([gx + u, 0, gz - 3], [gx + u, 0, gz + 3], GR, 1); line([gx - 3, 0, gz + u], [gx + 3, 0, gz + u], GR, 1); }
  g.globalAlpha = 1;
  if (document.getElementById("v3trail").checked) for (const [b, col] of [["calcn_r", "#c0392b"], ["calcn_l", "#2f7bd6"], ["pelvis", FG]]) {
    if (!B[b]) continue; g.globalAlpha = 0.5; g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath();
    for (let k = 0; k < D.t.length; k++) { const p = pr(at(b, k)); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); } g.stroke(); g.globalAlpha = 1; }
  const tor = at("torso");
  if (tor) { line(pel, tor, "#b9b4a8", 9); const top = [tor[0] + (tor[0] - pel[0]) * 3.2, tor[1] + 0.42, tor[2] + (tor[2] - pel[2]) * 3.2]; line(tor, top, "#b9b4a8", 9);
    const h = pr([top[0], top[1] + 0.13, top[2]]); g.fillStyle = "#b9b4a8"; g.beginPath(); g.arc(h[0], h[1], 0.1 * sc, 0, 7); g.fill(); }
  // far leg first
  const legs = ["r", "l"].sort((a, b) => (at("femur_" + a) ? pr(at("femur_" + a))[2] : 0) - (at("femur_" + b) ? pr(at("femur_" + b))[2] : 0));
  for (const sd of legs) { const ch = CHAIN(sd).filter((b) => B[b]), col = sd === "r" ? "#c0392b" : "#2f7bd6";
    for (let k = 1; k < ch.length; k++) line(at(ch[k - 1]), at(ch[k]), col, k < 3 ? 8 : 6);
    for (const b of ch.slice(1)) { const p = pr(at(b)); g.fillStyle = FG; g.beginPath(); g.arc(p[0], p[1], 3.2, 0, 7); g.fill(); }
    if (sd === st.side) { const p = pr(at(ch[1])); g.fillStyle = col; g.font = "11px system-ui"; g.fillText(sd === "r" ? "right" : "left", p[0] + 10, p[1]); } }
  if (document.getElementById("v3grf").checked) for (const pl of D.grf3 || []) {
    const F = [pl.F[0][i], pl.F[1][i], pl.F[2][i]], P0 = [pl.P[0][i], pl.P[1][i] || 0, pl.P[2][i]]; if (!(F[1] > 20)) continue;
    const k = 0.45 / ((D.mass || 75) * 9.81), P1 = [P0[0] + F[0] * k, P0[1] + F[1] * k, P0[2] + F[2] * k]; line(P0, P1, "#2ca02c", 4);
    const q = pr(P1); g.fillStyle = "#2ca02c"; g.beginPath(); g.arc(q[0], q[1], 5, 0, 7); g.fill(); g.font = "11px system-ui"; g.fillText((Math.hypot(...F) / ((D.mass || 75) * 9.81)).toFixed(2) + " BW", q[0] + 8, q[1]); }
  document.getElementById("v3t").textContent = D.t[i].toFixed(3) + " s"; document.getElementById("v3fr").value = i;
  cursor(D.t[i]);
}
const TABS = {
  Kinematics: () => [["Joint angles (deg)", ["hip", "knee", "ankle"].map((j, k) => ({ x: D.t, y: D.sides[st.side].joints[j].angle || [], name: j, mode: "lines" })), "deg"]],
  Moments: () => [["Inverse-dynamics moments", ["hip", "knee", "ankle"].map((j) => ({ x: D.t, y: D.sides[st.side].joints[j].idMoment || [], name: j, mode: "lines" })), U.m],
    ...(D.res ? [["Pelvis residual forces", D.res.F.map((r) => ({ x: D.res.t, y: r.y, name: r.name, mode: "lines" })), D.mass ? "% BW" : "N"]] : [])],
  Muscles: () => { const ms = methods(), mus = D.sides[st.side].muscles || []; return ms.flatMap((k) => [
    [D.methods[k].label + ": activation", mus.filter((m) => m.act[k]).map((m) => ({ x: D.t, y: m.act[k], name: m.name, mode: "lines" })), "0–1"],
    [D.methods[k].label + ": muscle force", mus.filter((m) => m.force && m.force[k]).map((m) => ({ x: D.t, y: m.force[k], name: m.name, mode: "lines" })), "N"]]); },
  "Contact forces": () => ["hip", "knee", "ankle"].map((j) => [j + " contact force", methods().filter((k) => (D.sides[st.side].joints[j].m[k] || {}).jcf).map((k) => ({ x: D.t, y: D.sides[st.side].joints[j].m[k].jcf, name: D.methods[k].label, mode: "lines", line: { color: MC[k] } })), U.f]),
};
function v3tabs() {
  if (!V.open) return;
  document.getElementById("v3fr").max = D.t.length - 1; V.fr = Math.min(V.fr, D.t.length - 1);
  const tb = document.getElementById("v3tabs"); tb.innerHTML = Object.keys(TABS).map((k) => \`<button data-tab="\${k}" class="\${k === V.tab ? "on" : ""}">\${k}</button>\`).join("");
  tb.querySelectorAll("button").forEach((b) => { b.onclick = () => { V.tab = b.dataset.tab; v3tabs(); }; });
  const c = document.getElementById("v3tabc"); [...c.children].forEach((d) => { try { Plotly.purge(d); } catch {} }); c.innerHTML = "";
  TABS[V.tab]().forEach(([title, tr, unit], k) => { const d = document.createElement("div"); d.className = "p"; d.id = "v3p" + k; c.appendChild(d);
    Plotly.react(d, tr, lay(title, unit, { margin: { l: 48, r: 8, t: 30, b: 34 }, legend: { orientation: "h", y: -0.2, font: { size: 9 } } }), { responsive: true, displaylogo: false });
    d.on("plotly_click", (e) => { const x = e.points[0].x; let j = 0; while (j < D.t.length - 1 && D.t[j] < x) j++; V.fr = j; v3draw(); }); });
  v3draw();
}
function v3loop(now) {
  if (!V.open || !V.play) return;
  const dt = (D.t[1] - D.t[0]) || 0.005, sp = +document.getElementById("v3speed").value;
  if (now - V.last >= 1000 * dt / sp) { V.last = now; V.fr = (V.fr + 1) % D.t.length; v3draw(); }
  requestAnimationFrame(v3loop);
}
function v3init() {
  const el = document.getElementById("v3d"), c = document.getElementById("v3c"), fr = document.getElementById("v3fr");
  document.getElementById("v3open").onclick = () => { if (!D.bodies) { alert("No body positions in this trial yet (they are written by inverse dynamics)."); return; }
    V.open = true; el.style.display = "flex"; fr.max = D.t.length - 1; document.getElementById("v3title").textContent = "3D view · " + document.querySelector("h1").textContent; v3tabs(); };
  document.getElementById("v3close").onclick = () => { V.open = false; V.play = false; el.style.display = "none"; cursor(null); };
  fr.oninput = () => { V.fr = +fr.value; v3draw(); };
  document.getElementById("v3play").onclick = (e) => { V.play = !V.play; e.target.textContent = V.play ? "⏸" : "▶"; if (V.play) requestAnimationFrame(v3loop); };
  for (const id of ["v3grf", "v3trail"]) document.getElementById(id).onchange = v3draw;
  let drag = null;
  c.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; c.setPointerCapture(e.pointerId); });
  c.addEventListener("pointermove", (e) => { if (!drag) return; V.yaw += (e.clientX - drag[0]) * 0.01; V.pitch = Math.max(-1.5, Math.min(1.5, V.pitch + (e.clientY - drag[1]) * 0.01)); drag = [e.clientX, e.clientY]; v3draw(); });
  c.addEventListener("pointerup", () => { drag = null; });
  c.addEventListener("wheel", (e) => { e.preventDefault(); V.zoom = Math.max(0.3, Math.min(6, V.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); v3draw(); }, { passive: false });
  addEventListener("resize", v3draw);
}
window.addEventListener("load", () => { if (!window.Plotly) { document.getElementById("err").style.display = "block"; return; } ui(); draw(); v3init(); });
</script></body></html>`;
}
