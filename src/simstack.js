/**
 * simstack.js -- the static-optimisation, CEINMS and joint-reaction figures,
 * drawn as bioscout draws them: side-view poses with the GRF arrow at the
 * foot events, the vertical GRF per foot, then one row per panel on a shared
 * time axis (right leg red, left blue).
 *
 *   muscle_groups.png          summed force per muscle group (left axis) + mean activation
 *                              (right axis, 0-1), EMG shaded when there is EMG
 *   muscle_moments_r/l.png     ID moment, muscles, reserve (or residual) + the joint angle
 *   jrf_so.png / jrf_ceinms    |joint reaction force| at hip, knee, ankle in body weights
 *   jrf_*_coverage_frontal / _sagittal.png
 *                              the force vector at the foot events in polar plots, per joint
 */
import { readSto, grfBySide, footEvents } from "./simfigs.js";

const R_COL = "#c0392b", L_COL = "#2f7bd6", GREEN = "#2ca02c", PURPLE = "#9467bd";
const sideCol = (s) => (s === "r" ? R_COL : s === "l" ? L_COL : "#000");
const nice = (lo, hi) => {
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
};
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? +v.toFixed(1) + "" : +v.toFixed(2) + "");
const png = (c) => new Promise((r) => c.toBlob(r, "image/png"));
const interp = (tq, t, v) => { let k = 0; return tq.map((x) => { while (k < t.length - 2 && t[k + 1] < x) k++; const a = t[k], b = t[k + 1] ?? a; const f = b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : 0; return v[k] + f * ((v[k + 1] ?? v[k]) - v[k]); }); };

/** Events (foot strike / off) inside [t0, t1], both feet within 40 ms merged. */
function trialEvents(grf, t0, t1) {
  if (!grf) return [];
  return [...footEvents(grf.t, grf.r.vy, "r"), ...footEvents(grf.t, grf.l.vy, "l")].filter((e) => e.t >= t0 && e.t <= t1).sort((a, b) => a.t - b.t)
    .reduce((acc, e) => { const p = acc[acc.length - 1]; if (p && e.t - p.t < 0.04 && p.on === e.on && p.side !== e.side) { p.name = e.on ? "both feet strike" : "both feet off"; p.side = "b"; return acc; } acc.push({ ...e }); return acc; }, []);
}

/** Side-view skeletons at `times`, centred over X(t); returns nothing, draws into g at the row (y, h). */
function drawPoses(g, bodies, grf, times, X, y, h) {
  const at = (b, ax, i) => bodies.col(`${b}_${ax}`)[i];
  const idxOf = (tt) => { let k = 0; while (k < bodies.t.length - 1 && bodies.t[k] < tt) k++; return k; };
  const chain = (sd) => ["pelvis", `femur_${sd}`, `tibia_${sd}`, `talus_${sd}`, `calcn_${sd}`, `toes_${sd}`].filter((b) => bodies.col(b + "_x"));
  const fwdAt = (i) => {
    let fx = 0, fz = 0;
    for (const sd of ["r", "l"]) if (bodies.col(`toes_${sd}_x`) && bodies.col(`calcn_${sd}_x`)) { fx += at(`toes_${sd}`, "x", i) - at(`calcn_${sd}`, "x", i); fz += at(`toes_${sd}`, "z", i) - at(`calcn_${sd}`, "z", i); }
    const n = Math.hypot(fx, fz) || 1; return [fx / n, fz / n];
  };
  const floor = Math.min(...bodies.cols.filter((c) => c.endsWith("_y")).flatMap((c) => bodies.col(c)).filter(Number.isFinite));
  const S = (h - 30) / 1.75; let lastX = -1e9;
  for (const tt of times) {
    const i = idxOf(tt), [fx, fz] = fwdAt(i), x0 = at("pelvis", "x", i), z0 = at("pelvis", "z", i);
    let cx = X(tt); if (cx - lastX < 70) cx = lastX + 70; lastX = cx;
    const P = (b) => [cx + ((at(b, "x", i) - x0) * fx + (at(b, "z", i) - z0) * fz) * S, y + h - 6 - (at(b, "y", i) - floor) * S];
    if (bodies.col("torso_x")) {
      const [a1, b1] = P("pelvis"), [a2, b2] = P("torso");
      g.strokeStyle = "#c8c4ba"; g.lineWidth = 6; g.lineCap = "round"; g.beginPath(); g.moveTo(a1, b1); g.lineTo(a2, b2); g.lineTo(a2, b2 - 0.5 * S); g.stroke();
      g.fillStyle = "#c8c4ba"; g.beginPath(); g.arc(a2, b2 - 0.6 * S, 0.09 * S, 0, 7); g.fill();
    }
    for (const sd of ["l", "r"]) {
      g.strokeStyle = sd === "r" ? "rgba(192,57,43,.75)" : "rgba(47,123,214,.75)"; g.lineWidth = 5; g.lineCap = "round"; g.beginPath();
      chain(sd).forEach((b, k) => { const [a, bb] = P(b); k ? g.lineTo(a, bb) : g.moveTo(a, bb); }); g.stroke();
      if (!grf) continue;
      let j = 0; while (j < grf.t.length - 1 && grf.t[j] < tt) j++;
      grf[sd].F.forEach(([gx, gy], q) => {
        const [px, py] = grf[sd].P[q]; if (!(gy[j] > 20)) return;
        const pz = grf[sd].Pz ? grf[sd].Pz[q][j] : z0, gz = grf[sd].Fz ? grf[sd].Fz[q][j] : 0;
        const ax0 = cx + ((px[j] - x0) * fx + (pz - z0) * fz) * S, ay0 = y + h - 6 - ((py[j] || 0) - floor) * S, k = S * 0.3 / 1000;
        const ax1 = ax0 + (gx[j] * fx + gz * fz) * k, ay1 = ay0 - gy[j] * k;
        g.strokeStyle = sideCol(sd); g.fillStyle = g.strokeStyle; g.lineWidth = 3; g.beginPath(); g.moveTo(ax0, ay0); g.lineTo(ax1, ay1); g.stroke();
        const an = Math.atan2(ay1 - ay0, ax1 - ax0); g.beginPath(); g.moveTo(ax1, ay1); g.lineTo(ax1 - 10 * Math.cos(an - 0.4), ay1 - 10 * Math.sin(an - 0.4)); g.lineTo(ax1 - 10 * Math.cos(an + 0.4), ay1 - 10 * Math.sin(an + 0.4)); g.closePath(); g.fill();
      });
    }
  }
}

/**
 * The shared layout. hdr: {t0, t1, grfText, grfXml, bodiesText}. rows: [{title, titleColor,
 *   left: {lines:[{t, v, color, dash, width}], label, lo?, hi?}, right?: {lines, fills:[{t, v, color}], label, lo, hi}}]
 * legend: [[label, color, dash, kind?]]
 */
async function stackFigure(hdr, rows, legend) {
  const { t0, t1 } = hdr;
  const grf = hdr.grfText ? grfBySide(hdr.grfText, hdr.grfXml) : null, bodies = hdr.bodiesText ? readSto(hdr.bodiesText) : null;
  const events = trialEvents(grf, t0, t1);
  const W = 1300, X0 = 120, PW = 1040, poseH = bodies ? 200 : 0, grfH = grf ? 95 : 0, rowH = 118, gap = 54;
  const H = 30 + poseH + (grf ? grfH + gap : 0) + rows.length * (rowH + gap) + 90;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  const X = (v) => X0 + (v - t0) / (t1 - t0 || 1) * PW, ticks = nice(t0, t1);
  const vlines = (top, h) => { g.save(); g.setLineDash([4, 3]); g.strokeStyle = "#555"; g.lineWidth = 1; for (const e of events) { g.beginPath(); g.moveTo(X(e.t), top); g.lineTo(X(e.t), top + h); g.stroke(); } g.restore(); };
  const frame = (top, h) => { g.strokeStyle = "#000"; g.lineWidth = 1; g.strokeRect(X0, top, PW, h); for (const v of ticks) if (v >= t0 && v <= t1) { g.beginPath(); g.moveTo(X(v), top + h); g.lineTo(X(v), top + h + 3); g.stroke(); } };
  const yAxis = (top, h, lo, hi, right, color, label) => {
    const Y = (v) => top + h - (v - lo) / (hi - lo || 1) * h;
    g.font = "11px sans-serif"; g.fillStyle = color; g.strokeStyle = color; g.textAlign = right ? "left" : "right"; g.textBaseline = "middle";
    for (const v of nice(lo, hi)) { if (v < lo || v > hi) continue; const xx = right ? X0 + PW : X0; g.beginPath(); g.moveTo(xx, Y(v)); g.lineTo(xx + (right ? 3 : -3), Y(v)); g.stroke(); g.fillText(fmt(v), xx + (right ? 6 : -6), Y(v)); }
    if (label) { g.save(); g.translate(right ? X0 + PW + 48 : X0 - 52, top + h / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.fillText(label, 0, 0); g.restore(); }
    return Y;
  };
  const line = (ts, vs, Y, col, dash, w = 1.8, top = 0, h = H) => { g.save(); g.beginPath(); g.rect(X0, top, PW, h); g.clip(); g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath(); let pen = false; vs.forEach((v, i) => { if (!Number.isFinite(v) || ts[i] < t0 || ts[i] > t1) { pen = false; return; } pen ? g.lineTo(X(ts[i]), Y(v)) : g.moveTo(X(ts[i]), Y(v)); pen = true; }); g.stroke(); g.restore(); };
  const fill = (ts, vs, Y, col, top, h) => { g.save(); g.beginPath(); g.rect(X0, top, PW, h); g.clip(); g.fillStyle = col; g.beginPath(); g.moveTo(X(Math.max(t0, ts[0])), Y(0)); ts.forEach((tt, i) => { if (tt >= t0 && tt <= t1 && Number.isFinite(vs[i])) g.lineTo(X(tt), Y(vs[i])); }); g.lineTo(X(Math.min(t1, ts[ts.length - 1])), Y(0)); g.fill(); g.restore(); };
  const range = (arrs, lo0, hi0) => { const v = arrs.flat().filter(Number.isFinite); let lo = lo0 ?? Math.min(...v), hi = hi0 ?? Math.max(...v); if (!(hi > lo)) { lo -= 1; hi += 1; } const p = (hi - lo) * 0.06; return [lo0 ?? lo - p, hi0 ?? hi + p]; };
  let y = 20;
  if (bodies) {
    let times = events.length >= 2 ? events.map((e) => e.t) : [0.15, 0.5, 0.85].map((f) => t0 + f * (t1 - t0));
    if (events.length && events.length < 3 && bodies.col("pelvis_y")) { const py = bodies.col("pelvis_y"); let k = -1; bodies.t.forEach((tt, i) => { if (tt < events[0].t && (k < 0 || py[i] < py[k])) k = i; }); if (k >= 0) times = [bodies.t[k], ...times].sort((a, b) => a - b); }
    drawPoses(g, bodies, grf, times, X, y, poseH); y += poseH;
  }
  if (grf) {
    y += 22; g.font = "10px sans-serif"; g.fillStyle = "#333"; g.textAlign = "center"; g.textBaseline = "bottom";
    for (const e of events) g.fillText(e.name, X(e.t), y - 2);
    const [lo, hi] = range([[0], grf.r.vy, grf.l.vy]); const Y = yAxis(y, grfH, Math.min(0, lo), hi, false, "#000", "vGRF (N)");
    for (const sd of ["l", "r"]) { fill(grf.t, grf[sd].vy, Y, sd === "r" ? "rgba(192,57,43,.08)" : "rgba(47,123,214,.08)", y, grfH); line(grf.t, grf[sd].vy, Y, sideCol(sd), null, 1.8, y, grfH); }
    vlines(y, grfH); frame(y, grfH);
    g.font = "12px sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
    [["left foot", L_COL], ["right foot", R_COL]].forEach(([lab, col], k) => { g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath(); g.moveTo(X0 + PW + 20, y + 20 + k * 18); g.lineTo(X0 + PW + 44, y + 20 + k * 18); g.stroke(); g.fillStyle = "#000"; g.fillText(lab, X0 + PW + 50, y + 20 + k * 18); });
    y += grfH + gap;
  }
  for (const r of rows) {
    g.font = "13px sans-serif"; g.fillStyle = r.titleColor || "#000"; g.textAlign = "left"; g.textBaseline = "bottom"; g.fillText(r.title, X0, y - 6);
    if (r.right) {
      const [lo, hi] = range([...(r.right.lines || []), ...(r.right.fills || [])].map((s) => s.v), r.right.lo, r.right.hi);
      const Y = yAxis(y, rowH, lo, hi, true, "#777", r.right.label);
      for (const f of r.right.fills || []) fill(f.t, f.v, Y, f.color, y, rowH);
      for (const s of r.right.lines || []) line(s.t, s.v, Y, s.color, s.dash, s.width || 1.4, y, rowH);
    }
    const [lo, hi] = range(r.left.lines.map((s) => s.v), r.left.lo, r.left.hi);
    const Y = yAxis(y, rowH, lo, hi, false, r.left.color || "#000", r.left.label);
    if (lo < 0 && hi > 0) { g.strokeStyle = "#ccc"; g.lineWidth = 1; g.beginPath(); g.moveTo(X0, Y(0)); g.lineTo(X0 + PW, Y(0)); g.stroke(); }
    for (const s of r.left.lines) line(s.t, s.v, Y, s.color, s.dash, s.width || 1.8, y, rowH);
    vlines(y, rowH); frame(y, rowH);
    y += rowH + gap;
  }
  y -= gap;
  g.font = "11px sans-serif"; g.fillStyle = "#000"; g.textAlign = "center"; g.textBaseline = "top";
  for (const v of ticks) if (v >= t0 && v <= t1) g.fillText(fmt(v), X(v), y + 6);
  g.font = "14px sans-serif"; g.fillText("time (s)", X0 + PW / 2, y + 24);
  g.font = "12px sans-serif"; g.textAlign = "left"; g.textBaseline = "middle";
  const tw = legend.reduce((s, [lab]) => s + 52 + g.measureText(lab).width, 0); let lx = Math.max(10, W / 2 - tw / 2);
  for (const [lab, col, dash, kind] of legend) {
    if (kind === "fill") { g.fillStyle = col; g.fillRect(lx, y + 52, 26, 12); } else { g.strokeStyle = col; g.lineWidth = 2; g.setLineDash(dash || []); g.beginPath(); g.moveTo(lx, y + 58); g.lineTo(lx + 26, y + 58); g.stroke(); g.setLineDash([]); }
    g.fillStyle = "#000"; g.fillText(lab, lx + 32, y + 58); lx += 52 + g.measureText(lab).width;
  }
  return png(c);
}

// ------------------------------------------------------------------ muscle groups
const MGROUPS = [
  ["Gluteus Maximus", /^(glmax|glut_max)/], ["Gluteus Medius", /^(glmed|glut_med)/], ["Iliopsoas", /^(iliacus|psoas)/],
  ["Rectus Femoris", /^(recfem|rect_fem)/], ["Biceps Femoris", /^(bflh|bfsh|bifem)/], ["Semimembranosus", /^semimem/],
  ["Semitendinosus", /^semiten/], ["Vasti", /^vas/], ["Triceps Surae", /^(gas|soleus|med_gas|lat_gas)/], ["Tibialis Anterior", /^(tibant|tib_ant)/],
];
const stem = (n) => n.replace(/_[rl]\d*$/, "").replace(/\d+$/, "");
const sideOf = (n) => (n.match(/_([rl])\d*$/) || [])[1];

export async function muscleGroupsFigure({ forceText, actText, emgText, hdr }) {
  const F = readSto(forceText), A = actText ? readSto(actText) : null, E = emgText ? readSto(emgText) : null;
  const t0 = hdr.t0 ?? F.t[0], t1 = hdr.t1 ?? F.t[F.t.length - 1];
  const rows = [];
  for (const sd of ["r", "l"]) for (const [lab, re] of MGROUPS) {
    const ms = F.cols.filter((c) => c !== "time" && sideOf(c) === sd && re.test(stem(c)) && !/reserve/.test(c));
    if (!ms.length) continue;
    const sum = F.t.map((_, i) => ms.reduce((s, m) => s + F.col(m)[i], 0));
    const right = { lines: [], fills: [], label: "activation", lo: 0, hi: 1.05 };
    let act = null;
    if (A) { const am = ms.filter((m) => A.col(m)); if (am.length) { act = A.t.map((_, i) => am.reduce((s, m) => s + A.col(m)[i], 0) / am.length); right.lines.push({ t: A.t, v: act, color: "#555", width: 1.6 }); } }
    let note = "";
    if (E) {
      const em = ms.filter((m) => E.col(m));
      if (em.length) {
        const ev = E.t.map((_, i) => em.reduce((s, m) => s + E.col(m)[i], 0) / em.length); right.fills.push({ t: E.t, v: ev, color: "rgba(150,150,150,.32)" });
        if (act) {
          const e2 = interp(A.t, E.t, ev), mE = e2.reduce((a, b) => a + b, 0) / e2.length, mA = act.reduce((a, b) => a + b, 0) / act.length;
          let sxy = 0, sxx = 0, syy = 0, se = 0; e2.forEach((v, i) => { sxy += (v - mE) * (act[i] - mA); sxx += (v - mE) ** 2; syy += (act[i] - mA) ** 2; se += (v - act[i]) ** 2; });
          note = `   R²=${(sxx && syy ? sxy * sxy / sxx / syy : 0).toFixed(2)}  RMSE=${Math.sqrt(se / e2.length).toFixed(2)}`;
        }
      }
    }
    rows.push({ title: `${sd.toUpperCase()} ${lab}${note}`, left: { lines: [{ t: F.t, v: sum, color: sideCol(sd) }], label: "force (N)", lo: 0, color: sideCol(sd) }, right });
  }
  return stackFigure({ ...hdr, t0, t1 }, rows, [["GRF at the COP (pose row)", "#444"], ["∑ force (N, left)", R_COL], ["mean activation (right)", "#555"], ...(E ? [["EMG (shaded)", "rgba(150,150,150,.4)", null, "fill"], ["R²/RMSE = EMG vs activation", "#fff"]] : [])]);
}

// ------------------------------------------------------------------ muscle moments
const MCOORDS = ["hip_flexion", "hip_adduction", "hip_rotation", "knee_angle", "knee_adduction", "ankle_angle", "subtalar_angle"];
/** side: "r"|"l". Either forceText (SO: reserves in it) or musclesText (CEINMS: muscle moments per coordinate). */
export async function muscleMomentsFigure({ side, idText, ikText, forceText, musclesText, hdr }) {
  const id = readSto(idText), ik = ikText ? readSto(ikText) : null, F = forceText ? readSto(forceText) : null, Mu = musclesText ? readSto(musclesText) : null;
  const tt = (F || Mu).t, t0 = hdr.t0 ?? tt[0], t1 = hdr.t1 ?? tt[tt.length - 1];
  const rows = [];
  for (const b of MCOORDS) {
    const c = `${b}_${side}`, idv = id.col(c + "_moment"); if (!idv) continue;
    const ID = interp(tt, id.t, idv);
    let mus, res;
    if (Mu) { const m = Mu.col(c + "_moment"); if (!m) continue; mus = m; res = ID.map((v, i) => v - m[i]); }
    else { const rc = F.col(c + "_reserve") || F.col("reserve_" + c); if (!rc && !F.cols.some((x) => x.startsWith(c))) continue; res = rc || tt.map(() => 0); mus = ID.map((v, i) => v - res[i]); }
    const rngv = Math.max(...ID) - Math.min(...ID) || 1, rmse = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length), pk = Math.max(...res.map(Math.abs));
    const pct = (v) => (100 * v / rngv).toFixed(Math.abs(100 * v / rngv) < 10 ? 1 : 0);
    const ok = 100 * rmse / rngv < 5 ? GREEN : 100 * rmse / rngv < 10 ? "#d4a017" : R_COL;
    const row = { title: `${c}   RMSE ${pct(rmse)} % · peak ${pct(pk)} % of ID range`, titleColor: ok,
      left: { lines: [{ t: tt, v: ID, color: "#000", width: 2.6 }, { t: tt, v: mus, color: "#1f77b4", dash: [6, 4], width: 1.8 }, { t: tt, v: res, color: PURPLE, width: 1.6 }], label: "N·m" } };
    if (ik && ik.col(c)) row.right = { lines: [{ t: ik.t, v: ik.col(c), color: "#888", dash: [2, 3], width: 1.4 }], label: "angle (°)" };
    rows.push(row);
  }
  if (!rows.length) throw new Error("no coordinates of side " + side);
  return stackFigure({ ...hdr, t0, t1 }, rows, [["GRF at the COP (pose row)", "#444"], ["ID moment", "#000"], [Mu ? "muscles (CEINMS)" : "muscles (ID - reserve)", "#1f77b4", [6, 4]], [Mu ? "residual (ID - muscles)" : "reserve", PURPLE], ["joint angle (right axis)", "#888", [2, 3]]]);
}

// ------------------------------------------------------------------ joint reaction forces
/** {hip|knee|ankle: {r|l: {base, frame}}} from the JRA column names. */
function jrfColumns(cols) {
  const out = {}, want = { hip: "femur", knee: "tibia", ankle: "talus" };
  for (const [j, body] of Object.entries(want)) for (const sd of ["r", "l"]) {
    const fx = cols.find((c) => c.endsWith(`_on_${body}_${sd}_in_${body}_${sd}_fx`));
    if (fx) (out[j] = out[j] || {})[sd] = fx.slice(0, -3);
  }
  return out;
}
export function bodyWeight(osimText) {
  let m = 0; for (const b of osimText.matchAll(/<Body\b[^>]*>[\s\S]*?<mass>\s*([-\d.eE+]+)/g)) m += +b[1];
  return m * 9.80665;
}
export async function jrfFigure({ jraText, bw, label = "SO", hdr }) {
  const J = readSto(jraText), cols = jrfColumns(J.cols), t0 = hdr.t0 ?? J.t[0], t1 = hdr.t1 ?? J.t[J.t.length - 1];
  const rows = [];
  for (const j of ["hip", "knee", "ankle"]) {
    if (!cols[j]) continue;
    const lines = [], peaks = [];
    for (const sd of ["r", "l"]) {
      const b = cols[j][sd]; if (!b) continue;
      const v = J.t.map((_, i) => Math.hypot(J.col(b + "_fx")[i], J.col(b + "_fy")[i], J.col(b + "_fz")[i]) / bw);
      lines.push({ t: J.t, v, color: sideCol(sd), width: 2 });
      const inT = v.filter((_, i) => J.t[i] >= t0 && J.t[i] <= t1); peaks.push(`${sd.toUpperCase()} ${Math.max(...inT).toFixed(2)}`);
    }
    rows.push({ title: `${j} |resultant|   peak (${label}): ${peaks.join(", ")} x BW`, left: { lines, label: "|F| (x BW)", lo: 0 } });
  }
  if (!rows.length) throw new Error("no hip / knee / ankle reactions in the JRA file");
  return stackFigure({ ...hdr, t0, t1 }, rows, [["GRF at the COP (pose row)", "#444"], ["right", R_COL], ["left", L_COL], [label, "#555"]]);
}

/** Polar plots of the reaction vector at the foot events. plane: "frontal" | "sagittal". */
export async function jrfCoverageFigure({ jraText, bw, plane, label = "SO", title = "", hdr }) {
  const J = readSto(jraText), cols = jrfColumns(J.cols);
  const grf = hdr.grfText ? grfBySide(hdr.grfText, hdr.grfXml) : null;
  const t0 = J.t[0], t1 = J.t[J.t.length - 1];
  let ev = trialEvents(grf, t0, t1);
  if (!ev.length) ev = [0.2, 0.4, 0.6, 0.8].map((f) => ({ t: t0 + f * (t1 - t0), name: `${Math.round(f * 100)} %` }));
  ev = ev.slice(0, 6);
  const joints = ["hip", "knee", "ankle"].filter((j) => cols[j]);
  const rowsDef = []; for (const sd of ["r", "l"]) for (const j of joints) if (cols[j][sd]) rowsDef.push([j, sd]);
  const ncol = ev.length + 1, cw = 190, rh = 200, X0 = 110, Y0 = 70;
  const W = X0 + ncol * cw + 30, H = Y0 + rowsDef.length * rh + 70;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#000"; g.font = "15px sans-serif"; g.textAlign = "center";
  g.fillText(`${title ? title + " · " : ""}${label} · ${plane} — joint reaction force on the distal bone, in its own frame (x BW)`, W / 2, 24);
  g.font = "12px sans-serif";
  ev.forEach((e, k) => g.fillText(`${e.name}  ${e.t.toFixed(2)} s`, X0 + k * cw + cw / 2, Y0 - 12));
  g.fillText("full trial", X0 + ev.length * cw + cw / 2, Y0 - 12);
  const idx = (tt) => { let k = 0; while (k < J.t.length - 1 && J.t[k] < tt) k++; return k; };
  // horizontal axis: frontal = medio-lateral (z, lateral to the right for both sides), sagittal = antero-posterior (x, anterior right)
  const comp = (b, sd, i, j) => {
    const s = j === "hip" ? -1 : 1;                                  // hip: the load on the acetabulum
    const fx = s * J.col(b + "_fx")[i] / bw, fy = s * J.col(b + "_fy")[i] / bw, fz = s * J.col(b + "_fz")[i] / bw;
    return [plane === "frontal" ? (sd === "r" ? fz : -fz) : fx, fy, Math.hypot(fx, fy, fz)];
  };
  rowsDef.forEach(([j, sd], r) => {
    const b = cols[j][sd], cy = Y0 + r * rh + rh / 2 - 10;
    let maxF = 0; for (let i = 0; i < J.t.length; i++) maxF = Math.max(maxF, comp(b, sd, i, j)[2]);
    const step = maxF > 12 ? 5 : 2, ring = Math.max(step, Math.ceil(maxF / step) * step), rad = 78, K = rad / ring;
    g.save(); g.translate(28, cy); g.rotate(-Math.PI / 2); g.fillStyle = sideCol(sd); g.font = "14px sans-serif"; g.textAlign = "center"; g.fillText(`${j} ${sd.toUpperCase()}`, 0, 0); g.restore();
    for (let k = 0; k <= ev.length; k++) {
      const cx = X0 + k * cw + cw / 2;
      g.strokeStyle = "#777"; g.lineWidth = 1.2; g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.stroke();
      g.strokeStyle = "#ccc"; g.lineWidth = 1; for (let q = step; q < ring; q += step) { g.beginPath(); g.arc(cx, cy, q * K, 0, 7); g.stroke(); }
      g.beginPath(); g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy); g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad); g.stroke();
      if (k === 0 && r === 0) {
        g.fillStyle = "#000"; g.font = "10px sans-serif"; g.textAlign = "center";
        g.fillText("SUP", cx, cy - rad + 12); g.fillText("INF", cx, cy + rad - 4);
        g.fillText(plane === "frontal" ? "MED" : "POST", cx - rad + 16, cy - 3); g.fillText(plane === "frontal" ? "LAT" : "ANT", cx + rad - 14, cy - 3);
        g.fillText(`${ring} BW`, cx + 20, cy + rad - 14);
      }
      g.strokeStyle = sideCol(sd); g.fillStyle = sideCol(sd);
      if (k < ev.length) {
        const [h, v, m] = comp(b, sd, idx(ev[k].t), j), x1 = cx + h * K, y1 = cy - v * K;
        g.lineWidth = 3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(x1, y1); g.stroke();
        const an = Math.atan2(y1 - cy, x1 - cx); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - 9 * Math.cos(an - 0.45), y1 - 9 * Math.sin(an - 0.45)); g.lineTo(x1 - 9 * Math.cos(an + 0.45), y1 - 9 * Math.sin(an + 0.45)); g.closePath(); g.fill();
        g.font = "12px sans-serif"; g.textAlign = "center"; g.fillText(m.toFixed(1), cx, cy + rad + 16);
      } else {
        g.lineWidth = 1.5; g.beginPath(); let im = 0, mm = 0;
        for (let i = 0; i < J.t.length; i++) { const [h, v, m] = comp(b, sd, i, j); i ? g.lineTo(cx + h * K, cy - v * K) : g.moveTo(cx + h * K, cy - v * K); if (m > mm) { mm = m; im = i; } }
        g.stroke(); const [h, v] = comp(b, sd, im, j);
        g.lineWidth = 2.5; g.beginPath(); g.moveTo(cx + h * K - 5, cy - v * K - 5); g.lineTo(cx + h * K + 5, cy - v * K + 5); g.moveTo(cx + h * K + 5, cy - v * K - 5); g.lineTo(cx + h * K - 5, cy - v * K + 5); g.stroke();
        g.font = "12px sans-serif"; g.textAlign = "center"; g.fillText(`peak ${mm.toFixed(1)} @ ${J.t[im].toFixed(2)} s`, cx, cy + rad + 16);
      }
    }
  });
  g.fillStyle = "#444"; g.font = "11px sans-serif"; g.textAlign = "left";
  g.fillText("arrow = reaction force at the event (|F| in BW below); full trial: the path of the vector tip, × = its peak. Hip shown as the load on the acetabulum.", 20, H - 20);
  return png(c);
}

// ------------------------------------------------------------------ contributions to the contact force
const GROUP_COL = { "Intersegmental": "#b8a07a", "Adductors": "#2bb3c0", "Gluteus maximus": "#a46bb8",
  "Gluteus med+min": "#5b8db8", "Hamstrings": "#5e2d6e", "Iliopsoas": "#e07a3a", "Rectus femoris": "#2e6b45",
  "Triceps surae": "#a51f24", "Vasti": "#6abf69", "Other muscles": "#cfcfcf", "Other leg (lumped)": "#c8d6c2" };
const GROUP_ORDER = Object.keys(GROUP_COL);
/** Stacked contributions of each muscle group to the hip / knee / ankle contact force,
 *  one row per leg, as bioscout's jcf_stack figure. contribText: jra_<tag>_contrib.sto (N). */
export async function jrfStackFigure({ contribText, bw, label = "SO", title = "" }) {
  const C = readSto(contribText), t = C.t, n = t.length;
  const series = {};                                  // "hip_r" -> {group: values/BW}
  for (const c of C.cols) {
    if (c === "time") continue;
    const [jk, g] = c.split("|"); (series[jk] = series[jk] || {})[g.replace(/_/g, " ")] = C.col(c).map((v) => v / bw);
  }
  const joints = ["hip", "knee", "ankle"], sides = ["r", "l"].filter((sd) => joints.some((j) => series[`${j}_${sd}`]));
  if (!sides.length) throw new Error("no contributions in the file");
  const W = 1500, X0 = 70, colW = (W - X0 - 20) / 3, PW = colW - 50, rowH = 230, Y0 = 90, H = Y0 + sides.length * rowH + 140;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#000"; g.font = "bold 18px sans-serif"; g.textAlign = "center";
  g.fillText(`${title ? title + " — " : ""}${label} contributions to the joint contact force`, W / 2, 30);
  const used = new Set();
  sides.forEach((sd, r) => {
    joints.forEach((j, k) => {
      const S = series[`${j}_${sd}`]; if (!S) return;
      const x0 = X0 + k * colW, y0 = Y0 + r * rowH, h = rowH - 60;
      if (r === 0) { g.font = "bold 15px sans-serif"; g.fillStyle = "#000"; g.textAlign = "center"; g.fillText(`${j} contact force (BW)`, x0 + PW / 2, Y0 - 20); }
      const groups = GROUP_ORDER.filter((gr) => S[gr]);
      const tot = t.map((_, i) => groups.reduce((a, gr) => a + S[gr][i], 0));
      let hi = Math.max(0.5, ...tot), lo = 0;
      const neg = t.map((_, i) => groups.reduce((a, gr) => a + Math.min(0, S[gr][i]), 0));
      lo = Math.min(0, ...neg); hi *= 1.08; lo *= 1.08;
      const X = (i) => x0 + (i / (n - 1)) * PW, Y = (v) => y0 + h - ((v - lo) / (hi - lo || 1)) * h;
      const posB = new Array(n).fill(0), negB = new Array(n).fill(0);
      for (const gr of groups) {
        const v = S[gr]; if (Math.max(...v.map(Math.abs)) < 0.01) continue;
        used.add(gr);
        for (const sign of [1, -1]) {
          const base = sign > 0 ? posB : negB, top = base.map((b, i) => b + (sign > 0 ? Math.max(0, v[i]) : Math.min(0, v[i])));
          g.beginPath(); for (let i = 0; i < n; i++) g.lineTo(X(i), Y(top[i])); for (let i = n - 1; i >= 0; i--) g.lineTo(X(i), Y(base[i]));
          g.closePath(); g.fillStyle = GROUP_COL[gr] || "#999"; g.globalAlpha = sign > 0 ? 1 : 0.6; g.fill(); g.globalAlpha = 1;
          for (let i = 0; i < n; i++) base[i] = top[i];
        }
      }
      g.strokeStyle = "#000"; g.lineWidth = 1.8; g.beginPath(); tot.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.stroke();
      g.lineWidth = 1; g.strokeStyle = "#000"; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0, y0 + h); g.lineTo(x0 + PW, y0 + h); g.stroke();
      g.strokeStyle = "#999"; g.beginPath(); g.moveTo(x0, Y(0)); g.lineTo(x0 + PW, Y(0)); g.stroke();
      g.fillStyle = "#000"; g.font = "11px sans-serif"; g.textAlign = "right"; g.textBaseline = "middle";
      for (const v of nice(lo, hi)) if (v >= lo && v <= hi) g.fillText(fmt(v), x0 - 5, Y(v));
      g.textAlign = "center"; g.textBaseline = "top";
      for (const p of [0, 20, 40, 60, 80, 100]) g.fillText(String(p), x0 + p / 100 * PW, y0 + h + 5);
      if (r === sides.length - 1) { g.font = "13px sans-serif"; g.fillText("% trial", x0 + PW / 2, y0 + h + 22); }
      if (k === 0) { g.save(); g.translate(22, y0 + h / 2); g.rotate(-Math.PI / 2); g.font = "bold 14px sans-serif"; g.fillStyle = sideCol(sd); g.fillText(sd === "r" ? "right" : "left", 0, 0); g.restore(); }
      g.textBaseline = "alphabetic";
    });
  });
  // legend
  const items = GROUP_ORDER.filter((gr) => used.has(gr));
  g.font = "13px sans-serif"; g.textAlign = "left"; g.fillStyle = "#000";
  const ly = Y0 + sides.length * rowH + 10;
  g.textAlign = "center"; g.fillText("contribution = projection on the total joint contact force (sums to |JCF|); below 0 = pulls against it", W / 2, ly);
  g.textAlign = "left";
  const per = 4, cw = 260, lx0 = W / 2 - (per * cw) / 2;
  [...items, "|JCF|"].forEach((gr, k) => {
    const x = lx0 + (k % per) * cw, y = ly + 20 + Math.floor(k / per) * 22;
    if (gr === "|JCF|") { g.strokeStyle = "#000"; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y + 6); g.lineTo(x + 30, y + 6); g.stroke(); }
    else { g.fillStyle = GROUP_COL[gr]; g.fillRect(x, y, 30, 12); }
    g.fillStyle = "#000"; g.fillText(gr, x + 38, y + 11);
  });
  return png(cv);
}
