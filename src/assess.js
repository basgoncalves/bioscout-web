/**
 * assess.js -- the physical assessment: three guided tests, one report.
 *
 * The rest of the app logs whatever the athlete happens to do. This does the
 * opposite: a fixed protocol, in a fixed order, so two assessments six weeks
 * apart are comparable and a left-right difference means something.
 *
 *   1. gait   -- walk away from the camera and back until the stop tone,
 *                enough passes for at least ten strides
 *   2. squat  -- three bodyweight squats
 *   3. cmj    -- two countermovement jumps
 *
 * Each test reuses an existing activity and the existing recorder, so nothing
 * about the pose pipeline is duplicated here. What lives here is the protocol,
 * the left-right comparison, the reference bands, and the score.
 *
 * On the score: it is a weighted mean of parts that are all shown alongside
 * it. A single number nobody can take apart is a horoscope, so every component
 * prints its own inputs, and a component with no data is dropped rather than
 * defaulted to something flattering.
 */
import { t as tr } from "./i18n.js";
import { TIPTOE_THRESHOLDS, SYMPTOM_CRITERIA, TIPTOE_CAVEAT, DISTANCES,
         standing } from "./tiptoe_ref.js";

const KEY = "bioscout.assess.v1";

/* The protocol.
 *
 * `recommended` is how many the test wants; `floor` is how few it can still
 * say anything from. Between the two the report is produced and marked short,
 * because an athlete who managed six strides is better served by six strides
 * and a warning than by nothing -- the number is on the page either way, so
 * the reader can judge it. Below the floor there is genuinely nothing to
 * average and the test is treated as not recorded.
 *
 * `perLeg` counts the two legs separately and takes the smaller: ten strides
 * that are nine left and one right is not ten strides of anything.
 */
export const ASSESS_TESTS = [
  { id: "gait",  activity: "walk",  perLeg: true, recommended: 10, floor: 2, seconds: 30 },
  { id: "squat", activity: "squat", recommended: 3,  floor: 1, seconds: 0 },
  { id: "cmj",   activity: "cmj",   recommended: 2,  floor: 1, seconds: 0 },
  // The tip-toe test. Both legs in one clip -- the count that matters is per
  // leg and so is the comparison between them, and asking for two separate
  // recordings of a to-failure test is asking for the second one to be
  // recorded tired.
  { id: "tiptoe", activity: "heelraise", perLeg: true, recommended: 25, floor: 3, seconds: 0 },
  // Neck range of motion. Reported, never scored: there is no population norm
  // for neck range in this project, so the only honest comparison is to the
  // athlete's own earlier tests, which the load panel makes.
  { id: "neck", activity: "neck", recommended: 6, floor: 2, seconds: 0 },
];

/** The target in force for a test: the athlete's own, or the recommendation. */
export function targetFor(t, targets = {}) {
  const v = +targets[t.id];
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : t.recommended;
}

/** How many usable reps a recorded set holds, per leg where that matters. */
export function countReps(t, set) {
  const reps = set?.perRep || [];
  if (!t.perLeg) return { total: reps.length, counted: reps.length, l: null, r: null };
  const l = reps.filter((r) => r.stance_side === "l").length;
  const r = reps.filter((r) => r.stance_side === "r").length;
  return { total: reps.length, l, r, counted: Math.min(l, r) };
}

/* Reference bands: the range a healthy adult typically falls in.
 *
 * THESE ARE ORDER-OF-MAGNITUDE BANDS, not norms from one named cohort, and
 * they are deliberately in one table so they can be replaced wholesale with
 * values from whatever literature the assessment is being read against. A band
 * is [low, high] in the metric's own unit; `wide` is how far outside the band
 * scores zero, so a metric is never a cliff edge.
 */
export const REFERENCE = {
  cadence_spm:       { test: "gait",  band: [100, 125], wide: 25, dp: 0 },
  contact_s:         { test: "gait",  band: [0.60, 0.80], wide: 0.20, dp: 2 },
  duty_factor:       { test: "gait",  band: [0.55, 0.65], wide: 0.10, dp: 2 },
  knee_flex_max_deg: { test: "squat", band: [100, 130], wide: 30, dp: 0 },
  height_flight_m:   { test: "cmj",   band: [0.25, 0.45], wide: 0.15, dp: 2 },
};

/* Metrics compared left against right. Only the gait test carries a side per
 * rep (`stance_side`), which is why the symmetry half of the report rests on
 * walking rather than on the squat: a two-legged squat has one number for both
 * legs and splitting it would be invention. */
export const SIDE_METRICS = ["contact_s", "stride_s", "swing_s"];

/* Limb symmetry: 5% or less passes without comment, 20% or more scores zero.
 * The 10% line in between is the familiar return-to-sport threshold, and it is
 * where this starts calling a difference worth looking at. */
const ASYM_GOOD = 5, ASYM_BAD = 20, ASYM_FLAG = 10;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const nums = (reps, k) => reps.map((r) => r[k])
  .filter((v) => typeof v === "number" && Number.isFinite(v));

/** Percent difference between the two sides, relative to their mean, so the
 *  answer does not depend on which leg is called the reference. */
export function asymmetryPct(l, r) {
  if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
  const m = (Math.abs(l) + Math.abs(r)) / 2;
  return m > 0 ? Math.abs(l - r) / m * 100 : null;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** 100 inside the band, falling to 0 `wide` beyond either edge. */
export function bandScore(value, [lo, hi], wide) {
  if (!Number.isFinite(value)) return null;
  if (value >= lo && value <= hi) return 100;
  const out = value < lo ? lo - value : value - hi;
  return Math.round(clamp01(1 - out / wide) * 100);
}

export function asymScore(pct) {
  if (!Number.isFinite(pct)) return null;
  if (pct <= ASYM_GOOD) return 100;
  if (pct >= ASYM_BAD) return 0;
  return Math.round((1 - (pct - ASYM_GOOD) / (ASYM_BAD - ASYM_GOOD)) * 100);
}

/**
 * The report.
 *
 * `tests` is { gait, squat, cmj } of stored sets (the shape addSet returns:
 * `perRep`, `reps`, `activity`). Missing tests are simply absent from the
 * report -- a partial assessment reports what it has and says what it is
 * missing, rather than scoring the gaps as zero.
 */
export function assessReport(tests = {}, targets = {}) {
  const done = [], missing = [], short = [];
  for (const t of ASSESS_TESTS) {
    const set = tests[t.id];
    const reps = set?.perRep || [];
    const count = countReps(t, set);
    const target = targetFor(t, targets);
    if (count.counted >= t.floor) {
      const entry = { ...t, set, reps, count, target, short: count.counted < target };
      done.push(entry);
      if (entry.short) short.push(entry);
    } else {
      missing.push({ ...t, have: count.counted, count, target });
    }
  }

  // --- left vs right, from the gait strides -------------------------------
  const gait = done.find((d) => d.id === "gait");
  const sides = [];
  if (gait) {
    const L = gait.reps.filter((r) => r.stance_side === "l");
    const R = gait.reps.filter((r) => r.stance_side === "r");
    for (const k of SIDE_METRICS) {
      const l = mean(nums(L, k)), r = mean(nums(R, k));
      const pct = asymmetryPct(l, r);
      if (pct == null) continue;
      sides.push({ key: k, left: l, right: r, pct, score: asymScore(pct),
                   flag: pct >= ASYM_FLAG, nL: L.length, nR: R.length });
    }
    // Reported whichever way the strides were tagged: this one is measured
    // within a rep rather than by comparing two sets of them.
    const ka = mean(nums(gait.reps, "knee_asymmetry_deg"));
    if (ka != null) sides.push({ key: "knee_asymmetry_deg", diffDeg: ka,
                                 pct: null, score: null, flag: Math.abs(ka) >= 5 });
  }

  // --- magnitudes against the reference bands -----------------------------
  const marks = [];
  for (const [key, ref] of Object.entries(REFERENCE)) {
    const d = done.find((x) => x.id === ref.test);
    if (!d) continue;
    const v = mean(nums(d.reps, key));
    if (v == null) continue;
    marks.push({ key, test: ref.test, value: v, band: ref.band, dp: ref.dp,
                 score: bandScore(v, ref.band, ref.wide),
                 within: v >= ref.band[0] && v <= ref.band[1] });
  }

  /* --- tip-toe capacity, reported and NOT scored ------------------------
   *
   * Deliberately outside the score. Every threshold it could be scored
   * against is graded very low -- consensus values that have never been
   * tested against a running outcome -- and folding one into a number that
   * the athlete reads as "my score" would launder that grading away. The
   * count, the symmetry and where they sit are all shown; what they are not
   * is a mark out of a hundred.
   */
  const tt = done.find((d) => d.id === "tiptoe");
  let tiptoe = null;
  if (tt) {
    const l = tt.reps.filter((r) => r.stance_side === "l").length;
    const r = tt.reps.filter((r) => r.stance_side === "r").length;
    const hi = Math.max(l, r), lo = Math.min(l, r);
    const lsi = hi > 0 ? (lo / hi) * 100 : null;
    const repsRow = TIPTOE_THRESHOLDS.find((x) => x.key === "slhr_reps");
    const lsiRow = TIPTOE_THRESHOLDS.find((x) => x.key === "slhr_lsi");
    tiptoe = {
      left: l, right: r, weaker: lo, lsi,
      // The weaker leg against each distance, because the weaker leg is the
      // one that has to do the running too.
      byDistance: DISTANCES.map((d, i) => ({
        distance: d,
        reps: standing(lo, repsRow, i),
        lsi: standing(lsi, lsiRow, i),
      })),
    };
  }

  /* --- neck range, reported and not scored ------------------------------
   * Same reasoning as the tip-toe panel: nothing here has a reference range
   * worth scoring against, so the numbers are shown and left as numbers. */
  const nk = done.find((d) => d.id === "neck");
  let neck = null;
  if (nk) {
    const pick = (k) => {
      const v = nk.reps.map((r) => r[k]).filter((x) => Number.isFinite(x));
      return v.length ? Math.max(...v) : null;
    };
    neck = { reps: nk.reps.length, flex_ext_deg: pick("flex_ext_deg"),
             bend_deg: pick("bend_deg"), rotation_deg: pick("rotation_deg") };
  }

  // --- one number, from parts that are all on the page --------------------
  const symScores = sides.map((s) => s.score).filter((s) => s != null);
  const magScores = marks.map((m) => m.score).filter((s) => s != null);
  const parts = [];
  if (symScores.length) parts.push({ id: "symmetry", score: Math.round(mean(symScores)), weight: 0.5, n: symScores.length });
  if (magScores.length) parts.push({ id: "magnitude", score: Math.round(mean(magScores)), weight: 0.5, n: magScores.length });
  const wsum = parts.reduce((a, p) => a + p.weight, 0);
  const score = parts.length
    ? Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0) / wsum) : null;

  return { done, missing, short, sides, marks, parts, score, tiptoe, neck,
           band: score == null ? null : score >= 85 ? "strong" : score >= 70 ? "typical" : "below",
           // Complete means every test is recorded to its target. A report
           // built from short tests is still a report; it just says so.
           complete: missing.length === 0 && short.length === 0 };
}

/* --- the stored run -------------------------------------------------------
 * One assessment at a time, per athlete, kept across a reload so a phone that
 * sleeps between the squat and the jump has not lost the walk.
 */
const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
};
const write = (v) => {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window */ }
};

export function getAssess(profile = null) {
  const a = read();
  return a && a.profile === profile ? a : null;
}

export function startAssess(profile = null) {
  const a = { profile, started: new Date().toISOString(), tests: {}, targets: {} };
  write(a);
  return a;
}

/** File a recorded set under its test. Returns the updated assessment. */
export function putAssessTest(id, set, profile = null) {
  const a = getAssess(profile) || startAssess(profile);
  a.tests[id] = set;
  write(a);
  return a;
}

export function clearAssess() { write(null); }

/* --- finishing ------------------------------------------------------------
 * An assessment can be finished with two tests, one, or none at all.
 *
 * The session happened whether or not the recordings did: the athlete turned
 * up, the room was booked, the date is a real data point in their history, and
 * a screening that cannot be filed until it is complete is a screening that
 * quietly goes missing whenever a knee hurts or a phone dies. So finishing
 * files what there is and says what is absent, rather than refusing.
 *
 * The gap has to survive as a gap. `missing` is stored explicitly, so a
 * reader months later sees "no jump recorded" rather than an assessment that
 * merely happens not to mention jumps -- and so a later visit can fill it in
 * knowing what it is filling.
 */
const HKEY = "bioscout.assessments.v1";
const HISTORY_MAX = 200;

const readHistory = () => {
  try { return JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch { return []; }
};

export function listAssessments(profile = null) {
  const all = readHistory();
  return profile == null ? all : all.filter((a) => a.profile === profile);
}

export function finishAssess(profile = null, { note = "" } = {}) {
  const a = getAssess(profile);
  // Nothing started is still an attendance: a record is created either way, so
  // "they came in and we got nothing" is a thing the history can say.
  const base = a || startAssess(profile);
  const report = assessReport(base.tests, base.targets);
  const filed = {
    profile,
    started: base.started,
    finished: new Date().toISOString(),
    tests: base.tests,
    targets: base.targets || {},
    note,
    // Denormalised on purpose: the report is what someone will read, and
    // recomputing it later means depending on today's thresholds still being
    // in the code. What was concluded on the day is part of the record.
    recorded: report.done.map((d) => d.id),
    missing: report.missing.map((m) => m.id),
    short: report.short.map((x) => ({ id: x.id, had: x.count.counted, target: x.target })),
    score: report.score,
    attendanceOnly: report.done.length === 0,
  };
  const all = readHistory();
  all.push(filed);
  try { localStorage.setItem(HKEY, JSON.stringify(all.slice(-HISTORY_MAX))); }
  catch { /* private window, or full */ }
  write(null);                       // the next assessment starts clean
  return filed;
}

/** The next test that is not yet recorded to its target, or null. */
export function nextTest(a) {
  return ASSESS_TESTS.find((x) =>
    countReps(x, a?.tests?.[x.id]).counted < targetFor(x, a?.targets)) || null;
}

/** The athlete's own target for a test, kept with the assessment. */
export function setTarget(id, n, profile = null) {
  const a = getAssess(profile) || startAssess(profile);
  a.targets = a.targets || {};
  a.targets[id] = Math.max(1, Math.round(+n) || 1);
  write(a);
  return a;
}

/* --- rendering ------------------------------------------------------------
 * Pure HTML from the report, so the page can be re-rendered from stored data
 * alone and the whole thing can be checked without a browser.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmt = (v, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : "—");
const SIDE_DP = { contact_s: 3, stride_s: 3, swing_s: 3 };

/** The dial, reused from the health rating's shape so the two read as one app. */
function scoreDial(score) {
  const r = 34, c = 2 * Math.PI * r, on = c * (score / 100);
  const col = score >= 85 ? "var(--good)" : score >= 70 ? "var(--accent)" : "var(--warn)";
  return `<svg class="dial" viewBox="0 0 80 80" role="img" aria-label="${esc(tr("assessScoreAria", { n: score }))}">
    <circle cx="40" cy="40" r="${r}" fill="none" stroke="var(--line)" stroke-width="7"/>
    <circle cx="40" cy="40" r="${r}" fill="none" stroke="${col}" stroke-width="7"
      stroke-linecap="round" stroke-dasharray="${on.toFixed(1)} ${(c - on).toFixed(1)}"
      transform="rotate(-90 40 40)"/>
    <text x="40" y="46" text-anchor="middle" font-size="21" font-weight="700" fill="var(--ink)">${score}</text>
  </svg>`;
}

/* The tip-toe panel.
 *
 * Every number here carries its grading in the same table cell region as the
 * number itself, because the review this comes from exists precisely because
 * these values circulate stripped of it. "Meets" is written as meets the
 * consensus value, never as ready, cleared, or passed. */
function tiptoeHTML(tt) {
  if (!tt) return "";
  const rows = tt.byDistance.map((d) => {
    const cell = (st) => {
      if (!st) return `<td style="text-align:right">—</td>`;
      const col = st.meets ? "var(--good)" : "var(--warn)";
      return `<td style="text-align:right;color:${col}">${st.lo === st.hi ? st.lo : st.lo + "–" + st.hi}</td>`;
    };
    return `<tr><td>${esc(d.distance)}</td>${cell(d.reps)}${cell(d.lsi)}</tr>`;
  }).join("");
  const lsiTxt = tt.lsi == null ? "—" : tt.lsi.toFixed(0) + "%";
  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("tiptoeTitle"))}</div>
    <p class="sub" style="margin:2px 0 8px">${esc(tr("tiptoeSub"))}</p>
    <p style="margin:0 0 8px">${esc(tr("tiptoeCounts", {
      l: tt.left, r: tt.right, weaker: tt.weaker, lsi: lsiTxt }))}</p>
    <table><thead><tr><th>${esc(tr("tiptoeDistance"))}</th>
      <th style="text-align:right">${esc(tr("tiptoeRepsCol"))}</th>
      <th style="text-align:right">${esc(tr("tiptoeLsiCol"))}</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="note" style="color:var(--warn);margin-top:8px">${esc(tr("tiptoeGrade"))}</p>
    <p class="note">${esc(TIPTOE_CAVEAT)}</p>
    <div style="font-weight:600;margin-top:10px">${esc(tr("tiptoeSymptomTitle"))}</div>
    <ul class="sub" style="margin:4px 0 0;padding-left:18px">${SYMPTOM_CRITERIA.map((c) =>
      `<li>${esc(c.text)} <span class="note">(${esc(c.grade)})</span></li>`).join("")}</ul>
  </div>`;
}

/* The neck panel: three ranges and nothing else. No band, no score, no
 * comparison to a population that this project has not measured. */
function neckHTML(nk) {
  if (!nk) return "";
  const row = (k) => `<tr><td>${esc(tr("var_" + k) === "var_" + k ? k : tr("var_" + k))}</td>
    <td style="text-align:right">${nk[k] == null ? "\u2014" : nk[k].toFixed(0) + "\u00b0"}</td></tr>`;
  return `<div class="daybox">
    <div style="font-weight:600">${esc(tr("neckTestTitle"))}</div>
    <p class="sub" style="margin:2px 0 8px">${esc(tr("neckTestSub", { n: nk.reps }))}</p>
    <table><tbody>${["flex_ext_deg", "bend_deg", "rotation_deg"].map(row).join("")}</tbody></table>
    <p class="note">${esc(tr("neckTestNote"))}</p>
  </div>`;
}

export function assessReportHTML(report) {
  const { sides, marks, parts, score, band, missing, short, tiptoe, neck } = report;

  const head = score == null
    ? `<p class="sub">${esc(tr("assessNothingYet"))}</p>`
    : `<div class="health">${scoreDial(score)}<div class="healthText">
        <div style="font-weight:600">${esc(tr("assessScore"))}</div>
        <p class="sub" style="margin:2px 0 0">${esc(tr("assessBand_" + band))}</p>
        <p class="note" style="margin:4px 0 0">${parts.map((p) =>
          esc(tr("assessPart_" + p.id) + ": " + p.score)).join(" · ")}</p>
      </div></div>`;

  const missLine = missing.length
    ? `<p class="note">${esc(tr("assessMissing", {
        tests: missing.map((m) => tr("assessTest_" + m.id)).join(", ") }))}</p>`
    : "";

  /* Said once, plainly, above the numbers it applies to. A short test is not
   * wrong, it is thinner: fewer reps means the mean of them moves around more,
   * and a left-right difference from three strides is a weaker claim than the
   * same difference from ten. The reader is told which tests, and how short. */
  const shortLine = short.length
    ? `<p class="note" style="color:var(--warn)">${esc(tr("assessShortWarn", {
        tests: short.map((x) => tr("assessTest_" + x.id)
          + ` (${x.count.counted}/${x.target}${x.perLeg ? " " + tr("assessPerLeg") : ""})`).join(", "),
      }))}</p>`
    : "";

  const sideRows = sides.filter((s) => s.key !== "knee_asymmetry_deg").map((s) =>
    `<tr><td>${esc(tr("var_" + s.key) === "var_" + s.key ? s.key : tr("var_" + s.key))}</td>
      <td style="text-align:right">${fmt(s.left, SIDE_DP[s.key] ?? 2)}</td>
      <td style="text-align:right">${fmt(s.right, SIDE_DP[s.key] ?? 2)}</td>
      <td style="text-align:right;${s.flag ? "color:var(--warn)" : ""}">${fmt(s.pct, 1)}%</td></tr>`).join("");
  const knee = sides.find((s) => s.key === "knee_asymmetry_deg");

  const markRows = marks.map((m) =>
    `<tr><td>${esc(tr("var_" + m.key) === "var_" + m.key ? m.key : tr("var_" + m.key))}</td>
      <td style="text-align:right">${fmt(m.value, m.dp)}</td>
      <td style="text-align:right;color:var(--muted)">${fmt(m.band[0], m.dp)}–${fmt(m.band[1], m.dp)}</td>
      <td style="text-align:right;${m.within ? "" : "color:var(--warn)"}">${m.score}</td></tr>`).join("");

  return `${head}${missLine}${shortLine}
    ${sideRows ? `<div class="daybox"><div style="font-weight:600">${esc(tr("assessSides"))}</div>
      <p class="sub" style="margin:2px 0 8px">${esc(tr("assessSidesSub"))}</p>
      <table><thead><tr><th>${esc(tr("measure"))}</th><th style="text-align:right">${esc(tr("assessLeft"))}</th>
        <th style="text-align:right">${esc(tr("assessRight"))}</th>
        <th style="text-align:right">${esc(tr("assessDiff"))}</th></tr></thead>
        <tbody>${sideRows}</tbody></table>
      ${knee ? `<p class="note">${esc(tr("assessKneeAsym", { deg: fmt(knee.diffDeg, 1) }))}</p>` : ""}
      </div>` : ""}
    ${markRows ? `<div class="daybox"><div style="font-weight:600">${esc(tr("assessMarks"))}</div>
      <p class="sub" style="margin:2px 0 8px">${esc(tr("assessMarksSub"))}</p>
      <table><thead><tr><th>${esc(tr("measure"))}</th><th style="text-align:right">${esc(tr("assessYou"))}</th>
        <th style="text-align:right">${esc(tr("assessBandCol"))}</th>
        <th style="text-align:right">${esc(tr("scoreCol"))}</th></tr></thead>
        <tbody>${markRows}</tbody></table></div>` : ""}
    ${tiptoeHTML(tiptoe)}
    ${neckHTML(neck)}
    <p class="note">${esc(tr("assessCaveat"))}</p>`;
}
