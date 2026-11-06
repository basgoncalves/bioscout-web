/**
 * End-of-session report (Developer mode): what the whole session added up to.
 *
 * Three things the per-set views cannot show, because each needs the session
 * as a whole: how long it ran and how hard it was, which muscle groups carried
 * the work, and where on the floor it happened.
 *
 * HOW HARD IT WAS
 * Two independent answers, and this file keeps them apart rather than blending
 * them into one score that hides which one it came from:
 *   density  volume (kg) per working minute -- from the training log, always
 *            available, and the one a leaderboard can compare across people.
 *   effort   the accelerometer's effort index -- only when the phone was on
 *            the body, and comparable only within one athlete's own sessions
 *            with the phone in the same place.
 *
 * MUSCLE LOAD
 * Modelled from the movement pattern, NOT measured. Each movement is given the
 * share of its load that each group takes (a squat loads knee extensors and
 * hip extensors, a pull-up the elbow flexors and shoulder extensors), and the
 * set's volume is divided accordingly. So the spider shows how this session's
 * work was distributed between groups -- useful for spotting a session that
 * was all quads and no posterior chain -- and it is not a force, not an EMG
 * estimate, and not comparable to the muscle forces the simulation produces.
 * Where a set carries measured joint moments they scale the group's share, so
 * a heavier set counts for more than a light one of the same movement.
 */

import { BW_FRACTION, liftReport } from "./postrack.js";

/* Share of a movement's load taken by each group. Rows need not sum to 1:
 * a movement that loads two groups hard loads them both hard. Drawn from the
 * usual EMG and modelling picture of each exercise, rounded to a tenth --
 * finer numbers would imply a precision this does not have. */
export const MOVEMENT_LOAD = {
  squat:      { knee_ext: 1.0, hip_ext: 0.7, ankle_pf: 0.3 },
  slsquat:    { knee_ext: 1.0, hip_ext: 0.7, ankle_pf: 0.4, hip_flex: 0.2 },
  lunge:      { knee_ext: 0.9, hip_ext: 0.7, ankle_pf: 0.3 },
  deadlift:   { hip_ext: 1.0, knee_ext: 0.4, shoulder_ext: 0.3 },
  bridge:     { hip_ext: 1.0, knee_flex: 0.4 },
  kickback:   { hip_ext: 0.8, knee_flex: 0.2 },
  heelraise:  { ankle_pf: 1.0 },
  cmj:        { knee_ext: 0.9, hip_ext: 0.8, ankle_pf: 0.8 },
  sj:         { knee_ext: 0.9, hip_ext: 0.7, ankle_pf: 0.7 },
  jump:       { knee_ext: 0.9, hip_ext: 0.8, ankle_pf: 0.8 },
  jumpshot:   { knee_ext: 0.7, hip_ext: 0.6, ankle_pf: 0.6, shoulder_flex: 0.4 },
  run:        { hip_ext: 0.7, knee_ext: 0.6, ankle_pf: 0.9, hip_flex: 0.5 },
  walk:       { hip_ext: 0.4, ankle_pf: 0.4, knee_ext: 0.3 },
  sidestep:   { hip_ext: 0.6, knee_ext: 0.6, ankle_pf: 0.5 },
  pullup:     { elbow_flex: 0.9, shoulder_ext: 1.0 },
  curl:       { elbow_flex: 1.0 },
  row:        { shoulder_ext: 0.9, elbow_flex: 0.6 },
  dip:        { elbow_ext: 1.0, shoulder_flex: 0.6 },
  pushup:     { elbow_ext: 0.9, shoulder_flex: 0.7 },
  ohpress:    { elbow_ext: 0.9, shoulder_flex: 1.0 },
  raise:      { shoulder_flex: 1.0 },
  plank:      { hip_flex: 0.4, shoulder_flex: 0.3 },
  sideplank:  { hip_flex: 0.4, shoulder_ext: 0.3 },
  wallsit:    { knee_ext: 1.0, hip_ext: 0.3 },
  movement:   {},
};

export const SPIDER_GROUPS = [
  { key: "hip_ext", label: "Hip ext." }, { key: "knee_ext", label: "Knee ext." },
  { key: "ankle_pf", label: "Ankle PF" }, { key: "knee_flex", label: "Knee flex." },
  { key: "hip_flex", label: "Hip flex." }, { key: "shoulder_ext", label: "Shoulder ext." },
  { key: "elbow_flex", label: "Elbow flex." }, { key: "elbow_ext", label: "Elbow ext." },
  { key: "shoulder_flex", label: "Shoulder flex." },
];

/** Session duration in seconds, from the first set to the last plus its length. */
export function sessionDuration(sess) {
  const ts = (sess?.sets || []).map((s) => +new Date(s.at)).filter(Number.isFinite);
  if (!ts.length) return 0;
  const span = (Math.max(...ts) - Math.min(...ts)) / 1000;
  // The last set still took time; add its own duration so a two-set session is
  // not reported as the gap between their start stamps alone.
  const last = sess.sets[sess.sets.length - 1];
  const lastLen = (last.perRep || []).reduce((a, r) => a + (r.duration_s || 0), 0);
  return Math.round(span + lastLen);
}

/** The headline numbers: duration and intensity. */
export function sessionTotals(sess, effort = null) {
  const lifts = liftReport(sess);
  const duration_s = sessionDuration(sess);
  const volume_kg = lifts.reduce((a, l) => a + (l.volume_kg || 0), 0);
  const reps = lifts.reduce((a, l) => a + l.reps, 0);
  const min = duration_s / 60;
  return {
    duration_s, volume_kg, reps, sets: (sess?.sets || []).length,
    density_kg_min: min > 0 ? Math.round(volume_kg / min) : 0,
    effort_index: effort?.ok ? effort.effort_index : null,
    work_pct: effort?.ok ? effort.work_pct : null,
  };
}

/**
 * Load per muscle group for the session, as a share of the hardest-loaded
 * group (0-1) plus the raw kg behind it.
 */
export function muscleLoad(sess) {
  const out = {};
  for (const s of sess?.sets || []) {
    const share = MOVEMENT_LOAD[s.activity];
    if (!share) continue;
    const bm = +s.massKg || 0;
    const load = Math.max(0, bm * (BW_FRACTION[s.activity] ?? 0) + (+s.addedKg || 0) - (+s.assistKg || 0));
    let vol = load * s.reps;
    if (!vol) vol = s.reps;           // no load known: reps still happened
    /* A measured set says how hard it actually was. Scale by the peak lower-limb
     * moment against a nominal 150 N*m, clamped, so a heavy set outweighs a
     * light one of the same movement without a single rep dominating the plot. */
    const peaks = (s.perRep || []).map((r) =>
      Math.max(r.peak_hip_Nm || 0, r.peak_knee_Nm || 0, r.peak_ankle_Nm || 0)).filter(Boolean);
    if (peaks.length) {
      const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length;
      vol *= Math.min(2, Math.max(0.5, mean / 150));
    }
    for (const [g, w] of Object.entries(share)) out[g] = (out[g] || 0) + vol * w;
  }
  const max = Math.max(0, ...Object.values(out)) || 1;
  return SPIDER_GROUPS.map(({ key, label }) => ({
    key, label, kg: Math.round(out[key] || 0), share: +((out[key] || 0) / max).toFixed(2),
  })).filter((g) => g.kg > 0);
}

/** Spider / radar plot of the muscle-group load. */
export function spiderSVG(groups, labelOf = (g) => g.label) {
  if (!groups || groups.length < 3) return "";
  const S = 300, c = S / 2, R = S / 2 - 48;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + 2 * Math.PI * i / groups.length;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  let rings = "";
  for (const f of [0.25, 0.5, 0.75, 1]) {
    rings += `<polygon points="${groups.map((_, i) => pt(i, R * f).map((v) => v.toFixed(1)).join(",")).join(" ")}"
      fill="none" stroke="var(--line,#8884)"/>`;
  }
  const spokes = groups.map((_, i) => {
    const [x, y] = pt(i, R);
    return `<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line,#8884)"/>`;
  }).join("");
  const poly = groups.map((g, i) => pt(i, R * Math.max(0.02, g.share)).map((v) => v.toFixed(1)).join(",")).join(" ");
  const labels = groups.map((g, i) => {
    const [x, y] = pt(i, R + 16);
    const anchor = Math.abs(x - c) < 6 ? "middle" : x > c ? "start" : "end";
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}"
      font-size="10" fill="var(--muted,#888)">${labelOf(g)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${S} ${S}" style="width:100%;max-width:320px;display:block;margin:6px auto" role="img">
    ${rings}${spokes}
    <polygon points="${poly}" fill="#2b7de9" fill-opacity=".28" stroke="#2b7de9" stroke-width="2"/>
    ${labels}</svg>`;
}

/**
 * Top view of the whole session: every set's floor path in one picture, in the
 * horizontal plane only (the vertical is deliberately absent -- a top view of
 * someone squatting should show a dot, not a line).
 *
 * Paths are per set and each is measured from the camera, so they share an
 * origin only if the camera did not move. Said on the page, not hidden here.
 */
export function topViewSVG(paths, labels = {}) {
  const sets = Object.entries(paths || {}).filter(([, p]) => p?.ok && p.x?.length);
  if (!sets.length) return "";
  const COL = ["#2b7de9", "#e9572b", "#2bb673", "#b52be9", "#e9b82b", "#2bd1e9", "#e92b8a"];
  const xs = sets.flatMap(([, p]) => p.x), ys = sets.flatMap(([, p]) => p.z);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1.5) * 1.15;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const S = 300, pad = 16, k = (S - 2 * pad) / span;
  const X = (x) => pad + (x - (cx - span / 2)) * k, Y = (y) => pad + (y - (cy - span / 2)) * k;
  let grid = "";
  for (let g = Math.ceil(cx - span / 2); g <= cx + span / 2; g++)
    grid += `<line x1="${X(g).toFixed(1)}" y1="${pad}" x2="${X(g).toFixed(1)}" y2="${S - pad}" stroke="var(--line,#8884)"/>`;
  for (let g = Math.ceil(cy - span / 2); g <= cy + span / 2; g++)
    grid += `<line x1="${pad}" y1="${Y(g).toFixed(1)}" x2="${S - pad}" y2="${Y(g).toFixed(1)}" stroke="var(--line,#8884)"/>`;
  const lines = sets.map(([, p], n) => {
    const col = COL[n % COL.length];
    const d = p.x.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(p.z[i]).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" opacity=".9"/>
      <circle cx="${X(p.x[0]).toFixed(1)}" cy="${Y(p.z[0]).toFixed(1)}" r="3.5" fill="${col}"/>`;
  }).join("");
  const legend = sets.map(([i], n) => `<span style="color:${COL[n % COL.length]}">&#9632; ${labels[i] || i}</span>`).join(" &nbsp;");
  return `<svg viewBox="0 0 ${S} ${S}" style="width:100%;max-width:320px;display:block;margin:6px auto" role="img">
    <rect x="${pad}" y="${pad}" width="${S - 2 * pad}" height="${S - 2 * pad}" fill="none" stroke="var(--line,#8886)"/>
    ${grid}${lines}</svg><div class="note" style="text-align:center">${legend}</div>`;
}
