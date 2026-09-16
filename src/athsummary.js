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
import { REFERENCE } from "./assess.js";

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

/** Mean of one rep measure within a set. */
function setMean(set, m) {
  return mean((set.perRep || []).map((r) => r[m]).filter(num));
}

/** {mean, min, max, n} of a list, or null. */
export function stats(v) {
  const x = v.filter(num);
  return x.length ? { mean: mean(x), min: Math.min(...x), max: Math.max(...x), n: x.length } : null;
}

/** Per metric: mean and range of the SET means (one value per set). */
export function metricStats(sets) {
  const out = { n: sets.length, reps: stats(sets.map((s) => s.reps)) };
  for (const [m] of ASM_METRICS) {
    const st = stats(sets.map((s) => setMean(s, m)));
    if (st) out[m] = st;
  }
  return out;
}

/** Everything the page shows, as numbers, for every task at once. */
export function athleteSummary({ days, weights = [] }, today = new Date()) {
  const toKey = keyOf(today);
  const sets = labelSets(days);
  const wins = ASM_WINDOWS.map(([name, n]) => {
    const from = windowStart(today, n);
    const w = weights.filter((x) => inWin(x.day, from, toKey));
    const dayList = [...days.values()].filter((d) => inWin(d.key, from, toKey));
    const perSess = new Map();
    let nSets = 0, reps = 0, cardioS = 0;
    for (const d of dayList) {
      for (const s of d.sets || []) {
        perSess.set(s.session, (perSess.get(s.session) || 0) + (s.reps || 0));
        nSets++; reps += s.reps || 0;
      }
      cardioS += d.cardioSeconds || 0;
    }
    return {
      name, n, from,
      weight: w.length ? { ...stats(w.map((x) => x.kg)), change: w[w.length - 1].kg - w[0].kg } : null,
      volume: { days: dayList.length, sessions: perSess.size, sets: nSets, reps,
                repsPerSession: stats([...perSess.values()]), cardioMin: Math.round(cardioS / 60) },
      sets: sets.filter((s) => inWin(s.day, from, toKey)),
    };
  });
  const tasks = [...new Set(sets.map((s) => s.activity))].sort();
  const weekly = [];
  for (let i = 11; i >= 0; i--) {
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7 * i);
    const from = windowStart(end, 7), to = keyOf(end);
    let r = 0;
    for (const d of days.values()) if (inWin(d.key, from, to)) r += d.reps || 0;
    weekly.push({ to, reps: r });
  }
  return { wins, tasks, weekly };
}

/** One task: stats per window, and fresh vs fatigued over the last week. */
export function taskStats(sum, task) {
  const of = (list) => list.filter((s) => s.activity === task);
  const wk = of(sum.wins[0].sets);
  return {
    byWin: sum.wins.map((w) => metricStats(of(w.sets))),
    fresh: metricStats(wk.filter((s) => !s.fatigued)),
    tired: metricStats(wk.filter((s) => s.fatigued)),
    weekSets: wk,
  };
}

/** Resample an array to n points on 0..100 %. */
export function resample(a, n = 101) {
  const v = Array.from(a || [], Number);
  if (v.length < 2) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * (v.length - 1)) / (n - 1), lo = Math.floor(x), hi = Math.min(v.length - 1, lo + 1);
    out[i] = v[lo] + (v[hi] - v[lo]) * (x - lo);
  }
  return out.some(num) ? out : null;
}

/* Compact per-set mean waveform, stored ON the set (profiles.addSet) so it
 * syncs with the log and outlives the 12-set curve store: angle and moment
 * only, 51 points, 0.1 precision -- a couple of kB a set. */
export const WAVE_METRICS = ["angle", "moment"];
export function setWave(reps) {
  const acc = {};
  for (const r of reps || []) {
    for (const [k, v] of Object.entries(r.jm || {})) {
      const m = k.match(/^[a-z]+_([a-z]+)(?:_[lr])?$/);
      if (!m || !WAVE_METRICS.includes(m[1])) continue;
      const rs = resample(v, 51);
      if (rs) (acc[k] = acc[k] || []).push(rs);
    }
  }
  const out = {};
  for (const [k, list] of Object.entries(acc)) {
    out[k] = list[0].map((_, i) => {
      const x = mean(list.map((c) => c[i]).filter(num));
      return num(x) ? Math.round(x * 10) / 10 : null;
    });
  }
  return Object.keys(out).length ? out : null;
}

const meanCurve = (list) => (list.length
  ? list[0].map((_, i) => mean(list.map((c) => c[i]).filter(num))) : null);

/**
 * Mean waveforms of one metric (angle/vel/moment/power) per jm key, fresh and
 * fatigued. Each rep is time-normalised to 0-100 %, averaged within its set,
 * then the set means are averaged -- so a 12-rep set does not outweigh a
 * 4-rep one. `getCurves(session, index)` is profiles.js's.
 */
export function curveSummary(weekSets, getCurves, metric) {
  const acc = new Map();   // key -> {fresh: [setMean], tired: [setMean]}
  for (const s of weekSets) {
    let c = null;
    try { c = getCurves(s.session, s.index); } catch { c = null; }
    const perKey = new Map();
    if (!c || !Array.isArray(c.reps)) {
      // No full curves on this device (recorded elsewhere, or evicted):
      // fall back to the compact mean the set itself carries.
      for (const [k, v] of Object.entries(s.wave || {})) {
        const m = k.match(/^([a-z]+)_([a-z]+)(?:_([lr]))?$/);
        const rs = m && m[2] === metric ? resample(v) : null;
        if (rs) perKey.set(k, [rs]);
      }
      c = { reps: [] };
    }
    for (const r of c.reps) {
      for (const [k, v] of Object.entries(r.jm || {})) {
        const m = k.match(/^([a-z]+)_([a-z]+)(?:_([lr]))?$/);
        if (!m || m[2] !== metric) continue;
        const rs = resample(v);
        if (!rs) continue;
        if (!perKey.has(k)) perKey.set(k, []);
        perKey.get(k).push(rs);
      }
    }
    for (const [k, list] of perKey) {
      if (!acc.has(k)) acc.set(k, { fresh: [], tired: [] });
      acc.get(k)[s.fatigued ? "tired" : "fresh"].push(meanCurve(list));
    }
  }
  return [...acc].map(([key, v]) => {
    const m = key.match(/^([a-z]+)_[a-z]+(?:_([lr]))?$/);
    return { key, joint: m[1], side: m[2] || null,
             fresh: meanCurve(v.fresh), nFresh: v.fresh.length,
             tired: meanCurve(v.tired), nTired: v.tired.length };
  });
}

/** App reference band for a task's metric, from assess.js (rough, not a norm). */
export function refBandFor(task, metric) {
  const r = REFERENCE[metric];
  return r && r.test === task ? r.band : null;
}

/* ---- markup ------------------------------------------------------------ */

const f = (v, dp) => (num(v) ? v.toFixed(dp) : "–");
/** "mean (min–max)", or just the mean when there is one value. */
export const mr = (st, dp) => (!st ? "–" : st.n > 1
  ? `${f(st.mean, dp)} <span class="sub">(${f(st.min, dp)}–${f(st.max, dp)})</span>` : f(st.mean, dp));
const delta = (a, b) => (a && b && num(a.mean) && num(b.mean) && a.mean !== 0
  ? ((b.mean - a.mean) / Math.abs(a.mean)) * 100 : null);
const pct = (d) => (d == null ? "" : `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`);

function table(head, rows) {
  return `<div style="overflow-x:auto"><table class="asmTable"><thead><tr>${
    head.map((h, i) => `<th${i ? ' style="text-align:right"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) =>
      `<td${i ? ' style="text-align:right"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function weeklySVG(weekly) {
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

/**
 * Waveform plot, 0-100 % of the rep. `lines`: [{y, color, dash, label}],
 * `bands`: [{lo, hi, color}] drawn underneath (literature ranges).
 */
export function curveSVG(lines, bands = [], unit = "") {
  const W = 340, H = 200, L = 38, R = 8, T = 8, B = 22;
  const all = [...lines.flatMap((l) => l.y), ...bands.flatMap((b) => [...b.lo, ...b.hi])].filter(num);
  if (!all.length) return "";
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const X = (i, n) => L + ((W - L - R) * i) / (n - 1);
  const Y = (v) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const path = (y) => y.map((v, i) => (num(v) ? `${i && num(y[i - 1]) ? "L" : "M"}${X(i, y.length).toFixed(1)},${Y(v).toFixed(1)}` : "")).join("");
  let out = "";
  for (const b of bands) {
    const n = b.lo.length;
    const top = b.hi.map((v, i) => `${i ? "L" : "M"}${X(i, n).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const bot = b.lo.map((v, i) => `L${X(n - 1 - i, n).toFixed(1)},${Y(b.lo[n - 1 - i]).toFixed(1)}`).join("");
    out += `<path d="${top}${bot}Z" fill="${b.color}" opacity=".15"/>`;
  }
  for (const t of [lo + pad, (lo + hi) / 2, hi - pad]) {
    out += `<line x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="var(--line)" opacity=".6"/>
      <text x="${L - 4}" y="${(Y(t) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${t.toFixed(Math.abs(hi - lo) < 5 ? 1 : 0)}</text>`;
  }
  if (lo < 0 && hi > 0) out += `<line x1="${L}" x2="${W - R}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="var(--muted)" opacity=".5"/>`;
  for (const l of lines) {
    out += `<path d="${path(l.y)}" fill="none" stroke="${l.color}" stroke-width="2" opacity="${l.op ?? 1}" ${
      l.dash ? 'stroke-dasharray="6 4"' : ""} stroke-linejoin="round"><title>${esc(l.label)}</title></path>`;
  }
  out += `<text x="${L}" y="${H - 6}" font-size="10" fill="var(--muted)">0%</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--muted)">100% ${esc(tr("asmOfRep"))}</text>
    <text x="4" y="${T + 8}" font-size="10" fill="var(--muted)">${esc(unit)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${out}</svg>`;
}

const sec = (title, body, id = "") => `<div class="daybox"${id ? ` id="${id}"` : ""}><div style="font-weight:600;margin-bottom:6px">${esc(title)}</div>${body}</div>`;

/** Static sections: body composition, volume, weekly reps. `on` = ticked windows. */
export function generalHTML(sum, on, heightM = null) {
  const wins = sum.wins.filter((w) => on.includes(w.name));
  const bmi = (kg) => (heightM && num(kg) ? ` <span class="sub">· BMI ${(kg / (heightM * heightM)).toFixed(1)}</span>` : "");
  const body = wins.some((w) => w.weight)
    ? table([tr("asmPeriod"), tr("asmMeanKg"), tr("asmChange")], wins.map((w) => [
      esc(tr("asmWin_" + w.name)),
      w.weight ? `${mr(w.weight, 1)} kg${bmi(w.weight.mean)}` : "–",
      w.weight && w.weight.n > 1 ? `${w.weight.change >= 0 ? "+" : ""}${w.weight.change.toFixed(1)} kg` : "–",
    ]))
    : `<p class="sub" style="margin:0">${esc(tr("noWeightYet"))}</p>`;
  const vol = table([tr("asmPeriod"), tr("asmSessions"), tr("asmSets"), tr("asmReps"), tr("asmRepsPerSession"), tr("asmCardio")],
    wins.map((w) => [esc(tr("asmWin_" + w.name)), w.volume.sessions, w.volume.sets, w.volume.reps,
      mr(w.volume.repsPerSession, 0), w.volume.cardioMin ? `${w.volume.cardioMin} min` : "–"]));
  return sec(tr("asmBody"), body) + sec(tr("asmVolume"), vol) + sec(tr("asmWeekly"), weeklySVG(sum.weekly));
}

/** The task table: one row per metric, one column per ticked window, plus the
 *  app's reference band where one exists, plus fresh / fatigued / change. */
export function taskTableHTML(sum, ts, task, on) {
  const cols = sum.wins.map((w, i) => ({ w, st: ts.byWin[i] })).filter((c) => on.includes(c.w.name));
  const hasRef = ASM_METRICS.some(([k]) => refBandFor(task, k));
  const pickOf = (key) => (st) => (key === "reps" ? st.reps : st[key]);
  const label = (t, unit) => `${esc(t)}${unit ? ` <span class="sub">${esc(unit)}</span>` : ""}`;
  const shown = [["reps", "", 1, tr("asmRepsPerSet")],
    ...ASM_METRICS.filter(([k]) => cols.some((c) => c.st[k]) || ts.fresh[k] || ts.tired[k])
      .map(([k, u, dp]) => [k, u, dp, tr("asm_m_" + k)])];
  // Periods (narrow enough for a phone: the fatigue comparison is its own table).
  const t1 = table([tr("asmMetric"), ...cols.map((c) => tr("asmWin_" + c.w.name)), ...(hasRef ? [tr("asmRef")] : [])], [
    ...shown.map(([k, u, dp, t]) => {
      const b = refBandFor(task, k);
      return [label(t, u), ...cols.map((c) => mr(pickOf(k)(c.st), dp)), ...(hasRef ? [b ? `${b[0]}–${b[1]}` : ""] : [])];
    }),
    [esc(tr("asmSetsCounted")), ...cols.map((c) => c.st.n || "–"), ...(hasRef ? [""] : [])]]);
  const t2 = table([tr("asmMetric"), tr("asmFresh"), tr("asmFatigued"), tr("asmDiff")], [
    ...shown.map(([k, u, dp, t]) => [label(t, u), mr(pickOf(k)(ts.fresh), dp), mr(pickOf(k)(ts.tired), dp),
                                     pct(delta(pickOf(k)(ts.fresh), pickOf(k)(ts.tired)))]),
    [esc(tr("asmSetsCounted")), ts.fresh.n || "–", ts.tired.n || "–", ""]]);
  return t1 + `<div style="font-weight:600;margin:12px 0 4px">${esc(tr("asmFatigue"))}</div>` + t2
    + `<p class="note" style="margin:6px 0 0">${esc(tr("asmTableNote"))}${hasRef ? " " + esc(tr("asmRefNote")) : ""}</p>`;
}
