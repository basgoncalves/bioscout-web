/**
 * dashboard.js -- the training history: what was done, on which days.
 *
 * Everything here reads the archive and the open session that profiles.js
 * already keeps. Nothing new is stored, so the dashboard cannot disagree with
 * the session card -- there is one record and two views of it.
 *
 * Two things about that record shape the whole file:
 *
 *   1. A session is archived only when the athlete starts a NEXT one. The
 *      session they are in the middle of is not in the archive, and leaving it
 *      out would mean today's training is missing from the calendar until
 *      tomorrow. `allSessions()` puts it back.
 *
 *   2. Sets carry `at`, sessions carry `started`, and both are UTC ISO. A
 *      calendar is a local-time object: an 8pm session in Vienna is 18:00Z and
 *      slicing the ISO string would file it on the right day, but a 1am one is
 *      23:00Z the day BEFORE and would not. Days are therefore keyed off the
 *      local calendar fields, never off the string.
 *
 * The computation is separate from the markup so test_dashboard.mjs can check
 * the bucketing -- which is the part with edge cases -- without a DOM.
 */
import { t as tr } from "./i18n.js";
import { MOODS, collectDiary, moodTrend, tagLevels, LEVEL_MAX } from "./diary.js";
import { collectWeights, weightOn, weightSeries, weightNear, weightWindow } from "./weight.js";
import { collectCycle, cycleStarts, cycleLengths, lengthStats, predictNext,
         dayOfCycle, phaseModel, cycleDayKey, LUTEAL_DAYS, FLOWS } from "./cycle.js";
import { itemKcal, mealKcal, describe, UNITS } from "./foods.js";
import { collectSleep, meanSleep, duration as sleepMins, fmt as fmtSleep } from "./sleep.js";
import { collectVitals, meanSteps } from "./vitals.js";
import { collectWater, collectCoffee, fmtVolume, DRINKS } from "./water.js";
import { collectReaction, reactionTrend } from "./reaction.js";
import { collectCardio, fmtDuration, fmtDistance, pace } from "./cardio.js";
import { rate, scoreColour } from "./health.js";
import { MILESTONES, badgeCount, repUnit } from "./achievements.js";

/* Plurals come from the dictionary keys the session card already uses, rather
 * than from new ones. "3 reps in 1 sets" is the kind of thing that makes an
 * app look machine-made, and English is the easy case -- German needs it too. */
const nSets = (n) => tr(n === 1 ? "nSet" : "nSets", { n });
const nReps = (n) => tr(n === 1 ? "nRep" : "nRepsCount", { n });
const nDays = (n) => tr(n === 1 ? "nDay" : "nDays", { n });
const nActs = (n) => tr(n === 1 ? "nActivity" : "nActivities", { n });

/* ---- days ------------------------------------------------------------- */

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. */
export function dayKey(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Archive plus the session still open, oldest first.
 *
 * `profile` scopes the result to one athlete. The archive is device-wide and
 * always has been, so a shared phone holds everyone's sessions in one list;
 * once the app asks who is training, the calendar has to answer for that
 * person alone. Sessions recorded with no profile selected belong to nobody
 * and are therefore in nobody's history -- they are still on the device, and
 * still in the export, but they do not silently pad someone else's totals.
 */
export function allSessions(archive, open, profile = null) {
  let out = Array.isArray(archive) ? archive.slice() : [];
  // The open session may already be in the archive if it was imported from
  // another device, and a session with no sets is not training that happened.
  if (open && open.sets && open.sets.length &&
      !out.some((s) => s.started === open.started)) out.push(open);
  if (profile) out = out.filter((s) => s.profile === profile);
  return out.sort((a, b) => String(a.started).localeCompare(String(b.started)));
}

/** Meals for one athlete, grouped into local calendar days. */
export function collectMeals(meals, profile = null) {
  const days = new Map();
  for (const m of meals || []) {
    if (profile && m.profile !== profile) continue;
    const key = dayKey(m.at);
    if (!key) continue;
    if (!days.has(key)) days.set(key, { key, meals: [], kcal: 0, counted: 0 });
    const d = days.get(key);
    d.meals.push(m);
    // Calories are optional, so a day's total is only over the meals that
    // carry one. `counted` says how many that was, because "1400 kcal" from
    // two of five meals is a different claim from "1400 kcal" from all five.
    if (Number.isFinite(m.kcal)) { d.kcal += m.kcal; d.counted++; }
  }
  for (const d of days.values()) d.meals.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return days;
}

/**
 * Group sets into local calendar days.
 *
 * Sets are bucketed individually rather than by the session's start time. A
 * session that runs through midnight is two days of training, and the athlete
 * looking at the calendar means the day they did the work.
 */
const emptyDay = (key) => ({
  key, sets: [], reps: 0, activities: new Set(), sessions: new Set(),
  cardio: [], cardioSeconds: 0, cardioMetres: 0, assess: false,
});

/**
 * Days that have training on them, from sets and from imported cardio both.
 *
 * `cardio` is optional and folds into the SAME day rather than a calendar of
 * its own: the day you ran and the day you squatted are both training days.
 * What it does not do is add to `reps` -- a 40-minute run has no reps, and
 * inventing some would corrupt every volume bar in the app. A cardio-only day
 * therefore exists with reps of zero, which the shading handles deliberately.
 */
export function collectDays(sessions, cardio = []) {
  const days = new Map();
  for (const s of sessions) {
    for (const set of s.sets || []) {
      const key = dayKey(set.at || s.started);
      if (!key) continue;
      if (!days.has(key)) days.set(key, emptyDay(key));
      const d = days.get(key);
      d.sets.push({ ...set, session: s.started, profile: s.profile ?? null, sport: s.sport ?? null });
      d.reps += set.reps || 0;
      if (set.assess) d.assess = true;
      if (set.activity) d.activities.add(set.activity);
      d.sessions.add(s.started);
    }
  }
  for (const [key, c] of collectCardio(cardio)) {
    if (!days.has(key)) days.set(key, emptyDay(key));
    const d = days.get(key);
    d.cardio = c.items;
    d.cardioSeconds = c.seconds;
    d.cardioMetres = c.metres;
  }
  for (const d of days.values()) d.sets.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return days;
}

/**
 * Consecutive training days ending today, or ending yesterday if today has no
 * training yet -- a streak should not read zero all morning just because the
 * session has not happened yet.
 */
export function streak(days, today = new Date()) {
  const has = (d) => days.has(dayKey(d));
  const cur = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!has(cur)) {
    cur.setDate(cur.getDate() - 1);
    if (!has(cur)) return 0;
  }
  let n = 0;
  while (has(cur)) { n++; cur.setDate(cur.getDate() - 1); }
  return n;
}

/** Headline totals across everything on the device. */
export function overall(days, today = new Date()) {
  const keys = [...days.keys()].sort();
  const sessions = new Set();
  let sets = 0, reps = 0;
  for (const d of days.values()) {
    sets += d.sets.length;
    reps += d.reps;
    for (const s of d.sessions) sessions.add(s);
  }
  return {
    days: keys.length,
    sessions: sessions.size,
    sets,
    reps,
    first: keys[0] ?? null,
    last: keys[keys.length - 1] ?? null,
    streak: streak(days, today),
  };
}

/* ---- calendar --------------------------------------------------------- */

/**
 * Weeks of a month as a 7-column grid, Monday first, padded with the
 * neighbouring months' days so every row is full. Cells carry `inMonth` so the
 * padding can be dimmed rather than dropped -- a grid with holes in it reads
 * as missing data.
 */
export function monthMatrix(year, month) {
  const first = new Date(year, month, 1);
  // getDay() is Sunday-first; shift so Monday is column 0.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const weeks = [];
  const cur = new Date(start);
  do {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push({
        date: new Date(cur),
        key: dayKey(cur),
        inMonth: cur.getMonth() === month && cur.getFullYear() === year,
      });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  } while (cur.getMonth() === month && cur.getFullYear() === year);
  return weeks;
}

/** Reps per ISO week (Monday-start) for the last `n` weeks, oldest first. */
export function weeklyVolume(days, n = 12, today = new Date()) {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const out = [];
  for (let w = n - 1; w >= 0; w--) {
    const start = new Date(monday);
    start.setDate(start.getDate() - w * 7);
    let reps = 0, sets = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const hit = days.get(dayKey(d));
      if (hit) { reps += hit.reps; sets += hit.sets.length; }
    }
    out.push({ start: dayKey(start), reps, sets });
  }
  return out;
}

/* ---- markup ----------------------------------------------------------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* "8,432 steps · 58 bpm resting · 120/80 mmHg", or just the parts logged. Shared by
 * the calendar cell label and the day card so the two cannot say different
 * things about the same day. */
function vitalsInfo(hit) {
  const parts = [];
  if (Number.isFinite(hit?.steps)) parts.push(tr("vitalsSteps", { n: hit.steps.toLocaleString() }));
  if (Number.isFinite(hit?.restingHr)) parts.push(tr("vitalsHr", { n: hit.restingHr }));
  if (Number.isFinite(hit?.sys) && Number.isFinite(hit?.dia)) {
    parts.push(tr("vitalsBp", { sys: hit.sys, dia: hit.dia }));
  }
  return parts.join(" · ");
}

/** "6 Sep", for buttons and captions that name a day other than today. */
const shortDay = (key) =>
  localeDay(key).toLocaleDateString([], { day: "numeric", month: "short" });

const localeDay = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/* Shading runs in four steps against the busiest day on screen, not against a
 * fixed rep count: 30 reps is a heavy day of squats and a light one of
 * skipping, and the calendar should not claim to know which. */
function level(reps, max) {
  if (!reps) return 0;
  if (!max) return 1;
  return Math.min(4, 1 + Math.floor((3 * reps) / max));
}

/* What the shading means depends on the mode: reps on a training day, meals
 * logged on a food day. Calories would be the obvious alternative, but they
 * are optional per meal, so a day of untyped meals would read as an empty one. */
const weightOf = (mode) => (d) =>
  mode === "sleep" ? (d.minutes || 1)       // a night with no parseable duration still shows
  : mode === "vitals" ? (d.steps || 1)      // a HR- or pressure-only day still shows
  : mode === "meals" ? d.meals.length
  : mode === "diary" ? (d.rated ? d.mood : 0.5)   // an unrated day still shows faintly
  // A run has no reps, so a cardio-only day would shade as an empty one.
  // It shows at the lowest level instead: present, without claiming a volume
  // it does not have.
  : (d.reps || (d.cardio && d.cardio.length ? 1 : 0));

function calendarHTML(days, year, month, selected, todayKey, mode) {
  const weeks = monthMatrix(year, month);
  const w = weightOf(mode);
  const inView = weeks.flat().filter((c) => c.inMonth).map((c) => days.get(c.key)).filter(Boolean);
  const max = Math.max(0, ...inView.map(w));

  // Weekday initials from the locale rather than hardcoded: a German user
  // should not get M T W T F S S.
  const heads = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(2024, 0, 1 + i);           // 2024-01-01 was a Monday
    heads.push(`<div class="dow">${esc(d.toLocaleDateString([], { weekday: "narrow" }))}</div>`);
  }

  const cells = weeks.flat().map((c) => {
    const hit = days.get(c.key);
    const cls = ["day"];
    if (!c.inMonth) cls.push("out");
    if (hit) cls.push("has", "l" + level(w(hit), max));
    // Outlined, not recoloured: the fill still means training volume, and an
    // assessment day is usually a training day too.
    if (hit?.assess) cls.push("assessDay");
    if (c.key === todayKey) cls.push("today");
    if (c.key === selected) cls.push("sel");
    const assessNote = hit?.assess ? " \u00b7 " + tr("assessTag") : "";
    const label = !hit ? c.key
      : mode === "sleep"
        ? tr("dayCellSleep", { date: c.key,
            hours: hit.minutes != null ? fmtSleep(hit.minutes) : tr("logged") })
      : mode === "diary"
        ? tr("dayCellDiary", { date: c.key, mood: hit.rated ? hit.mood.toFixed(1) : "—" })
      : mode === "meals"
        ? tr("dayCellMeals", { date: c.key, n: hit.meals.length })
      : mode === "vitals"
        ? tr("dayCellVitals", { date: c.key, info: vitalsInfo(hit) })
        : tr("dayCellLabel", { date: c.key, reps: nReps(hit.reps), sets: nSets(hit.sets.length) });
    // Every day is selectable, empty ones included: the dashboard is where
    // things get added, and you cannot add to a day you cannot select.
    // The red outline says something happened; the label says what, for anyone
    // reading by tooltip or by screen reader rather than by colour.
    const full = label + assessNote;
    return `<button type="button" class="${cls.join(" ")}" data-day="${c.key}"
      title="${esc(full)}" aria-label="${esc(full)}">
      <span>${c.date.getDate()}</span>${assessNote
        ? `<span class="dayDot" aria-hidden="true"></span>` : ""}</button>`;
  }).join("");

  const title = new Date(year, month, 1)
    .toLocaleDateString([], { month: "long", year: "numeric" });

  return `
    <div class="calmode">
      <select id="dashMode" aria-label="${esc(tr("calendarShows"))}">
        <option value="training"${mode === "meals" ? "" : " selected"}>${esc(tr("modeTraining"))}</option>
        <option value="meals"${mode === "meals" ? " selected" : ""}>${esc(tr("modeMeals"))}</option>
        <option value="diary"${mode === "diary" ? " selected" : ""}>${esc(tr("modeDiary"))}</option>
        <option value="sleep"${mode === "sleep" ? " selected" : ""}>${esc(tr("sleep"))}</option>
        <option value="vitals"${mode === "vitals" ? " selected" : ""}>${esc(tr("vitals"))}</option>
      </select>
    </div>
    <div class="calnav">
      <button type="button" class="ghost calbtn" id="dashPrev" aria-label="${esc(tr("prevMonth"))}">‹</button>
      <div class="calmonth">${esc(title)}</div>
      <button type="button" class="ghost calbtn" id="dashNext" aria-label="${esc(tr("nextMonth"))}">›</button>
    </div>
    <div class="cal">${heads.join("")}${cells}</div>`;
}

function volumeHTML(days, today) {
  const weeks = weeklyVolume(days, 12, today);
  const max = Math.max(1, ...weeks.map((w) => w.reps));
  if (!weeks.some((w) => w.reps)) return "";
  const bars = weeks.map((w) => {
    const h = Math.round((100 * w.reps) / max);
    const d = localeDay(w.start).toLocaleDateString([], { day: "numeric", month: "short" });
    return `<div class="vbar" title="${esc(tr("weekOf", { date: d, reps: nReps(w.reps) }))}">
      <i style="height:${h}%"></i></div>`;
  }).join("");
  return `<div class="vol"><div class="sub" style="margin:14px 0 4px">${
    esc(tr("weeklyVolume"))}</div><div class="vbars">${bars}</div></div>`;
}

/**
 * Badges per movement at 10, 100, 500 and 1000 reps (achievements.js).
 * One row per task the athlete has done, four medals, and how far to the next.
 * `list` is null when the page did not compute it (tests of other sections).
 */
export function achievementsHTML(list) {
  if (!list) return "";
  const head = `<div style="font-weight:600">${esc(tr("achievements"))}</div>`;
  if (!list.length) {
    return `<div class="daybox" id="achBox">${head}
      <p class="sub" style="margin:6px 0 0">${esc(tr("achEmpty"))}</p></div>`;
  }
  const date = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  const label = (n) => (n >= 1000 ? `${n / 1000}k` : String(n));
  const rows = list.map((a) => {
    const medals = a.tiers.map((t, i) => `<span class="ach t${i + 1}${t.at ? " on" : ""}" title="${
      esc(t.at ? tr("achEarned", { date: date(t.at) }) : repUnit(t.n, a.activity, tr))}">${label(t.n)}</span>`).join("");
    // Progress is measured from the last milestone passed, so the bar fills
    // from empty again after each badge instead of creeping along a 0-1000 line.
    const prev = [0, ...MILESTONES].filter((n) => n <= a.total && (a.next === null || n < a.next)).pop() || 0;
    const pct = a.next === null ? 100 : Math.round((100 * (a.total - prev)) / (a.next - prev));
    const nextTxt = a.next === null ? tr("achAll") : tr("achNext", { left: a.next - a.total, next: a.next });
    return `<div class="achRow">
      <div class="achName"><b>${esc(tr(a.activity))}</b><span class="sub">${
        esc(repUnit(a.total, a.activity, tr))}</span></div>
      <div class="achMedals">${medals}</div>
      <div class="achBar" title="${esc(nextTxt)}"><i style="width:${pct}%"></i></div>
      <div class="sub achNextTxt">${esc(nextTxt)}</div>
    </div>`;
  }).join("");
  return `<div class="daybox" id="achBox">${head}
    <p class="sub" style="margin:2px 0 8px">${esc(tr("achBadges", {
      n: badgeCount(list), max: list.length * MILESTONES.length }))}</p>
    ${rows}
    <p class="sub" style="margin:8px 0 0">${esc(tr("achNote"))}</p></div>`;
}

function dayHTML(day, key, reactionLines = "") {
  const btns = `<div class="row" style="margin-top:10px">
      <button id="newTrainingBtn" style="margin:0">${esc(tr("newTrainingSession"))}</button>
      <button type="button" class="ghost" id="trainImport" style="margin:0;padding:9px">${esc(tr("import"))}</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="ghost" id="assessBtn" style="margin:0">${esc(tr("assess"))}</button>
      <button type="button" class="ghost" id="reactionBtn" style="margin:0">${esc(tr("rtTitle"))}</button>
    </div>`;
  if (!day) {
    return `<div class="daybox"><div style="font-weight:600">${esc(tr("modeTraining"))}</div>
      ${reactionLines || `<p class="sub" style="margin:6px 0 0">${esc(tr("noTrainingThatDay"))}</p>`}${btns}</div>`;
  }
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // One row per SESSION, not per set: a set is a trial inside a session and
  // every trial of one session used to open the same summary page. Sets are
  // folded onto their session's `started` timestamp -- the session's identity.
  const bySession = new Map();
  for (const s of day.sets) {
    if (!bySession.has(s.session)) {
      bySession.set(s.session, { started: s.session, sets: 0, reps: 0, acts: new Set(), assess: 0,
                                 sport: s.sport || null });
    }
    const g = bySession.get(s.session);
    g.sets++; g.reps += s.reps; g.acts.add(s.activity);
    if (s.assess) g.assess++;
  }
  /* An assessment reads differently from training and should look different.
   * The sets are tagged, so the row can say what it was rather than presenting
   * a screening as an ordinary session that happens to contain a walk. */
  const rows = [...bySession.values()].map((g) =>
    `<tr class="sessionRow${g.assess ? " assessRow" : ""}" data-session="${esc(g.started)}">
      <td>${esc(time(g.started))}${g.assess
        ? ` <span class="tagAssess">${esc(tr("assessTag"))}</span>` : ""}</td>
      <td>${g.sport ? `<b>${esc(tr("sport_" + g.sport))}</b><br>` : ""}${
        [...g.acts].map((a) => esc(tr(a))).join(", ")}</td><td>${g.sets}</td><td>${g.reps}</td></tr>`).join("");
  const acts = [...day.activities].map((a) => esc(tr(a))).join(", ");

  const hasSets = day.sets.length > 0;
  const cardio = day.cardio || [];
  const cardioRows = cardio.map((c) => {
    // Pace goes in the title rather than a column: it is meaningless for a
    // rowing machine or a gym class, and an empty sixth column on every such
    // row is worse than a tooltip on the rows that have one.
    const p = pace(c.seconds, c.metres);
    return `<tr><td>${esc(time(c.at))}</td><td>${esc(c.sport)}</td>
      <td>${esc(fmtDuration(c.seconds))}</td>
      <td${p ? ` title="${esc(tr("paceLabel", { pace: p }))}"` : ""}>${
        esc(fmtDistance(c.metres) || "—")}</td>
      <td>${c.avgHr ? Math.round(c.avgHr) : "—"}</td></tr>`;
  }).join("");
  const cardioBlock = cardio.length ? `
    <div style="font-weight:600;margin-top:${hasSets ? "14px" : "0"}">${esc(tr("cardio"))}</div>
    <p class="sub" style="margin:2px 0 8px">${esc(nActs(cardio.length))} · ${
      esc(fmtDuration(day.cardioSeconds))}${
      day.cardioMetres ? " · " + esc(fmtDistance(day.cardioMetres)) : ""}</p>
    <table><thead><tr><th>${esc(tr("time"))}</th><th>${esc(tr("sport"))}</th>
      <th>${esc(tr("duration"))}</th><th>${esc(tr("distance"))}</th>
      <th>${esc(tr("avgHrCol"))}</th></tr></thead>
      <tbody>${cardioRows}</tbody></table>
    <p class="sub" style="margin:8px 0 0">${esc(tr("cardioSource"))}</p>` : "";

  /* Sets and cardio get separate summaries. Reps-and-load and
   * time-and-distance do not average into one sentence, and a day with only a
   * run would otherwise open with "0 sets, 0 reps" over an empty table. */
  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("modeTraining"))}</div>
    ${hasSets ? `
    <p class="sub" style="margin:2px 0 8px">${esc(tr("daySub", {
      sets: nSets(day.sets.length), reps: nReps(day.reps),
    }))}${day.sessions.size > 1 ? " · " + esc(tr("nSessionsOnDay", { n: day.sessions.size })) : ""
    }${acts ? " · " + acts : ""}</p>
    <table><thead><tr><th>${esc(tr("time"))}</th><th>${esc(tr("movement"))}</th>
      <th>${esc(tr("sets"))}</th><th>${esc(tr("reps"))}</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="sub" style="margin:8px 0 0">${esc(tr("tapSessionHint"))}</p>` : ""}${cardioBlock}${reactionLines}${btns}
  </div>`;
}

/**
 * Calories per day across the month on show.
 *
 * The mean is over days that actually have a figure, and the caption says how
 * many those were. Averaging over all thirty would divide by days nobody
 * logged and report a number far below anything eaten -- an average that
 * flatters by accident is worse than no average.
 *
 * There is no target line. The app has no basis for one.
 */
function intakeHTML(mealDays, weights, year, month) {
  const p = (n) => String(n).padStart(2, "0");
  const last = new Date(year, month + 1, 0).getDate();
  const bars = [];
  let sum = 0, logged = 0;
  for (let i = 1; i <= last; i++) {
    const key = `${year}-${p(month + 1)}-${p(i)}`;
    const day = mealDays.get(key);
    const kcal = day && day.counted ? day.kcal : null;
    if (kcal) { sum += kcal; logged++; }
    bars.push({ key, kcal, day: i });
  }
  const mean = logged ? Math.round(sum / logged) : null;
  const max = Math.max(1, ...bars.map((b) => b.kcal || 0));

  const wSeries = weightSeries(weights, year, month);
  const known = wSeries.filter((w) => w.kg !== null);
  const wLine = known.length
    ? `<span> · ${esc(tr("weightRange", {
        lo: Math.min(...known.map((w) => w.kg)).toFixed(1),
        hi: Math.max(...known.map((w) => w.kg)).toFixed(1) }))}</span>`
    : "";

  if (!logged) {
    return `<p class="sub" style="margin:2px 0 0">${esc(tr("noIntakeThisMonth"))}${wLine}</p>`;
  }

  // The mean is drawn as a rule across the bars so a day reads against it at a
  // glance, which is the comparison asked for -- not against a goal.
  const meanPct = Math.round((100 * mean) / max);
  return `
    <p class="sub" style="margin:2px 0 8px">${esc(tr("intakeMean", { kcal: mean, n: logged }))}${wLine}</p>
    <div class="intake">
      <div class="meanline" style="bottom:${meanPct}%"><span>${mean}</span></div>
      ${bars.map((b) => `<div class="ibar${b.kcal ? "" : " none"}"
        title="${esc(b.kcal ? tr("kcalOnDay", { kcal: b.kcal, date: b.key }) : tr("noneLogged", { date: b.key }))}">
        <i style="height:${b.kcal ? Math.round((100 * b.kcal) / max) : 0}%"></i></div>`).join("")}
    </div>`;
}

/**
 * The health dial: one arc, coloured by score, with the metrics under it.
 *
 * The arc is the score and the number in the middle is the score, so the two
 * cannot disagree. Each metric that fed it is named with its own value, so a
 * rating is never a number with no visible source -- and the caveat rides
 * along, because a dial is exactly the sort of thing that gets believed.
 */
function healthHTML(ctx) {
  const r = rate(ctx);
  const pct = r.score === null ? 0 : Math.round(r.score * 100);
  const colour = scoreColour(r.score);
  const C = 2 * Math.PI * 34;

  const detail = r.contributions.map((c) =>
    `<span>${esc(tr(c.label))} ${esc(c.text)}</span>`).join(" · ");
  const want = r.missing.length
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("healthNeeds", {
        what: r.missing.map((m) => esc(tr(m.label))).join(", ") }))}</p>` : "";
  const caveat = r.contributions.find((c) => c.caveat);

  return `<div class="health">
    <svg viewBox="0 0 80 80" class="dial" role="img"
      aria-label="${esc(tr("healthLabel", { pct }))}">
      <circle cx="40" cy="40" r="34" fill="none" stroke="var(--bg)" stroke-width="9"/>
      ${r.score === null ? "" : `<circle cx="40" cy="40" r="34" fill="none" stroke="${colour}"
        stroke-width="9" stroke-linecap="round" stroke-dasharray="${(C * r.score).toFixed(1)} ${C.toFixed(1)}"
        transform="rotate(-90 40 40)"/>`}
      <text x="40" y="44" text-anchor="middle" class="dialText"
        fill="${colour}">${r.score === null ? "\u2014" : pct}</text>
    </svg>
    <div class="healthText">
      <div style="font-weight:600">${esc(tr("healthRating"))}</div>
      ${detail ? `<p class="sub" style="margin:2px 0 0">${detail}</p>` : ""}
      ${want}
      ${caveat ? `<p class="note" style="margin:4px 0 0">${esc(tr(caveat.caveat))}</p>` : ""}
    </div>
  </div>`;
}

/** The selected day's meals, and the form to add one to it. */
/* One glass or cup, drawn: the outline always, the drink only when it was
 * had. Drawn rather than an emoji so an empty one reads as empty on every phone. */
const glassSVG = (full) => `<svg class="glass${full ? " full" : ""}" viewBox="0 0 24 32" aria-hidden="true">
    <path class="fill" d="M5.4 11 H18.6 L17.3 28.2 H6.7 Z"/>
    <path class="rim" d="M3.5 3 H20.5 L18.4 29 H5.6 Z"/></svg>`;
const cupSVG = (full) => `<svg class="glass cup${full ? " full" : ""}" viewBox="0 0 24 32" aria-hidden="true">
    <path class="fill" d="M3.3 14 H16.7 L16 25 Q15.6 27.5 13 27.5 H7 Q4.4 27.5 4 25 Z"/>
    <path class="rim" d="M2 10 H18 L17 25.5 Q16.6 29 13 29 H7 Q3.4 29 3 25.5 Z"/>
    <path class="rim" d="M17.6 13.5 H19.5 Q22.5 13.5 22.2 17.5 Q21.9 21.5 17.2 21.5"/>
    <path class="steam" d="M7 7 Q5.8 5 7 3 M11 7 Q9.8 5 11 3 M15 7 Q13.8 5 15 3"/></svg>`;

/** A drink for the day: ten glasses of water (0.5 L) or cups of coffee
 *  (100 mL), filled from the left, with - and + either side. Every tap is saved
 *  on the spot (index.html, button.drinkBtn), because a counter that also wants
 *  a Save button is one nobody keeps. */
function drinkHTML(kind, hit) {
  const d = DRINKS[kind];
  const n = hit ? hit.n : 0;
  const icon = kind === "coffee" ? cupSVG : glassSVG;
  const icons = Array.from({ length: d.max }, (_, i) => icon(i < n)).join("");
  const label = tr(kind === "coffee" ? "coffeeCups" : "waterGlasses",
                   { n, max: d.max, l: fmtVolume(n, kind) });
  const each = kind === "coffee"
    ? `${Math.round(d.cupL * 1000)} mL`
    : `${d.cupL.toLocaleString([], { minimumFractionDigits: 1 })} L`;
  return `<div class="entry drink" data-kind="${kind}" id="${kind}Box">
    <div class="waterHead"><span style="font-weight:600">${esc(tr(kind))}</span>
      <span class="sub">${esc(fmtVolume(n, kind))}</span></div>
    <div class="water">
      <button type="button" class="ghost waterBtn drinkBtn" data-drink="${kind}" data-dir="-1"${
        n <= 0 ? " disabled" : ""} aria-label="${esc(tr(kind === "coffee" ? "coffeeLess" : "waterLess"))}">−</button>
      <div class="glasses" role="img" aria-label="${esc(label)}" title="${esc(label)}">${icons}</div>
      <button type="button" class="ghost waterBtn drinkBtn" data-drink="${kind}" data-dir="1"${
        n >= d.max ? " disabled" : ""} aria-label="${esc(tr(kind === "coffee" ? "coffeeMore" : "waterMore"))}">+</button>
    </div>
    <p class="sub" style="margin:4px 0 0">${esc(tr(kind === "coffee" ? "coffeeEach" : "waterEach", { l: each }))}</p>
  </div>`;
}

function mealsHTML(day, key, todayKey, water = null, coffee = null) {
  const rows = (day?.meals || []).map((m) => {
    const t = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const shot = m.photo
      ? `<img class="mealShot" data-at="${esc(m.at)}" alt="" width="44" height="44">`
      : "";
    const what = m.items && m.items.length ? describe(m.items) : m.text;
    const sum = m.items && m.items.length ? mealKcal(m.items) : null;
    const kcal = sum ? sum.kcal : m.kcal;
    // A total that could not cover every item is marked, not rounded up into
    // a claim about the whole meal.
    const mark = sum && sum.kcal !== null && !sum.complete ? "+" : "";
    return `<tr><td>${esc(t)}</td><td>${shot}${esc(what)}</td>
      <td style="text-align:right">${kcal ?? "—"}${mark}</td>
      <td style="width:1%"><button type="button" class="linky mealDel"
        data-at="${esc(m.at)}" aria-label="${esc(tr("delete"))}">×</button></td></tr>`;
  }).join("");

  // Only over the meals that carry a figure, and it says so. A total that
  // quietly ignores three untyped meals is a wrong number, not a partial one.
  const sum = day && day.counted
    ? `<p class="sub" style="margin:6px 0 0">${esc(tr("kcalFromN", {
        kcal: day.kcal, n: day.counted, total: day.meals.length }))}</p>`
    : "";

  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("meals"))}</div>
    ${rows
      ? `<table><thead><tr><th>${esc(tr("time"))}</th><th>${esc(tr("meal"))}</th>
           <th style="text-align:right">${esc(tr("kcal"))}</th><th></th></tr></thead>
         <tbody>${rows}</tbody></table>${sum}`
      : `<p class="sub" style="margin:6px 0 0">${esc(tr("noMealsThatDay"))}</p>`}
    <button type="button" class="ghost" id="addMealBtn" style="margin-top:8px">${esc(tr("addMeal"))}</button>
    ${drinkHTML("water", water)}
    ${drinkHTML("coffee", coffee)}
  </div>`;
}

/**
 * The cycle section: where today sits, what the history says, and what is
 * predicted -- with the evidence attached to every number.
 */
function cycleHTML(cycleDays, key, todayKey) {
  const starts = cycleStarts(cycleDays);
  if (!starts.length) return "";              // nothing logged: no section at all

  const stats = lengthStats(cycleLengths(starts));
  const pred = predictNext(starts, localeDay(todayKey));
  const hit = cycleDays.get(key);
  const n = dayOfCycle(starts, key);

  const flow = hit && hit.flow ? tr(FLOWS.find((f) => f.v === hit.flow).key) : null;
  const dayLine = n
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("cycleDayN", { n }))}${
        flow ? " · " + esc(flow) : ""}${
        hit && hit.symptoms.length ? " · " + hit.symptoms.map((s) => esc(tr(s) || s)).join(", ") : ""}</p>`
    : "";

  /* Every figure says what it rests on. "28 days" from three cycles and
   * "28 days" from thirty look identical otherwise, and the first is a guess
   * wearing the second's clothes. */
  const histLine = stats
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("cycleHistory", {
        mean: stats.mean.toFixed(1), n: stats.n, min: stats.min, max: stats.max }))}</p>`
    : `<p class="sub" style="margin:2px 0 0">${esc(tr("cycleNotEnough", {
        n: tr(starts.length === 1 ? "nPeriod" : "nPeriods", { n: starts.length }) }))}</p>`;

  const predLine = pred
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("cycleDue", {
        date: shortDay(pred.due), spread: nDays(pred.spread), n: pred.stats.n }))}</p>`
    : "";

  const model = phaseModel(cycleDays);
  const ring = model ? ringHTML(model, cycleDays, todayKey) : "";
  const legend = !model ? "" : `<div class="ringKey">
      <span><i class="kPeriod"></i>${esc(tr("phasePeriod"))}</span>
      ${model.fertile ? `<span><i class="kFertile"></i>${esc(tr("phaseFertile"))}</span>` : ""}
      ${model.ovulation ? `<span><i class="kOvu"></i>${esc(tr("phaseOvulation"))}</span>` : ""}
      <span><i class="kLogged"></i>${esc(tr("phaseLogged"))}</span>
    </div>
    <p class="note" style="margin:6px 0 0">${esc(model.provisional
      ? tr("phaseNoteProvisional", { n: model.cycle })
      : tr("phaseNote", { luteal: LUTEAL_DAYS }))}</p>`;

  return `<div class="daybox cycleSub">
    <div style="font-weight:600">${esc(tr("cycle"))}</div>
    ${ring}${legend}
    ${dayLine}${histLine}${predLine}
    <button type="button" class="ghost" id="openCycleBtn" style="margin-top:10px">${
      esc(tr("openCycle"))}</button>
  </div>`;
}

/* ---- the ring ---------------------------------------------------------- */

const R = 74, CX = 100, CY = 100, W = 20;

/** Polar to cartesian, with day 1 at the top and the cycle running clockwise. */
function pt(day, cycle, r = R) {
  const a = ((day - 1) / cycle) * 2 * Math.PI - Math.PI / 2;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

/** An arc from day `a` to day `b` inclusive, as an SVG path. */
function arc(a, b, cycle) {
  const [x1, y1] = pt(a, cycle);
  // b + 1 so a single-day segment has width: day 5 spans 5 to 6, not 5 to 5.
  const [x2, y2] = pt(b + 1, cycle);
  const big = (b + 1 - a) / cycle > 0.5 ? 1 : 0;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 ${big} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/**
 * The cycle as a ring: where today sits, and what is estimated around it.
 *
 * Two kinds of thing are drawn and they must not look alike. Days actually
 * logged are solid. Everything derived -- the expected period, the fertile
 * window, ovulation -- is dashed, because it is arithmetic from an average
 * and not a record of anything. A ring that renders both the same way is how
 * these apps end up being trusted for things they cannot do.
 */
function ringHTML(model, cycleDays, todayKey) {
  const { cycle, period, ovulation, fertile } = model;
  const starts = model.starts;
  const day = dayOfCycle(starts, todayKey);

  const seg = (a, b, cls) => (b >= a
    ? `<path class="${cls}" d="${arc(a, b, cycle)}" fill="none" stroke-width="${W}"/>` : "");

  // Logged days of the current cycle, drawn over the estimate as short solid
  // ticks: the difference between "you bled on the 3rd" and "a period is due
  // around the 3rd" is the whole point of the picture.
  const last = starts[starts.length - 1];
  const logged = [...cycleDays.keys()].filter((k) => k >= last)
    .map((k) => dayOfCycle(starts, k)).filter((n) => n && n <= cycle);
  const ticks = logged.map((n) =>
    `<path class="ringLogged" d="${arc(n, n, cycle)}" fill="none" stroke-width="${W}"/>`).join("");

  const marker = day && day <= cycle ? (() => {
    const [x, y] = pt(day + 0.5, cycle);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" class="ringToday"/>`;
  })() : "";

  const ofLine = model.provisional ? tr("ofNAssumed", { n: cycle }) : tr("ofNDays", { n: cycle });
  const centre = day
    ? `<tspan x="${CX}" dy="-4" class="ringBig">${day}</tspan>
       <tspan x="${CX}" dy="17" class="ringSmall">${esc(ofLine)}</tspan>`
    : `<tspan x="${CX}" dy="4" class="ringSmall">${esc(tr("cycleNoToday"))}</tspan>`;

  return `<svg viewBox="0 0 200 200" class="ring" role="img"
    aria-label="${esc(tr("cycleRingLabel", { day: day ?? "—", n: cycle }))}">
    <circle cx="${CX}" cy="${CY}" r="${R}" class="ringBase" fill="none" stroke-width="${W}"/>
    ${seg(1, period, "ringPeriod")}
    ${fertile ? seg(fertile.from, fertile.to, "ringFertile") : ""}
    ${ovulation ? seg(ovulation, ovulation, "ringOvu") : ""}
    ${ticks}${marker}
    <text x="${CX}" y="${CY}" text-anchor="middle" class="ringText">${centre}</text>
  </svg>`;
}

/** The night that ended on this day, and the form to record it. */
function sleepHTML(sleepDays, key, todayKey, trend) {
  const hit = sleepDays.get(key);
  const line = hit
    ? (hit.minutes === null
        ? `<p class="sub" style="margin:6px 0 0">${esc(tr("sleepUnclear", { bed: hit.bed, wake: hit.wake }))}</p>`
        : `<p class="sub" style="margin:6px 0 0">${esc(tr("sleepLine", {
            dur: fmtSleep(hit.minutes), bed: hit.bed, wake: hit.wake }))}</p>`)
    : `<p class="sub" style="margin:6px 0 0">${esc(tr("noSleepThatDay"))}</p>`;

  /* Said with the number of nights behind it. "7 h 20" from three nights and
   * from fourteen are different claims, and most fortnights have gaps. */
  const trendLine = trend
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("sleepMean", {
        dur: fmtSleep(trend.mean), n: trend.nights }))}</p>`
    : "";

  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("sleep"))}</div>
    ${trendLine}${line}
    <div class="row" style="margin-top:8px">
      <div>
        <label for="sleepBed">${esc(tr("toBed"))}</label>
        <input id="sleepBed" type="time" value="${esc(hit?.bed || "")}">
      </div>
      <div>
        <label for="sleepWake">${esc(tr("gotUp"))}</label>
        <input id="sleepWake" type="time" value="${esc(hit?.wake || "")}">
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="ghost" id="sleepSave" style="margin:0;padding:9px">${
        esc(key === todayKey ? tr("saveToday") : tr("saveToDay", { date: shortDay(key) }))}</button>
      <button type="button" class="ghost" id="sleepImport" style="margin:0;padding:9px">${esc(tr("import"))}${importInfo()}</button>
    </div>
  </div>`;
}

/* The "i" beside every Import button.
 *
 * There is exactly one import format and no way to guess it from the button,
 * so people hand it their watch's own export and get a refusal that tells them
 * nothing. A hover says what the file has to be; the link goes to the page that
 * says it properly, including the formats that do NOT work, which is the half
 * the refusal never covers. It is a link and not a tooltip alone because a
 * tooltip cannot be read on a phone at all. */
export function importInfo() {
  return `<a class="infoDot" href="formats.html" target="_blank" rel="noopener"
     title="${esc(tr("importAcceptsTip"))}"
     aria-label="${esc(tr("importAcceptsTip"))}">i</a>`;
}

/** Steps, resting heart rate and blood pressure for the day, typed in (or, for
 *  the heart rate, counted with the guide in index.html's #hrDlg) -- see
 *  vitals.js for why a blank day is not carried forward from the last one. */
function vitalsHTML(vitalsDays, key, todayKey, trend) {
  const hit = vitalsDays.get(key);
  const line = hit
    ? `<p class="sub" style="margin:6px 0 0">${esc(vitalsInfo(hit))}</p>`
    : `<p class="sub" style="margin:6px 0 0">${esc(tr("noVitalsThatDay"))}</p>`;

  const trendLine = trend
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("vitalsMean", {
        n: trend.mean.toLocaleString(), days: trend.days }))}</p>`
    : "";

  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("vitals"))}</div>
    ${trendLine}${line}
    <div class="row" style="margin-top:8px">
      <div>
        <label for="vitalsSteps">${esc(tr("steps"))}</label>
        <input id="vitalsSteps" type="number" min="0" step="1" inputmode="numeric"
               value="${hit?.steps ?? ""}">
      </div>
      <div>
        <label for="vitalsHr">${esc(tr("restingHr"))}</label>
        <input id="vitalsHr" type="number" min="1" step="1" inputmode="numeric"
               value="${hit?.restingHr ?? ""}">
      </div>
    </div>
    <button type="button" class="ghost" id="hrMeasureBtn" style="margin:8px 0 0;padding:9px">${
      esc(tr("hrMeasure"))}</button>
    <div style="font-weight:600;font-size:13.5px;margin-top:10px">${esc(tr("bloodPressure"))}</div>
    <div class="row" style="margin-top:4px">
      <div>
        <label for="vitalsSys">${esc(tr("bpSys"))}</label>
        <input id="vitalsSys" type="number" min="60" max="260" step="1" inputmode="numeric"
               placeholder="120" value="${hit?.sys ?? ""}">
      </div>
      <div>
        <label for="vitalsDia">${esc(tr("bpDia"))}</label>
        <input id="vitalsDia" type="number" min="30" max="160" step="1" inputmode="numeric"
               placeholder="80" value="${hit?.dia ?? ""}">
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="ghost" id="vitalsSave" style="margin:0;padding:9px">${
        esc(key === todayKey ? tr("saveToday") : tr("saveToDay", { date: shortDay(key) }))}</button>
      <button type="button" class="ghost" id="vitalsImport" style="margin:0;padding:9px">${esc(tr("import"))}${importInfo()}</button>
    </div>
  </div>`;
}

/** The day's reaction-time tests, as lines under the day's training: each
 *  test's game and median, and the usual time for the latest game on the
 *  same input. The games themselves are their own screen (#viewReaction). */
function reactionLinesHTML(entries, key, today) {
  const list = collectReaction(entries).get(key) || [];
  if (!list.length) return "";
  const inputOf = (i) => i ? tr("rtInput_" + i) : "";
  const rows = list.map((t) => {
    const time = new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<p class="sub" style="margin:3px 0 0"><b>${esc(time)}</b> · ${esc(tr("rtGame_" + t.game))}
      · ${esc(tr("rtMedianMs", { ms: t.median }))} · ${esc(tr("rtBestMs", { ms: t.best }))}${
      t.game !== "simple" ? " · " + esc(tr("rtErrorsN", { n: t.errors || 0 })) : ""}${
      t.input ? " · " + esc(inputOf(t.input)) : ""}</p>`;
  }).join("");
  const last = list[list.length - 1];
  const trend = reactionTrend(entries, last.input, 30, today, last.game);
  const trendLine = trend && trend.tests > 1
    ? `<p class="sub" style="margin:3px 0 0">${esc(tr("rtUsualGame", { game: tr("rtGame_" + last.game),
        ms: trend.median, n: trend.tests, input: inputOf(last.input) }))}</p>` : "";
  return `<div style="font-weight:600;margin-top:12px">${esc(tr("rtTitle"))}</div>${rows}${trendLine}`;
}

/* ---- the cycle view ---------------------------------------------------- */

/**
 * A dot per day of the cycle, coloured by phase.
 *
 * Same rule as the ring it replaces: a day that was LOGGED is filled solid,
 * and a day that is merely expected is hollow. The colours say which phase the
 * arithmetic puts a day in; the fill says whether anyone actually recorded
 * anything. Confusing the two is how a calendar of estimates comes to be read
 * as a calendar of facts.
 */
export function cycleDotsHTML(model, cycleDays, todayKey, selected) {
  const { cycle, period, ovulation, fertile, pms, starts } = model;
  const today = dayOfCycle(starts, todayKey);
  const rDot = cycle > 34 ? 5.5 : 6.5;

  const phaseOf = (n) => {
    if (n <= period) return "dPeriod";
    if (ovulation && n === ovulation) return "dOvu";
    if (fertile && n >= fertile.from && n <= fertile.to) return "dFertile";
    if (pms && n >= pms.from && n <= pms.to) return "dPms";
    return "dPlain";
  };

  const dots = [];
  for (let n = 1; n <= cycle; n++) {
    const key = cycleDayKey(starts, n);
    const [x, y] = pt(n, cycle, R + 2);
    const cls = ["dot", phaseOf(n)];
    if (cycleDays.has(key)) cls.push("logged");
    if (n === today) cls.push("isToday");
    if (key === selected) cls.push("isSel");
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rDot}"
      class="${cls.join(" ")}" data-cday="${n}" data-key="${key}">
      <title>${esc(tr("cycleDotLabel", { n, date: shortDay(key) }))}</title></circle>`);
  }

  const centre = today
    ? `<tspan x="${CX}" dy="-6" class="ringBig">${today}</tspan>
       <tspan x="${CX}" dy="18" class="ringSmall">${esc(model.provisional
         ? tr("ofNAssumed", { n: cycle }) : tr("ofNDays", { n: cycle }))}</tspan>`
    : `<tspan x="${CX}" dy="4" class="ringSmall">${esc(tr("cycleNoToday"))}</tspan>`;

  // Phase names sit on the ring rather than in a key underneath, so a day and
  // its label are read together instead of by cross-reference.
  const label = (from, to, cls, text) => {
    const mid = (from + to) / 2;
    const [x, y] = pt(mid, cycle, R - 26);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="dotLabel ${cls}"
      text-anchor="middle">${esc(text)}</text>`;
  };

  return `<svg viewBox="0 0 200 200" class="dotRing" role="img"
    aria-label="${esc(tr("cycleRingLabel", { day: today ?? "—", n: cycle }))}">
    ${dots.join("")}
    ${label(1, period, "lPeriod", tr("phasePeriod"))}
    ${fertile ? label(fertile.from, fertile.to, "lFertile", tr("phaseFertile")) : ""}
    ${pms ? label(pms.from, pms.to, "lPms", tr("phasePms")) : ""}
    <text x="${CX}" y="${CY}" text-anchor="middle" class="ringText">${centre}</text>
  </svg>`;
}

/** The whole cycle screen: the wheel, the day being looked at, and its form. */
export function cycleViewHTML(model, cycleDays, todayKey, selected, symptoms, draft) {
  if (!model) {
    return `<p class="sub" style="margin:0 0 10px">${esc(tr("cycleNothingYet"))}</p>
      ${cycleFormHTML(todayKey, null, symptoms)}`;
  }
  const n = dayOfCycle(model.starts, selected);
  const hit = cycleDays.get(selected);
  const future = selected > todayKey;

  const stats = lengthStats(cycleLengths(model.starts));
  const pred = predictNext(model.starts, localeDay(todayKey));

  return `
    ${cycleDotsHTML(model, cycleDays, todayKey, selected)}
    <p class="note" style="margin:2px 0 10px;text-align:center">${esc(model.provisional
      ? tr("phaseNoteProvisional", { n: model.cycle })
      : tr("phaseNote", { luteal: LUTEAL_DAYS }))}</p>
    <div class="daybox">
      <div style="font-weight:600">${esc(localeDay(selected)
        .toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))}${
        n ? ` · ${esc(tr("cycleDayN", { n }))}` : ""}</div>
      ${future
        ? `<p class="sub" style="margin:6px 0 0">${esc(tr("cycleFutureDay"))}</p>`
        : cycleFormHTML(selected, hit || null, symptoms, draft)}
    </div>
    ${stats ? `<p class="sub" style="margin:10px 0 0">${esc(tr("cycleHistory", {
        mean: stats.mean.toFixed(1), n: stats.n, min: stats.min, max: stats.max }))}</p>` : ""}
    ${pred ? `<p class="sub" style="margin:2px 0 0">${esc(tr("cycleDue", {
        date: shortDay(pred.due), spread: nDays(pred.spread), n: pred.stats.n }))}</p>` : ""}
    <p class="note" style="margin:6px 0 0">${esc(tr("cycleCaveat"))}</p>`;
}

/** The cycle form, for the Add dialog. */
export function cycleFormHTML(key, current, symptoms, draft = null) {
  const on = draft || { flow: current?.flow ?? null, symptoms: current?.symptoms ?? [] };
  const flows = FLOWS.map((f) =>
    `<button type="button" class="chip flowBtn${on.flow === f.v ? " on" : ""}"
       data-flow="${f.v}">${esc(tr(f.key))}</button>`).join("");
  const chips = symptoms.map((s) =>
    `<button type="button" class="chip symBtn${(on.symptoms || []).includes(s) ? " on" : ""}"
       data-sym="${esc(s)}">${esc(tr(s) || s)}</button>`).join("");
  return `
    <p class="sub" style="margin:0 0 8px">${esc(tr("cycleFormFor", { date: shortDay(key) }))}</p>
    <div class="chips">${flows}</div>
    <div class="chips" style="margin-top:8px">${chips}</div>
    <div class="row" style="margin-top:10px">
      <button type="button" class="ghost" id="cycleSave" style="margin:0;padding:9px">${
        esc(tr("saveToDay", { date: shortDay(key) }))}</button>
      ${current ? `<button type="button" class="ghost" id="cycleClear" style="margin:0;padding:9px">${
        esc(tr("clearDay"))}</button>` : ""}
    </div>
    <p class="note" style="margin:8px 0 0">${esc(tr("cycleCaveat"))}</p>`;
}

/** The meal form on its own, for the Add dialog. */
export function mealFormHTML(key, todayKey, draft = { items: [] }, names = []) {
  const rows = (draft.items || []).map((it, i) => {
    const k = itemKcal(it);
    const unit = it.unit || "g";
    // The amount on screen is whatever was typed (`qty`), in `unit`; `grams`
    // stays the canonical figure the calorie arithmetic runs on. Older items
    // saved before units existed have only `grams`, which IS the amount once
    // the unit defaults to "g" -- so this falls back to it.
    const amt = it.qty ?? it.grams;
    const decimalUnit = unit === "Kg" || unit === "L";
    return `<div class="itemRow">
      <input class="itemName" data-i="${i}" list="foodList" value="${esc(it.name || "")}"
             placeholder="${esc(tr("foodName"))}" autocomplete="off">
      <select class="itemUnit" data-i="${i}" aria-label="${esc(tr("unit"))}">
        ${UNITS.map((u) => `<option value="${u}"${u === unit ? " selected" : ""}>${u}</option>`).join("")}
      </select>
      <button type="button" class="stepBtn gramStep" data-i="${i}" data-dir="-1">−</button>
      <input class="itemGrams" data-i="${i}" type="number" inputmode="decimal" min="0"
             step="${decimalUnit ? "0.1" : "1"}"
             value="${amt ?? ""}" aria-label="${esc(tr("grams"))}">
      <button type="button" class="stepBtn gramStep" data-i="${i}" data-dir="1">+</button>
      <span class="itemKcal">${k === null ? "—" : k}</span>
      <button type="button" class="linky itemDel" data-i="${i}"
              aria-label="${esc(tr("delete"))}">×</button>
    </div>`;
  }).join("");

  const sum = mealKcal(draft.items);
  const totalLine = sum.kcal === null
    ? `<p class="sub" style="margin:6px 0 0">${esc(tr("noKcalYet"))}</p>`
    : `<p class="sub" style="margin:6px 0 0">${esc(sum.complete
        ? tr("mealTotal", { kcal: sum.kcal })
        : tr("mealTotalPartial", { kcal: sum.kcal, n: sum.counted, total: sum.items }))}</p>`;

  return `
    <datalist id="foodList">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
    <div class="items">${rows}</div>
    <button type="button" class="ghost" id="itemAdd" style="margin-top:8px;padding:9px">${
      esc(tr("addItem"))}</button>
    ${totalLine}
    <p class="note" style="margin:4px 0 0">${esc(tr("foodsApproximate"))}</p>
    <div class="row" style="margin-top:10px">
      <button type="button" class="ghost" id="mealShotBtn" style="margin:0;padding:9px">${
        esc(tr("addPhoto"))}</button>
      <span class="sub" id="mealShotName"></span>
    </div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="ghost" id="mealAddDay" style="margin:0;padding:9px">${
        esc(key === todayKey ? tr("addMealToday") : tr("addMealToDay", { date: shortDay(key) }))}</button>
      ${key === todayKey ? "" :
        `<button type="button" class="ghost" id="mealAddNow" style="margin:0;padding:9px">${esc(tr("logNow"))}</button>`}
    </div>`;
}

/** The diary form on its own, for the Add dialog. */
/** The selected day's diary, and the form to write one. */
/* Five faces, red to green, for the day's overall mood -- one tap, no entry
 * to open. Mouths from a deep frown to an open smile, so the scale reads
 * without the colours too. */
const FACE_COLOURS = ["#d0463b", "#e0873a", "#d8b43a", "#86b84f", "#3e9d5b"];
const FACE_MOUTHS = [
  "M8 18 Q12 13.5 16 18",          // 1 awful
  "M8.5 17 Q12 14.8 15.5 17",      // 2 bad
  "M8.5 16 L15.5 16",              // 3 ok
  "M8.5 15 Q12 17.6 15.5 15",      // 4 good
  "M7.5 14 Q12 20 16.5 14 Z",      // 5 great (open)
];
function moodFacesHTML(current) {
  return `<div class="faces" role="radiogroup" aria-label="${esc(tr("moodToday"))}">${MOODS.map((m, i) => {
    const on = current === m.v;
    const c = FACE_COLOURS[i];
    return `<button type="button" class="faceBtn${on ? " on" : ""}" data-mood="${m.v}" role="radio"
        aria-checked="${on}" aria-label="${esc(tr(m.key))}" title="${esc(tr(m.key))}" style="--fc:${c}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle class="fc" cx="12" cy="12" r="10.2"/>
        <circle class="eye" cx="8.8" cy="9.6" r="1.3"/><circle class="eye" cx="15.2" cy="9.6" r="1.3"/>
        <path class="mouth${i === 4 ? " open" : ""}" d="${FACE_MOUTHS[i]}"/></svg></button>`;
  }).join("")}</div>`;
}

function diaryHTML(day, key, todayKey, trend) {
  const rows = (day?.entries || []).map((e) => {
    const t = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const m = MOODS.find((x) => x.v === e.mood);
    const chips = tagLevels(e).map(({ tag, n }) =>
      `<span class="chip on">${esc(tr(tag) || tag)}${n > 1 ? " " + n : ""}</span>`).join("");
    return `<div class="entry">
      <div class="erow"><b>${esc(t)}</b>
        <span class="mood m${e.mood || 0}">${m ? esc(tr(m.key)) : "·"}</span>
        <span style="flex:1"></span>
        <button type="button" class="linky diaryDel" data-at="${esc(e.at)}"
          aria-label="${esc(tr("delete"))}">×</button></div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      ${e.note ? `<p class="sub" style="margin:4px 0 0;white-space:pre-wrap">${esc(e.note)}</p>` : ""}
    </div>`;
  }).join("");

  /* Said only when there is something to say it from. "3.8 over 12 days" is a
   * claim about twelve days; a bare 3.8 would be read as a claim about the
   * month, and most months have blanks in them. */
  const trendLine = trend
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("moodOverDays", {
        mean: trend.mean.toFixed(1), n: trend.days }))}</p>`
    : "";

  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("diary"))}</div>
    ${trendLine}
    <p class="sub" style="margin:6px 0 0">${esc(tr(key === todayKey ? "moodToday" : "moodThatDay"))}</p>
    ${moodFacesHTML(day?.quick ?? null)}
    ${rows || `<p class="sub" style="margin:6px 0 0">${esc(tr("noDiaryThatDay"))}</p>`}
    <button type="button" class="ghost" id="addDiaryBtn" style="margin-top:8px">${esc(tr("addEntry"))}</button>
  </div>`;
}

export function diaryFormHTML(key, todayKey, tags, draft = { tags: [], levels: {} }) {
  const picker = MOODS.map((m) =>
    `<button type="button" class="moodBtn m${m.v}" data-mood="${m.v}"
       aria-label="${esc(tr(m.key))}">${esc(tr(m.key))}</button>`).join("");

  // Unchosen tags stay chips. Chosen ones get a stepper, on their own row
  // where the − and + are big enough to hit and the number is readable --
  // both crammed into a chip is a 24px target on a phone.
  const chosen = draft.tags || [];
  const chips = tags.filter((t) => !chosen.includes(t)).map((t) =>
    `<button type="button" class="chip tagBtn" data-tag="${esc(t)}">${esc(tr(t) || t)}</button>`).join("");
  const steppers = chosen.map((t) => {
    const n = Number.isFinite(draft.levels?.[t]) ? draft.levels[t] : 1;
    return `<div class="stepRow">
      <span class="stepName">${esc(tr(t) || t)}</span>
      <button type="button" class="stepBtn" data-step-tag="${esc(t)}" data-d="-1"
        aria-label="−">−</button>
      <span class="stepN">${n}</span>
      <button type="button" class="stepBtn" data-step-tag="${esc(t)}" data-d="1"
        aria-label="+" ${n >= LEVEL_MAX ? "disabled" : ""}>+</button>
    </div>`;
  }).join("");

  return `
    <label style="margin-top:10px">${esc(tr("overall"))}</label>
    <div class="moods">${picker}</div>
    ${steppers ? `<div class="steps">${steppers}</div>` : ""}
    <div class="chips" style="margin-top:8px">${chips}
      <button type="button" class="chip addTag" id="tagAdd">+</button></div>
    <p class="note" style="margin:6px 0 0">${esc(tr("levelHint", { max: LEVEL_MAX }))}</p>
    <label for="diaryNote" style="margin-top:8px">${esc(tr("note"))}</label>
    <textarea id="diaryNote" rows="2" placeholder="${esc(tr("notePlaceholder"))}"></textarea>
    <div class="row" style="margin-top:8px">
      <button type="button" class="ghost" id="diaryAddDay" style="margin:0;padding:9px">${
        esc(key === todayKey ? tr("saveToday") : tr("saveToDay", { date: shortDay(key) }))}</button>
      ${key === todayKey ? "" :
        `<button type="button" class="ghost" id="diaryAddNow" style="margin:0;padding:9px">${esc(tr("logNow"))}</button>`}
    </div>`;
}

/** The weight form, for the Add dialog. */
/* ---- weight: the day's figure, a stepper, and the timeline --------------- */

/** A number field with - and + either side, 0.1 kg a tap (held: repeats).
 *  The buttons exist so a weight can be nudged from the last one without the
 *  phone's keyboard coming up at all. Wired by wireSteppers() in index.html.
 *  Called with id="weightKg" (the pre-session dialog) and id="weightDayKg"
 *  (the day view) -- named here so test_dom_ids can see them created. */
export function weightStepperHTML(id, kg) {
  return `<div class="stepper" data-step="0.1" data-min="20" data-max="500">
      <button type="button" class="ghost stepBtn" data-dir="-1" aria-label="${esc(tr("minusTenth"))}">−</button>
      <input id="${esc(id)}" type="number" step="0.1" min="20" max="500" inputmode="decimal"
             value="${kg != null ? (+kg).toFixed(1) : ""}" aria-label="${esc(tr("weightKg"))}">
      <button type="button" class="ghost stepBtn" data-dir="1" aria-label="${esc(tr("plusTenth"))}">+</button>
    </div>`;
}

/** Where a default weight came from, in words: this day, or n days either
 *  side of it. */
export function weightSourceText(near) {
  if (!near) return tr("noWeightYet");
  const kg = near.kg.toFixed(1);
  if (near.offset === 0) return tr("weightOnThisDay", { kg });
  return tr(near.offset < 0 ? "weightFromEarlier" : "weightFromLater",
            { kg, date: shortDay(near.day), n: nDays(Math.abs(near.offset)) });
}

export const WEIGHT_RANGES = { week: 7, month: 30, year: 365 };

/**
 * The timeline, as an inline SVG: a step line (a weight holds until the next
 * one -- see weight.js) with a dot on every actual weigh-in. Colours are
 * the page's own variables, so it follows the light and dark themes.
 */
export function weightChartSVG(win) {
  const W = 320, H = 130, L = 34, R = 8, T = 10, B = 22;
  const vals = [...win.points.map((p) => p.kg), ...(win.carried != null ? [win.carried] : [])];
  if (!vals.length) {
    return `<p class="sub" style="margin:8px 0 0">${esc(tr("noWeightInRange"))}</p>`;
  }
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { const m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const span = win.days - 1 || 1;
  const x = (day) => L + (W - L - R) * (daysFrom(win.start, day) / span);
  const y = (kg) => T + (H - T - B) * (1 - (kg - lo) / (hi - lo));
  const xEnd = W - R;
  // Step path: from the left edge at the carried weight, then flat to each
  // weigh-in and up or down to it, then flat to the right edge.
  let d = "", cur = win.carried, cx = L;
  if (cur != null) d = `M${L},${y(cur).toFixed(1)}`;
  for (const p of win.points) {
    const px = x(p.day);
    if (cur == null) d += `M${px.toFixed(1)},${y(p.kg).toFixed(1)}`;
    else d += `H${px.toFixed(1)}V${y(p.kg).toFixed(1)}`;
    cur = p.kg; cx = px;
  }
  if (cur != null) d += `H${xEnd}`;
  const dots = win.points.map((p) =>
    `<circle cx="${x(p.day).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="${win.days > 60 ? 2 : 3}"
       fill="var(--accent)"><title>${esc(shortDay(p.day))} · ${p.kg.toFixed(1)} kg</title></circle>`).join("");
  const fmt = (v) => v.toFixed(1);
  const lbl = (day) => esc(win.days > 60
    ? localeDay(day).toLocaleDateString([], { month: "short", year: "numeric" })
    : shortDay(day));
  return `<svg class="wchart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${esc(tr("weightTimeline"))}" style="width:100%;height:auto;display:block;margin-top:8px">
    <line x1="${L}" y1="${T}" x2="${xEnd}" y2="${T}" stroke="var(--line)"/>
    <line x1="${L}" y1="${H - B}" x2="${xEnd}" y2="${H - B}" stroke="var(--line)"/>
    <text x="${L - 4}" y="${T + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${fmt(hi)}</text>
    <text x="${L - 4}" y="${H - B + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${fmt(lo)}</text>
    <text x="${L}" y="${H - 6}" font-size="10" fill="var(--muted)">${lbl(win.start)}</text>
    <text x="${xEnd}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--muted)">${lbl(win.end)}</text>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

const daysFrom = (a, b) => {
  const t = (k) => { const [yy, mm, dd] = k.split("-").map(Number); return Date.UTC(yy, mm - 1, dd, 12); };
  return Math.round((t(b) - t(a)) / 86400000);
};

/** The weight section of the day view: what was logged that day (or what is
 *  standing from before), a stepper to log it, and the timeline. */
function weightDayHTML(wts, key, todayKey, range) {
  const r = WEIGHT_RANGES[range] ? range : "month";
  const near = weightNear(wts, key);
  const on = near && near.offset === 0;
  const line = on ? tr("weightOnThisDay", { kg: near.kg.toFixed(1) })
    : near ? `${tr("noWeightThatDay")} · ${weightSourceText(near)}`
    : tr("noWeightYet");
  const win = weightWindow(wts, key, WEIGHT_RANGES[r]);
  return `<div class="daybox" id="weightBox">
    <div style="font-weight:600">${esc(tr("weightTitle"))}</div>
    <p class="sub" style="margin:4px 0 8px">${esc(line)}</p>
    <div class="row" style="align-items:center">
      ${weightStepperHTML("weightDayKg", near ? near.kg : null)}
      <button type="button" class="ghost" id="weightDaySave" style="margin:0;padding:9px;flex:0 0 auto;width:auto">${
        esc(key === todayKey ? tr("saveToday") : tr("saveToDay", { date: shortDay(key) }))}</button>
    </div>
    <div class="seg" role="group" aria-label="${esc(tr("weightTimeline"))}" style="margin-top:10px">
      ${Object.keys(WEIGHT_RANGES).map((k) => `<button type="button" class="ghost wrange${k === r ? " on" : ""}"
        data-range="${k}" aria-pressed="${k === r}">${esc(tr("range_" + k))}</button>`).join("")}
    </div>
    ${weightChartSVG(win)}
  </div>`;
}

/**
 * The whole dashboard as one HTML string.
 *
 * `view` is {year, month, selected}; the caller owns it so that paging months
 * does not lose the selected day, and re-rendering after a new set does not
 * throw the athlete back to today.
 */
export function renderDashboard(sessions, meals, diary, weights, cycle, sleep, vitals, cardio, water,
                                coffee, view, today = new Date()) {
  const days = collectDays(sessions, cardio);
  const mealDays = collectMeals(meals);
  const diaryDays = collectDiary(diary);
  const wts = collectWeights(weights);
  const cycleDays = collectCycle(cycle);
  const sleepDays = collectSleep(sleep);
  const vitalsDays = collectVitals(vitals);
  const waterDays = collectWater(water);
  const coffeeDays = collectCoffee(coffee);
  const o = overall(days, today);
  const todayKey = dayKey(today);
  // "cycle" is deliberately not a mode here: it already has its own section,
  // rendered under the diary on every day (see cycleHTML below), so it does
  // not also need to be a peer of Training/Meals/Diary/Sleep/Vitals in this
  // list. Sleep and vitals have no such section of their own tucked under
  // another one, so they stay normal peer modes -- the calendar can shade
  // nights or step counts the same way it shades meals or diary entries.
  const mode = ["meals", "diary", "sleep", "vitals"].includes(view.mode) ? view.mode : "training";

  // An athlete with no training but a week of meals still has a dashboard.
  /* No special empty state. Every section already says when it has nothing --
   * and the old shortcut rendered a calendar and an Add button ONLY, which
   * meant the first thing anybody wanted to log could not be logged until
   * something else existed. */
  const monthSessions = new Set();
  for (const [key, d0] of days) {
    if (key.startsWith(`${view.year}-${String(view.month + 1).padStart(2, "0")}`)) {
      for (const s of d0.sessions) monthSessions.add(s);
    }
  }
  const nowW = weightOn(wts, todayKey);

  return `
    <div style="font-weight:600;margin:0 0 2px">${esc(tr("monthlySummary"))}</div>
    <p class="sub" style="margin:0 0 6px">${esc(tr("monthSessions", {
      n: monthSessions.size, days: o.days }))}</p>
    ${healthHTML({ heightM: view.heightM, weightKg: nowW ? nowW.kg : null,
                   sex: view.sex, ageY: view.ageY })}
    ${intakeHTML(mealDays, wts, view.year, view.month)}
    <div class="dashCols"><div class="dashLeft">
    <div id="dayHead">
      <div style="font-weight:600">${esc(localeDay(view.selected)
        .toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))}</div>
    </div>
    ${calendarHTML({ meals: mealDays, diary: diaryDays, sleep: sleepDays, vitals: vitalsDays }[mode] || days,
                   view.year, view.month, view.selected, todayKey, mode)}
    ${weightDayHTML(wts, view.selected, todayKey, view.weightRange)}
    </div><div class="dashRight">
    <div class="dayHead2">${esc(localeDay(view.selected)
      .toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))}</div>
    ${dayHTML(days.get(view.selected), view.selected,
              reactionLinesHTML(view.reaction || [], view.selected, today))}
    ${mealsHTML(mealDays.get(view.selected), view.selected, todayKey, waterDays.get(view.selected),
                coffeeDays.get(view.selected))}
    ${diaryHTML(diaryDays.get(view.selected), view.selected, todayKey,
                moodTrend(diaryDays, 30, today))}
    ${sleepHTML(sleepDays, view.selected, todayKey, meanSleep(sleepDays, 14, today))}
    ${vitalsHTML(vitalsDays, view.selected, todayKey, meanSteps(vitalsDays, 14, today))}
    ${cycleHTML(cycleDays, view.selected, todayKey)}
    </div></div>
    ${volumeHTML(days, today)}
    ${achievementsHTML(view.achievements || null)}
    <div class="daybox">
      <div style="font-weight:600">${esc(tr("yourData"))}</div>
      <!-- Filled in after probing for the local Strava helper. The default
           text is the honest one for the common case: no helper running, so
           nothing here can import. index.html swaps it and reveals a button
           only once the helper answers -- same self-declaring rule the
           YouTube link box follows. -->
      <p class="sub" style="margin:6px 0 8px" id="stravaNote">${esc(tr("uploadSoon"))}</p>
      <div class="row" style="margin:0">
        <button type="button" class="ghost" id="stravaConnect" style="margin:0;padding:9px" hidden>${
          esc(tr("stravaConnect"))}</button>
        <button type="button" class="ghost" id="stravaImport" style="margin:0;padding:9px" hidden>${
          esc(tr("stravaImport"))}</button>
      </div>
    </div>
    <button class="ghost" id="shareBtn" style="margin-top:10px">${esc(tr("shareMonth"))}</button>
    <p class="sub" style="margin:12px 0 0">${esc(tr("dashboardCap"))}</p>`;
}

/**
 * A percentile of a list of numbers, by linear interpolation between the two
 * neighbouring order statistics (the same definition numpy uses by default).
 *
 * Exported and tested rather than written inline in the chart, because the
 * off-by-one in `q * n` versus `q * (n - 1)` is invisible on a plot: it shifts
 * every value by one rep's worth and still draws a perfectly plausible
 * whisker. With fewer than three values a percentile is a restatement of the
 * extremes, so it is not offered -- the caller draws the range alone.
 */
export function percentile(values, q) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x))
                  .sort((a, b) => a - b);
  if (v.length < 3) return null;
  const i = q * (v.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
}
