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

/* Plurals come from the dictionary keys the session card already uses, rather
 * than from new ones. "3 reps in 1 sets" is the kind of thing that makes an
 * app look machine-made, and English is the easy case -- German needs it too. */
const nSets = (n) => tr(n === 1 ? "nSet" : "nSets", { n });
const nReps = (n) => tr(n === 1 ? "nRep" : "nRepsCount", { n });

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
export function collectDays(sessions) {
  const days = new Map();
  for (const s of sessions) {
    for (const set of s.sets || []) {
      const key = dayKey(set.at || s.started);
      if (!key) continue;
      if (!days.has(key)) {
        days.set(key, { key, sets: [], reps: 0, activities: new Set(), sessions: new Set() });
      }
      const d = days.get(key);
      d.sets.push({ ...set, session: s.started, profile: s.profile ?? null });
      d.reps += set.reps || 0;
      if (set.activity) d.activities.add(set.activity);
      d.sessions.add(s.started);
    }
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
const weightOf = (mode) => (d) => (mode === "meals" ? d.meals.length : d.reps);

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
    if (c.key === todayKey) cls.push("today");
    if (c.key === selected) cls.push("sel");
    const label = !hit ? c.key
      : mode === "meals"
        ? tr("dayCellMeals", { date: c.key, n: hit.meals.length })
        : tr("dayCellLabel", { date: c.key, reps: nReps(hit.reps), sets: nSets(hit.sets.length) });
    return `<button type="button" class="${cls.join(" ")}" data-day="${c.key}"
      ${hit ? "" : "disabled"} title="${esc(label)}" aria-label="${esc(label)}">
      <span>${c.date.getDate()}</span></button>`;
  }).join("");

  const title = new Date(year, month, 1)
    .toLocaleDateString([], { month: "long", year: "numeric" });

  return `
    <div class="calmode">
      <select id="dashMode" aria-label="${esc(tr("calendarShows"))}">
        <option value="training"${mode === "meals" ? "" : " selected"}>${esc(tr("modeTraining"))}</option>
        <option value="meals"${mode === "meals" ? " selected" : ""}>${esc(tr("modeMeals"))}</option>
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

function dayHTML(day, key) {
  const date = localeDay(key).toLocaleDateString([],
    { weekday: "long", day: "numeric", month: "long" });
  if (!day) {
    return `<div class="daybox"><div class="sub" style="margin:0">${esc(date)}</div>
      <p class="sub" style="margin:6px 0 0">${esc(tr("noTrainingThatDay"))}</p></div>`;
  }
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const rows = day.sets.map((s) => {
    const load = [s.addedKg ? "+" + s.addedKg : "", s.assistKg ? "−" + s.assistKg : ""]
      .filter(Boolean).join(" ");
    return `<tr><td>${esc(time(s.at))}</td><td>${esc(tr(s.activity))}</td>
      <td>${s.reps}</td><td>${esc(load)}</td></tr>`;
  }).join("");
  const acts = [...day.activities].map((a) => esc(tr(a))).join(", ");
  return `<div class="daybox">
    <div style="font-weight:600">${esc(date)}</div>
    <p class="sub" style="margin:2px 0 8px">${esc(tr("daySub", {
      sets: nSets(day.sets.length), reps: nReps(day.reps),
    }))}${day.sessions.size > 1 ? " · " + esc(tr("nSessionsOnDay", { n: day.sessions.size })) : ""
    }${acts ? " · " + acts : ""}</p>
    <table><thead><tr><th>${esc(tr("time"))}</th><th>${esc(tr("movement"))}</th>
      <th>${esc(tr("reps"))}</th><th>${esc(tr("load"))}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

/** The selected day's meals, and the form to add one to it. */
function mealsHTML(day, key, todayKey) {
  const rows = (day?.meals || []).map((m) => {
    const t = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<tr><td>${esc(t)}</td><td>${esc(m.text)}</td>
      <td style="text-align:right">${m.kcal ?? "—"}</td>
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
    <div class="row" style="margin-top:10px">
      <div style="flex:2.2">
        <label for="mealText">${esc(tr("meal"))}</label>
        <input id="mealText" type="text" autocomplete="off" placeholder="${esc(tr("mealPlaceholder"))}">
      </div>
      <div style="flex:1">
        <label for="mealKcal">${esc(tr("kcalOptional"))}</label>
        <input id="mealKcal" type="number" min="0" step="10" inputmode="numeric">
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="ghost" id="mealAddDay" style="margin:0;padding:9px">${
        esc(key === todayKey ? tr("addMealToday") : tr("addMealToDay", { date: shortDay(key) }))}</button>
      ${key === todayKey ? "" :
        `<button type="button" class="ghost" id="mealAddNow" style="margin:0;padding:9px">${esc(tr("logNow"))}</button>`}
    </div>
  </div>`;
}

const shortDay = (key) =>
  localeDay(key).toLocaleDateString([], { day: "numeric", month: "short" });

/**
 * The whole dashboard as one HTML string.
 *
 * `view` is {year, month, selected}; the caller owns it so that paging months
 * does not lose the selected day, and re-rendering after a new set does not
 * throw the athlete back to today.
 */
export function renderDashboard(sessions, meals, view, today = new Date()) {
  const days = collectDays(sessions);
  const mealDays = collectMeals(meals);
  const o = overall(days, today);
  const todayKey = dayKey(today);
  const mode = view.mode === "meals" ? "meals" : "training";

  // An athlete with no training but a week of meals still has a dashboard.
  if (!o.days && !mealDays.size) {
    return `<h1 style="font-size:17px;margin:0 0 2px">${esc(tr("dashboardTitle"))}</h1>
      <p class="sub" style="margin:0">${esc(tr("dashboardEmpty"))}</p>`;
  }

  const tile = (v, label) =>
    `<div class="tile"><b>${v}</b><span>${esc(label)}</span></div>`;

  return `
    <h1 style="font-size:17px;margin:0 0 2px">${esc(tr("dashboardTitle"))}</h1>
    <p class="sub" style="margin:0 0 10px">${esc(tr("dashboardSub", {
      first: localeDay(o.first).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }),
    }))}</p>
    <div class="tiles">
      ${tile(o.days, tr("tileDays"))}
      ${tile(o.sessions, tr("tileSessions"))}
      ${tile(o.reps, tr("tileReps"))}
      ${tile(o.streak, tr("tileStreak"))}
    </div>
    ${calendarHTML(mode === "meals" ? mealDays : days,
                   view.year, view.month, view.selected, todayKey, mode)}
    ${dayHTML(days.get(view.selected), view.selected)}
    ${mealsHTML(mealDays.get(view.selected), view.selected, todayKey)}
    ${volumeHTML(days, today)}
    <p class="sub" style="margin:12px 0 0">${esc(tr("dashboardCap"))}</p>`;
}
