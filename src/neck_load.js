/**
 * neck_load.js -- training load for neck work, and a neck capacity test.
 *
 * Two things that are usually conflated, kept apart here on purpose.
 *
 * LOAD is what the athlete did: sets and reps of neck work over the weeks, and
 * whether this week is a lot more than the weeks behind it. That is ordinary
 * training-load bookkeeping and it needs no model.
 *
 * CAPACITY is what the neck can do: the range it can move through, measured by
 * the neck test. It is reported beside the load, not multiplied into it.
 *
 * The two are then put beside a THIRD thing -- what a cervical-spine model says
 * the neck has to resist at 1-6 g of cornering load (neck_gload.js, from
 * N. Berger's thesis). That comparison is the reason this file exists, and its
 * limits have to be stated where the code is, not only in the interface:
 *
 *   * The model is an ISOMETRIC HOLD against a lateral force in a fixed neutral
 *     posture. The neck test is a slow, unloaded range-of-motion task. Neither
 *     is neck strength, and neither predicts the other.
 *   * From about 4 g the model is out of muscle -- a third of its 72 muscles
 *     saturate -- so those rows describe what the neck cannot do, not what it
 *     does.
 *   * Nothing here says an athlete with a given range or a given weekly volume
 *     can tolerate a given g. No study in this project tested that, and the
 *     functions below deliberately provide no way to express it.
 *
 * So: `neckLoadSeries` and `neckAcuteChronic` answer "how much have they been
 * doing"; `neckCapacity` answers "what did the test measure"; and the g-load
 * table is shown alongside as context, unjoined.
 */

const DAY = 86400000;

const dayKeyOf = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return null;
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Every neck set out of a list of sessions, tagged with the day it happened. */
export function neckSets(sessions = []) {
  const out = [];
  for (const s of sessions || []) {
    for (const set of s?.sets || []) {
      if (set.activity !== "neck") continue;
      const at = set.at || s.started;
      const key = dayKeyOf(at);
      if (key) out.push({ at, key, reps: set.reps || 0, set });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * Daily neck volume, in reps.
 *
 * Reps, not a made-up load unit. A neck rep has no external load to multiply by
 * -- the head is the load and it does not change between sessions -- so reps
 * are the honest currency, and inventing an intensity factor to dress them up
 * as "arbitrary units" would add precision that is not there.
 */
export function neckLoadSeries(sessions = [], days = 42, today = new Date()) {
  const end = new Date(today); end.setHours(0, 0, 0, 0);
  const byDay = new Map();
  for (const s of neckSets(sessions)) {
    byDay.set(s.key, (byDay.get(s.key) || 0) + s.reps);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(+end - i * DAY);
    const p = (x) => String(x).padStart(2, "0");
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    out.push({ key, reps: byDay.get(key) || 0 });
  }
  return out;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

/**
 * This week against the four before it.
 *
 * The acute:chronic ratio is a familiar way to ask "is this week unusual", and
 * that is all it is used for here. It is reported as a ratio with both its
 * inputs beside it, never as a risk: the injury-prediction claims made for this
 * number have been contested hard in the literature, and a neck-training
 * version of it has never been studied at all.
 *
 * Returns null rather than a number when there is no chronic history to compare
 * against -- a first week of training has no ratio, and 1.0 would be a lie.
 */
export function neckAcuteChronic(sessions = [], today = new Date()) {
  /* Five weeks, so the four chronic weeks are the ones BEFORE this one rather
   * than including it. A chronic window that contains the acute week dampens
   * exactly the spike the ratio exists to show -- a week of triple volume
   * comes out at 2.3 instead of 4 -- and it also gives a first-ever week a
   * chronic average to divide by, which is a ratio invented out of nothing. */
  const series = neckLoadSeries(sessions, 35, today);
  const acute = sum(series.slice(-7).map((d) => d.reps));
  const priorWeeks = [];
  for (let w = 0; w < 4; w++) {
    priorWeeks.push(sum(series.slice(w * 7, w * 7 + 7).map((d) => d.reps)));
  }
  const chronic = sum(priorWeeks) / 4;
  return {
    acute,
    chronic: +chronic.toFixed(1),
    weeks: priorWeeks,
    ratio: chronic > 0 ? +(acute / chronic).toFixed(2) : null,
    // Whether anything at all sits in the chronic window, which is what makes
    // the ratio mean something rather than merely exist.
    enough: priorWeeks.some((w) => w > 0),
  };
}

/**
 * What the neck test measured: the three ranges, and how they compare with the
 * athlete's own best. There is no population norm for neck range in this
 * project, so the comparison is to themselves -- which is the comparison that
 * survives not having one.
 */
export function neckCapacity(sessions = [], { latestOnly = false } = {}) {
  const sets = neckSets(sessions);
  if (!sets.length) return null;
  const KEYS = ["flex_ext_deg", "bend_deg", "rotation_deg"];
  const all = sets.flatMap((s) => s.set.perRep || []);
  if (!all.length) return null;
  const best = {}, latest = {};
  for (const k of KEYS) {
    const v = all.map((r) => r[k]).filter((x) => Number.isFinite(x));
    best[k] = v.length ? Math.max(...v) : null;
  }
  const lastSet = sets[sets.length - 1];
  for (const k of KEYS) {
    const v = (lastSet.set.perRep || []).map((r) => r[k]).filter((x) => Number.isFinite(x));
    latest[k] = v.length ? Math.max(...v) : null;
  }
  return {
    keys: KEYS, best, latest, at: lastSet.at,
    sessions: new Set(sets.map((s) => s.key)).size,
    reps: sum(sets.map((s) => s.reps)),
    // Per measure: is the most recent test within 10% of their best, or down on
    // it? A drop is worth looking at; it is not a diagnosis of anything.
    down: KEYS.filter((k) => Number.isFinite(best[k]) && Number.isFinite(latest[k])
                             && best[k] > 0 && latest[k] < 0.9 * best[k]),
  };
}

/* --- rendering ------------------------------------------------------------ */

const esc = (s2) => String(s2).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Six weeks of daily neck reps as bars. Empty days are drawn as empty, not
 *  skipped: the gaps between sessions are the shape of the training. */
function loadBars(series, width = 420, height = 90) {
  const max = Math.max(1, ...series.map((d) => d.reps));
  const w = width / series.length;
  const bars = series.map((d, i) => {
    if (!d.reps) return "";
    const h = (d.reps / max) * (height - 16);
    return `<rect x="${(i * w + w * 0.15).toFixed(1)}" y="${(height - 12 - h).toFixed(1)}"
      width="${(w * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="var(--accent)"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img"
      aria-label="${esc(tr("neckLoadBarsAria", { n: series.length }))}"
      style="display:block;max-width:${width}px">
    ${bars}
    <line x1="0" x2="${width}" y1="${height - 12}" y2="${height - 12}" stroke="var(--line)"/>
    <text x="0" y="${height - 1}" font-size="10" fill="var(--muted)">${esc(tr("neckLoadWeeksAgo", { n: 6 }))}</text>
    <text x="${width}" y="${height - 1}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(tr("today"))}</text>
  </svg>`;
}

let tr = (k) => k;
/** The i18n function is injected rather than imported so this module stays
 *  testable without a dictionary, and so the caller cannot forget to pass it. */
export function setNeckLoadTr(fn) { if (typeof fn === "function") tr = fn; }

export function neckLoadHTML(sessions, today = new Date()) {
  const series = neckLoadSeries(sessions, 42, today);
  const ac = neckAcuteChronic(sessions, today);
  const cap = neckCapacity(sessions);
  if (!series.some((d) => d.reps) && !cap) return "";

  const ratioLine = ac.ratio == null
    ? `<p class="sub" style="margin:2px 0 0">${esc(tr("neckLoadNoChronic"))}</p>`
    : `<p class="sub" style="margin:2px 0 0">${esc(tr("neckLoadRatio", {
        acute: ac.acute, chronic: ac.chronic, ratio: ac.ratio.toFixed(2) }))}</p>`;

  const capBlock = !cap ? "" : `
    <div style="font-weight:600;margin-top:10px">${esc(tr("neckLoadRange"))}</div>
    <table><thead><tr><th></th>
      <th style="text-align:right">${esc(tr("neckLoadLatest"))}</th>
      <th style="text-align:right">${esc(tr("neckLoadBest"))}</th></tr></thead>
      <tbody>${cap.keys.map((k) => {
        const down = cap.down.includes(k);
        const f = (v) => (v == null ? "\u2014" : v.toFixed(0) + "\u00b0");
        return `<tr><td>${esc(tr("var_" + k) === "var_" + k ? k : tr("var_" + k))}</td>
          <td style="text-align:right;${down ? "color:var(--warn)" : ""}">${f(cap.latest[k])}</td>
          <td style="text-align:right;color:var(--muted)">${f(cap.best[k])}</td></tr>`;
      }).join("")}</tbody></table>
    ${cap.down.length ? `<p class="note" style="color:var(--warn)">${esc(tr("neckLoadDown"))}</p>` : ""}`;

  return `<div class="daybox" id="neckLoadBox">
    <div style="font-weight:600">${esc(tr("neckLoadTitle2"))}</div>
    <p class="sub" style="margin:2px 0 6px">${esc(tr("neckLoadSub2", {
      reps: series.reduce((a, b) => a + b.reps, 0), n: 6 }))}</p>
    ${loadBars(series)}
    ${ratioLine}
    <p class="note">${esc(tr("neckLoadRatioNote"))}</p>
    ${capBlock}
  </div>`;
}
