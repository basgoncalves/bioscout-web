/**
 * bodymap.js -- pick a strength exercise by body part.
 *
 * A front and a back figure; tap a muscle group and the exercises the app can
 * analyse for it come up underneath, tap one and it becomes the Movement. The
 * groups this session has already trained are tinted, so the figure doubles
 * as "what have I done today".
 *
 * Only movements BioScout can actually measure are offered. A group with none
 * (the core, for now) says so rather than pointing at something the recorder
 * would then refuse. The figure is drawn here from plain shapes -- no image
 * files, so it follows the page's light and dark colours.
 */

/** Muscle group -> the movements that train it, main ones first. */
export const REGION_EXERCISES = {
  neck: ["neck"],
  shoulders: ["dip", "pullup"],
  chest: ["dip"],
  back: ["pullup"],
  biceps: ["pullup"],
  triceps: ["dip"],
  core: [],
  glutes: ["kickback", "squat", "slsquat"],
  quads: ["squat", "slsquat", "cmj", "sj"],
  hamstrings: ["kickback"],
  calves: ["heelraise", "cmj", "sj"],
};
export const REGIONS = Object.keys(REGION_EXERCISES);

/** The groups a movement trains (inverse of REGION_EXERCISES). */
export function regionsFor(activity) {
  return REGIONS.filter((r) => REGION_EXERCISES[r].includes(activity));
}

/* Shapes, in a 260 x 262 box: front figure centred on x = 60, back on
 * x = 200. Each entry is [region or null (not selectable), svg element]. */
const E = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`;
const R = (x, y, w, h, r = 5) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
const P = (d) => `<path d="${d}"/>`;

function figure(cx, back) {
  const L = (dx) => cx - dx, Rt = (dx) => cx + dx;
  const parts = [
    // Torso underlay, so the groups read as one body rather than loose pieces.
    [null, P(`M${L(26)},44 Q${cx},34 ${Rt(26)},44 L${Rt(21)},90 L${Rt(18)},126 L${L(18)},126 L${L(21)},90 Z`)],
    [null, `<circle cx="${cx}" cy="20" r="13"/>`],                        // head
    ["neck", R(cx - 6, 32, 12, 10, 3)],
    ["shoulders", E(L(24), 51, 10, 9) + E(Rt(24), 51, 10, 9)],
    [back ? "triceps" : "biceps", E(L(30), 78, 7, 16) + E(Rt(30), 78, 7, 16)],
    [null, E(L(34), 111, 6, 16) + E(Rt(34), 111, 6, 16)],                // forearms
    [null, E(L(36), 132, 5, 6) + E(Rt(36), 132, 5, 6)],                  // hands
  ];
  if (!back) {
    parts.push(
      ["chest", P(`M${L(20)},45 Q${L(20)},44 ${cx - 1},45 L${cx - 1},66 Q${L(10)},72 ${L(20)},66 Z`)
              + P(`M${Rt(20)},45 Q${Rt(20)},44 ${cx + 1},45 L${cx + 1},66 Q${Rt(10)},72 ${Rt(20)},66 Z`)],
      ["core", R(cx - 13, 71, 26, 42, 7)],
      [null, P(`M${L(16)},113 L${Rt(16)},113 L${Rt(18)},128 L${L(18)},128 Z`)],   // hips
      ["quads", E(L(11), 160, 10, 30) + E(Rt(11), 160, 10, 30)],
      [null, E(L(11), 193, 6, 5) + E(Rt(11), 193, 6, 5)],                // knees
      [null, E(L(12), 220, 6, 22) + E(Rt(12), 220, 6, 22)],              // shins
    );
  } else {
    parts.push(
      ["back", P(`M${L(14)},40 L${Rt(14)},40 L${cx},66 Z`)                // traps
             + P(`M${L(19)},58 Q${L(18)},90 ${cx - 2},104 L${cx - 2},66 Z`)   // lats
             + P(`M${Rt(19)},58 Q${Rt(18)},90 ${cx + 2},104 L${cx + 2},66 Z`)],
      ["core", R(cx - 11, 100, 22, 16, 5)],                                 // lower back
      ["glutes", E(L(10), 128, 11, 12) + E(Rt(10), 128, 11, 12)],
      ["hamstrings", E(L(12), 166, 10, 25) + E(Rt(12), 166, 10, 25)],
      [null, E(L(11), 195, 6, 5) + E(Rt(11), 195, 6, 5)],                // knees
      ["calves", E(L(12), 218, 8, 20) + E(Rt(12), 218, 8, 20)],
    );
  }
  parts.push([null, E(L(12), 246, 7, 4) + E(Rt(12), 246, 7, 4)]);       // feet
  return parts;
}

/**
 * The figure plus the chosen group's exercises.
 *   tr        the page's translate function
 *   selected  the tapped group, or null
 *   trained   groups this session has already done (tinted)
 *   current   the Movement currently selected, shown as chosen
 */
export function bodyMapHTML(tr, { selected = null, trained = [], current = null } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const done = new Set(trained);
  const draw = (cx, back) => figure(cx, back).map(([reg, shape]) => reg
    ? `<g class="bm-part${reg === selected ? " sel" : done.has(reg) ? " done" : ""}" data-region="${reg}"
         role="button" tabindex="0" aria-label="${esc(tr("bm_" + reg))}"><title>${esc(tr("bm_" + reg))}</title>${shape}</g>`
    : `<g class="bm-base">${shape}</g>`).join("");
  const ex = selected ? REGION_EXERCISES[selected] : null;
  const list = !selected
    ? `<p class="sub" style="margin:6px 0 0">${esc(tr("bmHint"))}</p>`
    : `<div style="margin-top:6px"><b>${esc(tr("bm_" + selected))}</b>${ex.length
        ? `<div style="margin-top:4px">${ex.map((a) => `<button type="button"
            class="ghost bmEx${a === current ? " on" : ""}" data-activity="${a}">${esc(tr(a))}</button>`).join("")}</div>`
        : `<p class="sub" style="margin:4px 0 0">${esc(tr("bmNone"))}</p>`}</div>`;
  return `<svg class="bodymap" viewBox="0 0 260 262" role="group" aria-label="${esc(tr("bmTitle"))}">
      ${draw(60, false)}${draw(200, true)}
      <text x="60" y="260" text-anchor="middle">${esc(tr("bmFront"))}</text>
      <text x="200" y="260" text-anchor="middle">${esc(tr("bmBack"))}</text>
    </svg>${list}`;
}
