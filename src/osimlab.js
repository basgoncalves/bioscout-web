/**
 * osimlab.js -- the "OpenSim trial" card: marker and force-plate data through
 * scaling, inverse kinematics, inverse dynamics, static optimisation and joint
 * reaction loads.
 *
 * None of that runs here. A browser cannot run OpenSim, so the work is done by
 * the lab engine (bioscout/lab/web_engine.py in the Python repo) on a PC that
 * has OpenSim, reached either on this same PC (http://127.0.0.1) or through
 * the https address the lecturer's engine prints for phones. This module is
 * the page's half: talking to the engine, and turning each step's result file
 * into the few curves worth looking at.
 *
 * The picking functions are pure -- result in, series out -- and are what
 * tests/test_osimlab.mjs checks. They read OpenSim's own column names, which
 * differ between models, so they match by pattern and say nothing rather than
 * guess when a model names things another way.
 */

/** The steps as the card shows them, and the engine step that produces each. */
export const OSIM_STEPS = [
  { id: "data", run: "export" },
  { id: "scale", run: "scale" },
  { id: "ikid", run: "ikid" },
  { id: "so", run: "so" },
];

/**
 * An engine address the page is willing to call: https anywhere (the tunnel),
 * or plain http on this very computer. Anything else -- another machine over
 * plain http, a javascript: link in a pasted address -- is refused.
 */
export function cleanEngineUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

/** `?engine=...&code=...` from the link the engine prints; null when absent. */
export function engineFromSearch(search) {
  const q = new URLSearchParams(search || "");
  const url = cleanEngineUrl(q.get("engine"));
  const code = (q.get("code") || "").trim();
  return url && /^[A-Za-z0-9_-]{4,64}$/.test(code) ? { url, code } : null;
}

/** What a chosen file is, from its name and which trial it was chosen for. */
export function fileKind(name, slot) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  if (ext === "c3d") return slot === "static" ? "static_c3d" : "motion_c3d";
  if (ext === "trc") return slot === "static" ? "static_trc" : "motion_trc";
  if ((ext === "mot" || ext === "sto") && slot === "motion") return "motion_grf";
  return null;
}

export class EngineError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** The engine's HTTP API. `fetchFn` is injectable for tests. */
export function makeEngineClient({ url, code, fetchFn = (...a) => fetch(...a) }) {
  const call = async (path, { method = "GET", body = null, json = true } = {}) => {
    let r;
    try {
      r = await fetchFn(url + path, { method, body, cache: "no-store",
        headers: { "X-Lab-Code": code, ...(body && typeof body === "string" ? { "Content-Type": "application/json" } : {}) } });
    } catch { throw new EngineError("offline", "engine not reachable"); }
    if (!r.ok) {
      let e = {};
      try { e = await r.json(); } catch { /* not json */ }
      throw new EngineError(e.error || String(r.status), e.message || `HTTP ${r.status}`);
    }
    return json ? r.json() : r;
  };
  return {
    url,
    health: () => call(`/health?code=${encodeURIComponent(code)}`),
    newJob: () => call("/api/job", { method: "POST" }),
    status: (job) => call(`/api/job/${job}`),
    upload: (job, kind, file) => call(`/api/job/${job}/file?kind=${kind}`, { method: "POST", body: file }),
    setMass: (job, mass) => call(`/api/job/${job}/mass`, { method: "POST", body: JSON.stringify({ mass }) }),
    example: (job) => call(`/api/job/${job}/example`, { method: "POST" }),
    run: (job, step) => call(`/api/job/${job}/run`, { method: "POST", body: JSON.stringify({ step }) }),
    result: (job, what) => call(`/api/job/${job}/result?what=${what}`),
    bundleUrl: (job) => `${url}/api/job/${job}/bundle?code=${encodeURIComponent(code)}`,
  };
}

// ---- reading results ---------------------------------------------------------
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const col = (res, name) => (res && res.data && Array.isArray(res.data[name]) ? res.data[name] : null);
const peakAbs = (a) => a.reduce((m, v) => (fin(v) && Math.abs(v) > m ? Math.abs(v) : m), 0);
const median = (a) => { const s = a.filter(fin).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

export const JOINT_COLORS = { hip: "#2f6fe4", knee: "#e8871a", ankle: "#1d7a45" };
const ANGLE_COLS = { hip: ["hip_flexion"], knee: ["knee_angle", "knee_flexion"], ankle: ["ankle_angle", "ankle_flexion"] };

/**
 * Hip, knee and ankle flexion, right and left, flexion positive.
 *
 * The knee is the catch: gait2392-family models (GPK among them) count knee
 * flexion NEGATIVE, Rajagopal counts it positive. A knee never hyperextends by
 * forty degrees, so a knee column whose median is below zero is a
 * negative-flexion model and is flipped; `flipped` says so.
 */
export function pickAngles(res) {
  const out = [];
  let flipped = false;
  for (const [joint, bases] of Object.entries(ANGLE_COLS)) {
    for (const side of ["r", "l"]) {
      const name = bases.map((b) => `${b}_${side}`).find((n) => col(res, n));
      if (!name) continue;
      let y = col(res, name);
      if (res.inDegrees === false) y = y.map((v) => (v * 180) / Math.PI);
      if (joint === "knee" && median(y) < 0) { y = y.map((v) => -v); flipped = true; }
      out.push({ joint, side, column: name, y, color: JOINT_COLORS[joint], dash: side === "l" });
    }
  }
  return { series: out, flipped };
}

/** The matching inverse-dynamics moments in N·m per kg. Signs are OpenSim's
 *  own (the coordinate's positive direction); nothing is flipped. */
export function pickMoments(res, massKg) {
  const out = [];
  const m = massKg > 0 ? massKg : 1;
  for (const [joint, bases] of Object.entries(ANGLE_COLS)) {
    for (const side of ["r", "l"]) {
      const name = bases.map((b) => `${b}_${side}_moment`).find((n) => col(res, n));
      if (!name) continue;
      out.push({ joint, side, column: name, y: col(res, name).map((v) => v / m),
                 color: JOINT_COLORS[joint], dash: side === "l" });
    }
  }
  return { series: out, perKg: massKg > 0 };
}

/** Marker error over the trial, in cm: mean RMS and the worst single marker. */
export function markerErrors(res) {
  const rms = col(res, "marker_error_RMS"), max = col(res, "marker_error_max");
  if (!rms || !max) return null;
  const mean = rms.filter(fin).reduce((a, b) => a + b, 0) / Math.max(1, rms.filter(fin).length);
  return { rms_cm: +(mean * 100).toFixed(2), max_cm: +(Math.max(...max.filter(fin)) * 100).toFixed(2) };
}

/** Not a muscle: reserve and residual actuators, the pelvis residuals OpenSim
 *  writes as FX..MZ, and the ground reaction itself, which the force file
 *  carries as <body>_grf_..._Fy and the like. */
const NOT_MUSCLE = /reserve|residual|^[FM][XYZ]$|_actuator$|grf|_[FTp][xyz]$/i;

/** The n muscles with the highest peak force, strongest first. */
export function topMuscles(res, n = 6) {
  const cols = (res && res.columns) || [];
  return cols.filter((c) => !NOT_MUSCLE.test(c) && col(res, c))
    .map((c) => ({ column: c, y: col(res, c), peak: peakAbs(col(res, c)) }))
    .sort((a, b) => b.peak - a.peak).slice(0, n);
}

/**
 * How much of the joint moments static optimisation could NOT give to muscles.
 * The reserve actuators fill whatever the muscles cannot; a large reserve next
 * to a small net moment means the muscle forces on the page are not explaining
 * the movement. Returns the largest reserve (N·m) and its column.
 */
export function worstReserve(res) {
  let worst = null;
  for (const c of (res && res.columns) || []) {
    if (!/reserve/i.test(c) || !col(res, c)) continue;
    const p = peakAbs(col(res, c));
    if (!worst || p > worst.peak) worst = { column: c, peak: +p.toFixed(1) };
  }
  return worst;
}

/** Joints a reaction file holds: every prefix that has _fx, _fy and _fz.
 *  The pelvis-on-ground "joint" is the residual, not a joint load. */
export function reactionJoints(res) {
  const cols = new Set((res && res.columns) || []);
  const out = [];
  for (const c of cols) {
    if (!c.endsWith("_fx")) continue;
    const key = c.slice(0, -3);
    if (!cols.has(key + "_fy") || !cols.has(key + "_fz") || /^ground_/.test(key)) continue;
    out.push({ key, joint: key.split("_on_")[0] });
  }
  return out;
}

/** The first hip (right before left), else the first joint: what to show first. */
export function defaultReactionJoint(joints) {
  const hip = joints.filter((j) => /hip/i.test(j.joint));
  return (hip.find((j) => /_r$/.test(j.joint)) || hip[0] || joints[0] || {}).key || null;
}

/** Resultant joint reaction force in body weights, plus its three parts. */
export function reactionForce(res, key, massKg) {
  const fx = col(res, key + "_fx"), fy = col(res, key + "_fy"), fz = col(res, key + "_fz");
  if (!fx || !fy || !fz) return null;
  const bw = massKg > 0 ? massKg * 9.80665 : 1;
  const mag = fx.map((v, i) => Math.hypot(v, fy[i], fz[i]) / bw);
  return { resultant: mag, fx: fx.map((v) => v / bw), fy: fy.map((v) => v / bw), fz: fz.map((v) => v / bw),
           peak: +Math.max(...mag.filter(fin)).toFixed(2), inBW: massKg > 0 };
}

/** Segment scale factors worth a row: one per body, left sides folded into
 *  the right when they match (they do unless the scaling was asymmetric). */
export function scaleRows(factors) {
  const byName = new Map((factors || []).map((f) => [f.segment, f.scales]));
  const rows = [];
  for (const [seg, sc] of byName) {
    if (/_l$/.test(seg)) {
      const r = byName.get(seg.replace(/_l$/, "_r"));
      if (r && r.every((v, i) => Math.abs(v - sc[i]) < 1e-3)) continue;
    }
    const both = /_r$/.test(seg) && byName.has(seg.replace(/_r$/, "_l"))
      && byName.get(seg.replace(/_r$/, "_l")).every((v, i) => Math.abs(v - sc[i]) < 1e-3);
    rows.push({ segment: both ? seg.replace(/_r$/, "") : seg, scales: sc });
  }
  return rows;
}

// ---- drawing -------------------------------------------------------------------
const escXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function niceStep(span, target = 4) {
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || mag;
}

/**
 * One line chart as an SVG string. `series`: [{ label, y, color, dash }].
 * Colours come from the caller; grid and text use the page's CSS variables so
 * the chart follows light and dark.
 */
export function lineChartSVG({ time, series, yUnit = "", xUnit = "s", zero = true }) {
  const W = 340, H = 170, L = 38, R = 8, T = 10, B = 26;
  const ys = series.flatMap((s) => s.y).filter(fin);
  if (!time || time.length < 2 || !ys.length) return "";
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const t0 = time[0], t1 = time[time.length - 1];
  const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const dp = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
  let grid = "";
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid += `<line x1="${L}" y1="${Y(v).toFixed(1)}" x2="${W - R}" y2="${Y(v).toFixed(1)}" stroke="var(--line)"${
      Math.abs(v) < step / 1e6 ? "" : ' stroke-dasharray="2 3"'}/>`
      + `<text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="var(--muted)">${v.toFixed(dp)}</text>`;
  }
  const paths = series.map((s) => {
    let d = "", pen = false;
    s.y.forEach((v, i) => {
      if (!fin(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(time[i]).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
    });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.8"${s.dash ? ' stroke-dasharray="5 3"' : ""}>`
      + `<title>${escXml(s.label)}</title></path>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img">${grid}${paths}`
    + `<text x="${L}" y="${H - 6}" font-size="9" fill="var(--muted)">${t0.toFixed(2)} ${escXml(xUnit)}</text>`
    + `<text x="${W - R}" y="${H - 6}" font-size="9" text-anchor="end" fill="var(--muted)">${t1.toFixed(2)} ${escXml(xUnit)}</text>`
    + (yUnit ? `<text x="${L + 4}" y="${T + 8}" font-size="9" fill="var(--muted)">${escXml(yUnit)}</text>` : "")
    + `</svg>`;
}

/** The key under a chart: a swatch (dashed for the left side) and a label. */
export function legendHTML(series) {
  return `<div class="sub" style="font-size:12px;display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:2px">${
    series.map((s) => `<span style="white-space:nowrap"><svg width="18" height="8" style="vertical-align:middle">`
      + `<line x1="0" y1="4" x2="18" y2="4" stroke="${s.color}" stroke-width="2"${s.dash ? ' stroke-dasharray="5 3"' : ""}/></svg> ${
        escXml(s.label)}</span>`).join("")}</div>`;
}

/** Distinct colours for a handful of muscle curves. */
export const MUSCLE_COLORS = ["#2f6fe4", "#e8871a", "#1d7a45", "#c0392b", "#7d5bbe", "#0f8f9c"];
