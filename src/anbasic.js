/* Analysis → Basic: a small spreadsheet (type or paste from Excel) with descriptive
 * statistics per column: n, mean, SD, SEM, min, max, median and the t-based
 * confidence interval of the mean. Maths from stats.js (describe, tInv). */
import * as S from "./stats.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (s) => { const t = String(s ?? "").trim().replace(",", "."); return t === "" ? NaN : Number(t); };
const fmt = (v, d = 3) => (Number.isFinite(v) ? (+v.toFixed(d)).toString() : "–");

const B = { head: ["A", "B", "C"], rows: Array.from({ length: 10 }, () => ["", "", ""]), conf: 0.95 };

export function statsOf(col, conf) {
  const d = S.describe(col.map(num)), n = d.n;
  if (!n) return { n: 0 };
  const tc = n > 1 ? S.tInv(1 - (1 - conf) / 2, n - 1) : NaN;
  return { n, mean: d.mean, sd: d.sd, se: d.se, min: d.min, max: d.max, median: d.median, lo: d.mean - tc * d.se, hi: d.mean + tc * d.se };
}

export function basicHTML(L) {
  const grid = `<table class="anTbl anGrid"><thead><tr><th></th>${B.head.map((h, j) => `<th><input data-bh="${j}" value="${esc(h)}" aria-label="${esc(L("bColName"))}"></th>`).join("")}</tr></thead>
    <tbody>${B.rows.map((r, i) => `<tr><td class="anRowN">${i + 1}</td>${r.map((v, j) => `<td><input data-bc="${i},${j}" value="${esc(v)}" inputmode="decimal"></td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return `<div class="card"><b>${L("tabBasic")}</b><p class="note" style="margin:4px 0 8px">${L("bNote")}</p>
    <div class="anBtns"><button type="button" class="ghost anSmall" id="anBRow">+ ${L("bRow")}</button><button type="button" class="ghost anSmall" id="anBCol">+ ${L("bCol")}</button>
    <button type="button" class="ghost anSmall" id="anBEx">${L("bExample")}</button><button type="button" class="ghost anSmall" id="anBClear">${L("bClear")}</button>
    <label style="display:flex;align-items:center;gap:6px;margin-left:auto">${L("bConf")}<select id="anBConf">${[0.9, 0.95, 0.99].map((c) => `<option value="${c}"${c === B.conf ? " selected" : ""}>${c * 100}%</option>`).join("")}</select></label></div>
    <div class="anTblWrap" style="max-height:420px;overflow:auto">${grid}</div></div>
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b>${L("bResults")}</b><button type="button" class="ghost anSmall" id="anBCsv">CSV</button></div>
    <div class="anTblWrap" id="anBRes">${resultsHTML(L)}</div></div>`;
}

function rowsOf(L) {
  const ci = Math.round(B.conf * 100);
  const heads = ["", "n", L("bMean"), "SD", "SEM", "Min", "Max", L("bMedian"), `${ci}% CI ${L("bLow")}`, `${ci}% CI ${L("bHigh")}`];
  const rows = B.head.map((h, j) => { const s = statsOf(B.rows.map((r) => r[j]), B.conf); return [h, s.n, s.mean, s.sd, s.se, s.min, s.max, s.median, s.lo, s.hi]; }).filter((r) => r[1] > 0);
  return { heads, rows };
}
function resultsHTML(L) {
  const { heads, rows } = rowsOf(L);
  if (!rows.length) return `<p class="note">${L("bEmpty")}</p>`;
  return `<table class="anTbl"><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, j) => `<td class="${j ? "num" : ""}">${j === 0 ? esc(c) : j === 1 ? c : fmt(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    <p class="note anNote">${L("bMethod")}</p>`;
}

/** Wire the tab after it was rendered into `host`. */
export function wireBasic(host, L, { rerender, download }) {
  const upd = () => { const r = host.querySelector("#anBRes"); if (r) r.innerHTML = resultsHTML(L); };
  host.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.bc) { const [i, j] = el.dataset.bc.split(",").map(Number); B.rows[i][j] = el.value; upd(); }
    else if (el.dataset.bh) { B.head[+el.dataset.bh] = el.value; upd(); }
  });
  host.addEventListener("change", (e) => { if (e.target.id === "anBConf") { B.conf = +e.target.value; upd(); } });
  // paste a block from Excel / Sheets / a CSV: fills from the cell, grows the table
  host.addEventListener("paste", (e) => {
    const el = e.target; if (!el.dataset || (!el.dataset.bc && !el.dataset.bh)) return;
    const txt = (e.clipboardData || window.clipboardData).getData("text"); if (!/[\t\n;]/.test(txt.trim())) return;
    e.preventDefault();
    const lines = txt.replace(/\r/g, "").replace(/\n+$/, "").split("\n").map((l) => l.split(l.includes("\t") ? "\t" : ";"));
    let [i0, j0] = el.dataset.bc ? el.dataset.bc.split(",").map(Number) : [-1, +el.dataset.bh];
    const width = Math.max(...lines.map((l) => l.length));
    while (B.head.length < j0 + width) { B.head.push(String.fromCharCode(65 + B.head.length % 26)); B.rows.forEach((r) => r.push("")); }
    lines.forEach((l, k) => {
      const i = i0 + k;
      if (i < 0) { l.forEach((v, m) => (B.head[j0 + m] = v.trim())); return; }
      while (B.rows.length <= i) B.rows.push(B.head.map(() => ""));
      l.forEach((v, m) => (B.rows[i][j0 + m] = v.trim()));
    });
    rerender();
  });
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "anBRow") { for (let k = 0; k < 5; k++) B.rows.push(B.head.map(() => "")); rerender(); }
    else if (b.id === "anBCol") { B.head.push(String.fromCharCode(65 + B.head.length % 26)); B.rows.forEach((r) => r.push("")); rerender(); }
    else if (b.id === "anBClear") { B.head = ["A", "B", "C"]; B.rows = Array.from({ length: 10 }, () => ["", "", ""]); rerender(); }
    else if (b.id === "anBEx") {
      B.head = ["jump_cm", "sprint_s", "mass_kg"];
      B.rows = [[34.2, 4.21, 72.5], [29.8, 4.45, 80.1], [41.0, 4.02, 68.0], [36.5, 4.30, 75.3], [31.2, 4.38, 77.8], [38.9, 4.11, 70.2], [33.4, 4.27, 74.6], [27.6, 4.59, 83.0]].map((r) => r.map(String));
      rerender();
    } else if (b.id === "anBCsv") {
      const { heads, rows } = rowsOf(L);
      const csv = [heads.map((h, j) => (j ? h : "variable")).join(","), ...rows.map((r) => r.map((c, j) => (j === 0 ? `"${String(c).replace(/"/g, '""')}"` : Number.isFinite(c) ? +c.toFixed(6) : "")).join(","))].join("\r\n");
      download("descriptives.csv", csv);
    }
  });
}
