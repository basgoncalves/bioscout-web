/**
 * simfigs.js -- the figures the Python bioscout writes next to its OpenSim
 * results, drawn here on a canvas from the same files, in the same layout:
 *
 *   _ik_marker_errors_plot.png   every marker's error over time + the mean (dashed)
 *   kinematics_moments.png       one column per joint: angle (top) and moment (bottom)
 *   inverse_dynamics.png         every ID column in a 3-wide grid
 *   residuals.png                the six pelvis residuals with +-10 % / +-25 % |GRF| bands
 *
 * Colours as bioscout: right blue, left red, midline black.
 */
const RIGHT = "#1f77b4", LEFT = "#d62728", MID = "#000";
const TAB10 = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];

/** .mot/.sto text -> {t, cols, col(name)} */
export function readSto(text) {
  const L = text.split(/\r?\n/), h = L.findIndex((l) => l.trim().toLowerCase() === "endheader");
  const cols = L[h + 1].trim().split(/[\t ]+/);
  const rows = L.slice(h + 2).filter((l) => l.trim()).map((l) => l.trim().split(/[\t ]+/).map(Number));
  const col = (n) => { const i = cols.indexOf(n); return i < 0 ? null : rows.map((r) => r[i]); };
  return { cols, rows, col, t: col("time") };
}

const nice = (lo, hi) => {                       // ~5 round ticks
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const span = hi - lo, raw = span / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const ticks = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
};
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? +v.toFixed(1) + "" : +v.toFixed(3) + "");

/** One matplotlib-like axes. series: [{x, y, color, dash?, width?}] */
function axes(g, r, series, o = {}) {
  const { x, y, w, h } = r;
  const xs = series.flatMap((s) => s.x), ys = series.flatMap((s) => s.y).filter(Number.isFinite);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), lo = o.ylo ?? Math.min(...ys), hi = o.yhi ?? Math.max(...ys);
  if (!(hi > lo)) { lo -= 1; hi += 1; } const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const X = (v) => x + (v - x0) / (x1 - x0 || 1) * w, Y = (v) => y + h - (v - lo) / (hi - lo) * h;
  g.save(); g.fillStyle = "#fff"; g.fillRect(x, y, w, h);
  for (const b of o.bands || []) { g.fillStyle = b.color; g.fillRect(x, Math.max(y, Y(b.hi)), w, Math.min(y + h, Y(b.lo)) - Math.max(y, Y(b.hi))); }
  if (o.grid) { g.strokeStyle = "#ddd"; g.lineWidth = 1; for (const v of nice(lo, hi)) { g.beginPath(); g.moveTo(x, Y(v)); g.lineTo(x + w, Y(v)); g.stroke(); } }
  if (o.zero !== false && lo < 0 && hi > 0) { g.strokeStyle = o.zeroColor || "#bbb"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, Y(0)); g.lineTo(x + w, Y(0)); g.stroke(); }
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  for (const s of series) {
    g.strokeStyle = s.color; g.lineWidth = s.width || 1.6; g.setLineDash(s.dash || []); g.beginPath(); let pen = false;
    s.y.forEach((v, i) => { if (!Number.isFinite(v)) { pen = false; return; } pen ? g.lineTo(X(s.x[i]), Y(v)) : g.moveTo(X(s.x[i]), Y(v)); pen = true; });
    g.stroke(); g.setLineDash([]);
  }
  g.restore();
  g.strokeStyle = "#000"; g.lineWidth = 1; g.strokeRect(x, y, w, h);
  g.fillStyle = "#000"; g.font = "11px sans-serif"; g.textAlign = "right"; g.textBaseline = "middle";
  for (const v of nice(lo, hi)) { if (v < lo || v > hi) continue; g.fillText(fmt(v), x - 4, Y(v)); g.beginPath(); g.moveTo(x - 3, Y(v)); g.lineTo(x, Y(v)); g.stroke(); }
  g.textAlign = "center"; g.textBaseline = "top";
  for (const v of nice(x0, x1)) { if (v < x0 || v > x1) continue; g.fillText(fmt(v), X(v), y + h + 4); g.beginPath(); g.moveTo(X(v), y + h); g.lineTo(X(v), y + h + 3); g.stroke(); }
  if (o.xlabel) g.fillText(o.xlabel, x + w / 2, y + h + 18);
  if (o.ylabel) { g.save(); g.translate(x - 38, y + h / 2); g.rotate(-Math.PI / 2); g.fillStyle = o.ylabelColor || "#000"; g.textBaseline = "bottom"; g.fillText(o.ylabel, 0, 0); g.restore(); }
  if (o.title) { g.font = `${o.titleSize || 12}px sans-serif`; g.textBaseline = "bottom"; g.fillText(o.title, x + w / 2, y - 4); }
  if (o.legend) {                                 // matplotlib-like box, best corner = top left
    const items = o.legend; g.font = "10px sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
    const bw = 8 + Math.max(...items.map((i) => g.measureText(i.label).width)) + 28, bh = items.length * 14 + 6;
    const bx = x + 6, by = o.note ? y + h - bh - 6 : y + 6; g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(bx, by, bw, bh); g.strokeStyle = "#999"; g.strokeRect(bx, by, bw, bh);
    items.forEach((it, i) => { g.strokeStyle = it.color; g.lineWidth = 1.6; g.setLineDash(it.dash || []); g.beginPath(); g.moveTo(bx + 5, by + 10 + i * 14); g.lineTo(bx + 23, by + 10 + i * 14); g.stroke(); g.setLineDash([]); g.fillStyle = "#000"; g.fillText(it.label, bx + 28, by + 10 + i * 14); });
  }
  if (o.note) { g.font = "9px sans-serif"; g.textAlign = "left"; g.textBaseline = "top"; const tw = g.measureText(o.note).width + 6; g.fillStyle = "rgba(255,255,255,.9)"; g.fillRect(x + 3, y + 3, tw, 13); g.strokeStyle = "#999"; g.strokeRect(x + 3, y + 3, tw, 13); g.fillStyle = "#000"; g.fillText(o.note, x + 6, y + 5); }
  g.textAlign = "left"; g.textBaseline = "alphabetic";
}

const canvas = (W, H, title) => {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  if (title) { g.fillStyle = "#000"; g.font = "16px sans-serif"; g.textAlign = "center"; g.fillText(title, W / 2, 26); g.textAlign = "left"; }
  return [c, g];
};
const png = (c) => new Promise((r) => c.toBlob(r, "image/png"));

/** coordinate name -> [base, side|null]; "hip_flexion_r" -> ["hip_flexion", "r"] */
const splitSide = (n) => { const m = n.match(/^(.*)_([rl])$/); return m ? [m[1], m[2]] : [n, null]; };
const strip = (n) => n.replace(/_(moment|force)$/, "");
const sideColor = (s) => (s === "r" ? RIGHT : s === "l" ? LEFT : MID);

/** Group columns by base joint keeping first-seen order: [{base, sides: {r|l|none: colname}}] */
function groupSides(names) {
  const groups = [], byBase = {};
  for (const n of names) {
    const [base, side] = splitSide(strip(n));
    if (!byBase[base]) { byBase[base] = { base, sides: {} }; groups.push(byBase[base]); }
    byBase[base].sides[side || "none"] = n;
  }
  return groups;
}
const legendRL = (sides) => (sides.r || sides.l ? [sides.r && { label: "right", color: RIGHT }, sides.l && { label: "left", color: LEFT }].filter(Boolean) : null);

// ------------------------------------------------------------------ 1. marker errors
export async function markerErrorsFigure(errAllText) {
  const d = readSto(errAllText), names = d.cols.filter((c) => c !== "time");
  const series = names.map((n, i) => ({ x: d.t, y: d.col(n), color: TAB10[i % 10], width: 1.3 }));
  const mean = d.t.map((_, i) => { const v = names.map((n) => d.col(n)[i]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; });
  series.push({ x: d.t, y: mean, color: "#000", dash: [6, 4], width: 2 });
  const W = 1200, H = 600, [c, g] = canvas(W, H);
  axes(g, { x: 150, y: 70, w: 790, h: 470 }, series, { title: "Marker Errors Over Time", titleSize: 14, xlabel: "Time (s)", ylabel: "Marker Error (m)", grid: true, zero: false });
  // legend column on the right, as matplotlib's bbox_to_anchor legend
  g.font = "11px sans-serif"; g.strokeStyle = "#999"; g.strokeRect(945, 70, 130, Math.min(470, 8 + names.length * 16));
  names.slice(0, 28).forEach((n, i) => { g.strokeStyle = TAB10[i % 10]; g.lineWidth = 1.6; g.beginPath(); g.moveTo(952, 82 + i * 16); g.lineTo(976, 82 + i * 16); g.stroke(); g.fillStyle = "#000"; g.textBaseline = "middle"; g.fillText(n, 982, 82 + i * 16); });
  if (names.length > 28) g.fillText(`… ${names.length - 28} more`, 982, 82 + 28 * 16);
  return png(c);
}

// ------------------------------------------------------------------ 2. kinematics + moments
const KIN_ORDER = ["pelvis_tilt", "pelvis_list", "pelvis_rotation", "hip_flexion", "hip_adduction", "hip_rotation", "knee_angle", "knee_adduction", "ankle_angle", "subtalar_angle", "lumbar_extension", "lumbar_bending", "lumbar_rotation"];
export async function kinematicsMomentsFigure(ikText, idText, errAllText) {
  const ik = readSto(ikText), id = idText ? readSto(idText) : null;
  const groups = groupSides(ik.cols.filter((c) => c !== "time")).filter((gr) => KIN_ORDER.includes(gr.base))
    .sort((a, b) => KIN_ORDER.indexOf(a.base) - KIN_ORDER.indexOf(b.base));
  // per-joint marker error note (mm), R/L, from the per-marker file
  const JM = { pelvis: ["ASI", "PSI", "SACR"], hip: ["ASI", "PSI", "SACR", "THI", "TH"], knee: ["THI", "FC", "KNE", "TIB", "SHA", "TH"], ankle: ["MAL", "ANK", "HEE", "TOE", "MT", "M5", "SHA", "TIB"] };
  const note = {};
  if (errAllText) {
    const e = readSto(errAllText), mk = e.cols.filter((c) => c !== "time");
    for (const jk of Object.keys(JM)) {
      const parts = [];
      for (const [s, L] of [["r", "R"], ["l", "L"]]) {
        const sel = mk.filter((m) => JM[jk].some((p) => m.toUpperCase().includes(p)) && (m.toUpperCase().startsWith(L) || !/^[LR]/i.test(m)));
        const v = sel.flatMap((m) => e.col(m)).filter(Number.isFinite);
        if (v.length) parts.push(`${L} ${(Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) * 1000).toFixed(1)}`);
      }
      if (parts.length) note[jk] = "mk err (mm): " + parts.join(", ");
    }
  }
  const n = groups.length, pw = 190, ph = 190, W = 60 + n * (pw + 50), H = 60 + 2 * (ph + 60);
  const [c, g] = canvas(W, H, "Kinematics (top) & Moments (bottom)");
  groups.forEach((gr, i) => {
    const x = 70 + i * (pw + 50), ang = [], mom = [];
    for (const [side, col] of Object.entries(gr.sides)) {
      ang.push({ x: ik.t, y: ik.col(col), color: sideColor(side) });
      if (id) { const mc = id.cols.find((cc) => strip(cc) === col); if (mc) mom.push({ x: id.t, y: id.col(mc), color: sideColor(side) }); }
    }
    axes(g, { x, y: 60, w: pw, h: ph }, ang, { title: gr.base, ylabel: "Angle (deg)", legend: legendRL(gr.sides), note: note[gr.base.split("_")[0]], zero: false });
    if (mom.length) axes(g, { x, y: 60 + ph + 60, w: pw, h: ph }, mom, { xlabel: "Time (s)", ylabel: id.cols.some((cc) => strip(cc) === Object.values(gr.sides)[0] && cc.endsWith("_force")) ? "Force (N)" : "Moment (Nm)", zero: false });
  });
  return png(c);
}

// ------------------------------------------------------------------ 3. inverse dynamics grid
export async function inverseDynamicsFigure(idText) {
  const id = readSto(idText), names = id.cols.filter((c) => c !== "time");
  const groups = groupSides(names);
  const rank = (b) => (b.startsWith("lumbar") ? 0 : b.startsWith("pelvis_t") && groups.find((x) => x.base === b).sides.none.endsWith("_force") ? 2 : b.startsWith("pelvis") ? 1 : 3);
  groups.sort((a, b) => rank(a.base) - rank(b.base));
  const ncol = 3, nrow = Math.ceil(groups.length / ncol), pw = 260, ph = 180, W = 90 + ncol * (pw + 140), H = 70 + nrow * (ph + 80);
  const [c, g] = canvas(W, H, "Inverse Dynamics Joint Moments");
  groups.forEach((gr, i) => {
    const x = 90 + (i % ncol) * (pw + 140), y = 70 + Math.floor(i / ncol) * (ph + 80);
    const series = Object.entries(gr.sides).map(([side, col]) => ({ x: id.t, y: id.col(col), color: sideColor(side) }));
    const first = Object.values(gr.sides)[0];
    axes(g, { x, y, w: pw, h: ph }, series, { title: first.replace(/_[rl](_moment|_force)$/, "$1"), ylabel: first.endsWith("_force") ? "Force (N)" : "Moment (Nm)", xlabel: "Time", legend: legendRL(gr.sides), zero: false });
  });
  return png(c);
}

// ------------------------------------------------------------------ 4. residuals
export async function residualsFigure(idText, grfText) {
  const id = readSto(idText);
  let grfMax = null;
  if (grfText) {
    const gr = readSto(grfText), fc = gr.cols.filter((c) => /force.*v[xyz]$/i.test(c));
    const plates = {}; for (const c of fc) { const k = c.slice(0, -1); (plates[k] = plates[k] || []).push(gr.col(c)); }
    let mx = 0; for (const comps of Object.values(plates)) comps[0].forEach((_, i) => { mx = Math.max(mx, Math.hypot(...comps.map((v) => v[i] || 0))); });
    grfMax = mx || null;
  }
  const panels = [["pelvis_tx_force", "FX residual force", "Residual force (N)"], ["pelvis_ty_force", "FY residual force", "Residual force (N)"], ["pelvis_tz_force", "FZ residual force", "Residual force (N)"],
    ["pelvis_tilt_moment", "tilt residual moment", "Residual moment (Nm)"], ["pelvis_list_moment", "list residual moment", "Residual moment (Nm)"], ["pelvis_rotation_moment", "rotation residual moment", "Residual moment (Nm)"]];
  const pw = 400, ph = 250, W = 120 + 3 * (pw + 150), H = 110 + 2 * (ph + 90);
  const [c, g] = canvas(W, H, "Inverse-Dynamics pelvis residuals — absolute, with ±10 % / ±25 % of max |GRF| bands");
  panels.forEach(([col, title, ylabel], i) => {
    const y = id.col(col); if (!y) return;
    const x = 120 + (i % 3) * (pw + 150), yy = 80 + Math.floor(i / 3) * (ph + 90);
    const isF = col.endsWith("_force"), ref = grfMax ? (isF ? grfMax : grfMax * 1.0) : null;   // moments: % of max|GRF| x 1 m
    const peak = ref ? Math.max(...y.map(Math.abs)) / ref * 100 : null;
    const bands = ref ? [{ lo: -0.25 * ref, hi: 0.25 * ref, color: "rgba(255,240,170,.55)" }, { lo: -0.1 * ref, hi: 0.1 * ref, color: "rgba(190,230,190,.7)" }] : [];
    const lim = ref ? Math.max(0.3 * ref, ...y.map(Math.abs)) * 1.05 : null;
    axes(g, { x, y: yy, w: pw, h: ph }, [{ x: id.t, y, color: "#8c6bb1", width: 2 }], { title: title + (peak != null ? `  peak=${peak.toFixed(0)}% |GRF|` : ""), ylabel, ylabelColor: "#8c6bb1", bands, zeroColor: "#444", ylo: lim ? -lim : undefined, yhi: lim });
  });
  g.font = "12px sans-serif"; g.textAlign = "center"; g.fillStyle = "#000";
  g.fillText("residual (N / Nm)   —   green ±10 %, yellow ±25 % of max |GRF|" + (grfMax ? ` (max |GRF| = ${grfMax.toFixed(0)} N; moments: × 1 m)` : " (no GRF file: no bands)"), W / 2, H - 14);
  return png(c);
}
