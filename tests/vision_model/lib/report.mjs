/**
 * report.mjs -- the tables.
 *
 * Two outputs, because they answer different questions:
 *
 *   report.md    the decision. One row per model, the numbers that decide
 *                whether to switch, and an explicit verdict line.
 *   report.html  the evidence. Every clip, every joint, every waveform drawn
 *                against the ground truth, so a disagreement can be looked at
 *                rather than argued about from an RMSE.
 *
 * The HTML is self-contained (no CDN, no fetch): it is opened from disk, and
 * the app's own deploy notes are a long story about pages that looked fine and
 * were not serving what they claimed.
 */

const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "--");
const pct = (v, d = 1) => (Number.isFinite(v) ? (v * 100).toFixed(d) + "%" : "--");

function mdTable(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => "| " + cells.map((c, i) => String(c ?? "").padEnd(w[i])).join(" | ") + " |";
  return [line(head), "|" + w.map((n) => "-".repeat(n + 2)).join("|") + "|",
          ...rows.map(line)].join("\n");
}

export function markdown(run) {
  const { models, clips, perModel, perClip, thresholds, baseline } = run;
  const L = [];
  L.push(`# Vision-model comparison -- BioScout`, "");
  L.push(`Run ${run.startedAt}  |  ${clips.length} clip(s), ${models.length} model(s)`);
  L.push(`Baseline: **${baseline}** (what the app ships today)`, "");

  L.push(`## Verdict`, "");
  for (const m of models) {
    const s = perModel[m.id];
    if (!s) continue;
    L.push(`- **${m.id}** -- ${s.verdict}`);
  }
  L.push("");

  L.push(`## Accuracy against marker-based IK`, "");
  L.push(mdTable(
    ["model", "joint RMSE deg", "after bias deg", "bias deg", "ROM err deg", "r", "joints"],
    models.filter((m) => perModel[m.id]).map((m) => {
      const s = perModel[m.id].gt;
      return [m.id, f(s.rmse), f(s.rmseDetrended), f(s.bias), f(s.romErr), f(s.r, 3), s.n];
    })));
  L.push("", `Median over every scored joint and clip. RMSE threshold ${thresholds.rmseDeg} deg.`, "");

  L.push(`## What the app then reports`, "");
  L.push(mdTable(
    ["model", "task called right", "rep count right", "rep diff", "outcome drift vs baseline"],
    models.filter((m) => perModel[m.id]).map((m) => {
      const s = perModel[m.id].task;
      return [m.id, `${s.activityOk}/${s.activityN}`, `${s.repsOk}/${s.repsN}`,
              s.repDiffs.join(","), s.drift];
    })));
  L.push("");

  L.push(`## Tracking quality (no ground truth needed)`, "");
  L.push(mdTable(
    ["model", "detection", "key landmarks", "jitter %torso", "segment CV %", "swaps/s"],
    models.filter((m) => perModel[m.id]).map((m) => {
      const q = perModel[m.id].quality;
      return [m.id, pct(q.detection), pct(q.keyPresence), f(q.jitterPct),
              f(q.segmentCV, 1), f(q.swapsPerS, 3)];
    })));
  L.push("");

  L.push(`## Cost`, "");
  L.push(mdTable(
    ["model", "size MB", "load ms", "first frame ms", "median ms/frame", "p95 ms", "x baseline"],
    models.filter((m) => perModel[m.id]).map((m) => {
      const t = perModel[m.id].timing;
      return [m.id, f(t.sizeMB, 1), f(t.loadMs, 0), f(t.firstMs, 0),
              f(t.medianMs, 1), f(t.p95Ms, 1), f(t.vsBaseline, 2)];
    })));
  L.push("", "> Measured in headless Chromium on the machine that ran this, not on a phone.",
         "> Read the ratios, not the milliseconds.", "");

  L.push(`## Per clip`, "");
  for (const c of clips) {
    L.push(`### ${c.id} -- ${c.activity}`, "");
    const rows = [];
    for (const m of models) {
      const r = perClip[`${c.id}__${m.id}`];
      if (!r) continue;
      rows.push([m.id, r.error ? "ERROR: " + r.error : (r.task?.classified ?? "--"),
                 r.task?.nReps ?? "--",
                 f(r.gtSummary?.rmse), f(r.quality?.jitterPct), f(r.timing?.medianMs, 1)]);
    }
    L.push(mdTable(["model", "called it", "reps", "RMSE deg", "jitter", "ms/frame"], rows));
    L.push("");
    // Per joint, for the models that had ground truth.
    for (const m of models) {
      const r = perClip[`${c.id}__${m.id}`];
      if (!r || !r.gt || !Object.keys(r.gt).length) continue;
      L.push(`**${m.id}** per joint` + (r.align ? `  (lag ${f(r.align.lag, 3)} s on ${r.align.channel}, r=${f(r.align.r, 3)})` : ""), "");
      L.push(mdTable(["joint", "RMSE", "after bias", "bias", "ROM est", "ROM ref", "peak err", "r", "n"],
        Object.entries(r.gt).map(([j, a]) => [j, f(a.rmse), f(a.rmseDetrended), f(a.bias),
                                              f(a.romEst, 1), f(a.romRef, 1), f(a.peakErr), f(a.r, 3), a.n])));
      L.push("");
    }
  }
  if (run.notes && run.notes.length) {
    L.push(`## Notes and refusals`, "");
    for (const n of run.notes) L.push(`- ${n}`);
    L.push("");
  }
  return L.join("\n");
}

/** A self-contained HTML report with one waveform plot per joint per clip. */
export function html(run) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const plots = [];
  for (const c of run.clips) {
    for (const j of run.plotJoints[c.id] || []) {
      const series = [];
      let ref = null;
      for (const m of run.models) {
        const r = run.perClip[`${c.id}__${m.id}`];
        if (!r || !r.plot || !r.plot[j]) continue;
        series.push({ name: m.id, y: r.plot[j].est, t: r.plot[j].t });
        if (!ref && r.plot[j].ref) ref = { name: "IK", y: r.plot[j].ref, t: r.plot[j].t };
      }
      if (series.length) plots.push({ clip: c.id, joint: j, series, ref });
    }
  }
  return `<!doctype html><meta charset="utf-8"><title>Vision models -- BioScout</title>
<style>
 :root{--bg:#fff;--fg:#151515;--mut:#666;--line:#ddd}
 @media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--mut:#999;--line:#333}}
 body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1000px;margin-inline:auto}
 h1{font-size:22px} h2{font-size:17px;margin-top:28px;border-bottom:1px solid var(--line);padding-bottom:4px}
 table{border-collapse:collapse;width:100%;margin:8px 0;font-variant-numeric:tabular-nums}
 th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:right} th:first-child,td:first-child{text-align:left}
 .wrap{overflow-x:auto} figure{margin:12px 0} figcaption{color:var(--mut);font-size:12px}
 svg{width:100%;height:190px;display:block} .leg span{margin-right:12px;font-size:12px}
 pre{white-space:pre-wrap}
</style>
<h1>Vision-model comparison</h1>
<p>${esc(run.startedAt)} &middot; baseline <b>${esc(run.baseline)}</b></p>
<div class="wrap"><pre>${esc(markdown(run))}</pre></div>
<h2>Waveforms against the lab</h2>
${plots.map((p) => plotSvg(p)).join("\n")}
`;

  function plotSvg({ clip, joint, series, ref }) {
    const all = [...series.map((s) => s.y), ref ? ref.y : []].flat().filter(Number.isFinite);
    if (!all.length) return "";
    const lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.08 || 1;
    const tAll = series[0].t;
    const t0 = tAll[0], t1 = tAll[tAll.length - 1];
    const X = (t) => ((t - t0) / (t1 - t0 || 1)) * 960 + 30;
    const Y = (v) => 170 - ((v - lo + pad) / (hi - lo + 2 * pad)) * 160;
    const COL = ["#3b7dd8", "#d86a3b", "#4aa564", "#9b59b6", "#c0392b"];
    const path = (t, y) => y.map((v, i) => (Number.isFinite(v)
      ? `${i && Number.isFinite(y[i - 1]) ? "L" : "M"}${X(t[i]).toFixed(1)},${Y(v).toFixed(1)}` : "")).join("");
    return `<figure><figcaption>${esc(clip)} &middot; ${esc(joint)} (deg)</figcaption>
<svg viewBox="0 0 1000 190" preserveAspectRatio="none">
 ${ref ? `<path d="${path(ref.t, ref.y)}" fill="none" stroke="#888" stroke-width="3" stroke-dasharray="6 4"/>` : ""}
 ${series.map((s, i) => `<path d="${path(s.t, s.y)}" fill="none" stroke="${COL[i % COL.length]}" stroke-width="1.6"/>`).join("\n ")}
</svg>
<div class="leg">${ref ? `<span style="color:#888">-- IK</span>` : ""}${series.map((s, i) => `<span style="color:${COL[i % COL.length]}">&#9632; ${esc(s.name)}</span>`).join("")}</div>
</figure>`;
  }
}
