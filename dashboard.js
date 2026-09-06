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
import { collectWeights, weightOn, weightSeries } from "./weight.js";
import { collectCycle, cycleStarts, cycleLengths, lengthStats, predictNext,
         dayOfCycle, phaseModel, LUTEAL_DAYS, FLOWS } from "./cycle.js";
import { itemKcal, mealKcal, describe } from "./foods.js";

/* Plurals come from the dictionary keys the session card already uses, rather
 * than from new ones. "3 reps in 1 sets" is the kind of thing that makes an
 * app look machine-made, and English is the easy case -- German needs it too. */
const nSets = (n) => tr(n === 1 ? "nSet" : "nSets", { n });
const nReps = (n) => tr(n === 1 ? "nRep" : "nRepsCount", { n });
const nDays = (n) => tr(n === 1 ? "nDay" : "nDays", { n });

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
  mode === "cycle" ? (d.flow || 1)          // a logged day with no flow still shows
  : mode === "meals" ? d.meals.length
  : mode === "diary" ? (d.rated ? d.mood : 0.5)   // an unrated day still shows faintly
  : d.reps;

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
      : mode === "cycle"
        ? tr("dayCellCycle", { date: c.key, flow: hit.flow
            ? tr(FLOWS.find((f) => f.v === hit.flow).key) : tr("logged") })
      : mode === "diary"
        ? tr("dayCellDiary", { date: c.key, mood: hit.rated ? hit.mood.toFixed(1) : "—" })
      : mode === "meals"
        ? tr("dayCellMeals", { date: c.key, n: hit.meals.length })
        : tr("dayCellLabel", { date: c.key, reps: nReps(hit.reps), sets: nSets(hit.sets.length) });
    // Every day is selectable, empty ones included: the dashboard is where
    // things get added, and you cannot add to a day you cannot select.
    return `<button type="button" class="${cls.join(" ")}" data-day="${c.key}"
      title="${esc(label)}" aria-label="${esc(label)}">
      <span>${c.date.getDate()}</span></button>`;
  }).join("");

  const title = new Date(year, month, 1)
    .toLocaleDateString([], { month: "long", year: "numeric" });

  return `
    <div class="calmode">
      <select id="dashMode" aria-label="${esc(tr("calendarShows"))}">
        <option value="training"${mode === "meals" ? "" : " selected"}>${esc(tr("modeTraining"))}</option>
        <option value="meals"${mode === "meals" ? " selected" : ""}>${esc(tr("modeMeals"))}</option>
        <option value="diary"${mode === "diary" ? " selected" : ""}>${esc(tr("modeDiary"))}</option>
        <option value="cycle"${mode === "cycle" ? " selected" : ""}>${esc(tr("modeCycle"))}</option>
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
  if (!day) {
    return `<div class="daybox"><div style="font-weight:600">${esc(tr("modeTraining"))}</div>
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
    <div style="font-weight:600">${esc(tr("modeTraining"))}</div>
    <p class="sub" style="margin:2px 0 8px">${esc(tr("daySub", {
      sets: nSets(day.sets.length), reps: nReps(day.reps),
    }))}${day.sessions.size > 1 ? " · " + esc(tr("nSessionsOnDay", { n: day.sessions.size })) : ""
    }${acts ? " · " + acts : ""}</p>
    <table><thead><tr><th>${esc(tr("time"))}</th><th>${esc(tr("movement"))}</th>
      <th>${esc(tr("reps"))}</th><th>${esc(tr("load"))}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
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

/** The selected day's meals, and the form to add one to it. */
function mealsHTML(day, key, todayKey) {
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
    : `<p class="sub" style="margin:2px 0 0">${esc(tr("cycleNotEnough", { n: starts.length }))}</p>`;

  const predLine = pred
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("cycleDue", {
        date: shortDay(pred.due), spread: nDays(pred.spread), n: pred.stats.n }))}</p>`
    : "";

  const model = phaseModel(cycleDays);
  const ring = model ? ringHTML(model, cycleDays, todayKey) : "";
  const legend = model ? `<div class="ringKey">
      <span><i class="kPeriod"></i>${esc(tr("phasePeriod"))}</span>
      ${model.fertile ? `<span><i class="kFertile"></i>${esc(tr("phaseFertile"))}</span>` : ""}
      ${model.ovulation ? `<span><i class="kOvu"></i>${esc(tr("phaseOvulation"))}</span>` : ""}
      <span><i class="kLogged"></i>${esc(tr("phaseLogged"))}</span>
    </div>
    <p class="note" style="margin:6px 0 0">${esc(tr("phaseNote", { luteal: LUTEAL_DAYS }))}</p>` : "";

  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("cycle"))}</div>
    ${ring}${legend}
    ${dayLine}${histLine}${predLine}
    <p class="note" style="margin:6px 0 0">${esc(tr("cycleCaveat"))}</p>
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

  const centre = day
    ? `<tspan x="${CX}" dy="-4" class="ringBig">${day}</tspan>
       <tspan x="${CX}" dy="17" class="ringSmall">${esc(tr("ofNDays", { n: cycle }))}</tspan>`
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

/** The cycle form, for the Add dialog. */
export function cycleFormHTML(key, current, symptoms) {
  const flows = FLOWS.map((f) =>
    `<button type="button" class="chip flowBtn" data-flow="${f.v}">${esc(tr(f.key))}</button>`).join("");
  const chips = symptoms.map((s) =>
    `<button type="button" class="chip symBtn" data-sym="${esc(s)}">${esc(tr(s) || s)}</button>`).join("");
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
    return `<div class="itemRow">
      <input class="itemName" data-i="${i}" list="foodList" value="${esc(it.name || "")}"
             placeholder="${esc(tr("foodName"))}" autocomplete="off">
      <button type="button" class="stepBtn gramStep" data-i="${i}" data-d="-10">−</button>
      <input class="itemGrams" data-i="${i}" type="number" inputmode="numeric" min="0" step="5"
             value="${it.grams ?? ""}" aria-label="${esc(tr("grams"))}">
      <button type="button" class="stepBtn gramStep" data-i="${i}" data-d="10">+</button>
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
    ${rows || `<p class="sub" style="margin:6px 0 0">${esc(tr("noDiaryThatDay"))}</p>`}
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
export function weightFormHTML(key, todayKey, current) {
  return `
    <p class="sub" style="margin:0 0 8px">${esc(current
      ? tr("weightCarried", { kg: current.kg.toFixed(1), n: nDays(current.stale) })
      : tr("noWeightYet"))}</p>
    <label for="weightKg">${esc(tr("weightKg"))}</label>
    <input id="weightKg" type="number" step="0.1" min="20" max="500" inputmode="decimal"
           value="${current ? current.kg.toFixed(1) : ""}">
    <div class="row" style="margin-top:8px">
      <button type="button" class="ghost" id="weightAddDay" style="margin:0;padding:9px">${
        esc(key === todayKey ? tr("saveToday") : tr("saveToDay", { date: shortDay(key) }))}</button>
    </div>`;
}

/**
 * The whole dashboard as one HTML string.
 *
 * `view` is {year, month, selected}; the caller owns it so that paging months
 * does not lose the selected day, and re-rendering after a new set does not
 * throw the athlete back to today.
 */
export function renderDashboard(sessions, meals, diary, weights, cycle, view, today = new Date()) {
  const days = collectDays(sessions);
  const mealDays = collectMeals(meals);
  const diaryDays = collectDiary(diary);
  const wts = collectWeights(weights);
  const cycleDays = collectCycle(cycle);
  const o = overall(days, today);
  const todayKey = dayKey(today);
  const mode = ["meals", "diary", "cycle"].includes(view.mode) ? view.mode : "training";

  // An athlete with no training but a week of meals still has a dashboard.
  if (!o.days && !mealDays.size && !diaryDays.size && !cycleDays.size) {
    return `<p class="sub" style="margin:0 0 10px">${esc(tr("dashboardEmpty"))}</p>
      ${calendarHTML(days, view.year, view.month, view.selected, todayKey, "training")}
      <button class="ghost" id="addBtn" style="margin-top:10px">${esc(tr("addEntry"))}</button>`;
  }

  return `
    <div style="font-weight:600;margin:0 0 2px">${esc(tr("monthlySummary"))}</div>
    ${intakeHTML(mealDays, wts, view.year, view.month)}
    <div id="dayHead">
      <div style="font-weight:600">${esc(localeDay(view.selected)
        .toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))}</div>
      ${(() => { const w = weightOn(wts, view.selected); return w
        ? `<p class="sub" style="margin:2px 0 0">${esc(w.stale === 0
            ? tr("weightMeasured", { kg: w.kg.toFixed(1) })
            : tr("weightCarried", { kg: w.kg.toFixed(1), n: nDays(w.stale) }))}</p>`
        : ""; })()}
      <button class="ghost" id="addBtn" style="margin-top:8px">${esc(tr("addEntry"))}</button>
    </div>
    ${calendarHTML({ meals: mealDays, diary: diaryDays, cycle: cycleDays }[mode] || days,
                   view.year, view.month, view.selected, todayKey, mode)}
    ${dayHTML(days.get(view.selected), view.selected)}
    ${mealsHTML(mealDays.get(view.selected), view.selected, todayKey)}
    ${diaryHTML(diaryDays.get(view.selected), view.selected, todayKey,
                moodTrend(diaryDays, 30, today))}
    ${cycleHTML(cycleDays, view.selected, todayKey)}
    ${volumeHTML(days, today)}
    <p class="sub" style="margin:12px 0 0">${esc(tr("dashboardCap"))}</p>`;
}
