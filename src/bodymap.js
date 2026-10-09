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
 * would then refuse. The figure is drawn here from angular plates -- no image
 * files, so it follows the page's light and dark colours.
 */

/** Muscle group -> the movements that train it, main ones first. */
export const REGION_EXERCISES = {
  neck: ["neck"],
  shoulders: ["ohpress", "raise", "pushup", "dip", "pullup", "plank"],
  chest: ["pushup", "dip"],
  back: ["pullup", "row", "deadlift"],
  biceps: ["curl", "pullup", "row"],
  triceps: ["pushup", "dip", "ohpress"],
  core: ["plank", "sideplank", "deadlift", "bridge"],
  glutes: ["bridge", "kickback", "squat", "lunge", "deadlift", "slsquat"],
  quads: ["squat", "lunge", "wallsit", "slsquat", "cmj", "sj"],
  hamstrings: ["deadlift", "bridge", "kickback"],
  calves: ["heelraise", "cmj", "sj"],
};
export const REGIONS = Object.keys(REGION_EXERCISES);

/** The groups a movement trains (inverse of REGION_EXERCISES). */
export function regionsFor(activity) {
  return REGIONS.filter((r) => REGION_EXERCISES[r].includes(activity));
}

/* Shapes, in a 260 x 262 box: front figure centred on x = 60, back on
 * x = 200. Each entry is [region or null (not selectable), svg element]. */

/* Armor-plate style (chosen 2026-10-09, draft C in assets/charachters/):
 * every group is a low-poly plate -- hex shoulder plates, chevron abs, diamond
 * knees, an octagon head -- with a thin seam between plates (CSS stroke).
 *
 * Shapes are written for the left side as [dx, y] with dx measured from the
 * centre line, then mirrored. The female figure is not the male one with a
 * different head: narrower shoulders and arms (`up` scales the upper body's
 * dx), wider hips and thighs (`lo`), a bust in place of flat pecs, and hair --
 * the same tap targets, so the two figures pick exactly the same groups. */
const BUILD = {
  male:   { up: 1.0,  lo: 1.0 },
  female: { up: 0.88, lo: 1.1 },
};

function figure(cx, back, female = false) {
  const b = female ? BUILD.female : BUILD.male;
  const pts = (list, k) => list.map(([dx, y]) => `${(cx + dx * k).toFixed(1)},${y}`).join(" ");
  const poly = (list, k = 1) => `<polygon points="${pts(list, k)}"/>`;
  // mirrored pair; list is the LEFT side, dx positive = away from centre
  const M = (list, k = 1) => poly(list.map(([dx, y]) => [-dx, y]), k) + poly(list, k);
  const U = (list) => M(list, b.up), Lo = (list) => M(list, b.lo);
  const parts = [];
  if (female && !back) {   // hair behind the head, angular bob
    parts.push(["hair", poly([[-14, 10], [-8, 3], [8, 3], [14, 10], [16, 38], [9, 34], [-9, 34], [-16, 38]])]);
  }
  parts.push(
    // torso underlay so the plates read as one body
    [null, poly([[-28 * b.up, 44], [28 * b.up, 44], [20 * b.up, 92], [18 * b.lo, 127], [-18 * b.lo, 127], [-20 * b.up, 92]])],
    [null, poly([[-7, 6], [7, 6], [13, 12], [13, 24], [7, 32], [-7, 32], [-13, 24], [-13, 12]], female ? 0.93 : 1)],   // head
  );
  if (female) parts.push(["hair", back
    ? poly([[-14, 9], [-8, 3], [8, 3], [14, 9], [15, 38], [0, 41], [-15, 38]])
    : poly([[-13, 13], [-7, 4], [7, 4], [13, 13], [6, 11], [0, 15], [-6, 11]])]);
  parts.push(
    ["neck", poly([[-7, 32], [7, 32], [5, 42], [-5, 42]], female ? 0.85 : 1)],
    ["shoulders", U([[15, 42], [27, 41], [37, 48], [35, 58], [25, 61], [17, 54]])],
    [back ? "triceps" : "biceps", U([[25, 63], [35, 62], [37, 78], [33, 95], [27, 95], [24, 78]])],
    [null, U([[27, 97], [34, 97], [38, 112], [37, 127], [32, 127], [29, 112]])],    // forearms
    [null, U([[32, 129], [39, 129], [41, 135], [37, 141], [33, 141]])],              // hands
  );
  if (!back) {
    parts.push(
      ["chest", female
        ? U([[2, 50], [10, 47], [18, 52], [18, 63], [10, 68], [2, 64]])
        : M([[1.5, 45], [23, 45], [21, 60], [12, 68], [1.5, 66]])],
      ["core", poly([[-12, 70], [0, 75], [12, 70], [12, 84], [0, 89], [-12, 84]])
             + poly([[-12, 87], [0, 92], [12, 87], [11, 100], [0, 105], [-11, 100]])
             + poly([[-11, 103], [0, 108], [11, 103], [10, 113], [0, 117], [-10, 113]])],
      ["hip", poly([[-18, 116], [-8, 120], [0, 119], [8, 120], [18, 116], [19, 128], [0, 136], [-19, 128]], b.lo)],
      ["quads", Lo([[4, 138], [14, 129], [22, 140], [18, 182], [11, 188], [6, 180]])],
      ["knee", M([[11, 186], [17, 193], [11, 200], [5, 193]])],
      ["shin", M([[6, 203], [11, 200], [16, 203], [15, 232], [11, 241], [8, 232]])],
    );
  } else {
    parts.push(
      ["back", poly([[-16, 41], [16, 41], [0, 64]], b.up)                         // traps
             + U([[21, 56], [3, 67], [2, 104], [9, 100], [16, 84]])],             // lats
      ["core", poly([[-12, 102], [0, 106], [12, 102], [12, 114], [0, 118], [-12, 114]])],   // lower back
      ["glutes", Lo([[2, 121], [12, 117], [22, 123], [22, 135], [13, 141], [3, 137]])],
      ["hamstrings", Lo([[4, 143], [13, 141], [21, 146], [18, 182], [11, 188], [6, 182]])],
      ["knee", M([[11, 187], [17, 194], [11, 201], [5, 194]])],
      ["calves", M([[6, 206], [11, 200], [18, 207], [16, 224], [11, 241], [7, 224]])],
    );
  }
  parts.push(["ankle", M([[6, 243], [17, 243], [20, 250], [12, 252], [5, 250]])]);   // feet
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
                                  female = false, regions = REGIONS, list: withList = true } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const done = new Set(trained);
  /* The figure also carries joints (knee, hip, ankle, shin) for return to
   * play. Only the parts `regions` names can be tapped; the rest are drawn
   * as plain body, so strength still offers muscle groups alone. */
  const tappable = new Set(regions);
  const draw = (cx, back) => figure(cx, back, female).map(([reg, shape]) =>
    reg === "hair" ? `<g class="bm-hair">${shape}</g>`
    : reg && tappable.has(reg)
    ? `<g class="bm-part${reg === selected ? " sel" : done.has(reg) ? " done" : ""}" data-region="${reg}"
         role="button" tabindex="0" aria-label="${esc(tr("bm_" + reg))}"><title>${esc(tr("bm_" + reg))}</title>${shape}</g>`
    : `<g class="bm-base">${shape}</g>`).join("");
  const ex = selected ? (REGION_EXERCISES[selected] || []) : null;
  const list = !selected
    ? `<p class="sub" style="margin:6px 0 0">${esc(tr("bmHint"))}</p>`
    : `<div style="margin-top:6px"><b>${esc(tr("bm_" + selected))}</b>${ex.length
        ? `<div style="margin-top:4px">${ex.map((a) => `<button type="button"
            class="ghost bmEx${a === current ? " on" : ""}" data-activity="${a}">${esc(tr(a))}</button>`).join("")}</div>`
        : `<p class="sub" style="margin:4px 0 0">${esc(tr("bmNone"))}</p>`}</div>`;
  if (!withList) return `<svg class="bodymap${female ? " female" : ""}" viewBox="0 0 260 262" role="group" aria-label="${esc(tr("bmTitle"))}">
      ${draw(60, false)}${draw(200, true)}
      <text x="60" y="260" text-anchor="middle">${esc(tr("bmFront"))}</text>
      <text x="200" y="260" text-anchor="middle">${esc(tr("bmBack"))}</text>
    </svg>`;
  return `<svg class="bodymap${female ? " female" : ""}" viewBox="0 0 260 262" role="group" aria-label="${esc(tr("bmTitle"))}">
      ${draw(60, false)}${draw(200, true)}
      <text x="60" y="260" text-anchor="middle">${esc(tr("bmFront"))}</text>
      <text x="200" y="260" text-anchor="middle">${esc(tr("bmBack"))}</text>
    </svg>${list}`;
}
