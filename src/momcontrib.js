/**
 * momcontrib.js -- muscle contributions to a joint MOMENT, stacked.
 *
 * The contact-force version of this figure (jcfcontrib.js) answers "who is
 * loading the joint". This answers "who is turning it", which is a different
 * question with a different sign: a muscle can only compress a joint, but it
 * turns the joint one way or the other, so these curves go both ways and the
 * stack has to grow in both directions from zero.
 *
 * Contribution = predicted muscle force x the model's moment arm at that
 * joint angle (data/moment_arms.json, tabulated offline from the .osim by
 * tools/moment_arms.py). The arm is a property of the model, not of the
 * movement, so one table serves every clip.
 *
 * THREE DOF PER HIP, not one. The hip is a ball joint and the surrogate
 * predicts all three of its moments; a sagittal-only figure could explain one
 * of them and silently ignored the adductors doing most of their work in the
 * frontal plane. A single camera does not measure the frontal and transverse
 * hip ANGLES, so the arm for those is read at neutral -- `angleKnown` says so
 * and the caller must print it.
 *
 * Sign is the model coordinate's own: positive is flexion, adduction and
 * internal rotation. Not the extension-positive convention the sagittal plots
 * use, because "extension positive" means nothing for rotation.
 */
import { CONTRIB_GROUPS } from "./jcfcontrib.js";

/** The degrees of freedom this figure can decompose, in menu order. */
export const MOM_DOFS = [
  { key: "hip", coord: "hip_flexion", label: "dofHipFlexion" },
  { key: "hip_adduction", coord: "hip_adduction", label: "dofHipAdduction" },
  { key: "hip_rotation", coord: "hip_rotation", label: "dofHipRotation" },
  { key: "knee", coord: "knee_angle", label: "dofKnee" },
  { key: "ankle", coord: "ankle_angle", label: "dofAnkle" },
];

const RESIDUAL = { key: "res", label: "momResidual", color: "#b9a37c" };

/** Linear lookup of one muscle's arm at each frame's angle, clamped at the ends. */
export function armAt(tab, muscle, angles) {
  const arm = tab && tab.muscles && tab.muscles[muscle];
  if (!arm || !tab.grid || arm.length !== tab.grid.length) return null;
  const g = tab.grid, last = g.length - 1;
  return angles.map((a) => {
    if (!Number.isFinite(a) || a <= g[0]) return arm[0];
    if (a >= g[last]) return arm[last];
    let i = 0;
    while (i < last - 1 && g[i + 1] < a) i++;
    const f = (a - g[i]) / (g[i + 1] - g[i] || 1);
    return arm[i] + (arm[i + 1] - arm[i]) * f;
  });
}

/**
 * One DOF decomposed.
 * `rep`: needs forces, forceNames, times; coords and osimOut when available.
 * -> { groups:[{key,label,color,y}], net, residual, angleKnown, nMuscles } or null.
 */
export function momentContributions(rep, { dof, side, arms, muscleJoints, net = null } = {}) {
  if (!rep || !rep.forces || !rep.forceNames || !dof || !arms) return null;
  const tab = arms.joints && arms.joints[dof.key];
  if (!tab) return null;
  const n = rep.forces.length;
  if (!n) return null;

  // The angle this arm is read at. Only the sagittal ones are measured from a
  // single camera; the others sit at the model's neutral pose.
  const measured = rep.coords && rep.coords[`${dof.coord}_${side}`];
  const angleKnown = Array.isArray(measured) && measured.length === n;
  const angles = angleKnown ? measured : new Array(n).fill(0);

  const mj = (muscleJoints && muscleJoints.muscleJoints) || {};
  const joint = dof.key.split("_")[0];           // hip_adduction -> hip
  const sums = new Map(), used = new Set();
  for (const g of CONTRIB_GROUPS) sums.set(g.key, new Array(n).fill(0));

  rep.forceNames.forEach((nm, mi) => {
    if (!new RegExp(`_${side}$`).test(nm)) return;
    if (mj[nm] && !mj[nm].includes(joint)) return;
    const arm = armAt(tab, nm, angles);
    if (!arm) return;                            // does not cross this joint
    const base = nm.replace(/_[lr]$/, "");
    const g = CONTRIB_GROUPS.find((x) => x.test(base));
    const acc = sums.get(g.key);
    for (let t = 0; t < n; t++) {
      const f = rep.forces[t][mi];
      acc[t] += (Number.isFinite(f) ? Math.max(0, f) : 0) * arm[t];
    }
    used.add(nm);
  });
  if (!used.size) return null;

  const groups = CONTRIB_GROUPS
    .map((g) => ({ key: g.key, label: g.label, color: g.color, y: sums.get(g.key) }))
    .filter((g) => g.y.some((v) => Math.abs(v) > 1e-6));

  const netArr = Array.isArray(net) && net.length === n ? net : null;
  const residual = netArr
    ? netArr.map((v, t) => v - groups.reduce((a, g) => a + g.y[t], 0))
    : null;
  // What this figure needs on its y axis, so two sides can share one.
  let hi = 0, lo = 0;
  const bands = residual ? [...groups.map((g) => g.y), residual] : groups.map((g) => g.y);
  for (let k = 0; k < n; k++) {
    let up = 0, dn = 0;
    for (const y of bands) { const v = y[k]; if (v > 0) up += v; else dn += v; }
    hi = Math.max(hi, up, netArr ? netArr[k] : -Infinity);
    lo = Math.min(lo, dn, netArr ? netArr[k] : Infinity);
  }
  return { groups, net: netArr, residual, angleKnown, nMuscles: used.size,
           residualMeta: RESIDUAL, range: [lo, hi] };
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "0");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * The stacked figure. Positive contributions stack up from zero, negative
 * ones stack down, so each band's THICKNESS is that group's share and the
 * outline is what the muscles add up to. The net moment rides on top as a
 * line: where it leaves the stack, something other than muscle -- gravity,
 * inertia, the ground reaction -- is making up the difference.
 */
export function momContribSVG(c, { t = (k) => k, marks = [], range = null, title = null, unit = "N·m" } = {}) {
  if (!c || !c.groups.length) return "";
  const W = 720, PH = 260, L = 52, R = 14, TOP = 14, BOT = 30;
  const n = c.groups[0].y.length;
  const bands = c.residual
    ? [...c.groups, { key: "res", label: c.residualMeta.label, color: c.residualMeta.color, y: c.residual }]
    : c.groups;

  let hi = 0, lo = 0;
  for (let i = 0; i < n; i++) {
    let up = 0, dn = 0;
    for (const b of bands) { const v = b.y[i]; if (v > 0) up += v; else dn += v; }
    hi = Math.max(hi, up); lo = Math.min(lo, dn);
    if (c.net) { hi = Math.max(hi, c.net[i]); lo = Math.min(lo, c.net[i]); }
  }
  if (hi === lo) { hi = 1; lo = -1; }
  const pad = 0.05 * (hi - lo);
  hi += pad; lo -= pad;
  // Two sides drawn one above the other must share an axis, or the smaller
  // one looks as big as the bigger one.
  if (range) { lo = range[0]; hi = range[1]; }
  const X = (i) => L + (W - L - R) * (n > 1 ? i / (n - 1) : 0.5);
  const Y = (v) => TOP + (PH - TOP - BOT) * (hi - v) / (hi - lo);

  // Stack each sign away from zero so a band's thickness is its own share.
  const up = new Array(n).fill(0), dn = new Array(n).fill(0);
  let areas = "";
  for (const b of bands) {
    const top = [], base = [];
    for (let i = 0; i < n; i++) {
      const v = b.y[i], pos = v > 0;
      const from = pos ? up[i] : dn[i], to = from + v;
      base.push([X(i), Y(from)]); top.push([X(i), Y(to)]);
      if (pos) up[i] = to; else dn[i] = to;
    }
    const pts = [...top, ...base.reverse()].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    areas += `<polygon points="${pts}" fill="${b.color}" fill-opacity=".85"/>`;
  }
  const netLine = c.net
    ? `<polyline fill="none" stroke="currentColor" stroke-width="2" points="${
        c.net.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/>`
    : "";
  const markLines = marks.filter((m) => Number.isFinite(m.frac)).map((m) => {
    const x = X(Math.round(m.frac * (n - 1)));
    return `<line x1="${x.toFixed(1)}" y1="${TOP}" x2="${x.toFixed(1)}" y2="${PH - BOT}"
             stroke="currentColor" stroke-dasharray="3 3" opacity=".5"/>`;
  }).join("");

  const key = bands.map((b) => `<span class="lgd"><i class="swatch" style="background:${
    b.color}"></i>${esc(t(b.label))}</span>`).join("");
  return `${title ? `<p class="sub" style="margin:4px 0 0">${esc(title)}</p>` : ""}
  <svg viewBox="0 0 ${W} ${PH}" class="plot" role="img">
    <line x1="${L}" y1="${Y(0).toFixed(1)}" x2="${W - R}" y2="${Y(0).toFixed(1)}"
          stroke="currentColor" opacity=".35"/>
    ${areas}${markLines}${netLine}
    <text x="4" y="${TOP + 10}" font-size="11" fill="currentColor" opacity=".7">${f1(hi)}</text>
    <text x="4" y="${(PH - BOT).toFixed(0)}" font-size="11" fill="currentColor" opacity=".7">${f1(lo)}</text>
    <text x="${L}" y="${PH - 8}" font-size="11" fill="currentColor" opacity=".7">${esc(unit)}</text>
  </svg>
  <div class="lgds">${key}${c.net ? `<span class="lgd"><i class="swatch"
      style="background:currentColor"></i>${esc(t("momNetLabel"))}</span>` : ""}</div>`;
}
