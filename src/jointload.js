/**
 * jointload.js -- where the joint contact forces point, at the instants that
 * matter, in one picture per task.
 *
 * The browser edition of bioscout's `plot jcf_coverage` figure
 * (bioscout/plot/jcf_coverage.py): a strip of poses at the task's key events,
 * the vertical ground reaction force of both feet with those events marked,
 * then one polar dial per joint (hip, knee, ankle) per event. Each dial shows
 * the contact-force VECTOR of that instant -- length = |F| in bodyweight on a
 * rim shared by every dial, direction = its angle in the chosen anatomical
 * plane -- and a last column traces the vector's tip over the whole cycle
 * (dot = start, cross = end).
 *
 * Two planes, one toggle:
 *   sagittal  up = superior, right = anterior
 *   frontal   up = superior, right = LATERAL (for either leg)
 *
 * Frames, as the v2 surrogate reports them (force_model_v2.json `frames`):
 *   hip    hip_*_pelvis_f*  is the force of the pelvis ON the femur, in the
 *          pelvis frame (x anterior, y up, z right). It is NEGATED here, so
 *          the dial shows the load ON THE ACETABULUM -- what the OpenSim
 *          figure shows, and the quantity hip papers report.
 *   knee   on the tibia, in the tibia frame.   ankle: on the talus, in its frame.
 *   z is mirrored for the left leg so "lateral" means lateral on both sides.
 *
 * What this is NOT. Every arrow is a MODEL ESTIMATE: a surrogate of OpenSim
 * static optimisation, driven by the ~12 sagittal coordinates a phone sees.
 * The medio-lateral component in particular is inferred from sagittal motion
 * alone (hip adduction and rotation are held at the training mean), so the
 * frontal view shows what the training cohort's frontal loading looked like
 * at this sagittal state, not this athlete's. The page says so under the plot.
 *
 * Pure: no DOM, no fetch. `jointLoadSVG` returns a string.
 */

export const PLANES = {
  sagittal: { cols: [0, 1], dirs: ["jlSup", "jlAnt", "jlInf", "jlPos"] },
  frontal: { cols: [2, 1], dirs: ["jlSup", "jlLat", "jlInf", "jlMed"] },
};
export const JOINTS = ["hip", "knee", "ankle"];
const NO_LEGS = new Set(["pullup", "dip", "pushup", "neck", "kickback"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const f1 = (v) => (isNum(v) ? v.toFixed(1) : "0");
const D2R = Math.PI / 180;

/** Can this rep draw the figure at all? */
export function hasJointLoad(rep, activity) {
  return !!(rep && rep.loads && rep.loads.length > 3 && rep.loadNames
            && rep.coords && !NO_LEGS.has(activity));
}

/** Same ladder as bioscout.plot.jcf_direction.nice_ceiling. */
export function niceCeiling(v) {
  if (!isNum(v) || v <= 0) return 1;
  const steps = [0.25, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 10];
  for (const s of steps) if (v / s <= 4) return Math.ceil(v / s) * s;
  return Math.ceil(v / 10) * 10;
}

/** Per-frame [x, y, z] of one joint, in the dial's convention (see header). */
export function jointVectors(rep, joint, side) {
  const names = rep.loadNames;
  const base = joint === "hip" ? `hip_${side}_pelvis_` : `${joint}_${side}_`;
  const ix = ["fx", "fy", "fz"].map((c) => names.indexOf(base + c));
  if (ix.some((i) => i < 0)) return null;
  const sgn = joint === "hip" ? -1 : 1;          // on the acetabulum
  const lat = side === "l" ? -1 : 1;             // +z = lateral on both legs
  return rep.loads.map((row) => [sgn * row[ix[0]], sgn * row[ix[1]], sgn * lat * row[ix[2]]]);
}

/** Vertical GRF of one foot in bodyweight, and where it came from. */
export function verticalGrf(rep, side, bwN) {
  const n = rep.loads.length;
  const own = rep.jm && rep.jm[`feet_grf_${side}`];
  if (own && own.length === n && bwN > 0 && Array.from(own).some((v) => isNum(v) && v > 0)) {
    return { v: Array.from(own, (x) => (isNum(x) ? Math.max(0, x / bwN) : 0)), source: "newton" };
  }
  const i = rep.loadNames.indexOf(`grf_${side}_fy`);
  return { v: rep.loads.map((r) => (i >= 0 ? Math.max(0, r[i]) : 0)), source: "model" };
}

// ── events ───────────────────────────────────────────────────────────────────

const arg = (a, lo, hi, better) => {
  let best = -1;
  for (let i = Math.max(0, lo); i <= Math.min(a.length - 1, hi); i++) {
    if (!isNum(a[i])) continue;
    if (best < 0 || better(a[i], a[best])) best = i;
  }
  return best;
};
const argmax = (a, lo = 0, hi = a.length - 1) => arg(a, lo, hi, (x, y) => x > y);
const argmin = (a, lo = 0, hi = a.length - 1) => arg(a, lo, hi, (x, y) => x < y);
function smooth(a, w) {
  const n = a.length, out = new Array(n), h = Math.max(1, Math.floor(w / 2));
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) if (isNum(a[k])) { s += a[k]; c++; }
    out[i] = c ? s / c : NaN;
  }
  return out;
}
function diff(a, t) {
  return a.map((_, i) => {
    const i0 = Math.max(0, i - 1), i1 = Math.min(a.length - 1, i + 1);
    const dt = t[i1] - t[i0];
    return dt > 0 ? (a[i1] - a[i0]) / dt : 0;
  });
}
const range = (a) => {
  const f = a.filter(isNum);
  return f.length ? Math.max(...f) - Math.min(...f) : 0;
};

/**
 * Is knee flexion positive or negative in this rep's coordinates? The .mot is
 * signed for the chosen OpenSim model (Rajagopal +, GPK -), and not every task
 * passes through the same flip. A knee flexes far and hyperextends barely, so
 * the larger excursion from zero IS flexion -- read it off the data.
 */
export function kneeSignOf(rep) {
  let hi = 0, lo = 0;
  for (const s of ["r", "l"]) for (const v of rep.coords[`knee_angle_${s}`] || []) {
    if (isNum(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
  }
  return -lo > hi ? -1 : 1;
}

/** Which family of instants a task has. */
export function eventFamily(activity, spec = {}) {
  if (spec.gait || activity === "run" || activity === "walk" || activity === "sidestep") return "gait";
  if (spec.jump || spec.shot || activity === "jumpshot") return "jump";
  return "squat";
}

/**
 * The instants the figure shows: [{ key, i }] sorted by frame, at most four.
 * Same definitions as bioscout/session/events.yaml where the signals exist in
 * the browser; `key` is an i18n key.
 */
export function loadEvents(rep, activity, spec, side, grf, kneeSign = 1) {
  const n = rep.loads.length, t = Array.from(rep.times);
  const c = rep.coords;
  const get = (k) => (c[k] && c[k].length >= n ? Array.from(c[k]).slice(0, n) : null);
  const hip = get(`hip_flexion_${side}`);
  const kneeRaw = get(`knee_angle_${side}`);
  const knee = kneeRaw && kneeRaw.map((v) => v * kneeSign);
  const ty = get("pelvis_ty");
  const tyOk = ty && range(ty) > 0.03;
  const fam = eventFamily(activity, spec);
  const ev = [];
  const push = (key, i) => { if (i >= 0) ev.push({ key, i }); };

  if (fam === "gait" && hip) {
    const pk = Math.max(...grf);
    const stance = grf.map((v) => pk > 0.2 && v > 0.1 * pk);
    // ONE stance: the contiguous contact around the peak. A whole-trial panel
    // holds several, and "push off" from one with "impact" from another is a
    // stride that never happened. Its swing is the one just before it (the
    // one after, when the clip starts in contact).
    let first = -1, last = -1;
    if (stance.some(Boolean)) {
      first = last = argmax(grf);
      while (first > 0 && stance[first - 1]) first--;
      while (last < n - 1 && stance[last + 1]) last++;
    }
    let s0 = first - 1, s1 = first - 1;
    while (s0 > 0 && !stance[s0 - 1]) s0--;
    if (first < 0) { s0 = 0; s1 = n - 1; }
    else if (s1 - s0 < 3) { s0 = s1 = last + 1; while (s1 < n - 1 && !stance[s1 + 1]) s1++; }
    if (s1 - s0 >= 3 && s0 >= 0 && s1 < n) push("jlEvMidSwing", argmax(hip, s0, s1));
    if (first >= 0) {
      // first local maximum in the first third of stance -- the impact peak
      const end = first + Math.floor((last - first) / 3);
      for (let i = first + 1; i < end; i++) {
        if (grf[i] > grf[i - 1] && grf[i] >= grf[i + 1] && grf[i] > 0.5 * pk) { push("jlEvImpact", i); break; }
      }
      push("jlEvPeakLoad", argmax(grf, first, last));
      push("jlEvPushOff", argmin(hip, first, last));
    }
  } else if (fam === "jump") {
    const total = grf;
    const apex = tyOk ? argmax(ty) : argmin(smooth(total, 5), Math.floor(n * 0.2), Math.floor(n * 0.9));
    if (apex > 1) {
      push("jlEvBottom", tyOk ? argmin(ty, 0, apex) : (knee ? argmax(knee, 0, apex) : -1));
      push("jlEvPeakPush", argmax(grf, 0, apex));
      push("jlEvApex", apex);
      if (apex < n - 2) push("jlEvLanding", argmax(grf, apex + 1, n - 1));
    }
  } else {
    const bottom = tyOk ? argmin(ty) : (knee ? argmax(knee) : -1);
    if (bottom > 1 && bottom < n - 2) {
      const vel = tyOk ? diff(smooth(ty, 5), t) : diff(smooth(knee, 5), t).map((v) => -v);
      push("jlEvStart", 0);
      push("jlEvPeakDescent", argmin(vel, 1, bottom));
      push("jlEvBottom", bottom);
      // Peak load on the way up -- unless it IS the bottom (it often is: the
      // turnaround is where the body is decelerated hardest), in which case a
      // second column for the same instant says nothing, and the fastest part
      // of the ascent is shown instead.
      const pl = argmax(grf, bottom + 1, n - 1);
      if (pl - bottom >= 3) push("jlEvPeakLoadUp", pl);
      else push("jlEvPeakAscent", argmax(vel, bottom + 1, n - 2));
    }
  }

  // Sort, and drop an event that lands on its neighbour's frame: two columns
  // showing the same instant under different names is a false distinction.
  ev.sort((a, b) => a.i - b.i);
  const out = [];
  for (const e of ev) if (!out.length || e.i - out[out.length - 1].i >= 2) out.push(e);
  if (out.length >= 2) return out.slice(0, 4);
  // Nothing recognisable: four evenly spaced instants, labelled by time.
  return [0.125, 0.375, 0.625, 0.875].map((f) => ({ key: null, i: Math.round(f * (n - 1)) }));
}

// ── the pose ─────────────────────────────────────────────────────────────────

/**
 * A stick figure from the rep's OpenSim coordinates (all sagittal rotations
 * about the pelvis z axis, flexion-positive after `kneeSign`). Returns segment
 * polylines in metres-ish units of body height, x anterior / y up / z right.
 */
export function poseAt(rep, i, kneeSign = 1) {
  const c = rep.coords;
  const q = (k) => { const a = c[k]; const v = a ? a[Math.min(i, a.length - 1)] : 0; return isNum(v) ? v : 0; };
  const tilt = q("pelvis_tilt") * D2R;
  const LT = 0.245, LS = 0.246, LF = 0.13, LTR = 0.30, HW = 0.075;
  const limbs = {};
  for (const s of ["r", "l"]) {
    const z = s === "r" ? HW : -HW;
    const add = q(`hip_adduction_${s}`) * D2R * (s === "r" ? -1 : 1);   // adduction -> toward midline
    const a1 = tilt + q(`hip_flexion_${s}`) * D2R;
    const a2 = a1 - q(`knee_angle_${s}`) * kneeSign * D2R;
    const a3 = a2 + q(`ankle_angle_${s}`) * D2R;
    const hipP = [0, 0, z];
    const kneeP = [hipP[0] + LT * Math.sin(a1), hipP[1] - LT * Math.cos(a1) * Math.cos(add),
                   z + LT * Math.cos(a1) * Math.sin(add)];
    const ankP = [kneeP[0] + LS * Math.sin(a2), kneeP[1] - LS * Math.cos(a2) * Math.cos(add),
                  kneeP[2] + LS * Math.cos(a2) * Math.sin(add)];
    const heel = [ankP[0] - 0.04 * Math.cos(a3), ankP[1] - 0.04 * Math.sin(a3) - 0.03, ankP[2]];
    const toe = [ankP[0] + LF * Math.cos(a3), ankP[1] + LF * Math.sin(a3) - 0.03,
                 ankP[2] + (s === "r" ? 0.03 : -0.03)];     // a little toe-out, so a front view has feet
    limbs[s] = { hip: hipP, knee: kneeP, ankle: ankP, heel, toe };
  }
  const a0 = tilt + q("lumbar_extension") * D2R;
  const neck = [-LTR * Math.sin(a0), LTR * Math.cos(a0), 0];
  const head = [neck[0] - 0.07 * Math.sin(a0), neck[1] + 0.07 * Math.cos(a0), 0];
  return { limbs, pelvis: [0, 0, 0], neck, head };
}

// ── drawing ──────────────────────────────────────────────────────────────────

/* Schematic bones behind each dial, unit circle coordinates (y up), one set
 * per plane. They orient the reader -- which way is the socket, where is the
 * plateau -- and carry no measurement. */
const BONES = {
  sagittal: {
    hip: [["M-.95,.15 C-.9,.85 -.2,1 .35,.9 C.8,.8 .95,.35 .7,.05 C.45,.3 -.25,.35 -.5,.05 C-.6,-.2 -.9,-.2 -.95,.15Z", .10],
          ["M0,0 m-.3,0 a.3,.3 0 1,0 .6,0 a.3,.3 0 1,0 -.6,0 M-.16,-.22 L.2,-.24 L.24,-1 L-.2,-1Z", .17]],
    knee: [["M-.26,1 L.26,1 L.34,.35 C.5,.05 .3,-.12 0,-.1 C-.4,-.12 -.55,.1 -.34,.4Z", .17],
           ["M-.42,-.2 L.4,-.2 C.42,-.4 .28,-.55 .24,-1 L-.24,-1 C-.26,-.6 -.44,-.45 -.42,-.2Z", .10],
           ["M.42,.3 C.62,.3 .62,-.05 .45,-.08 C.4,.05 .4,.2 .42,.3Z", .13]],
    ankle: [["M-.22,1 L.22,1 L.3,.12 C.1,.22 -.15,.22 -.34,.1Z", .17],
            ["M-.34,.04 C-.1,.2 .15,.2 .34,.04 L.5,-.25 L-.45,-.25Z", .13],
            ["M-.75,-.3 L.95,-.3 C1,-.5 .8,-.56 .5,-.58 L-.7,-.62 C-.85,-.55 -.85,-.4 -.75,-.3Z", .10]],
  },
  frontal: {
    hip: [["M.75,1 C.2,.95 -.3,.75 -.55,.35 C-.7,.05 -.95,-.1 -.9,-.45 C-.55,-.35 -.35,-.25 -.3,0 C-.2,.35 .25,.35 .32,.05 C.5,.35 .75,.6 .75,1Z", .10],
          ["M0,0 m-.28,0 a.28,.28 0 1,0 .56,0 a.28,.28 0 1,0 -.56,0 M.12,-.1 L.55,.12 C.75,.1 .78,-.2 .62,-.4 L.55,-1 L.2,-1 L.22,-.35Z", .17]],
    knee: [["M-.24,1 L.24,1 L.5,.3 C.55,-.05 .3,-.1 .08,.02 C-.1,-.1 -.55,-.05 -.5,.3Z", .17],
           ["M-.5,-.18 L.5,-.18 C.5,-.4 .28,-.5 .22,-1 L-.22,-1 C-.26,-.5 -.5,-.4 -.5,-.18Z", .10]],
    ankle: [["M-.2,1 L.2,1 L.3,.1 L.42,-.12 L.3,-.14 C.1,.18 -.12,.18 -.3,.1 L-.42,-.2 L-.3,.1Z", .17],
            ["M-.3,.04 C-.1,.14 .1,.14 .3,.04 L.34,-.3 L-.34,-.3Z", .13],
            ["M-.4,-.34 L.4,-.34 L.45,-.62 L-.45,-.62Z", .10]],
  },
};

function bonesSVG(joint, plane, cx, cy, R) {
  const k = R * 0.95;
  return (BONES[plane][joint] || []).map(([d, op]) =>
    `<path d="${d}" transform="translate(${f1(cx)} ${f1(cy)}) scale(${k.toFixed(2)} ${(-k).toFixed(2)})" fill="var(--ink)" fill-opacity="${op}"/>`).join("");
}

function arrowSVG(x0, y0, x1, y1, col, w = 2) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len < 1.2) return `<circle cx="${f1(x0)}" cy="${f1(y0)}" r="1.8" fill="${col}"/>`;
  const ux = dx / len, uy = dy / len, h = Math.min(6, len * 0.6), b = h * 0.5;
  const bx = x1 - ux * h, by = y1 - uy * h;
  return `<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(bx)}" y2="${f1(by)}" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`
    + `<path d="M${f1(x1)},${f1(y1)} L${f1(bx - uy * b)},${f1(by + ux * b)} L${f1(bx + uy * b)},${f1(by - ux * b)}Z" fill="${col}"/>`;
}

function skeletonSVG(pose, plane, cx, footY, scale, colR, colL, lift = 0) {
  const P = plane === "frontal"
    ? (p) => [-p[2], p[1]]                 // camera in front: subject's right on the viewer's left
    : (p) => [p[0], p[1]];
  const pts = [];
  for (const s of ["r", "l"]) for (const k of ["hip", "knee", "ankle", "heel", "toe"]) pts.push(P(pose.limbs[s][k]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const X = (p) => cx + P(p)[0] * scale;
  const Y = (p) => footY - (P(p)[1] - minY + lift) * scale;
  const line = (a, b, col, w) => `<line x1="${f1(X(a))}" y1="${f1(Y(a))}" x2="${f1(X(b))}" y2="${f1(Y(b))}" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`;
  let g = line(pose.pelvis, pose.neck, "var(--muted)", 2.2)
    + `<circle cx="${f1(X(pose.head))}" cy="${f1(Y(pose.head))}" r="${f1(0.05 * scale)}" fill="var(--muted)"/>`
    + line(pose.limbs.l.hip, pose.limbs.r.hip, "var(--muted)", 2.2);
  // far leg first, so the analysed colours read on top in a side view
  for (const [s, col] of [["l", colL], ["r", colR]]) {
    const L = pose.limbs[s];
    g += line(L.hip, L.knee, col, 2.4) + line(L.knee, L.ankle, col, 2.2)
       + line(L.heel, L.toe, col, 2) + line(L.ankle, L.heel, col, 1.6);
    for (const k of ["hip", "knee", "ankle"]) g += `<circle cx="${f1(X(L[k]))}" cy="${f1(Y(L[k]))}" r="1.9" fill="${col}"/>`;
  }
  return g;
}

/**
 * The figure. opts: { plane, side, activity, spec, massKg, externalKg, heightM,
 * colors: { l, r }, tr }; kneeSign is read off the data unless given.
 * Returns { svg, events:[{label, t}], rim, grfSource } or null.
 */
export function jointLoadSVG(rep, opts) {
  const { plane = "sagittal", side = "r", activity, spec = {},
          kneeSign = kneeSignOf(rep), colors = { l: "#2f9e5f", r: "#d1493f" }, tr = (k) => k,
          refPeaks = null, refColor = "#9aa4b8" } = opts;
  if (!hasJointLoad(rep, activity)) return null;
  const n = rep.loads.length, t = Array.from(rep.times).slice(0, n);
  const pct = rep.timeUnit === "%";
  const bwN = ((opts.massKg || 0) + (opts.externalKg || 0)) * 9.80665;
  const grfS = verticalGrf(rep, side, bwN);
  const other = side === "r" ? "l" : "r";
  const grfO = verticalGrf(rep, other, bwN);
  const ev = loadEvents(rep, activity, spec, side, grfS.v, kneeSign);
  const col = colors[side], cols = PLANES[plane].cols;

  // vectors and the shared rim
  const vec = {}, mag = {};
  let rimRaw = 0;
  for (const j of JOINTS) {
    const v = jointVectors(rep, j, side);
    if (!v) continue;
    vec[j] = v;
    /* LENGTH is the model's own magnitude target (hip_r_mag ...), the number
     * the joint-contact table reports; the components give the DIRECTION only.
     * The network predicts the two separately, and the norm of predicted
     * components is systematically smaller than the predicted norm (errors in
     * a component partly cancel; in a magnitude they cannot) -- 6.2 against
     * 7.5 BW at the hip on the first phone trial. One figure and one table
     * about the same joint must not disagree, so both read the same target. */
    const mi = rep.jrf && rep.jrfNames && rep.jrf.length === v.length
      ? rep.jrfNames.indexOf(`${j}_${side}_mag`) : -1;
    mag[j] = mi >= 0 ? rep.jrf.map((row) => Math.abs(row[mi]))
                     : v.map((p) => Math.hypot(p[0], p[1], p[2]));
    rimRaw = Math.max(rimRaw, ...mag[j].filter(isNum));
  }
  const joints = JOINTS.filter((j) => vec[j]);
  if (!joints.length) return null;
  /* The reference rings are inside the rim, not clipped by it.
   *
   * A reference larger than the athlete's own peak would be drawn outside the
   * dial and clipped, which reads as "there is no reference" -- the opposite
   * of what it means. It joins the scale instead. */
  if (refPeaks) {
    for (const j of JOINTS) {
      const v = refPeaks[j];
      if (isNum(v) && v > rimRaw) rimRaw = v;
    }
  }
  const rim = niceCeiling(rimRaw);

  // ── layout ────────────────────────────────────────────────────────────────
  const W = 360, GUT = 16, ncol = ev.length + 1;
  const colW = (W - GUT) / ncol, R = Math.min(colW / 2 - 3, 32);
  const cxOf = (k) => GUT + colW * (k + 0.5);
  const STRIP_H = 84, LABEL_H = 22, GRF_T = STRIP_H + LABEL_H + 6, GRF_H = 50;
  const DIAL_T = GRF_T + GRF_H + 34, ROW_H = 2 * R + 17;
  const H = DIAL_T + joints.length * ROW_H + 2;
  let g = "";

  // poses
  const flight = (i) => {
    const ty = rep.coords.pelvis_ty;
    if (!ty || grfS.v[i] + grfO.v[i] > 0.1) return 0;
    const base = Math.min(...Array.from(ty).filter(isNum));
    const lo = Array.from(ty).filter(isNum).sort((a, b) => a - b);
    const stand = lo[Math.floor(lo.length * 0.5)];
    return Math.max(0, Math.min(0.35, (ty[i] - Math.max(stand, base)) / (opts.heightM || 1.75)));
  };
  ev.forEach((e, k) => {
    g += skeletonSVG(poseAt(rep, e.i, kneeSign), plane, cxOf(k), STRIP_H, 78,
                     colors.r, colors.l, flight(e.i));
  });
  const evLabel = (e) => (e.key ? tr(e.key) : (pct ? `${t[e.i].toFixed(0)}%` : `${t[e.i].toFixed(2)} s`));
  ev.forEach((e, k) => {
    const words = evLabel(e).split(" ");
    const half = Math.ceil(words.length / 2);
    const lines = words.length > 1 && evLabel(e).length > 11
      ? [words.slice(0, half).join(" "), words.slice(half).join(" ")] : [evLabel(e)];
    lines.forEach((ln, r) => {
      g += `<text x="${f1(cxOf(k))}" y="${STRIP_H + 10 + r * 9.5}" font-size="8.5" text-anchor="middle" fill="var(--ink)">${ln}</text>`;
    });
  });

  // GRF strip, spanning the event columns only
  const gx0 = GUT + 14, gx1 = GUT + colW * ev.length - 4;
  const top = Math.max(0.5, ...grfS.v, ...grfO.v) * 1.15;
  const sx = (tt) => gx0 + ((tt - t[0]) / ((t[n - 1] - t[0]) || 1)) * (gx1 - gx0);
  const sy = (v) => GRF_T + GRF_H - (v / top) * GRF_H;
  for (const [s, series] of [[other, grfO.v], [side, grfS.v]]) {
    const pts = series.map((v, i) => `${f1(sx(t[i]))},${f1(sy(v))}`).join(" ");
    g += `<polygon points="${f1(sx(t[0]))},${f1(sy(0))} ${pts} ${f1(sx(t[n - 1]))},${f1(sy(0))}" fill="${colors[s]}" fill-opacity=".10"/>`
       + `<polyline points="${pts}" fill="none" stroke="${colors[s]}" stroke-width="1.6" stroke-linejoin="round"/>`;
  }
  g += `<line x1="${gx0}" y1="${sy(0)}" x2="${gx1}" y2="${sy(0)}" stroke="var(--muted)" stroke-width=".8"/>`
     + `<line x1="${gx0}" y1="${GRF_T}" x2="${gx0}" y2="${sy(0)}" stroke="var(--muted)" stroke-width=".8"/>`;
  const tickTop = niceCeiling(top / 1.15) <= top ? niceCeiling(top / 1.15) : Math.floor(top);
  for (const v of [0, tickTop]) {
    if (v > top) continue;
    g += `<text x="${gx0 - 3}" y="${f1(sy(v) + 3)}" font-size="7.5" text-anchor="end" fill="var(--muted)">${+v.toFixed(2)}</text>`;
  }
  g += `<text x="${GUT - 9}" y="${GRF_T + GRF_H / 2}" font-size="7.5" text-anchor="middle" fill="var(--muted)" transform="rotate(-90 ${GUT - 9} ${GRF_T + GRF_H / 2})">${tr("jlGrfAxis")}</text>`;
  g += `<text x="${gx1 + 5}" y="${f1(sy(0) + 2.5)}" font-size="7.5" fill="var(--muted)">${pct ? tr("jlCyclePct") : tr("jlTimeS")}</text>`;
  ev.forEach((e, k) => {
    const x = sx(t[e.i]);
    g += `<line x1="${f1(x)}" y1="${GRF_T - 2}" x2="${f1(x)}" y2="${f1(sy(0))}" stroke="var(--ink)" stroke-opacity=".7" stroke-width=".8" stroke-dasharray="3 2"/>`
       // leaders: instant -> its pose above, and -> its dial column below
       + `<line x1="${f1(x)}" y1="${GRF_T - 2}" x2="${f1(cxOf(k))}" y2="${STRIP_H + LABEL_H}" stroke="var(--muted)" stroke-opacity=".6" stroke-width=".6" stroke-dasharray="2 2"/>`
       + `<line x1="${f1(x)}" y1="${f1(sy(0) + 10)}" x2="${f1(cxOf(k))}" y2="${DIAL_T - R - 2 + R}" stroke="var(--muted)" stroke-opacity=".6" stroke-width=".6" stroke-dasharray="2 2"/>`
       + `<text x="${f1(x)}" y="${f1(sy(0) + 8.5)}" font-size="7" text-anchor="middle" fill="var(--ink)">${pct ? t[e.i].toFixed(0) + "%" : t[e.i].toFixed(2) + "s"}</text>`;
  });
  g += `<text x="${f1(cxOf(ev.length))}" y="${DIAL_T - 5}" font-size="8" text-anchor="middle" fill="var(--muted)">${tr("jlFullCycle")}</text>`;

  // dials
  const step = niceCeiling(rim / 3);
  joints.forEach((j, r) => {
    const cy = DIAL_T + R + r * ROW_H;
    g += `<text x="7" y="${cy}" font-size="9" text-anchor="middle" fill="${col}" transform="rotate(-90 7 ${cy})">${tr("jl_" + j)} ${tr(side === "l" ? "leftShort" : "rightShort")}</text>`;
    for (let k = 0; k < ncol; k++) {
      const cx = cxOf(k), whole = k === ev.length;
      const id = `jlc${r}_${k}`;
      g += `<clipPath id="${id}"><circle cx="${f1(cx)}" cy="${cy}" r="${R}"/></clipPath>`
         + `<g clip-path="url(#${id})">${bonesSVG(j, plane, cx, cy, R)}`;
      for (let s = step; s < rim - 1e-9; s += step) {
        g += `<circle cx="${f1(cx)}" cy="${cy}" r="${f1((s / rim) * R)}" fill="none" stroke="var(--muted)" stroke-opacity=".45" stroke-width=".5"/>`;
      }
      g += `<line x1="${f1(cx - R)}" y1="${cy}" x2="${f1(cx + R)}" y2="${cy}" stroke="var(--muted)" stroke-opacity=".45" stroke-width=".5"/>`
         + `<line x1="${f1(cx)}" y1="${cy - R}" x2="${f1(cx)}" y2="${cy + R}" stroke="var(--muted)" stroke-opacity=".45" stroke-width=".5"/>`;
      /* The reference is a MAGNITUDE, so it is a ring, not an arrow: the
       * corpus reports how big the contact force gets, not which way it
       * pointed in this plane. Drawing it as a vector would invent a
       * direction nobody measured. */
      if (refPeaks && isNum(refPeaks[j])) {
        g += `<circle cx="${f1(cx)}" cy="${cy}" r="${f1((refPeaks[j] / rim) * R)}"
               fill="none" stroke="${refColor}" stroke-width="1.1" stroke-dasharray="3 2.5"/>`;
      }
      const tip = (i) => {
        // length = |F| (3-D) on the shared rim; direction = its in-plane angle
        const p = vec[j][i], a = p[cols[0]], b = p[cols[1]], inPlane = Math.hypot(a, b) || 1;
        const m = (mag[j][i] / rim) * R;
        return [cx + (a / inPlane) * m, cy - (b / inPlane) * m];
      };
      let shown;
      if (whole) {
        const pts = [];
        for (let i = 0; i < n; i++) if (isNum(mag[j][i])) pts.push(tip(i));
        g += `<polyline points="${pts.map((p) => `${f1(p[0])},${f1(p[1])}`).join(" ")}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        if (pts.length) {
          const a = pts[0], z = pts[pts.length - 1];
          g += `<circle cx="${f1(a[0])}" cy="${f1(a[1])}" r="2.6" fill="${col}" stroke="var(--card)" stroke-width=".8"/>`
             + `<path d="M${f1(z[0] - 2.6)},${f1(z[1] - 2.6)} l5.2,5.2 m0,-5.2 l-5.2,5.2" stroke="var(--card)" stroke-width="3" stroke-linecap="round"/>`
             + `<path d="M${f1(z[0] - 2.6)},${f1(z[1] - 2.6)} l5.2,5.2 m0,-5.2 l-5.2,5.2" stroke="${col}" stroke-width="1.6" stroke-linecap="round"/>`;
        }
        shown = Math.max(...mag[j].filter(isNum));
      } else {
        const p = tip(ev[k].i);
        g += arrowSVG(cx, cy, p[0], p[1], col);
        shown = mag[j][ev[k].i];
      }
      g += `</g><circle cx="${f1(cx)}" cy="${cy}" r="${R}" fill="none" stroke="var(--muted)" stroke-width=".9"/>`
         + `<text x="${f1(cx)}" y="${cy + R + 10}" font-size="8.5" text-anchor="middle" fill="${col}">${f1(shown)}</text>`;
      if (r === 0 && k === 0) {
        const d = PLANES[plane].dirs, o = R * 0.80;
        const lab = (x, y, key) => `<text x="${f1(x)}" y="${f1(y)}" font-size="6.5" text-anchor="middle" fill="var(--ink)" stroke="var(--card)" stroke-width="2" paint-order="stroke">${tr(key)}</text>`;
        g += lab(cx, cy - o + 2, d[0]) + lab(cx + o - 3, cy + 2.3, d[1]) + lab(cx, cy + o + 2, d[2]) + lab(cx - o + 3, cy + 2.3, d[3]);
        for (let s = step, q = 0; s < rim - 1e-9 && q < 2; s += step, q++) {
          const rr = (s / rim) * R * 0.7071;
          g += `<text x="${f1(cx + rr + 1)}" y="${f1(cy + rr + 6)}" font-size="6" fill="var(--ink)" stroke="var(--card)" stroke-width="1.8" paint-order="stroke">${+s.toFixed(2)}</text>`;
        }
      }
    }
  });

  return {
    svg: `<svg class="jlsvg" viewBox="0 0 ${W} ${f1(H)}" role="img" aria-label="${tr("jlTitle")}" style="width:100%;height:auto;display:block">${g}</svg>`,
    events: ev.map((e) => ({ label: evLabel(e), t: t[e.i] })),
    rim, grfSource: grfS.source, side, plane,
    refShown: !!(refPeaks && JOINTS.some((j) => isNum(refPeaks[j]))),
    peaks: Object.fromEntries(joints.map((j) => [j, Math.max(...mag[j].filter(isNum))])),
  };
}

/** Every i18n key this module can ask for -- tests/test_jointload.mjs checks them. */
export const JL_KEYS = ["jlTitle", "jlSup", "jlInf", "jlAnt", "jlPos", "jlLat", "jlMed",
  "jl_hip", "jl_knee", "jl_ankle", "jlGrfAxis", "jlCyclePct", "jlTimeS", "jlFullCycle",
  "jlEvMidSwing", "jlEvImpact", "jlEvPeakLoad", "jlEvPushOff", "jlEvBottom", "jlEvPeakPush",
  "jlEvApex", "jlEvLanding", "jlEvStart", "jlEvPeakDescent", "jlEvPeakLoadUp", "jlEvPeakAscent",
  "jlViewSagittal", "jlViewFrontal", "jlNote", "jlNoteFrontal", "jlNoteGrfNewton",
  "jlNoteGrfModel", "jlPeaks", "leftShort", "rightShort"];
