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

/* Proportions. The female figure is not the male one with a different head:
 * narrower shoulders and arms, a waist, wider hips and thighs, a bust in place
 * of flat pecs, and hair -- the same shapes and the same tap targets, so the
 * two figures pick exactly the same groups. */
const BUILD = {
  male:   { sh: 26, shW: 21, waist: 21, hip: 18, delt: 24, deltR: 10, arm: 30, armR: 7,
            fore: 34, foreR: 6, hand: 36, core: 13, pelvis: 16, thigh: 11, thighR: 10,
            knee: 11, shin: 12, shinR: 6, lat: 19, glute: 10, gluteR: 11, calfR: 8 },
  female: { sh: 23, shW: 19, waist: 16, hip: 21, delt: 20, deltR: 8.5, arm: 26, armR: 6,
            fore: 30, foreR: 5, hand: 32, core: 11, pelvis: 20, thigh: 12, thighR: 10.5,
            knee: 10, shin: 11, shinR: 5.5, lat: 16, glute: 11, gluteR: 12.5, calfR: 7.5 },
};

function figure(cx, back, female = false) {
  const b = female ? BUILD.female : BUILD.male;
  const L = (dx) => cx - dx, Rt = (dx) => cx + dx;
  const parts = [];
  // Hair, front view: shoulder length, behind the head (a fringe goes on top
  // of the head below). The back view covers the head entirely, further down.
  if (female && !back) {
    parts.push(["hair", P(`M${L(13)},20 Q${L(14)},4 ${cx},5 Q${Rt(14)},4 ${Rt(13)},20 L${Rt(15)},41 Q${Rt(10)},43 ${Rt(7)},36 L${L(7)},36 Q${L(10)},43 ${L(15)},41 Z`)]);
  }
  parts.push(
    // Torso underlay, so the groups read as one body rather than loose pieces.
    [null, P(`M${L(b.sh)},44 Q${cx},34 ${Rt(b.sh)},44 Q${Rt(b.shW)},60 ${Rt(b.waist)},90 L${Rt(b.hip)},126 L${L(b.hip)},126 L${L(b.waist)},90 Q${L(b.shW)},60 ${L(b.sh)},44 Z`)],
    [null, `<circle cx="${cx}" cy="20" r="${female ? 12 : 13}"/>`],      // head
  );
  if (female) parts.push(["hair", back
    ? P(`M${L(12.5)},20 Q${L(13.5)},6 ${cx},6 Q${Rt(13.5)},6 ${Rt(12.5)},20 L${Rt(14)},40 Q${cx},43 ${L(14)},40 Z`)
    : P(`M${L(12)},21 Q${L(12.5)},6.5 ${cx},7 Q${Rt(12.5)},6.5 ${Rt(12)},21 Q${Rt(8)},12.5 ${cx},14 Q${L(8)},12.5 ${L(12)},21 Z`)]);
  parts.push(
    ["neck", R(cx - (female ? 5 : 6), 32, female ? 10 : 12, 10, 3)],
    ["shoulders", E(L(b.delt), 51, b.deltR, b.deltR - 1) + E(Rt(b.delt), 51, b.deltR, b.deltR - 1)],
    [back ? "triceps" : "biceps", E(L(b.arm), 78, b.armR, 16) + E(Rt(b.arm), 78, b.armR, 16)],
    [null, E(L(b.fore), 111, b.foreR, 16) + E(Rt(b.fore), 111, b.foreR, 16)],   // forearms
    [null, E(L(b.hand), 132, 5, 6) + E(Rt(b.hand), 132, 5, 6)],                 // hands
  );
  if (!back) {
    parts.push(
      ["chest", female
        ? E(L(8.5), 61, 8, 7.5) + E(Rt(8.5), 61, 8, 7.5)
        : P(`M${L(20)},45 Q${L(20)},44 ${cx - 1},45 L${cx - 1},66 Q${L(10)},72 ${L(20)},66 Z`)
          + P(`M${Rt(20)},45 Q${Rt(20)},44 ${cx + 1},45 L${cx + 1},66 Q${Rt(10)},72 ${Rt(20)},66 Z`)],
      ["core", female
        ? P(`M${L(11)},71 L${Rt(11)},71 Q${Rt(8)},92 ${Rt(12)},113 L${L(12)},113 Q${L(8)},92 ${L(11)},71 Z`)
        : R(cx - b.core, 71, 2 * b.core, 42, 7)],
      [null, P(`M${L(b.pelvis)},113 L${Rt(b.pelvis)},113 L${Rt(b.pelvis + 2)},128 L${L(b.pelvis + 2)},128 Z`)],   // hips
      ["quads", E(L(b.thigh), 160, b.thighR, 30) + E(Rt(b.thigh), 160, b.thighR, 30)],
      [null, E(L(b.knee), 193, 6, 5) + E(Rt(b.knee), 193, 6, 5)],               // knees
      [null, E(L(b.shin), 220, b.shinR, 22) + E(Rt(b.shin), 220, b.shinR, 22)], // shins
    );
  } else {
    parts.push(
      ["back", P(`M${L(14)},40 L${Rt(14)},40 L${cx},66 Z`)                // traps
             + P(`M${L(b.lat)},58 Q${L(b.lat - 1)},90 ${cx - 2},104 L${cx - 2},66 Z`)   // lats
             + P(`M${Rt(b.lat)},58 Q${Rt(b.lat - 1)},90 ${cx + 2},104 L${cx + 2},66 Z`)],
      ["core", R(cx - (female ? 10 : 11), 100, female ? 20 : 22, 16, 5)],     // lower back
      ["glutes", E(L(b.glute), 128, b.gluteR, 12) + E(Rt(b.glute), 128, b.gluteR, 12)],
      ["hamstrings", E(L(b.thigh + 1), 166, b.thighR, 25) + E(Rt(b.thigh + 1), 166, b.thighR, 25)],
      [null, E(L(b.knee), 195, 6, 5) + E(Rt(b.knee), 195, 6, 5)],               // knees
      ["calves", E(L(b.shin), 218, b.calfR, 20) + E(Rt(b.shin), 218, b.calfR, 20)],
    );
  }
  parts.push([null, E(L(12), 246, female ? 6 : 7, 4) + E(Rt(12), 246, female ? 6 : 7, 4)]);   // feet
  return parts;
}

/**
 * The figure plus the chosen group's exercises.
 *   tr        the page's translate function
 *   selected  the tapped group, or null
 *   trained   groups this session has already done (tinted)
 *   current   the Movement currently selected, shown as chosen
 *   female    draw the female figure (the athlete's profile says sex F)
 */
export function bodyMapHTML(tr, { selected = null, trained = [], current = null,
                                  female = false } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const done = new Set(trained);
  const draw = (cx, back) => figure(cx, back, female).map(([reg, shape]) =>
    reg === "hair" ? `<g class="bm-hair">${shape}</g>`
    : reg
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
  return `<svg class="bodymap${female ? " female" : ""}" viewBox="0 0 260 262" role="group" aria-label="${esc(tr("bmTitle"))}">
      ${draw(60, false)}${draw(200, true)}
      <text x="60" y="260" text-anchor="middle">${esc(tr("bmFront"))}</text>
      <text x="200" y="260" text-anchor="middle">${esc(tr("bmBack"))}</text>
    </svg>${list}`;
}
