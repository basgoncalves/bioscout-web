/**
 * Muscle contributions to the joint contact force, stacked per muscle group:
 * the browser's version of bioscout's contributions_so.png (hip, knee, ankle
 * x right, left).
 *
 * What the Python JRA does exactly -- each muscle's force projected on the
 * contact force through its path geometry -- needs the muscle paths, which
 * the surrogate does not carry. Here each muscle crossing the joint counts
 * with its whole force (muscles that cross a joint mostly compress it), and
 * "Intersegmental + other" is what is left of |JCF| after them: positive when
 * gravity, inertia and the ground reaction add to it, negative when the
 * muscle sum overstates it. An approximation, said so under the figure.
 */
export const CONTRIB_GROUPS = [
  { key: "add",   label: "Adductors",        color: "#2bb3c0", test: (m) => /^add/.test(m) },
  { key: "glmax", label: "Gluteus maximus",  color: "#a678c8", test: (m) => /^glmax/.test(m) },
  { key: "glmed", label: "Gluteus med+min",  color: "#5b8fbf", test: (m) => /^glm(ed|in)/.test(m) },
  { key: "ham",   label: "Hamstrings",       color: "#6b2f7a", test: (m) => /^(bflh|bfsh|semimem|semiten)/.test(m) },
  { key: "ilio",  label: "Iliopsoas",        color: "#e0733a", test: (m) => /^(iliacus|psoas)/.test(m) },
  { key: "rf",    label: "Rectus femoris",   color: "#2f6b47", test: (m) => /^recfem/.test(m) },
  { key: "vas",   label: "Vasti",            color: "#6cc26c", test: (m) => /^vas/.test(m) },
  { key: "ts",    label: "Triceps surae",    color: "#a61e24", test: (m) => /^(gas|soleus)/.test(m) },
  { key: "oth",   label: "Other muscles",    color: "#c9c9c9", test: () => true },
];
const INTERSEG = { key: "seg", label: "Intersegmental + other", color: "#b9a37c" };
const JOINTS = ["hip", "knee", "ankle"];

/** -> { [side]: { [joint]: { total:[], groups:{key:[]}, seg:[] } } } in BW, or null. */
export function jcfContributions(rep, muscleJoints, bwN) {
  if (!rep || !rep.jrf || !rep.jrfNames || !rep.forces || !rep.forceNames || !muscleJoints || !(bwN > 0)) return null;
  const mj = muscleJoints.muscleJoints || {};
  const n = rep.jrf.length, out = {};
  for (const side of ["r", "l"]) {
    out[side] = {};
    for (const j of JOINTS) {
      const ji = rep.jrfNames.indexOf(`${j}_${side}_mag`);
      if (ji < 0) continue;
      const total = rep.jrf.map((r) => r[ji]);
      const groups = {};
      for (const g of CONTRIB_GROUPS) groups[g.key] = new Array(n).fill(0);
      rep.forceNames.forEach((nm, mi) => {
        if (!new RegExp(`_${side}$`).test(nm) || !(mj[nm] || []).includes(j)) return;
        const base = nm.replace(/_[lr]$/, "");
        const g = CONTRIB_GROUPS.find((x) => x.test(base));
        for (let t = 0; t < n; t++) groups[g.key][t] += Math.max(0, rep.forces[t][mi]) / bwN;
      });
      const seg = total.map((v, t) => v - CONTRIB_GROUPS.reduce((a, g) => a + groups[g.key][t], 0));
      out[side][j] = { total, groups, seg };
    }
  }
  return out;
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "0");

/** The 2 x 3 grid as one SVG. t(key) translates; marks: [{frac, label}] for event lines. */
export function jcfContribSVG(c, { t = (k) => k, marks = [] } = {}) {
  if (!c) return "";
  const W = 720, PW = 220, PH = 120, GX = 20, L = 40, TOP = 22, GY = 34;
  let ymax = 0.5;
  for (const s of ["r", "l"]) for (const j of JOINTS) {
    const d = c[s] && c[s][j]; if (!d) continue;
    for (let i = 0; i < d.total.length; i++) {
      const pos = CONTRIB_GROUPS.reduce((a, g) => a + d.groups[g.key][i], 0) + Math.max(0, d.seg[i]);
      ymax = Math.max(ymax, d.total[i], pos);
    }
  }
  ymax = Math.ceil(ymax);
  const ymin = -Math.max(0.5, Math.ceil(Math.max(0, ...["r", "l"].flatMap((s) => JOINTS.flatMap((j) => (c[s] && c[s][j] ? c[s][j].seg.map((v) => -v) : [0])))) * 2) / 2);
  const H = TOP + 2 * (PH + GY) + 46;
  let g = "";
  ["r", "l"].forEach((side, row) => {
    JOINTS.forEach((j, col) => {
      const d = c[side] && c[side][j];
      const x0 = L + col * (PW + GX), y0 = TOP + row * (PH + GY);
      const X = (i, n) => x0 + (n > 1 ? (i / (n - 1)) * PW : 0);
      const Y = (v) => y0 + PH - ((v - ymin) / (ymax - ymin)) * PH;
      if (row === 0) g += `<text x="${x0 + PW / 2}" y="12" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">${t("jcj_" + j)}</text>`;
      if (col === 0) g += `<text x="10" y="${y0 + PH / 2}" font-size="10" font-weight="600" fill="var(--ink)" transform="rotate(-90 10 ${y0 + PH / 2})" text-anchor="middle">${t(side === "r" ? "rightLeg" : "leftLeg")}</text>`;
      g += `<line x1="${x0}" y1="${f1(Y(0))}" x2="${x0 + PW}" y2="${f1(Y(0))}" stroke="var(--muted)" stroke-width=".6"/>`;
      g += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + PH}" stroke="var(--muted)" stroke-width=".6"/>`;
      for (const v of [ymin, 0, ymax]) g += `<text x="${x0 - 3}" y="${f1(Y(v) + 3)}" font-size="8" text-anchor="end" fill="var(--muted)">${v}</text>`;
      if (!d) return;
      const n = d.total.length;
      // stack: intersegmental (its positive part) first, then the muscle groups
      const layers = [{ ...INTERSEG, v: d.seg.map((v) => Math.max(0, v)) }, ...CONTRIB_GROUPS.map((gr) => ({ ...gr, v: d.groups[gr.key] }))];
      let base = new Array(n).fill(0);
      for (const ly of layers) {
        const top = base.map((b, i) => b + ly.v[i]);
        if (top.some((v, i) => v - base[i] > 1e-4)) {
          const pts = top.map((v, i) => `${f1(X(i, n))},${f1(Y(v))}`).concat(base.map((v, i) => `${f1(X(i, n))},${f1(Y(v))}`).reverse());
          g += `<polygon points="${pts.join(" ")}" fill="${ly.color}" fill-opacity=".9"/>`;
        }
        base = top;
      }
      // the negative part of the remainder, below zero
      if (d.seg.some((v) => v < -1e-3)) {
        const pts = d.seg.map((v, i) => `${f1(X(i, n))},${f1(Y(Math.min(0, v)))}`).concat(d.seg.map((_, i) => `${f1(X(i, n))},${f1(Y(0))}`).reverse());
        g += `<polygon points="${pts.join(" ")}" fill="${INTERSEG.color}" fill-opacity=".9"/>`;
      }
      g += `<polyline points="${d.total.map((v, i) => `${f1(X(i, n))},${f1(Y(v))}`).join(" ")}" fill="none" stroke="var(--ink)" stroke-width="1.4"/>`;
      for (const m of marks) {
        const x = x0 + m.frac * PW;
        g += `<line x1="${f1(x)}" y1="${y0}" x2="${f1(x)}" y2="${y0 + PH}" stroke="var(--muted)" stroke-dasharray="3 2" stroke-width=".7"/>`;
        if (row === 0) g += `<text x="${f1(x)}" y="${y0 - 2}" font-size="7.5" text-anchor="middle" fill="var(--muted)">${m.label}</text>`;
      }
      if (row === 1) g += `<text x="${x0 + PW / 2}" y="${y0 + PH + 12}" font-size="8.5" text-anchor="middle" fill="var(--muted)">${t("pctRep")}</text>`;
    });
  });
  // legend
  const items = [INTERSEG, ...CONTRIB_GROUPS];
  let lx = L, ly = H - 26;
  items.forEach((it, k) => {
    const x = lx + (k % 6) * 112, y = ly + Math.floor(k / 6) * 13;
    g += `<rect x="${x}" y="${y - 8}" width="10" height="8" fill="${it.color}"/><text x="${x + 14}" y="${y}" font-size="8.5" fill="var(--ink)">${t("jcg_" + it.key)}</text>`;
  });
  g += `<line x1="${lx + 4 * 112}" y1="${ly + 9}" x2="${lx + 4 * 112 + 10}" y2="${ly + 9}" stroke="var(--ink)" stroke-width="1.4"/><text x="${lx + 4 * 112 + 14}" y="${ly + 13}" font-size="8.5" fill="var(--ink)">|JCF|</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${t("jcfContribTitle")}" style="max-width:${W}px">${g}</svg>`;
}
