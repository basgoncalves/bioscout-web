/**
 * athsummary.js -- the athlete's summary page (#viewSummary): means over the
 * last week, month, three months and year, side by side, so progression reads
 * across a row.
 *
 *   Body composition   weigh-in mean per window and the change across it
 *   Training volume    sessions, sets, reps, cardio time per window
 *   Timeline           reps per week, last 12 weeks
 *   Main metrics       per movement, the set means of the key rep measures
 *   Fresh vs fatigued  last 7 days: each movement's last set of a session
 *                      (fatigued) against its earlier sets (fresh)
 *   Achievements       the badge list the dashboard already draws
 *
 * "Good" set = an ordinary (non-assessment) set with at least one rep left
 * after rep removal -- removed reps are already out of perRep. A session with
 * one set of a movement has no fatigued set for it: nothing came before.
 *
 * Pure computation is exported for tests/test_athsummary.mjs; the markup is
 * one function, athleteSummaryHTML.
 */
import { t as tr } from "./i18n.js";

export const ASM_WINDOWS = [["week", 7], ["month", 30], ["quarter", 90], ["year", 365]];

/* The rep measures worth comparing, in display order, with unit and decimals.
 * Anything not listed is not shown -- perRep also carries flags and sides. */
export const ASM_METRICS = [
  ["duration_s", "s", 2], ["up_s", "s", 2], ["down_s", "s", 2],
  ["jump_height_m", "m", 3], ["height_flight_m", "m", 3], ["flight_s", "s", 3],
  ["depth_m", "m", 3], ["travel_m", "m", 3],
  ["knee_flex_max_deg", "°", 0], ["hip_flex_max_deg", "°", 0], ["elbow_flex_max_deg", "°", 0],
  ["stance_knee_flex_max_deg", "°", 0], ["hip_range_deg", "°", 0],
  ["peak_grf_bw", "BW", 2], ["peak_knee_Nm", "N·m", 0], ["peak_hip_Nm", "N·m", 0],
  ["peak_ankle_Nm", "N·m", 0], ["release_height_m", "m", 2],
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const num = (v) => typeof v === "number" && Number.isFinite(v);

/** First day key of an n-day window ending on `end` (inclusive). */
export function windowStart(end, n) {
  const d = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  d.setDate(d.getDate() - (n - 1));
  return keyOf(d);
}

const inWin = (key, from, to) => key >= from && key <= to;

/** Good sets, with each one marked fresh or fatigued (see header). */
export function labelSets(days) {
  const bySess = new Map();
  for (const d of days.values()) {
    for (const s of d.sets || []) {
      if (s.assess || !(s.reps > 0)) continue;
      const k = `${s.session}|${s.activity}`;
      if (!bySess.has(k)) bySess.set(k, []);
      bySess.get(k).push({ ...s, day: d.key || keyOf(new Date(s.at)) });
    }
  }
  const out = [];
  for (const list of bySess.values()) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    list.forEach((s, i) => out.push({ ...s, fatigued: list.length > 1 && i === list.length - 1 }));
  }
  return out;
}

/** Mean of one rep measure per set, then across sets. */
function setMean(set, m) {
  const v = (set.perRep || []).map((r) => r[m]).filter(num);
  return mean(v);
}

export function metricMeans(sets) {
  const out = { n: sets.length, reps: mean(sets.map((s) => s.reps)) };
  for (const [m] of ASM_METRICS) {
    const v = sets.map((s) => setMean(s, m)).filter(num);
    if (v.length) out[m] = mean(v);
  }
  return out;
}

/** Everything the page shows, as numbers. */
export function athleteSummary({ days, weights = [], achievements = [] }, today = new Date()) {
  const toKey = keyOf(today);
  const sets = labelSets(days);
  const wins = ASM_WINDOWS.map(([name, n]) => {
    const from = windowStart(today, n);
    const w = weights.filter((x) => inWin(x.day, from, toKey));
    const dayList = [...days.values()].filter((d) => inWin(d.key, from, toKey));
    const sess = new Set();
    let nSets = 0, reps = 0, cardioS = 0;
    for (const d of dayList) {
      for (const s of d.sets || []) { sess.add(s.session); nSets++; reps += s.reps || 0; }
      cardioS += d.cardioSeconds || 0;
    }
    return {
      name, n, from,
      weight: w.length ? { mean: mean(w.map((x) => x.kg)), first: w[0].kg, last: w[w.length - 1].kg, n: w.length } : null,
      volume: { days: dayList.length, sessions: sess.size, sets: nSets, reps, cardioMin: Math.round(cardioS / 60) },
      sets: sets.filter((s) => inWin(s.day, from, toKey)),
    };
  });
  const acts = [...new Set(sets.map((s) => s.activity))].sort();
  const metrics = acts.map((a) => ({
    activity: a,
    byWin: wins.map((w) => metricMeans(w.sets.filter((s) => s.activity === a))),
  })).filter((x) => x.byWin.some((m) => m.n));
  const wk = wins[0].sets;
  const fatigue = [...new Set(wk.map((s) => s.activity))].sort().map((a) => ({
    activity: a,
    fresh: metricMeans(wk.filter((s) => s.activity === a && !s.fatigued)),
    tired: metricMeans(wk.filter((s) => s.activity === a && s.fatigued)),
  })).filter((x) => x.fresh.n && x.tired.n);
  // Reps per week, 12 weeks, oldest first, the last one ending today.
  const weekly = [];
  for (let i = 11; i >= 0; i--) {
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7 * i);
    const from = windowStart(end, 7), to = keyOf(end);
    let r = 0;
    for (const d of days.values()) if (inWin(d.key, from, to)) r += d.reps || 0;
    weekly.push({ to, reps: r });
  }
  return { wins, metrics, fatigue, weekly, achievements };
}

/* ---- markup ------------------------------------------------------------ */

const fmt = (v, dp) => (num(v) ? v.toFixed(dp) : "–");
const delta = (a, b) => (num(a) && num(b) && a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null);
const pct = (d) => (d == null ? "" : `<span class="sub">${d >= 0 ? "+" : ""}${d.toFixed(0)}%</span>`);

function table(head, rows) {
  return `<div style="overflow-x:auto"><table class="asmTable"><thead><tr>${
    head.map((h, i) => `<th${i ? ' style="text-align:right"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) =>
      `<td${i ? ' style="text-align:right"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function weeklySVG(weekly) {
  const W = 320, H = 120, L = 6, B = 18, max = Math.max(1, ...weekly.map((w) => w.reps));
  const bw = (W - 2 * L) / weekly.length;
  const bars = weekly.map((w, i) => {
    const h = w.reps ? Math.max(2, ((H - B - 8) * w.reps) / max) : 0;
    return `<rect x="${(L + i * bw + bw * 0.15).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}"
      height="${h.toFixed(1)}" rx="2" fill="var(--accent)" opacity="${i === weekly.length - 1 ? 1 : 0.7}"><title>${w.reps}</title></rect>`;
  }).join("");
  const lbl = (i, a) => `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="${a}" font-size="10" fill="var(--muted)">${esc(weekly[i].to.slice(5))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(tr("asmWeekly"))}">
    <line x1="${L}" x2="${W - L}" y1="${H - B}" y2="${H - B}" stroke="var(--line)"/>${bars}${lbl(0, "start")}${lbl(weekly.length - 1, "end")}</svg>`;
}

export function athleteSummaryHTML(sum, { name = "", heightM = null, achievementsHTML = "" } = {}) {
  const winNames = sum.wins.map((w) => tr("asmWin_" + w.name));
  const sec = (title, body) => `<div class="daybox"><div style="font-weight:600;margin-bottom:6px">${esc(title)}</div>${body}</div>`;

  // Body composition
  const bmi = (kg) => (heightM && num(kg) ? ` <span class="sub">BMI ${(kg / (heightM * heightM)).toFixed(1)}</span>` : "");
  const body = sum.wins.some((w) => w.weight)
    ? table([tr("asmPeriod"), tr("asmMeanKg"), tr("asmChange")], sum.wins.map((w, i) => [
      esc(winNames[i]),
      w.weight ? `${w.weight.mean.toFixed(1)} kg${bmi(w.weight.mean)}` : "–",
      w.weight && w.weight.n > 1 ? `${(w.weight.last - w.weight.first >= 0 ? "+" : "")}${(w.weight.last - w.weight.first).toFixed(1)} kg` : "–",
    ]))
    : `<p class="sub" style="margin:0">${esc(tr("noWeightYet"))}</p>`;

  // Volume
  const vol = table([tr("asmPeriod"), tr("asmSessions"), tr("asmSets"), tr("asmReps"), tr("asmCardio")],
    sum.wins.map((w, i) => [esc(winNames[i]), w.volume.sessions, w.volume.sets, w.volume.reps,
      w.volume.cardioMin ? `${w.volume.cardioMin} min` : "–"]));

  // Main metrics per movement
  const metricRows = (cols) => {
    const rows = [[esc(tr("asmRepsPerSet")), ...cols.map((c) => fmt(c.reps, 1))],
                  [esc(tr("asmSetsCounted")), ...cols.map((c) => c.n || "–")]];
    for (const [k, unit, dp] of ASM_METRICS) {
      if (!cols.some((c) => num(c[k]))) continue;
      rows.push([`${esc(tr("asm_m_" + k))} <span class="sub">${esc(unit)}</span>`, ...cols.map((c) => fmt(c[k], dp))]);
    }
    return rows;
  };
  const metrics = sum.metrics.length
    ? sum.metrics.map((m) => `<div style="font-weight:600;margin:10px 0 2px">${esc(tr(m.activity))}</div>`
      + table([tr("asmMetric"), ...winNames], metricRows(m.byWin))).join("")
    : `<p class="sub" style="margin:0">${esc(tr("asmNoSets"))}</p>`;

  // Fresh vs fatigued
  const fat = sum.fatigue.length
    ? sum.fatigue.map((f) => {
      const rows = [[esc(tr("asmRepsPerSet")), fmt(f.fresh.reps, 1), fmt(f.tired.reps, 1), pct(delta(f.fresh.reps, f.tired.reps))],
                    [esc(tr("asmSetsCounted")), f.fresh.n, f.tired.n, ""]];
      for (const [k, unit, dp] of ASM_METRICS) {
        if (!num(f.fresh[k]) && !num(f.tired[k])) continue;
        rows.push([`${esc(tr("asm_m_" + k))} <span class="sub">${esc(unit)}</span>`,
                   fmt(f.fresh[k], dp), fmt(f.tired[k], dp), pct(delta(f.fresh[k], f.tired[k]))]);
      }
      return `<div style="font-weight:600;margin:10px 0 2px">${esc(tr(f.activity))}</div>`
        + table([tr("asmMetric"), tr("asmFresh"), tr("asmFatigued"), tr("asmDiff")], rows);
    }).join("")
    : `<p class="sub" style="margin:0">${esc(tr("asmNoFatigue"))}</p>`;

  return `<h2 style="font-size:17px;margin:0 0 2px">${esc(tr("asmTitle"))}</h2>
    <p class="sub" style="margin:0 0 8px">${esc(name)}</p>
    ${sec(tr("asmBody"), body)}
    ${sec(tr("asmVolume"), vol)}
    ${sec(tr("asmWeekly"), weeklySVG(sum.weekly))}
    ${sec(tr("asmMetrics"), metrics + `<p class="note" style="margin:8px 0 0">${esc(tr("asmMetricsNote"))}</p>`)}
    ${sec(tr("asmFatigue"), fat + `<p class="note" style="margin:8px 0 0">${esc(tr("asmFatigueNote"))}</p>`)}
    ${achievementsHTML}
    <p class="sub" style="margin:10px 0 0">${esc(tr("asmMore"))}</p>`;
}
