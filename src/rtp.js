/**
 * rtp.js -- return to play: pick the injured body part on the figure, the
 * injury, and the phase of recovery; get the test to repeat and the
 * exercises that fit that phase.
 *
 * The content comes from review 7 (_private/review/7_2026_Oct_MiniReview_
 * Return_to_Sport_Tests). Its rules carry over here unchanged:
 *   - every suggested test is one BioScout measures from the camera (timings,
 *     repetitions, jump height, sagittal range, left vs right);
 *   - nothing is a clearance. There is no pass mark, no readiness score, no
 *     force threshold; the athlete tracks themselves over weeks and the
 *     decision stays with their clinician;
 *   - the injury-to-test mapping and the phase exercises are an argued
 *     position ([A] in the review), not a validated protocol, and the page
 *     says so.
 *
 * Pure: data and HTML. tests/test_rtp.mjs checks the tables hold together.
 */

/** Body parts the return-to-play figure lets you tap. */
export const RTP_REGIONS = ["neck", "shoulders", "hip", "glutes", "quads", "hamstrings", "knee", "shin", "calves", "ankle"];

/** The recovery phases, in order, each with an icon (inline SVG paths, 24 px). */
export const RTP_PHASES = [
  { id: "protect", icon: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>' },
  { id: "mobility", icon: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>' },
  { id: "strength", icon: '<path d="M3 10v4M6 8v8M18 8v8M21 10v4M6 12h12"/>' },
  { id: "power", icon: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>' },
  { id: "sport", icon: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 21h6M10 17h4"/>' },
];
export const PHASE_IDS = RTP_PHASES.map((p) => p.id);

/*
 * Injuries. `regions`: where on the figure they appear (the first is the main
 * one). `tests`: what to record to follow it, BioScout movements, in order of
 * use (review 7 §5-6). `exercises`: per phase, movements the recorder can
 * track; empty means "nothing to record yet -- follow your clinician".
 * `common`: shown as a button when its region is tapped; the rest are in the
 * drop-down only.
 */
export const INJURIES = [
  { id: "ankleSprain", regions: ["ankle"], common: true, tests: ["heelraise", "slsquat", "cmj"],
    exercises: { protect: [], mobility: ["walk", "heelraise"], strength: ["heelraise", "slsquat", "squat"],
                 power: ["cmj", "sidestep", "run"], sport: ["sidestep", "run", "cmj"] } },
  { id: "chronicAnkle", regions: ["ankle"], common: false, tests: ["slsquat", "heelraise", "sidestep"],
    exercises: { protect: [], mobility: ["walk", "heelraise"], strength: ["slsquat", "heelraise"],
                 power: ["sidestep", "cmj"], sport: ["sidestep", "run"] } },
  { id: "achillesRupture", regions: ["calves", "ankle"], common: true, tests: ["heelraise", "cmj"],
    exercises: { protect: [], mobility: ["walk"], strength: ["heelraise", "squat"],
                 power: ["cmj", "run"], sport: ["run", "cmj", "sidestep"] } },
  { id: "achillesTendinopathy", regions: ["calves", "ankle"], common: true, tests: ["heelraise", "run"],
    exercises: { protect: ["walk"], mobility: ["walk", "heelraise"], strength: ["heelraise", "slsquat"],
                 power: ["cmj", "run"], sport: ["run", "cmj"] } },
  { id: "calfStrain", regions: ["calves"], common: true, tests: ["heelraise", "run"],
    exercises: { protect: [], mobility: ["walk"], strength: ["heelraise"], power: ["run", "cmj"], sport: ["run"] } },
  { id: "acl", regions: ["knee"], common: true, tests: ["slsquat", "cmj", "sj"],
    exercises: { protect: [], mobility: ["walk", "squat"], strength: ["squat", "slsquat", "kickback"],
                 power: ["cmj", "sj", "run"], sport: ["sidestep", "run", "cmj"] } },
  { id: "patellofemoral", regions: ["knee"], common: true, tests: ["run", "slsquat"],
    exercises: { protect: ["walk"], mobility: ["walk", "kickback"], strength: ["squat", "slsquat", "kickback"],
                 power: ["run", "cmj"], sport: ["run"] } },
  { id: "patellarTendinopathy", regions: ["knee"], common: true, tests: ["slsquat", "cmj"],
    exercises: { protect: [], mobility: ["walk"], strength: ["squat", "slsquat"], power: ["sj", "cmj"], sport: ["cmj", "run"] } },
  { id: "meniscus", regions: ["knee"], common: false, tests: ["squat", "slsquat"],
    exercises: { protect: [], mobility: ["walk", "squat"], strength: ["squat", "slsquat"], power: ["cmj", "run"], sport: ["run", "sidestep"] } },
  { id: "hamstringStrain", regions: ["hamstrings"], common: true, tests: ["run", "kickback"],
    exercises: { protect: [], mobility: ["walk", "kickback"], strength: ["kickback", "squat"],
                 power: ["run", "cmj"], sport: ["run", "sidestep"] } },
  { id: "quadStrain", regions: ["quads"], common: true, tests: ["squat", "cmj"],
    exercises: { protect: [], mobility: ["walk"], strength: ["squat", "slsquat"], power: ["cmj", "run"], sport: ["run", "cmj"] } },
  { id: "groin", regions: ["hip", "quads"], common: true, tests: ["sidestep", "squat"],
    exercises: { protect: [], mobility: ["walk", "squat"], strength: ["squat", "kickback"],
                 power: ["sidestep", "run"], sport: ["sidestep", "run"] } },
  { id: "fai", regions: ["hip", "glutes"], common: true, tests: ["squat", "kickback", "slsquat"],
    exercises: { protect: [], mobility: ["walk", "kickback"], strength: ["kickback", "squat", "slsquat"],
                 power: ["run", "cmj"], sport: ["run", "sidestep"] } },
  { id: "boneStress", regions: ["shin"], common: true, tests: ["run", "walk"],
    exercises: { protect: [], mobility: ["walk"], strength: ["heelraise", "squat"], power: ["run"], sport: ["run"] } },
  { id: "shinSplints", regions: ["shin"], common: true, tests: ["run", "heelraise"],
    exercises: { protect: ["walk"], mobility: ["walk", "heelraise"], strength: ["heelraise", "squat"], power: ["run"], sport: ["run"] } },
  { id: "shoulderDislocation", regions: ["shoulders"], common: true, tests: ["pushup"],
    exercises: { protect: [], mobility: [], strength: ["pushup"], power: ["pushup", "dip"], sport: ["pushup", "pullup"] } },
  { id: "concussion", regions: ["neck"], common: true, tests: ["reaction"],
    exercises: { protect: [], mobility: ["walk"], strength: ["walk", "squat"], power: ["run"], sport: ["run", "sidestep"] } },
  { id: "neckStrain", regions: ["neck"], common: false, tests: ["neck"],
    exercises: { protect: [], mobility: ["neck"], strength: ["neck"], power: ["neck"], sport: ["neck"] } },
];
export const INJURY = Object.fromEntries(INJURIES.map((i) => [i.id, i]));

/** Injuries shown as buttons for a tapped region. */
export function injuriesFor(region) {
  return INJURIES.filter((i) => i.regions.includes(region) && i.common);
}

/**
 * The most recent recorded set of any of `tests` within `days`, from a list of
 * sessions ({ started, sets: [{ activity, at }] }). "reaction" is matched
 * against reaction-test records ({ at }). Null when there is none.
 */
export function recentTest(tests, { sessions = [], reactions = [], days = 14, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  let best = null;
  for (const s of sessions) {
    for (const x of (s && s.sets) || []) {
      const at = Date.parse(x.at || s.started);
      if (tests.includes(x.activity) && at >= since && at <= now && (!best || at > best.at)) {
        best = { activity: x.activity, at };
      }
    }
  }
  if (tests.includes("reaction")) {
    for (const r of reactions) {
      const at = Date.parse(r.at);
      if (at >= since && at <= now && (!best || at > best.at)) best = { activity: "reaction", at };
    }
  }
  return best;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Everything under the figure. `state`: { region, injury, phase, showEx },
 * `recent`: recentTest() for the chosen injury, `fmtDate`: date formatter.
 * Buttons carry data-rtp-* attributes for the page to wire.
 */
export function rtpPanelHTML(tr, state, { recent = null, fmtDate = (t) => new Date(t).toLocaleDateString() } = {}) {
  const { region, injury, phase, showEx } = state;
  const inj = injury ? INJURY[injury] : null;
  const opts = INJURIES.map((i) => `<option value="${i.id}"${i.id === injury ? " selected" : ""}>${esc(tr("inj_" + i.id))}</option>`).join("");
  let h = "";
  if (region) {
    const list = injuriesFor(region);
    h += `<div style="margin-top:6px"><b>${esc(tr("bm_" + region))}</b><div style="margin-top:4px">${
      list.map((i) => `<button type="button" class="ghost bmEx${i.id === injury ? " on" : ""}" data-rtp-injury="${i.id}">${
        esc(tr("inj_" + i.id))}</button>`).join("") || `<span class="sub">${esc(tr("rtpNoCommon"))}</span>`}</div></div>`;
  } else {
    h += `<p class="sub" style="margin:6px 0 0">${esc(tr("rtpHint"))}</p>`;
  }
  h += `<label for="rtpInjury" style="margin-top:10px">${esc(tr("rtpAllInjuries"))}</label>
    <select id="rtpInjury"><option value="">${esc(tr("rtpPickInjury"))}</option>${opts}</select>`;
  if (!inj) return h;
  h += `<div style="margin-top:12px"><b>${esc(tr("rtpPhase"))}</b>
    <div class="rtpPhases">${RTP_PHASES.map((p, k) => `<button type="button" class="rtpPhase${p.id === phase ? " on" : ""}" data-rtp-phase="${p.id}"
      aria-pressed="${p.id === phase}"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p.icon}</svg>
      <span>${k + 1}. ${esc(tr("rtpPhase_" + p.id))}</span></button>`).join("")}</div></div>`;
  if (!phase) return h;
  // The test: suggested when nothing recent is on file, offered again otherwise.
  const testBtns = inj.tests.map((a) => `<button type="button" class="ghost bmEx" data-rtp-test="${a}">${
    esc(a === "reaction" ? tr("rtpReactionTest") : tr(a))}</button>`).join("");
  h += `<div class="rtpBlock">${recent
    ? `<p style="margin:0">${esc(tr("rtpTestRecent", { test: recent.activity === "reaction" ? tr("rtpReactionTest") : tr(recent.activity),
        date: fmtDate(recent.at) }))}</p>`
    : `<p style="margin:0"><b>${esc(tr("rtpTestSuggest"))}</b></p>`}
    <div>${testBtns}</div>
    <p class="note" style="margin:6px 0 0">${esc(tr("rtpTestNote_" + (inj.tests.includes("reaction") ? "concussion" : "general")))}</p></div>`;
  const ex = inj.exercises[phase] || [];
  h += `<button type="button" class="ghost" data-rtp-showex="1" style="margin-top:10px">${esc(tr(showEx ? "rtpHideExercises" : "rtpSuggestedExercises"))}</button>`;
  if (showEx) {
    h += `<div class="rtpBlock">${ex.length
      ? ex.map((a) => `<button type="button" class="ghost bmEx" data-rtp-ex="${a}">${esc(tr(a))}</button>`).join("")
      : `<p class="sub" style="margin:0">${esc(tr("rtpNoExercises"))}</p>`}
      <p class="note" style="margin:6px 0 0">${esc(tr("rtpExerciseNote"))}</p></div>`;
  }
  return h;
}
