/**
 * analysis.js -- the lab demo's Analysis page (between Simulate and BioFeedback).
 *
 *   Reliability   discrete (one column per trial, "<condition>-<N>" headers, as in
 *                 github.com/basgoncalves/reliability) and continuous (waveforms:
 *                 CMC, node-wise ICC / SEM / MDC, RMSE, linear fit method)
 *   Statistics    JASP / SPSS-style tests on a tidy CSV or xlsx table, each with
 *                 its assumption checks and the nonparametric alternative
 *   SPM           many curve files -> subject / group / condition / covariate ->
 *                 t-tests, ANOVA (one-way, RM, two-way, mixed), ANCOVA, regression,
 *                 with normality, equal-variance, sphericity and slope checks
 *
 * Every result exports as one zip (src/anexport.js): xlsx + CSV tables, SVG +
 * PNG figures, the data ready for JASP and SPSS, SPSS syntax and a Python
 * script that repeats the analysis with pingouin / spm1d.
 *
 * Maths: src/stats.js, src/reliability.js, src/spm.js (checked against scipy,
 * pingouin and spm1d in tests/test_stats.mjs, test_reliability.mjs, test_spm.mjs).
 * Nothing leaves the device: files are read in the browser.
 */
import * as S from "./stats.js";
import { reliabilityOf, conditionsFromHeaders, waveformReliability, ICC_TYPES } from "./reliability.js";
import { runSpm, TESTS, normalise } from "./spm.js";
import * as G from "./anfigs.js";
import { exportBundle, dataFiles, spssLoad, pyHeader, csvOf, safeName } from "./anexport.js";
import { readAny, readXlsxCells } from "./proc_io.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fin = Number.isFinite;
const C = G.PALETTE;
const PG_ICC = { "1-1": ["ICC(1,1)", "ICC1"], "1-k": ["ICC(1,k)", "ICC1k"], "A-1": ["ICC(A,1)", "ICC2"], "A-k": ["ICC(A,k)", "ICC2k"], "C-1": ["ICC(C,1)", "ICC3"], "C-k": ["ICC(C,k)", "ICC3k"] };

/* ------------------------------------------------------------------ *
 * Tables in
 * ------------------------------------------------------------------ */

/** CSV / TSV / semicolon text -> { headers, rows } of strings. Decimal commas are understood when the separator is ; or tab. */
export function parseTable(text) {
  const src = text.replace(/^﻿/, "");
  const head = src.split(/\r?\n/).slice(0, 20).join("\n");
  const count = (ch) => (head.match(new RegExp(ch === "\t" ? "\\t" : ch, "g")) || []).length;
  const sep = count("\t") > Math.max(count(","), count(";")) ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
  if (!clean.length) throw new Error("empty table");
  const width = Math.max(...clean.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, j) => clean[0][j] || `col${j + 1}`);
  const dec = sep !== ",";
  const body = clean.slice(1).map((r) => Array.from({ length: width }, (_, j) => {
    const v = r[j] ?? "";
    return dec && /^-?\d+,\d+(e-?\d+)?$/i.test(v) ? v.replace(",", ".") : v;
  }));
  return { headers, rows: body };
}

const MISSING = /^(|na|nan|n\/a|null|none|-|\.|missing)$/i;
const asNum = (s) => (MISSING.test(String(s).trim()) ? NaN : Number(String(s).trim()));

/** Typed columns: scale (numbers) or nominal (labels). */
export function typeTable({ headers, rows }, name = "data") {
  const cols = headers.map((h, j) => rows.map((r) => r[j] ?? ""));
  const vars = headers.map((h, j) => {
    const raw = cols[j], filled = raw.filter((v) => !MISSING.test(v));
    const nums = filled.map(asNum), allNum = filled.length > 0 && nums.every(fin);
    const uniq = new Set(filled).size;
    const ints = allNum && nums.every((v) => Number.isInteger(v));
    const type = allNum && !(ints && uniq <= 4 && filled.length >= 8) ? "scale" : "nominal";
    return { name: h, raw, type };
  });
  return { name, vars, n: rows.length };
}
export const valuesOf = (v) => (v.type === "scale" ? v.raw.map(asNum) : v.raw.map((s) => (MISSING.test(s) ? "" : String(s).trim())));

async function readTableFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xlsm") {
    const cells = await readXlsxCells(await file.arrayBuffer());
    const width = Math.max(...cells.map((r) => r.length));
    const rows = cells.filter((r) => r.some((c) => String(c).trim() !== "")).map((r) => Array.from({ length: width }, (_, j) => String(r[j] ?? "").trim()));
    return { headers: rows[0].map((h, j) => h || `col${j + 1}`), rows: rows.slice(1) };
  }
  return parseTable(await file.text());
}

/* ------------------------------------------------------------------ *
 * Examples (deterministic), so every tool can be tried at once
 * ------------------------------------------------------------------ */

function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return { u, n: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}
const r2 = (v) => Math.round(v * 100) / 100;

export function exampleReliability() {
  const R = rng(11), headers = ["participant", "Hip_ABD-1", "Hip_ABD-2", "Hip_ER-1", "Hip_ER-2", "Hip_ER-3", "Knee_F-1", "Knee_F-2"];
  const rows = [];
  for (let i = 0; i < 16; i++) {
    const abd = 120 + 25 * R.n(), er = 60 + 12 * R.n(), kf = 150 + 40 * R.n();
    rows.push([`P${String(i + 1).padStart(2, "0")}`, r2(abd + 7 * R.n()), r2(abd + 4 + 7 * R.n()), r2(er + 6 * R.n()), r2(er + 2 + 6 * R.n()), r2(er + 3 + 6 * R.n()),
      r2(kf + 0.12 * kf * R.n()), r2(kf + 6 + 0.12 * kf * R.n())].map(String));
  }
  return { headers, rows };
}

export function exampleStats() {
  const R = rng(7), headers = ["id", "group", "sex", "age", "mass", "speed", "jump_pre", "jump_post", "jump_6w", "peak_force", "injured"];
  const rows = [], groups = ["Control", "Runner", "Jumper"];
  for (let i = 0; i < 36; i++) {
    const g = i % 3, sex = R.u() < 0.5 ? "F" : "M", mass = r2((sex === "M" ? 78 : 64) + 8 * R.n());
    const base = 28 + (sex === "M" ? 5 : 0) + 3 * g + 4 * R.n();
    const speed = r2(3.2 + 0.4 * g + 0.35 * R.n());
    rows.push([`S${String(i + 1).padStart(2, "0")}`, groups[g], sex, Math.round(24 + 4 * R.n()), mass, speed,
      r2(base), r2(base + 1.5 + g * 1.2 + 2 * R.n()), r2(base + 2 + g * 2 + 2.4 * R.n()),
      r2(1.9 * mass * 9.81 * (1 + 0.1 * g) + 90 * R.n() + 120 * speed), R.u() < 0.15 + 0.1 * g ? "yes" : "no"].map(String));
  }
  return { headers, rows };
}

/** Knee flexion-like curves. kind "spm": 2 groups x 2 speeds; kind "rel": 2 sessions. */
export function exampleCurves(kind = "spm") {
  const R = rng(kind === "spm" ? 21 : 33), Q = 101, out = [];
  const base = (p) => 5 + 15 * Math.exp(-(((p - 15) / 8) ** 2)) + 55 * Math.exp(-(((p - 72) / 12) ** 2));
  const smoothNoise = (amp) => { const a = [R.n(), R.n(), R.n(), R.n()], ph = [R.u(), R.u(), R.u(), R.u()].map((v) => v * 6.28); return (p) => amp * a.reduce((s, ai, k) => s + ai * Math.sin((2 * Math.PI * (k + 1) * p) / 100 + ph[k]) / (k + 1), 0); };
  if (kind === "spm") {
    for (const grp of ["Control", "ACL"]) for (let s = 0; s < 10; s++) {
      const subj = `${grp === "Control" ? "C" : "A"}${String(s + 1).padStart(2, "0")}`, off = 3 * R.n(), sn = smoothNoise(3);
      for (const cond of ["Walk", "Fast"]) {
        const speed = r2((cond === "Walk" ? 1.3 : 1.9) + 0.12 * R.n());
        const tn = smoothNoise(1.2);
        const y = Float64Array.from({ length: Q }, (_, p) => base(p) * (cond === "Fast" ? 1.08 : 1) + off + sn(p) + tn(p) - (grp === "ACL" ? 7 * Math.exp(-(((p - 72) / 10) ** 2)) + 3 * Math.exp(-(((p - 15) / 7) ** 2)) : 0) + 4 * (speed - 1.6) * Math.exp(-(((p - 72) / 14) ** 2)));
        out.push({ name: `${subj}_${grp}_${cond}.csv`, path: "", y, subject: subj, A: grp, B: cond, cov: speed, use: true });
      }
    }
  } else {
    for (let s = 0; s < 12; s++) {
      const subj = `P${String(s + 1).padStart(2, "0")}`, off = 4 * R.n(), sn = smoothNoise(4);
      for (const ses of ["Day1", "Day2"]) {
        const tn = smoothNoise(1.6), shift = ses === "Day2" ? 1.5 : 0;
        const y = Float64Array.from({ length: Q }, (_, p) => base(p) + off + sn(p) + tn(p) + shift * Math.exp(-(((p - 72) / 12) ** 2)));
        out.push({ name: `${subj}_${ses}.mot`, path: "", y, subject: subj, A: "", B: ses, cov: NaN, use: true });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Result blocks
 *   { type: "table", name, head, rows, note }   cells: number | string | { p } | { i }
 *   { type: "fig", name, svg, caption }
 *   { type: "check", name, rows: [{ test, stat, p, ok, hint }] }
 *   { type: "note", text, warn }
 * ------------------------------------------------------------------ */

const P = (p) => ({ p });
const I = (i) => ({ i });
const cellText = (c) => (c == null ? "–" : typeof c === "object" ? (c.p !== undefined ? S.fmtP(c.p) : c.i !== undefined ? String(c.i) : c.ci ? `[${S.fmt(c.ci[0])}, ${S.fmt(c.ci[1])}]` : "") : typeof c === "number" ? (Number.isInteger(c) && Math.abs(c) < 1e6 ? String(c) : S.fmt(c)) : String(c));
const cellRaw = (c) => (c == null ? "" : typeof c === "object" ? (c.p !== undefined ? c.p : c.i !== undefined ? c.i : c.ci ? `[${+c.ci[0].toPrecision(6)}, ${+c.ci[1].toPrecision(6)}]` : "") : c);
const CI = (ci) => ({ ci });

function blocksToTables(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "table") out.push({ name: b.name, rows: [b.head, ...b.rows.map((r) => r.map(cellRaw))] });
    if (b.type === "check") out.push({ name: b.name, rows: [["Check", "Statistic", "p", "Met", "Note"], ...b.rows.map((r) => [r.test, r.stat ?? "", r.p ?? "", r.ok == null ? "" : r.ok ? "yes" : "no", r.hint || ""])] });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function mountAnalysis(root, { t, download }) {
  const L = (k, v) => t("an_" + k, v);
  const st = {
    tab: "stats",
    rel: { mode: "discrete", table: null, type: "A-1", zero: false, sep: "-", idCol: "", result: null, session: "B" },
    stats: { table: null, kind: "descriptives", roles: {}, nonpar: true, result: null },
    spm: { curves: [], cols: [], variable: "", Q: 101, pattern: "{subject}_{group}_{condition}", filter: "", names: { A: "Group", B: "Condition" }, test: "", alpha: 0.05, two: true, perm: false, iters: 1000, mu: 0, ylabel: "", result: null, raw: [] },
    msg: "", busy: false,
  };
  const say = (m) => { st.msg = m; render(); };

  /* ---------------- shared bits ---------------- */
  const tabBtn = (id, label) => `<button type="button" class="ghost anTab${st.tab === id ? " on" : ""}" data-tab="${id}">${label}</button>`;
  const sel = (id, opts, cur, attrs = "") => `<select id="${id}" ${attrs}>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

  function blocksHTML(res) {
    if (!res) return "";
    return res.blocks.map((b) => {
      if (b.type === "table") {
        return `<div class="anBlock"><div class="anBlockHead">${esc(b.name)}</div><div class="anTblWrap"><table class="anTbl"><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
          b.rows.map((r) => `<tr>${r.map((c, j) => `<td class="${j === 0 ? "" : "num"}${c && c.p !== undefined && c.p < 0.05 ? " sig" : ""}">${esc(cellText(c))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${b.note ? `<p class="note anNote">${esc(b.note)}</p>` : ""}</div>`;
      }
      if (b.type === "check") {
        return `<div class="anBlock"><div class="anBlockHead">${esc(b.name)}</div><table class="anTbl anChecks"><tbody>${b.rows.map((r) => `<tr class="${r.ok === false ? "bad" : r.ok ? "ok" : ""}"><td>${r.ok === false ? "⚠" : r.ok ? "✓" : "·"}</td><td>${esc(r.test)}</td><td class="num">${esc(r.stat ?? "")}</td><td class="num">${r.p != null && r.p !== "" ? esc(S.fmtP(r.p)) : ""}</td><td>${esc(r.hint || "")}</td></tr>`).join("")}</tbody></table></div>`;
      }
      if (b.type === "fig") return `<div class="anBlock anFigBox"><div class="anBlockHead">${esc(b.name)}</div>${b.svg}${b.caption ? `<p class="note anNote">${esc(b.caption)}</p>` : ""}</div>`;
      if (b.type === "note") return `<p class="note anNote${b.warn ? " bad" : ""}">${esc(b.text)}</p>`;
      return "";
    }).join("");
  }

  const resultCard = (res, exportId) => (res ? `<div class="card anResult"><div class="labHead"><b>${esc(res.title)}</b>
      <button type="button" class="ghost anSmall" id="${exportId}">${L("export")}</button></div>
      ${blocksHTML(res)}<p class="note anNote">${L("exportNote")}</p></div>` : "");

  /* ---------------- Statistics ---------------- */
  const KINDS = [
    ["descriptives", "k_descriptives"], ["ttest_one", "k_ttest_one"], ["ttest_paired", "k_ttest_paired"], ["ttest_ind", "k_ttest_ind"],
    ["anova1", "k_anova1"], ["anova_rm", "k_anova_rm"], ["anova2", "k_anova2"], ["ancova", "k_ancova"],
    ["corr", "k_corr"], ["regression", "k_regression"], ["chisq", "k_chisq"],
  ];
  const ROLES = {
    descriptives: [["vars", "scale", "multi"], ["split", "nominal", "opt"]],
    ttest_one: [["dv", "scale"], ["mu", "number"]],
    ttest_paired: [["a", "scale"], ["b", "scale"]],
    ttest_ind: [["dv", "scale"], ["group", "nominal"]],
    anova1: [["dv", "scale"], ["group", "nominal"]],
    anova_rm: [["levels", "scale", "multi"], ["between", "nominal", "opt"], ["wname", "text"]],
    anova2: [["dv", "scale"], ["A", "nominal"], ["B", "nominal"]],
    ancova: [["dv", "scale"], ["A", "nominal"], ["covs", "scale", "multi"]],
    corr: [["vars", "scale", "multi"], ["method", "method"]],
    regression: [["dv", "scale"], ["preds", "scale", "multi"]],
    chisq: [["a", "nominal"], ["b", "nominal"]],
  };

  function statsHTML() {
    const T = st.stats.table;
    const data = `<div class="card"><div class="labHead"><b>${L("data")}</b>
      <span class="anBtns"><label class="ghost anSmall anFileBtn"><input type="file" id="anStatsFile" accept=".csv,.tsv,.txt,.xlsx,.xlsm" hidden>${L("openTable")}</label>
      <button type="button" class="ghost anSmall" id="anStatsEx">${L("example")}</button></span></div>
      <p class="note">${L("statsIntro")}</p>
      ${T ? `<p class="sub">${esc(T.name)} · ${T.n} ${L("rows")} · ${T.vars.length} ${L("variables")}</p>
      <div class="anTblWrap anVars"><table class="anTbl"><thead><tr><th>${L("variable")}</th><th>${L("type")}</th><th>${L("valid")}</th><th>${L("preview")}</th></tr></thead><tbody>${
        T.vars.map((v, j) => `<tr><td>${esc(v.name)}</td><td>${sel("", [["scale", L("scale")], ["nominal", L("nominal")]], v.type, `data-vtype="${j}" class="anMini"`)}</td><td class="num">${valuesOf(v).filter((x) => (v.type === "scale" ? fin(x) : x !== "")).length}</td><td class="sub">${esc(v.raw.slice(0, 5).join(", "))}${v.raw.length > 5 ? "…" : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </div>`;
    if (!T) return data;
    const k = st.stats.kind, R = st.stats.roles;
    const varsOf = (type) => T.vars.filter((v) => type === "any" || v.type === type).map((v) => v.name);
    const roleUI = ROLES[k].map(([role, type, mode]) => {
      const lab = `<span>${L("role_" + role)}</span>`;
      if (type === "number") return `<label class="anRole">${lab}<input type="number" step="any" data-role="${role}" value="${esc(R[role] ?? 0)}"></label>`;
      if (type === "text") return `<label class="anRole">${lab}<input type="text" data-role="${role}" value="${esc(R[role] ?? L("withinDefault"))}"></label>`;
      if (type === "method") return `<label class="anRole">${lab}${sel("", [["pearson", "Pearson"], ["spearman", "Spearman"], ["both", L("both")]], R.method || "both", 'data-role="method"')}</label>`;
      const opts = varsOf(type);
      if (mode === "multi") {
        const cur = R[role] || [];
        return `<div class="anRole anMulti">${lab}<div class="anChips">${opts.map((o) => `<label class="anChip${cur.includes(o) ? " on" : ""}"><input type="checkbox" data-mrole="${role}" value="${esc(o)}"${cur.includes(o) ? " checked" : ""}>${esc(o)}</label>`).join("") || `<span class="sub">${L("noVarsOfType")}</span>`}</div></div>`;
      }
      return `<label class="anRole">${lab}${sel("", [["", mode === "opt" ? L("none") : L("choose")], ...opts.map((o) => [o, o])], R[role] || "", `data-role="${role}"`)}</label>`;
    }).join("");
    const setup = `<div class="card"><div class="labHead"><b>${L("analysis")}</b></div>
      <label class="anRole"><span>${L("test")}</span>${sel("anKind", KINDS.map(([v, key]) => [v, L(key)]), k)}</label>
      <p class="note">${L("kn_" + k)}</p>
      <div class="anRoles">${roleUI}</div>
      ${["ttest_one", "ttest_paired", "ttest_ind", "anova1", "anova_rm"].includes(k) ? `<label class="anCheck"><input type="checkbox" id="anNonpar"${st.stats.nonpar ? " checked" : ""}> ${L("showNonpar")}</label>` : ""}
      <button type="button" id="anStatsRun">${L("run")}</button></div>`;
    return data + setup + resultCard(st.stats.result, "anStatsExport");
  }

  function col(name) { const v = st.stats.table.vars.find((x) => x.name === name); if (!v) throw new Error(L("errPick")); return { v, x: valuesOf(v) }; }
  const need = (...names) => { for (const n of names) if (!n || (Array.isArray(n) && !n.length)) throw new Error(L("errRoles")); };

  function runStats() {
    const k = st.stats.kind, R = st.stats.roles, B = [], nonpar = st.stats.nonpar;
    const used = [], spss = [], py = [];
    const addVar = (name) => { if (name && !used.includes(name)) used.push(name); };
    const sn = (name) => safeName(name);         // matches dataFiles() for unique, valid names
    const descRow = (label, x) => { const d = S.describe(x); return [label, I(d.n), d.mean, d.sd, d.se, d.median, d.min, d.max, d.skew, d.kurtosis]; };
    const descHead = [L("group"), "N", L("mean"), "SD", "SE", L("median"), "Min", "Max", L("skew"), L("kurt")];
    const swRow = (label, x) => { const w = S.shapiroWilk(x); return { test: `${L("normality")} (Shapiro-Wilk) – ${label}`, stat: `W = ${S.fmt(w.W)}`, p: w.p, ok: !(w.p < 0.05), hint: w.p < 0.05 ? L("hintNonpar") : "" }; };
    const groupsOf = (y, g) => { const lv = S.levelsOf(g); return { lv, groups: lv.map((L0) => y.filter((v, i) => g[i] === L0 && fin(v))) }; };
    let title = L(KINDS.find((x) => x[0] === k)[1]);

    if (k === "descriptives") {
      need(R.vars);
      R.vars.forEach(addVar); addVar(R.split);
      const rows = [], checks = [];
      for (const name of R.vars) {
        const { x } = col(name);
        if (R.split) { const g = col(R.split).x, { lv, groups } = groupsOf(x, g); lv.forEach((L0, i) => { rows.push(descRow(`${name} · ${L0}`, groups[i])); checks.push(swRow(`${name} · ${L0}`, groups[i])); }); }
        else { rows.push(descRow(name, x)); checks.push(swRow(name, x)); }
      }
      B.push({ type: "table", name: L("descriptives"), head: [L("variable"), ...descHead.slice(1)], rows });
      B.push({ type: "check", name: L("assumptions"), rows: checks });
      for (const name of R.vars.slice(0, 6)) {
        const { x } = col(name);
        if (R.split) { const { lv, groups } = groupsOf(x, col(R.split).x); B.push({ type: "fig", name: `${name} – ${L("byGroup")}`, svg: G.groupsSVG(lv.map((l, i) => ({ label: l, values: groups[i] })), { ylabel: name }) }); }
        else B.push({ type: "fig", name: `${name} – Q-Q`, svg: G.qqSVG(S.qqPoints(x), { xlabel: L("theoretical"), ylabel: L("standardised") }) });
      }
      spss.push(`EXAMINE VARIABLES=${R.vars.map(sn).join(" ")}${R.split ? ` BY ${sn(R.split)}_code` : ""}\n  /PLOT BOXPLOT NPPLOT\n  /STATISTICS DESCRIPTIVES\n  /NOTOTAL.`);
      py.push(`print(df[${JSON.stringify(R.vars.map(sn))}]${R.split ? `.groupby(df[${JSON.stringify(sn(R.split))}])` : ""}.describe().T)`);
      py.push(`for v in ${JSON.stringify(R.vars.map(sn))}:\n    print(v, pg.normality(df, dv=v${R.split ? `, group=${JSON.stringify(sn(R.split))}` : ""}))`);
    } else if (k === "ttest_one") {
      need(R.dv); addVar(R.dv);
      const mu = +R.mu || 0, { x } = col(R.dv), r = S.tTestOneSample(x, mu);
      B.push({ type: "check", name: L("assumptions"), rows: [swRow(R.dv, x)] });
      const rows = [[`${R.dv} vs ${mu}`, "Student", r.t, r.df, P(r.p), r.diff, CI(r.ci95), r.d, r.g]];
      if (nonpar) { const w = S.wilcoxon(S.clean(x).map((v) => v - mu)); rows.push([`${R.dv} vs ${mu}`, "Wilcoxon", w.W, "", P(w.p), "", "", w.rankBiserial, ""]); }
      B.push({ type: "table", name: L("k_ttest_one"), head: ["", L("test"), "t / W", "df", "p", L("meanDiff"), "95% CI", "d / r(rb)", "Hedges g"], rows, note: L("noteD") });
      B.push({ type: "table", name: L("descriptives"), head: descHead, rows: [descRow(R.dv, x)] });
      B.push({ type: "fig", name: `${R.dv}`, svg: G.groupsSVG([{ label: R.dv, values: S.clean(x) }], { ylabel: R.dv }) });
      spss.push(`T-TEST /TESTVAL=${mu} /VARIABLES=${sn(R.dv)} /ES DISPLAY(TRUE) /CRITERIA=CI(.95).`);
      if (nonpar) spss.push(`NPTESTS /ONESAMPLE TEST (${sn(R.dv)}) WILCOXON(TESTVALUE=${mu}).`);
      py.push(`print(pg.ttest(df[${JSON.stringify(sn(R.dv))}].dropna(), ${mu}))`, `print(pg.wilcoxon(df[${JSON.stringify(sn(R.dv))}].dropna() - ${mu}))`);
    } else if (k === "ttest_paired") {
      need(R.a, R.b); addVar(R.a); addVar(R.b);
      const a = col(R.a).x, b = col(R.b).x, r = S.tTestPaired(a, b);
      const d = a.map((v, i) => v - b[i]);
      B.push({ type: "check", name: L("assumptions"), rows: [swRow(`${R.a} − ${R.b}`, d)] });
      const rows = [[`${R.a} − ${R.b}`, "Student", r.t, r.df, P(r.p), r.diff, CI(r.ci95), r.d, r.g]];
      if (nonpar) { const w = S.wilcoxon(a, b); rows.push([`${R.a} − ${R.b}`, "Wilcoxon", w.W, "", P(w.p), "", "", w.rankBiserial, ""]); }
      B.push({ type: "table", name: L("k_ttest_paired"), head: ["", L("test"), "t / W", "df", "p", L("meanDiff"), "95% CI", "dz / r(rb)", "Hedges g"], rows, note: L("noteD") });
      const ok = a.map((v, i) => fin(v) && fin(b[i]));
      B.push({ type: "table", name: L("descriptives"), head: descHead, rows: [descRow(R.a, a.filter((_, i) => ok[i])), descRow(R.b, b.filter((_, i) => ok[i]))] });
      B.push({ type: "fig", name: `${R.a} / ${R.b}`, svg: G.profileSVG([R.a, R.b], a.map((v, i) => [v, b[i]]).filter((_, i) => ok[i]), { ylabel: L("value") }) });
      spss.push(`T-TEST PAIRS=${sn(R.a)} WITH ${sn(R.b)} (PAIRED) /ES DISPLAY(TRUE) /CRITERIA=CI(.95).`);
      if (nonpar) spss.push(`NPAR TESTS /WILCOXON=${sn(R.a)} WITH ${sn(R.b)} (PAIRED).`);
      py.push(`d = df[[${JSON.stringify(sn(R.a))}, ${JSON.stringify(sn(R.b))}]].dropna()`, `print(pg.ttest(d.iloc[:, 0], d.iloc[:, 1], paired=True))`, `print(pg.wilcoxon(d.iloc[:, 0], d.iloc[:, 1]))`);
    } else if (k === "ttest_ind" || k === "anova1") {
      need(R.dv, R.group); addVar(R.dv); addVar(R.group);
      const y = col(R.dv).x, g = col(R.group).x, { lv, groups } = groupsOf(y, g);
      if (k === "ttest_ind" && lv.length !== 2) throw new Error(L("errTwoGroups", { n: lv.length }));
      if (lv.length < 2) throw new Error(L("errTwoGroups", { n: lv.length }));
      const lev = S.levene(groups);
      B.push({ type: "check", name: L("assumptions"), rows: [...lv.map((l, i) => swRow(l, groups[i])), { test: `${L("eqVar")} (Levene)`, stat: `F(${lev.df1}, ${lev.df2}) = ${S.fmt(lev.F)}`, p: lev.p, ok: !(lev.p < 0.05), hint: lev.p < 0.05 ? L(k === "ttest_ind" ? "hintWelch" : "hintWelchAnova") : "" }] });
      if (k === "ttest_ind") {
        const r = S.tTestIndependent(groups[0], groups[1]);
        const rows = [[`${lv[0]} − ${lv[1]}`, "Student", r.student.t, r.student.df, P(r.student.p), r.diff, CI(r.student.ci95), r.student.d, r.student.g],
          [`${lv[0]} − ${lv[1]}`, "Welch", r.welch.t, r.welch.df, P(r.welch.p), r.diff, CI(r.welch.ci95), r.welch.d, r.welch.g]];
        if (nonpar) { const m = S.mannWhitney(groups[0], groups[1]); rows.push([`${lv[0]} − ${lv[1]}`, `Mann-Whitney (${m.method})`, m.U, "", P(m.p), "", "", m.rankBiserial, ""]); }
        B.push({ type: "table", name: L("k_ttest_ind"), head: ["", L("test"), "t / U", "df", "p", L("meanDiff"), "95% CI", "d / r(rb)", "Hedges g"], rows, note: L("noteD") });
        spss.push(`T-TEST GROUPS=${sn(R.group)}_code(1 2) /VARIABLES=${sn(R.dv)} /ES DISPLAY(TRUE) /CRITERIA=CI(.95).`);
        if (nonpar) spss.push(`NPAR TESTS /M-W=${sn(R.dv)} BY ${sn(R.group)}_code(1 2).`);
        py.push(`a = df.loc[df[${JSON.stringify(sn(R.group))}] == ${JSON.stringify(lv[0])}, ${JSON.stringify(sn(R.dv))}].dropna()`, `b = df.loc[df[${JSON.stringify(sn(R.group))}] == ${JSON.stringify(lv[1])}, ${JSON.stringify(sn(R.dv))}].dropna()`,
          `print(pg.ttest(a, b, correction=False))  # Student`, `print(pg.ttest(a, b, correction=True))   # Welch`, `print(pg.mwu(a, b))`, `print(pg.homoscedasticity(df, dv=${JSON.stringify(sn(R.dv))}, group=${JSON.stringify(sn(R.group))}, center="mean"))`);
      } else {
        const a = S.anovaOneWay(groups), w = S.welchAnova(groups);
        const rows = [[L("between"), a.ssb, I(a.df1), a.msb, a.F, P(a.p), a.eta2, a.omega2], [L("within"), a.ssw, I(a.df2), a.msw, "", "", "", ""]];
        B.push({ type: "table", name: "ANOVA – " + R.dv, head: ["", "SS", "df", "MS", "F", "p", "η²", "ω²"], rows });
        const rob = [["Welch", w.F, w.df1, w.df2, P(w.p)]];
        if (nonpar) { const kw = S.kruskalWallis(groups); rob.push(["Kruskal-Wallis (H, χ²)", kw.H, kw.df, "", P(kw.p)]); }
        B.push({ type: "table", name: L("robust"), head: ["", "F / H", "df1", "df2", "p"], rows: rob });
        const ph = S.postHocOneWay(groups, lv);
        B.push({ type: "table", name: L("posthoc"), head: [L("comparison"), L("meanDiff"), "SE", "t", "p Tukey", "p Holm", "p Bonferroni", "p Games-Howell", "d"], rows: ph.map((o) => [`${o.a} − ${o.b}`, o.diff, o.se, o.t, P(o.pTukey), P(o.pHolm), P(o.pBonferroni), P(o.pGamesHowell), o.d]), note: L("notePosthoc") });
        spss.push(`ONEWAY ${sn(R.dv)} BY ${sn(R.group)}_code\n  /ES=OVERALL\n  /STATISTICS DESCRIPTIVES HOMOGENEITY WELCH\n  /POSTHOC=TUKEY GH BONFERRONI ALPHA(0.05).`);
        if (nonpar) spss.push(`NPAR TESTS /K-W=${sn(R.dv)} BY ${sn(R.group)}_code(1 ${lv.length}).`);
        py.push(`print(pg.anova(data=df, dv=${JSON.stringify(sn(R.dv))}, between=${JSON.stringify(sn(R.group))}, detailed=True))`, `print(pg.welch_anova(data=df, dv=${JSON.stringify(sn(R.dv))}, between=${JSON.stringify(sn(R.group))}))`,
          `print(pg.pairwise_tukey(data=df, dv=${JSON.stringify(sn(R.dv))}, between=${JSON.stringify(sn(R.group))}))`, `print(pg.pairwise_gameshowell(data=df, dv=${JSON.stringify(sn(R.dv))}, between=${JSON.stringify(sn(R.group))}))`, `print(pg.kruskal(data=df, dv=${JSON.stringify(sn(R.dv))}, between=${JSON.stringify(sn(R.group))}))`);
      }
      B.push({ type: "table", name: L("descriptives"), head: descHead, rows: lv.map((l, i) => descRow(l, groups[i])) });
      B.push({ type: "fig", name: `${R.dv} – ${R.group}`, svg: G.groupsSVG(lv.map((l, i) => ({ label: l, values: groups[i] })), { ylabel: R.dv, xlabel: R.group }) });
    } else if (k === "anova_rm") {
      need(R.levels); if (R.levels.length < 2) throw new Error(L("errLevels"));
      R.levels.forEach(addVar); addVar(R.between);
      const wname = R.wname || L("withinDefault");
      const Y = R.levels.map((n) => col(n).x), g = R.between ? col(R.between).x : null;
      const M = Y[0].map((_, i) => Y.map((c) => c[i]));
      const r = S.rmAnova(M, g);
      const checks = [];
      const keep = M.map((row, i) => row.every(fin) && (!g || g[i] !== ""));
      const Mk = M.filter((_, i) => keep[i]), gk = g ? g.filter((_, i) => keep[i]) : null;
      R.levels.forEach((n, j) => checks.push(swRow(n, Mk.map((row) => row[j]))));
      if (r.mauchly) checks.push({ test: `${L("sphericity")} (Mauchly)`, stat: `W = ${S.fmt(r.mauchly.W)}, χ²(${r.mauchly.df}) = ${S.fmt(r.mauchly.chi2)}`, p: r.mauchly.p, ok: !(r.mauchly.p < 0.05), hint: r.mauchly.p < 0.05 ? L("hintGG", { gg: S.fmt(r.epsilonGG) }) : `ε GG = ${S.fmt(r.epsilonGG)}, HF = ${S.fmt(r.epsilonHF)}` });
      if (g) { const lvg = S.levelsOf(gk); R.levels.forEach((n, j) => { const lv = S.levene(lvg.map((L0) => Mk.filter((_, i) => gk[i] === L0).map((row) => row[j]))); checks.push({ test: `${L("eqVar")} (Levene) – ${n}`, stat: `F = ${S.fmt(lv.F)}`, p: lv.p, ok: !(lv.p < 0.05) }); }); }
      B.push({ type: "check", name: L("assumptions"), rows: checks });
      const nm = (term) => (term === "within" ? wname : term === "within × group" ? `${wname} × ${R.between}` : term.startsWith("Residuals") ? L("residuals") : term === "group" ? R.between : term);
      B.push({ type: "table", name: L("withinEffects"), head: ["", L("correction"), "SS", "df", "MS", "F", "p", "ηp²"], rows: r.within.flatMap((w) => (w.F === undefined ? [[nm(w.term), "", w.ss, w.df, w.ms, "", "", ""]] : [
        [nm(w.term), L("none"), w.ss, w.df, w.ms, w.F, P(w.p), w.partialEta2],
        [nm(w.term), "Greenhouse-Geisser", w.ss, w.gg.df1, w.ss / w.gg.df1, w.F, P(w.gg.p), w.partialEta2],
        [nm(w.term), "Huynh-Feldt", w.ss, w.hf.df1, w.ss / w.hf.df1, w.F, P(w.hf.p), w.partialEta2]])) });
      if (r.between) B.push({ type: "table", name: L("betweenEffects"), head: ["", "SS", "df", "MS", "F", "p", "ηp²"], rows: r.between.map((b) => [nm(b.term), b.ss, b.df, b.ms, b.F ?? "", b.p != null ? P(b.p) : "", b.partialEta2 ?? ""]) });
      if (nonpar && !g) { const f = S.friedman(Mk); B.push({ type: "table", name: L("robust"), head: ["", "χ²", "df", "p", "Kendall W"], rows: [["Friedman", f.Q, f.df, P(f.p), f.kendallW]] }); }
      // post hoc: paired t, Holm and Bonferroni
      const pr = [], raw = [];
      for (let a = 0; a < R.levels.length; a++) for (let b = a + 1; b < R.levels.length; b++) { const tt = S.tTestPaired(Mk.map((row) => row[a]), Mk.map((row) => row[b])); pr.push([`${R.levels[a]} − ${R.levels[b]}`, tt.diff, tt.se, tt.t, tt.df]); raw.push(tt.p); }
      const ho = S.pAdjust(raw, "holm"), bo = S.pAdjust(raw, "bonferroni");
      if (R.levels.length > 2) B.push({ type: "table", name: L("posthoc"), head: [L("comparison"), L("meanDiff"), "SE", "t", "df", "p", "p Holm", "p Bonferroni"], rows: pr.map((row, i) => [...row, P(raw[i]), P(ho[i]), P(bo[i])]) });
      B.push({ type: "table", name: L("descriptives"), head: descHead, rows: g ? S.levelsOf(gk).flatMap((L0) => R.levels.map((n, j) => descRow(`${n} · ${L0}`, Mk.filter((_, i) => gk[i] === L0).map((row) => row[j])))) : R.levels.map((n, j) => descRow(n, Mk.map((row) => row[j]))) });
      const lvg = g ? S.levelsOf(gk) : null;
      B.push({ type: "fig", name: wname, svg: G.profileSVG(R.levels, Mk, { ylabel: L("value"), colors: g ? (i) => C[lvg.indexOf(gk[i]) % C.length] : null }) });
      spss.push(`GLM ${R.levels.map(sn).join(" ")}${g ? ` BY ${sn(R.between)}_code` : ""}\n  /WSFACTOR=${safeName(wname)} ${R.levels.length} Polynomial\n  /METHOD=SSTYPE(3)\n  /EMMEANS=TABLES(${safeName(wname)}) COMPARE ADJ(BONFERRONI)\n  /PRINT=DESCRIPTIVE ETASQ HOMOGENEITY\n  /CRITERIA=ALPHA(.05)\n  /WSDESIGN=${safeName(wname)}${g ? `\n  /DESIGN=${sn(R.between)}_code` : ""}.`);
      if (nonpar && !g) spss.push(`NPAR TESTS /FRIEDMAN=${R.levels.map(sn).join(" ")}.`);
      py.push(`df["_subject"] = np.arange(len(df))`, `long = df.melt(id_vars=["_subject"${g ? `, ${JSON.stringify(sn(R.between))}` : ""}], value_vars=${JSON.stringify(R.levels.map(sn))}, var_name="${safeName(wname)}", value_name="y").dropna()`,
        g ? `print(pg.mixed_anova(data=long, dv="y", within="${safeName(wname)}", between=${JSON.stringify(sn(R.between))}, subject="_subject", correction=True))` : `print(pg.rm_anova(data=long, dv="y", within="${safeName(wname)}", subject="_subject", correction=True, detailed=True))`,
        `print(pg.sphericity(data=long, dv="y", within="${safeName(wname)}", subject="_subject"))`, `print(pg.pairwise_tests(data=long, dv="y", within="${safeName(wname)}", subject="_subject", padjust="holm"))`);
      if (!g) py.push(`print(pg.friedman(data=long, dv="y", within="${safeName(wname)}", subject="_subject"))`);
      title += ` – ${wname}`;
    } else if (k === "anova2" || k === "ancova") {
      const covs = k === "ancova" ? R.covs || [] : [];
      need(R.dv, R.A); if (k === "anova2") need(R.B); else need(covs);
      [R.dv, R.A, R.B, ...covs].forEach((n) => n && addVar(n));
      const y0 = col(R.dv).x, A0 = col(R.A).x, B0 = k === "anova2" ? col(R.B).x : null, cv0 = covs.map((c) => col(c).x);
      const ok = y0.map((v, i) => fin(v) && A0[i] !== "" && (!B0 || B0[i] !== "") && cv0.every((c) => fin(c[i])));
      const y = y0.filter((_, i) => ok[i]), data = { A: A0.filter((_, i) => ok[i]) };
      if (B0) data.B = B0.filter((_, i) => ok[i]);
      covs.forEach((c, j) => (data["c" + j] = cv0[j].filter((_, i) => ok[i])));
      const n = y.length, levels = { A: S.levelsOf(data.A) }; if (B0) levels.B = S.levelsOf(data.B);
      const terms = k === "anova2" ? [{ name: "A", factors: ["A"] }, { name: "B", factors: ["B"] }, { name: "A:B", factors: ["A", "B"] }]
        : [...covs.map((c, j) => ({ name: "c" + j, covariates: ["c" + j] })), { name: "A", factors: ["A"] }];
      const tb = S.anovaTable(data, n, terms, levels, y);
      const nm = (term) => (term === "A" ? R.A : term === "B" ? R.B : term === "A:B" ? `${R.A} × ${R.B}` : term === "Residuals" ? L("residuals") : covs[+term.slice(1)]);
      const checks = [];
      const cells = k === "anova2" ? levels.A.flatMap((a) => levels.B.map((b) => [`${a} · ${b}`, (i) => data.A[i] === a && data.B[i] === b])) : levels.A.map((a) => [a, (i) => data.A[i] === a]);
      const lev = S.levene(cells.map(([, f]) => y.filter((_, i) => f(i))));
      checks.push({ ...swRow(L("residuals"), tb.resid) });
      checks.push({ test: `${L("eqVar")} (Levene)`, stat: `F(${lev.df1}, ${lev.df2}) = ${S.fmt(lev.F)}`, p: lev.p, ok: !(lev.p < 0.05), hint: lev.p < 0.05 ? L("hintVar") : "" });
      if (k === "ancova") {
        const tsl = S.anovaTable(data, n, [...terms, ...covs.map((c, j) => ({ name: "A:c" + j, factors: ["A"], covariates: ["c" + j] }))], levels, y);
        tsl.rows.filter((r) => /^A:c/.test(r.term)).forEach((r) => checks.push({ test: `${L("slopes")} – ${R.A} × ${covs[+r.term.slice(3)]}`, stat: `F(${r.df}, ${tsl.dfe}) = ${S.fmt(r.F)}`, p: r.p, ok: !(r.p < 0.05), hint: r.p < 0.05 ? L("hintSlopes") : "" }));
        covs.forEach((c, j) => { const pr = S.pearson(data["c" + j], y); checks.push({ test: `${L("linearity")} – ${c}`, stat: `r = ${S.fmt(pr.r)}`, p: pr.p, ok: null, hint: L("hintLinear") }); });
      }
      B.push({ type: "check", name: L("assumptions"), rows: checks });
      B.push({ type: "table", name: `${k === "ancova" ? "ANCOVA" : "ANOVA"} – ${R.dv} (${L("typeIII")})`, head: ["", "SS", "df", "MS", "F", "p", "ηp²", "ω²"], rows: tb.rows.map((r) => [nm(r.term), r.ss, I(r.df), r.ms, r.F ?? "", r.p != null ? P(r.p) : "", r.partialEta2 ?? "", r.omega2 ?? ""]), note: `R² = ${S.fmt(tb.r2)}` });
      const mm = S.marginalMeans(data, n, terms, levels, y, "A");
      B.push({ type: "table", name: `${L(k === "ancova" ? "adjMeans" : "margMeans")} – ${R.A}`, head: [R.A, L("mean"), "SE", "95% CI"], rows: mm.map((m) => [m.level, m.mean, m.se, CI(m.ci95)]) });
      if (k === "anova2") { const mb = S.marginalMeans(data, n, terms, levels, y, "B"); B.push({ type: "table", name: `${L("margMeans")} – ${R.B}`, head: [R.B, L("mean"), "SE", "95% CI"], rows: mb.map((m) => [m.level, m.mean, m.se, CI(m.ci95)]) }); }
      B.push({ type: "table", name: L("descriptives"), head: descHead, rows: cells.map(([lab, f]) => descRow(lab, y.filter((_, i) => f(i)))) });
      B.push({ type: "fig", name: `${R.dv} – ${k === "anova2" ? `${R.A} × ${R.B}` : R.A}`, svg: G.groupsSVG(cells.map(([lab, f]) => ({ label: lab, values: y.filter((_, i) => f(i)) })), { ylabel: R.dv }) });
      if (k === "ancova") covs.forEach((c, j) => B.push({ type: "fig", name: `${R.dv} vs ${c}`, svg: G.scatterSVG(data["c" + j], y, { xlabel: c, ylabel: R.dv, colors: data.A.map((a) => C[levels.A.indexOf(a) % C.length]) }) }));
      B.push({ type: "fig", name: `Q-Q – ${L("residuals")}`, svg: G.qqSVG(S.qqPoints(tb.resid), { xlabel: L("theoretical"), ylabel: L("standardised") }) });
      if (k === "anova2") spss.push(`UNIANOVA ${sn(R.dv)} BY ${sn(R.A)}_code ${sn(R.B)}_code\n  /METHOD=SSTYPE(3)\n  /PRINT=ETASQ DESCRIPTIVE HOMOGENEITY\n  /EMMEANS=TABLES(${sn(R.A)}_code*${sn(R.B)}_code)\n  /DESIGN=${sn(R.A)}_code ${sn(R.B)}_code ${sn(R.A)}_code*${sn(R.B)}_code.`);
      else {
        spss.push(`* ANCOVA.\nUNIANOVA ${sn(R.dv)} BY ${sn(R.A)}_code WITH ${covs.map(sn).join(" ")}\n  /METHOD=SSTYPE(3)\n  /PRINT=ETASQ DESCRIPTIVE HOMOGENEITY PARAMETER\n  /EMMEANS=TABLES(${sn(R.A)}_code) WITH(${covs.map((c) => sn(c) + "=MEAN").join(" ")}) COMPARE ADJ(BONFERRONI)\n  /DESIGN=${covs.map(sn).join(" ")} ${sn(R.A)}_code.`);
        spss.push(`* Homogeneity of regression slopes.\nUNIANOVA ${sn(R.dv)} BY ${sn(R.A)}_code WITH ${covs.map(sn).join(" ")}\n  /METHOD=SSTYPE(3)\n  /DESIGN=${covs.map(sn).join(" ")} ${sn(R.A)}_code ${covs.map((c) => `${sn(R.A)}_code*${sn(c)}`).join(" ")}.`);
      }
      if (k === "anova2") py.push(`print(pg.anova(data=df, dv=${JSON.stringify(sn(R.dv))}, between=[${JSON.stringify(sn(R.A))}, ${JSON.stringify(sn(R.B))}], ss_type=3, detailed=True))`);
      else py.push(`print(pg.ancova(data=df, dv=${JSON.stringify(sn(R.dv))}, between=${JSON.stringify(sn(R.A))}, covar=${JSON.stringify(covs.map(sn))}))`,
        `import statsmodels.formula.api as smf, statsmodels.api as sm`, `m = smf.ols("${sn(R.dv)} ~ C(${sn(R.A)}, Sum) * (${covs.map(sn).join(" + ")})", data=df).fit()`, `print(sm.stats.anova_lm(m, typ=3))  # interaction rows = homogeneity of slopes`);
    } else if (k === "corr") {
      need(R.vars); if (R.vars.length < 2) throw new Error(L("errTwoVars"));
      R.vars.forEach(addVar);
      const method = R.method || "both", rows = [];
      for (let a = 0; a < R.vars.length; a++) for (let b = a + 1; b < R.vars.length; b++) {
        const x = col(R.vars[a]).x, y = col(R.vars[b]).x;
        const pr = S.pearson(x, y), sp = S.spearman(x, y);
        rows.push([`${R.vars[a]} – ${R.vars[b]}`, I(pr.n), ...(method !== "spearman" ? [pr.r, CI(pr.ci95), P(pr.p)] : []), ...(method !== "pearson" ? [sp.rho, P(sp.p)] : [])]);
      }
      B.push({ type: "check", name: L("assumptions"), rows: R.vars.map((v) => swRow(v, col(v).x)) });
      B.push({ type: "table", name: L("k_corr"), head: [L("pair"), "N", ...(method !== "spearman" ? ["Pearson r", "95% CI", "p"] : []), ...(method !== "pearson" ? ["Spearman ρ", "p"] : [])], rows });
      for (let a = 0; a < Math.min(R.vars.length, 4); a++) for (let b = a + 1; b < Math.min(R.vars.length, 4); b++) B.push({ type: "fig", name: `${R.vars[b]} vs ${R.vars[a]}`, svg: G.scatterSVG(col(R.vars[a]).x, col(R.vars[b]).x, { xlabel: R.vars[a], ylabel: R.vars[b], fit: true }) });
      if (method !== "spearman") spss.push(`CORRELATIONS /VARIABLES=${R.vars.map(sn).join(" ")} /PRINT=TWOTAIL NOSIG /MISSING=PAIRWISE.`);
      if (method !== "pearson") spss.push(`NONPAR CORR /VARIABLES=${R.vars.map(sn).join(" ")} /PRINT=SPEARMAN TWOTAIL NOSIG /MISSING=PAIRWISE.`);
      py.push(`print(pg.pairwise_corr(df, columns=${JSON.stringify(R.vars.map(sn))}, method="pearson"))`, `print(pg.pairwise_corr(df, columns=${JSON.stringify(R.vars.map(sn))}, method="spearman"))`);
    } else if (k === "regression") {
      need(R.dv, R.preds); addVar(R.dv); R.preds.forEach(addVar);
      const r = S.linearRegression(col(R.dv).x, R.preds.map((p) => col(p).x), R.preds);
      B.push({ type: "check", name: L("assumptions"), rows: [
        { test: `${L("normality")} – ${L("residuals")} (Shapiro-Wilk)`, stat: `W = ${S.fmt(r.shapiroResid.W)}`, p: r.shapiroResid.p, ok: !(r.shapiroResid.p < 0.05) },
        { test: `${L("independence")} (Durbin-Watson)`, stat: S.fmt(r.durbinWatson), p: "", ok: r.durbinWatson > 1 && r.durbinWatson < 3, hint: L("hintDW") },
        ...r.coefs.slice(1).map((c) => ({ test: `${L("collinearity")} – ${c.term} (VIF)`, stat: S.fmt(c.vif), p: "", ok: c.vif < 5, hint: c.vif >= 5 ? L("hintVIF") : "" })),
      ] });
      B.push({ type: "table", name: L("modelSummary"), head: ["R", "R²", L("adjR2"), "RMSE", "F", "df1", "df2", "p", "N"], rows: [[r.R, r.r2, r.adjR2, r.rmse, r.F, I(r.df1), I(r.df2), P(r.p), I(r.n)]] });
      B.push({ type: "table", name: L("coefficients"), head: ["", "B", "SE", "β", "t", "p", "95% CI", "VIF"], rows: r.coefs.map((c) => [c.term, c.b, c.se, fin(c.beta) ? c.beta : "", c.t, P(c.p), CI(c.ci95), c.vif ?? ""]) });
      B.push({ type: "fig", name: `${L("residuals")} vs ${L("fitted")}`, svg: G.scatterSVG(r.fitted, r.resid, { xlabel: L("fitted"), ylabel: L("residuals") }) });
      B.push({ type: "fig", name: `Q-Q – ${L("residuals")}`, svg: G.qqSVG(S.qqPoints(r.resid), { xlabel: L("theoretical"), ylabel: L("standardised") }) });
      if (R.preds.length === 1) B.push({ type: "fig", name: `${R.dv} vs ${R.preds[0]}`, svg: G.scatterSVG(col(R.preds[0]).x, col(R.dv).x, { xlabel: R.preds[0], ylabel: R.dv, fit: true }) });
      spss.push(`REGRESSION\n  /MISSING LISTWISE\n  /STATISTICS COEFF OUTS CI(95) R ANOVA COLLIN TOL\n  /DEPENDENT ${sn(R.dv)}\n  /METHOD=ENTER ${R.preds.map(sn).join(" ")}\n  /RESIDUALS DURBIN NORMPROB(ZRESID).`);
      py.push(`d = df[[${JSON.stringify(sn(R.dv))}, ${R.preds.map((p) => JSON.stringify(sn(p))).join(", ")}]].dropna()`, `print(pg.linear_regression(d[${JSON.stringify(R.preds.map(sn))}], d[${JSON.stringify(sn(R.dv))}]))`);
    } else if (k === "chisq") {
      need(R.a, R.b); addVar(R.a); addVar(R.b);
      const r = S.chiSquare(col(R.a).x, col(R.b).x);
      B.push({ type: "check", name: L("assumptions"), rows: [{ test: L("expected5"), stat: `${Math.round(r.lowExpected * 100)} %`, p: "", ok: r.lowExpected <= 0.2, hint: r.lowExpected > 0.2 ? L("hintFisher") : "" }] });
      B.push({ type: "table", name: L("contingency"), head: [`${R.a} \\ ${R.b}`, ...r.cols, L("total")], rows: [...r.rows.map((rw, i) => [rw, ...r.O[i].map((o, j) => `${o} (${S.fmt(r.E[i][j], 1)})`), I(r.O[i].reduce((a, b) => a + b, 0))]), [L("total"), ...r.cols.map((_, j) => I(r.O.reduce((a, row) => a + row[j], 0))), I(r.N)]], note: L("noteExpected") });
      B.push({ type: "table", name: L("k_chisq"), head: ["", L("value"), "df", "p"], rows: [["Pearson χ²", r.chi2, I(r.df), P(r.p)], ["Cramér's V", r.cramerV, "", ""], ...(r.fisherP != null ? [[L("fisher"), "", "", P(r.fisherP)]] : []), ["N", I(r.N), "", ""]] });
      spss.push(`CROSSTABS /TABLES=${sn(R.a)}_code BY ${sn(R.b)}_code /STATISTICS=CHISQ PHI /CELLS=COUNT EXPECTED.`);
      py.push(`expected, observed, stats = pg.chi2_independence(df, x=${JSON.stringify(sn(R.a))}, y=${JSON.stringify(sn(R.b))})`, `print(observed); print(stats)`);
    }
    const vars = used.map((n) => { const v = st.stats.table.vars.find((x) => x.name === n); return { name: n, type: v.type, values: valuesOf(v) }; });
    return { title, blocks: B, spss, py, vars, kind: k };
  }

  async function exportStats() {
    const res = st.stats.result, df = dataFiles(res.vars);
    const files = [
      { name: "data/data_wide.csv", data: "﻿" + csvOf(df.wide) },
      { name: "data/data_spss.csv", data: csvOf(df.spss) },
      { name: "analysis.sps", data: spssLoad(df.map, "data/data_spss.csv") + "\n" + res.spss.join("\n\n") + "\n" },
      { name: "analysis.py", data: pyHeader() + `import pingouin as pg\n\ndf = pd.read_csv("data/data_spss.csv")\n\n` + res.py.join("\n") + "\n" },
    ];
    await exportBundle({ base: "bioscout_stats", tables: blocksToTables(res.blocks), figures: res.blocks.filter((b) => b.type === "fig"), files, readme: readme(res.title, df.map, "stats") }, download);
  }

  /* ---------------- Reliability ---------------- */
  function relHTML() {
    const R = st.rel;
    const mode = `<div class="anSeg">${["discrete", "continuous"].map((m) => `<button type="button" class="ghost anSmall${R.mode === m ? " on" : ""}" data-relmode="${m}">${L("rel_" + m)}</button>`).join("")}</div>`;
    const typeSel = `<label class="anRole"><span>${L("iccType")}</span>${sel("anIccType", ICC_TYPES.map((x) => [x, `ICC(${x.replace("-", ",")}) – ${L("icc_" + x.replace("-", ""))}`]), R.type)}</label>`;
    if (R.mode === "discrete") {
      const T = R.table;
      const conds = T ? relConditions() : [];
      return `<div class="card"><div class="labHead"><b>${L("relTitle")}</b>${mode}</div>
        <p class="note">${L("relIntro")}</p>
        <div class="anBtns"><label class="ghost anSmall anFileBtn"><input type="file" id="anRelFile" accept=".csv,.tsv,.txt,.xlsx,.xlsm" hidden>${L("openTable")}</label>
        <button type="button" class="ghost anSmall" id="anRelEx">${L("example")}</button></div>
        ${T ? `<p class="sub">${esc(T.name)} · ${T.n} ${L("rows")} · ${L("conditionsFound")}: ${conds.map((c) => `<b>${esc(c.name)}</b> (${c.cols.length})`).join(", ") || "–"}</p>` : ""}
        <div class="anRoles">${typeSel}
          <label class="anRole"><span>${L("trialSep")}</span><input type="text" id="anRelSep" value="${esc(R.sep)}" maxlength="3"></label></div>
        <label class="anCheck"><input type="checkbox" id="anRelZero"${R.zero ? " checked" : ""}> ${L("zeroMissing")}</label>
        <p class="note">${L("iccNote")}</p>
        <button type="button" id="anRelRun"${T ? "" : " disabled"}>${L("run")}</button></div>` + resultCard(R.result, "anRelExport");
    }
    const sp = st.spm;
    return `<div class="card"><div class="labHead"><b>${L("relTitle")}</b>${mode}</div>
      <p class="note">${L("relContIntro")}</p>
      <div class="anBtns"><button type="button" class="ghost anSmall" id="anRelCurvesEx">${L("example")}</button></div>
      ${curvesLoaderHTML()}
      ${sp.curves.length ? `<div class="anRoles">${typeSel}<label class="anRole"><span>${L("sessionsIn")}</span>${sel("anRelSession", [["B", sp.names.B], ["A", sp.names.A]], R.session)}</label></div>
      <button type="button" id="anRelContRun">${L("run")}</button>` : ""}</div>` + resultCard(R.result, "anRelExport");
  }

  function relConditions() {
    const T = st.rel.table, num = T.vars.filter((v) => v.type === "scale" || v.raw.every((s) => MISSING.test(s) || fin(asNum(s))));
    return conditionsFromHeaders(num.map((v) => v.name), st.rel.sep || "-").map((c) => ({ ...c, vars: c.cols.map((j) => num[j]) })).filter((c) => c.cols.length >= 2);
  }

  function runRelDiscrete() {
    const conds = relConditions(), B = [], type = st.rel.type;
    if (!conds.length) throw new Error(L("errNoConds"));
    const res = conds.map((c) => ({ c, r: reliabilityOf(c.vars[0].raw.map((_, i) => c.vars.map((v) => asNum(v.raw[i]))), { type, zeroIsMissing: st.rel.zero, trialNames: c.vars.map((v) => v.name) }) }));
    const valid = res.filter((x) => x.r.overall);
    if (!valid.length) throw new Error(L("errFewSubjects"));
    const head = [L("parameter"), ...valid.map((x) => x.c.name)];
    const O = (f) => valid.map((x) => f(x.r.overall, x.r));
    const rows = [
      ["N", ...O((o) => I(o.n))], [L("trials"), ...O((o) => I(o.k))], [L("excluded"), ...O((o, r) => I(r.excluded))],
      [`ICC(${type.replace("-", ",")})`, ...O((o) => o.icc)], ["ICC 95% CI", ...O((o) => CI(o.iccCI))], ["F", ...O((o) => o.iccF)], ["p (ICC)", ...O((o) => P(o.iccP))],
      [L("interpretation"), ...O((o) => L("koo_" + o.label))],
      ...valid[0].r.overall.trialMeans.map((_, j) => [`${L("mean")} T${j + 1}`, ...O((o) => (o.trialMeans[j] != null ? o.trialMeans[j] : ""))]),
      ...valid[0].r.overall.trialSDs.map((_, j) => [`SD T${j + 1}`, ...O((o) => (o.trialSDs[j] != null ? o.trialSDs[j] : ""))]),
      ["SEM (√MSE)", ...O((o) => o.sem)], ["SEM %", ...O((o) => o.semPct)], ["SEM (SD√(1−ICC))", ...O((o) => o.semICC)],
      ["MDC95", ...O((o) => o.mdc95)], ["MDC95 %", ...O((o) => o.mdcPct)], ["CV %", ...O((o) => o.cv)],
      [L("bias"), ...O((o) => (o.bias != null ? o.bias : ""))], [L("bias") + " 95% CI", ...O((o) => (o.biasCI ? CI(o.biasCI) : ""))], [`p (${L("bias")})`, ...O((o) => (o.biasP != null ? P(o.biasP) : o.trialP != null ? P(o.trialP) : ""))],
      [L("loa") + " −", ...O((o) => (o.loa ? o.loa[0] : ""))], [L("loa") + " +", ...O((o) => (o.loa ? o.loa[1] : ""))],
      [L("hetero") + " r", ...O((o) => (o.hetR != null ? o.hetR : ""))], [`p (${L("hetero")})`, ...O((o) => (o.hetP != null ? P(o.hetP) : ""))],
    ];
    B.push({ type: "table", name: L("relSummary"), head, rows, note: L("relSummaryNote") });
    const pairs = valid.flatMap((x) => x.r.pairs.map((p) => [x.c.name, `${p.a} / ${p.b}`, I(p.n), p.icc, CI(p.iccCI), L("koo_" + p.label), p.sem, p.mdc95, p.cv, p.bias, P(p.biasP), p.loa[0], p.loa[1], p.hetR, P(p.hetP)]));
    if (pairs.length) B.push({ type: "table", name: L("relPairs"), head: [L("condition"), L("pair"), "N", "ICC", "95% CI", L("interpretation"), "SEM", "MDC95", "CV %", L("bias"), "p", L("loa") + " −", L("loa") + " +", L("hetero") + " r", "p"], rows: pairs });
    const het = valid.filter((x) => (x.r.overall.hetP < 0.05) || x.r.pairs.some((p) => p.hetP < 0.05)).map((x) => x.c.name);
    if (het.length) B.push({ type: "note", warn: true, text: L("hetWarn", { list: het.join(", ") }) });
    for (const x of valid) {
      const r = x.r;
      if (r.k === 2) B.push({ type: "fig", name: `Bland-Altman – ${x.c.name}`, svg: G.blandAltmanSVG(r.overall, { xlabel: L("baMean"), ylabel: L("baDiff") }) });
      for (const p of r.pairs) B.push({ type: "fig", name: `Bland-Altman – ${p.a} / ${p.b}`, svg: G.blandAltmanSVG(p, { xlabel: L("baMean"), ylabel: L("baDiff") }) });
    }
    const model = type.startsWith("1") ? "ONEWAY" : type.startsWith("C") ? "MIXED) TYPE(CONSISTENCY" : "RANDOM) TYPE(ABSOLUTE";
    const vars = [], spss = [], py = [];
    if (st.rel.idCol || st.rel.table.vars.some((v) => v.type === "nominal")) { const idv = st.rel.table.vars.find((v) => v.type === "nominal"); if (idv) vars.push({ name: idv.name, type: "nominal", values: valuesOf(idv) }); }
    for (const x of valid) for (const v of x.c.vars) vars.push({ name: v.name, type: "scale", values: v.raw.map(asNum).map((z) => (st.rel.zero && z === 0 ? NaN : z)) });
    const sn = (n) => safeName(n);
    for (const x of valid) spss.push(`RELIABILITY /VARIABLES=${x.c.vars.map((v) => sn(v.name)).join(" ")}\n  /SCALE('${x.c.name.replace(/'/g, "")}') ALL\n  /MODEL=ALPHA\n  /STATISTICS=DESCRIPTIVE\n  /ICC=MODEL(${model}) CIN=95 TESTVAL=0.`);
    py.push(`import pingouin as pg`, `df = pd.read_csv("data/data_spss.csv")`, `df["_subject"] = np.arange(len(df))`, `conditions = ${JSON.stringify(Object.fromEntries(valid.map((x) => [x.c.name, x.c.vars.map((v) => sn(v.name))])), null, 1)}`,
      `ICC_TYPE = ${JSON.stringify(PG_ICC[type])}  # pingouin >= 0.6 names, then the older ICC1 / ICC2 (= A,1) / ICC3 (= C,1)`,
      `pick = lambda t: t.set_index("Type").loc[[n for n in ICC_TYPE if n in set(t["Type"])][0]]`,
      `rows = []`, `for name, cols in conditions.items():`, `    d = df[["_subject"] + cols].dropna()`, `    long = d.melt(id_vars="_subject", var_name="trial", value_name="y")`,
      `    icc = pick(pg.intraclass_corr(long, targets="_subject", raters="trial", ratings="y"))`,
      `    mse = pg.rm_anova(long, dv="y", within="trial", subject="_subject", detailed=True)["MS"].iloc[-1]`,
      `    sem = np.sqrt(mse); mdc = 1.96 * np.sqrt(2) * sem`,
      `    rec = dict(condition=name, n=len(d), ICC=icc["ICC"], CI95=icc["CI95"], SEM=sem, MDC95=mdc, SEM_pct=100 * sem / long.y.mean())`,
      `    if len(cols) == 2:`, `        diff = d[cols[1]] - d[cols[0]]; mean = d[cols].mean(axis=1)`,
      `        rec.update(bias=diff.mean(), LoA_low=diff.mean() - 1.96 * diff.std(), LoA_high=diff.mean() + 1.96 * diff.std(), hetero_r=np.corrcoef(mean, diff.abs())[0, 1])`,
      `    rows.append(rec)`, `print(pd.DataFrame(rows))`);
    return { title: `${L("relTitle")} – ICC(${type.replace("-", ",")})`, blocks: B, spss, py, vars };
  }

  function runRelCont() {
    const sp = st.spm, key = st.rel.session;
    const curves = sp.curves.filter((c) => c.use && c.y && c.subject !== "" && c[key] !== "");
    if (curves.length < 6) throw new Error(L("errFewCurves"));
    const ss = S.levelsOf(curves.map((c) => c[key]));
    const r = waveformReliability(curves.map((c) => ({ subject: c.subject, session: c[key], y: c.y })), { type: st.rel.type, sessions: ss });
    if (!r.icc) throw new Error(L("errFewSubjects"));
    const B = [], yl = sp.ylabel || sp.variable || L("value");
    B.push({ type: "table", name: L("relSummary"), head: [L("parameter"), L("value")], rows: [
      ["N", I(r.n)], [L("sessions"), ss.join(", ")], [L("nodes"), I(r.Q)],
      [`${L("meanOver")} ICC(${r.iccType.replace("-", ",")})`, r.meanICC], ["ICC min – max", `${S.fmt(Math.min(...r.icc))} – ${S.fmt(Math.max(...r.icc))}`],
      [`${L("meanOver")} SEM`, r.meanSEM], [`${L("meanOver")} MDC95`, r.meanMDC],
      ["CMC (mean ± SD)", `${S.fmt(r.cmcMean)} ± ${S.fmt(r.cmcSD)}`], [L("cmcUndef"), I(r.cmcUndefined)],
      ["RMSE (mean ± SD)", `${S.fmt(r.rmseMean)} ± ${S.fmt(r.rmseSD)}`], ["RMSE % range", r.rmsePctRange],
      ["LFM a1 / a0 / R²", `${S.fmt(r.lfm.a1)} / ${S.fmt(r.lfm.a0)} / ${S.fmt(r.lfm.r2)}`],
    ], note: L("contNote") });
    if (r.dropped.length) B.push({ type: "note", warn: true, text: L("droppedSubj", { list: r.dropped.join(", ") }) });
    B.push({ type: "table", name: L("perSubject"), head: [L("subject"), "CMC", ...r.perSubject[0].pairs.flatMap((p) => [`RMSE ${p.a}/${p.b}`, `a1`, `a0`, `R²`])], rows: r.perSubject.map((p) => [p.subject, fin(p.cmc) ? p.cmc : "–", ...p.pairs.flatMap((q) => [q.rmse, q.a1, q.a0, q.r2])]) });
    B.push({ type: "fig", name: L("sessionMeans"), svg: G.curvesSVG(ss.map((s, j) => ({ y: r.sessionMeans[j], lo: r.sessionMeans[j].map((v, q) => v - r.sessionSDs[j][q]), hi: r.sessionMeans[j].map((v, q) => v + r.sessionSDs[j][q]), color: C[j % C.length], label: `${s} (mean ± SD)` })), { ylabel: yl, xlabel: L("cycle") }) });
    B.push({ type: "fig", name: `ICC(${r.iccType.replace("-", ",")}) ${L("perNode")}`, svg: G.curvesSVG([{ y: r.icc, lo: r.iccLo, hi: r.iccHi, color: C[0], label: "ICC (95% CI)" }], { ylabel: "ICC", xlabel: L("cycle"), yr: [Math.min(0, ...r.iccLo), 1], hlines: [{ y: 0.9, label: L("koo_excellent"), color: C[2], dash: "3 3" }, { y: 0.75, label: L("koo_good"), color: C[6], dash: "3 3" }, { y: 0.5, label: L("koo_moderate"), color: C[3], dash: "3 3" }] }) });
    B.push({ type: "fig", name: `SEM / MDC95 ${L("perNode")}`, svg: G.curvesSVG([{ y: r.sem, color: C[0], label: "SEM" }, { y: r.mdc, color: C[3], label: "MDC95", dash: true }], { ylabel: yl, xlabel: L("cycle") }) });
    // systematic difference between the first two sessions: paired SPM
    try {
      const two = sp.curves.filter((c) => c.use && c.y && (c[key] === ss[0] || c[key] === ss[1])).map((c) => ({ y: c.y, subject: c.subject, B: c[key] }));
      const s = runSpm(two, { test: "ttest_paired", alpha: 0.05, twoTailed: true });
      const e = s.effects[0].spmi;
      B.push({ type: "fig", name: `${L("systematic")} (SPM paired t, ${ss[0]} − ${ss[1]})`, svg: G.spmSVG(e, { xlabel: L("cycle") }), caption: e.clusters.length ? L("clustersFound", { list: e.clusters.map((c) => `${S.fmt(c.x0 * 100 / (r.Q - 1), 0)}–${S.fmt(c.x1 * 100 / (r.Q - 1), 0)} % (p ${S.fmtP(c.p)})`).join("; ") }) : L("noClusters") });
    } catch { /* fewer than two sessions per subject: skip */ }
    return { title: `${L("relTitle")} – ${L("rel_continuous")}`, blocks: B, wave: r, sessions: ss, sessionKey: key };
  }

  async function exportRel() {
    const res = st.rel.result;
    if (st.rel.mode === "discrete") {
      const df = dataFiles(res.vars);
      const files = [
        { name: "data/data_wide.csv", data: "﻿" + csvOf(df.wide) }, { name: "data/data_spss.csv", data: csvOf(df.spss) },
        { name: "analysis.sps", data: spssLoad(df.map, "data/data_spss.csv") + "\n" + res.spss.join("\n\n") + "\n" },
        { name: "analysis.py", data: pyHeader() + "\n" + res.py.join("\n") + "\n" },
      ];
      await exportBundle({ base: "bioscout_reliability", tables: blocksToTables(res.blocks), figures: res.blocks.filter((b) => b.type === "fig"), files, readme: readme(res.title, df.map, "rel") }, download);
    } else {
      const files = curveFiles(st.spm.curves.filter((c) => c.use && c.y));
      const w = res.wave, Q = w.Q;
      files.push({ name: "tables/node_reliability.csv", data: csvOf([["node", "percent", "ICC", "ICC_lo", "ICC_hi", "SEM", "MDC95", ...res.sessions.flatMap((s) => [`mean_${s}`, `sd_${s}`])], ...Array.from({ length: Q }, (_, q) => [q, (100 * q) / (Q - 1), w.icc[q], w.iccLo[q], w.iccHi[q], w.sem[q], w.mdc[q], ...res.sessions.flatMap((_, j) => [w.sessionMeans[j][q], w.sessionSDs[j][q]])])]) });
      files.push({ name: "analysis.py", data: pyHeader(" spm1d") + curvesPyLoader() + `
import pingouin as pg, spm1d
key = ${JSON.stringify(res.sessionKey === "A" ? "group" : "condition")}
sessions = ${JSON.stringify(res.sessions)}
cube = []   # subject x session x node
for s, d in meta.groupby("subject"):
    if all((d[key] == x).any() for x in sessions):
        cube.append([Y[d.index[d[key] == x]].mean(axis=0) for x in sessions])
cube = np.array(cube); n, k, Q = cube.shape
icc = []
for q in range(Q):
    long = pd.DataFrame([(i, j, cube[i, j, q]) for i in range(n) for j in range(k)], columns=["s", "t", "y"])
    tb = pg.intraclass_corr(long, targets="s", raters="t", ratings="y")
    icc.append(tb.set_index("Type").loc[[n for n in ${JSON.stringify(PG_ICC[st.rel.type])} if n in set(tb["Type"])][0], "ICC"])
print("mean ICC", np.mean(icc))
def cmc(c):   # Ferrari 2010, one protocol: c = sessions x nodes
    G, F = c.shape; yf = c.mean(0); y = c.mean()
    r = ((c - yf) ** 2).sum() / (F * (G - 1)) / (((c - y) ** 2).sum() / (G * F - 1))
    return np.sqrt(1 - r) if r <= 1 else np.nan
print("CMC", np.nanmean([cmc(c) for c in cube]), np.nanstd([cmc(c) for c in cube], ddof=1))
t = spm1d.stats.ttest_paired(cube[:, 0], cube[:, 1]).inference(0.05, two_tailed=True)
print(t)
` });
      await exportBundle({ base: "bioscout_reliability_curves", tables: blocksToTables(res.blocks), figures: res.blocks.filter((b) => b.type === "fig"), files, readme: readme(res.title, null, "relcont") }, download);
    }
  }

  /* ---------------- Curves (SPM + continuous reliability) ---------------- */
  function curvesLoaderHTML() {
    const sp = st.spm, n = sp.curves.length;
    const levels = (k) => S.levelsOf(sp.curves.filter((c) => c.use).map((c) => c[k]));
    return `<div class="anLoader">
      <div class="anBtns">
        <label class="ghost anSmall anFileBtn"><input type="file" id="anCurveFiles" multiple accept=".csv,.tsv,.txt,.mot,.sto,.trc,.c3d,.xlsx" hidden>${L("addFiles")}</label>
        <label class="ghost anSmall anFileBtn"><input type="file" id="anCurveDir" webkitdirectory multiple hidden>${L("addFolder")}</label>
        <label class="ghost anSmall anFileBtn"><input type="file" id="anCurveTable" accept=".csv,.tsv,.txt,.xlsx" hidden>${L("addTable")}</label>
        ${n ? `<button type="button" class="ghost anSmall" id="anCurveClear">${L("clear")}</button>` : ""}
      </div>
      <label class="anRole"><span>${L("fileFilter")}</span><input type="text" id="anCurveFilter" value="${esc(sp.filter)}" placeholder="*force*.sto" spellcheck="false"></label>
      <p class="note">${L("curvesIntro")}</p>
      ${n ? `<div class="anRoles">
        ${sp.cols.length ? `<label class="anRole"><span>${L("variable")}</span>${sel("anCurveVar", sp.cols.map((c) => [c, c]), sp.variable)}</label>` : ""}
        <label class="anRole"><span>${L("nodes")}</span><input type="number" id="anCurveQ" min="11" max="1001" step="1" value="${sp.Q}"></label>
        <label class="anRole"><span>${L("ylabel")}</span><input type="text" id="anYlabel" value="${esc(sp.ylabel)}" placeholder="${esc(sp.variable || "")}"></label>
        <label class="anRole"><span>${L("nameA")}</span><input type="text" id="anNameA" value="${esc(sp.names.A)}"></label>
        <label class="anRole"><span>${L("nameB")}</span><input type="text" id="anNameB" value="${esc(sp.names.B)}"></label>
      </div>
      <div class="anPattern"><label class="anRole"><span>${L("pattern")}</span><input type="text" id="anPattern" value="${esc(sp.pattern)}" spellcheck="false"></label>
        <button type="button" class="ghost anSmall" id="anPatternApply">${L("applyPattern")}</button></div>
      <p class="note">${L("patternNote")}</p>
      <p class="sub">${n} ${L("curves")} · ${L("subjects")}: ${levels("subject").length} · ${esc(sp.names.A)}: ${esc(levels("A").join(", ") || "–")} · ${esc(sp.names.B)}: ${esc(levels("B").join(", ") || "–")}</p>
      <div class="anTblWrap anCurves"><table class="anTbl"><thead><tr><th>✓</th><th>${L("file")}</th><th>${L("subject")}</th><th>${esc(sp.names.A)}</th><th>${esc(sp.names.B)}</th><th>${L("covariate")}</th><th>${L("preview")}</th></tr></thead><tbody>${
        sp.curves.map((c, i) => `<tr${c.y ? "" : ' class="bad"'}><td><input type="checkbox" data-cuse="${i}"${c.use ? " checked" : ""}></td><td class="sub" title="${esc(c.path || c.name)}">${esc(c.name)}</td>
          ${["subject", "A", "B"].map((f) => `<td><input class="anCell" data-ci="${i}" data-cf="${f}" value="${esc(c[f] ?? "")}"></td>`).join("")}
          <td><input class="anCell num" data-ci="${i}" data-cf="cov" value="${fin(c.cov) ? c.cov : ""}"></td><td>${c.y ? spark(c.y) : esc(L("noVariable"))}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </div>`;
  }

  const spark = (y) => {
    const a = Array.from(y), lo = Math.min(...a), hi = Math.max(...a), w = 90, h = 22;
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline fill="none" stroke="var(--accent)" stroke-width="1.4" points="${a.map((v, i) => `${(i / (a.length - 1)) * w},${h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)}`).join(" ")}"/></svg>`;
  };

  /** Fill subject / A / B / cov from the file name (and folders) with a pattern like {group}/{subject}_{condition}_{*}. */
  function applyPattern() {
    const sp = st.spm, pat = sp.pattern.trim();
    if (!pat) return;
    const segs = pat.split("/"), split = (s) => s.split(/[_\-\s.]+/).filter(Boolean);
    for (const c of sp.curves) {
      const path = (c.path || c.name).replace(/\\/g, "/").split("/");
      path[path.length - 1] = path[path.length - 1].replace(/\.[^.]+$/, "");
      const take = segs.map((sg, i) => [sg, path[path.length - segs.length + i] || ""]);
      for (const [sg, val] of take) {
        const toks = split(sg), parts = split(val);
        toks.forEach((tk, j) => {
          const m = tk.match(/^\{(\w+|\*)\}$/); if (!m) return;
          const f = { subject: "subject", group: "A", a: "A", condition: "B", b: "B", session: "B", cov: "cov", covariate: "cov" }[m[1].toLowerCase()];
          if (!f) return;
          const v = j === toks.length - 1 ? parts.slice(j).join("_") : parts[j] ?? "";
          c[f] = f === "cov" ? asNum(v) : v;
        });
      }
    }
  }

  function rebuildCurves() {
    const sp = st.spm;
    for (const c of sp.curves) {
      if (!c.ds) continue;
      const y = c.ds.cols[sp.variable];
      c.y = y && Array.from(y).some(fin) ? normalise(y, sp.Q, c.ds.time && c.ds.time.length === y.length ? c.ds.time : null) : null;
    }
  }

  async function addCurveFiles(fileList) {
    const sp = st.spm, re = globRe(sp.filter);
    const files = [...fileList].filter((f) => /\.(csv|tsv|txt|mot|sto|trc|c3d|xlsx)$/i.test(f.name) && (!re || re.test(f.webkitRelativePath || f.name) || re.test(f.name)));
    if (fileList.length && !files.length) { st.msg = L("noFileMatch", { f: sp.filter || "*" }); return; }
    let bad = 0;
    for (const f of files) {
      try {
        const ds = (await readAny(f)).find((d) => Object.keys(d.cols).length) ;
        if (!ds) { bad++; continue; }
        sp.curves.push({ name: f.name, path: f.webkitRelativePath || f.name, ds, subject: "", A: "", B: "", cov: NaN, use: true });
      } catch { bad++; }
    }
    // the variable list: columns every file has first, then the rest
    const counts = new Map();
    for (const c of sp.curves) if (c.ds) for (const k of Object.keys(c.ds.cols)) counts.set(k, (counts.get(k) || 0) + 1);
    sp.cols = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    if (!sp.cols.includes(sp.variable)) sp.variable = sp.cols[0] || "";
    applyPattern(); rebuildCurves();
    st.msg = bad ? L("filesSkipped", { n: bad }) : "";
  }

  /** "*force*.sto" or "force; .mot" -> a regex over the file path (no wildcard = "contains"). */
  function globRe(f) {
    const parts = String(f || "").split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return null;
    const one = (g) => (/[*?]/.test(g) ? "(^|/)" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$" : g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(parts.map(one).join("|"), "i");
  }

  /** One table: rows are curves when it has label columns before the numbers, else columns are curves. */
  async function addCurveTable(file) {
    const T = typeTable(await readTableFile(file), file.name), sp = st.spm;
    const lab = T.vars.filter((v) => v.type === "nominal"), num = T.vars.filter((v) => v.type === "scale");
    const find = (re) => lab.find((v) => re.test(v.name)) || T.vars.find((v) => re.test(v.name));
    if (lab.length || num.length < 3 || T.n < num.length / 3) {
      // rows are curves: label columns + one numeric column per node
      const fs = { subject: find(/^(subj|subject|participant|id)/i), A: find(/^(group|grp|a)$/i), B: find(/^(cond|condition|session|b|day|trial)/i), cov: T.vars.find((v) => /^(cov|covariate|speed|age|mass)/i.test(v.name)) };
      const nodes = num.filter((v) => v !== fs.cov && v !== fs.subject);
      for (let i = 0; i < T.n; i++) {
        const y = Float64Array.from(nodes, (v) => asNum(v.raw[i]));
        sp.curves.push({ name: `${file.name} #${i + 1}`, path: "", y: normalise(y, sp.Q), raw: y, subject: fs.subject ? fs.subject.raw[i] : String(i + 1), A: fs.A ? fs.A.raw[i] : "", B: fs.B ? fs.B.raw[i] : "", cov: fs.cov ? asNum(fs.cov.raw[i]) : NaN, use: true });
      }
    } else {
      // columns are curves; their names go through the pattern
      const tcol = num.find((v) => /^(time|frame|x|percent|%|node)/i.test(v.name));
      for (const v of num) {
        if (v === tcol) continue;
        const y = Float64Array.from(v.raw, asNum);
        sp.curves.push({ name: v.name, path: "", y: normalise(y, sp.Q), raw: y, subject: "", A: "", B: "", cov: NaN, use: true });
      }
      applyPattern();
    }
  }

  function curveFiles(curves) {
    const sp = st.spm, Q = curves[0].y.length;
    const head = ["file", "subject", "group", "condition", "covariate", ...Array.from({ length: Q }, (_, q) => `n${String(q).padStart(3, "0")}`)];
    return [{ name: "data/curves_long.csv", data: "﻿" + csvOf([head, ...curves.map((c) => [c.name, c.subject, c.A, c.B, fin(c.cov) ? c.cov : "", ...Array.from(c.y)])]) },
      { name: "data/factor_names.txt", data: `group = ${sp.names.A}\ncondition = ${sp.names.B}\nvariable = ${sp.variable || sp.ylabel || ""}\nnodes = ${Q} (0-100 %)\n` }];
  }
  const curvesPyLoader = () => `import matplotlib.pyplot as plt

d = pd.read_csv("data/curves_long.csv", encoding="utf-8-sig", dtype={"subject": str, "group": str, "condition": str})
nodes = [c for c in d.columns if c.startswith("n") and c[1:].isdigit()]
Y = d[nodes].to_numpy(float)
meta = d[["file", "subject", "group", "condition", "covariate"]].fillna("")
`;

  function spmSuggest() {
    const sp = st.spm, cur = sp.curves.filter((c) => c.use && c.y);
    const nA = S.levelsOf(cur.map((c) => c.A)).length, nB = S.levelsOf(cur.map((c) => c.B)).length, hasCov = cur.some((c) => fin(c.cov));
    const subjRepeat = new Set(cur.map((c) => c.subject)).size < cur.length;
    if (nA >= 2 && nB >= 2) return subjRepeat ? "anova2onerm" : "anova2";
    if (nB === 2 && subjRepeat) return "ttest_paired";
    if (nB > 2 && subjRepeat) return "anova1rm";
    if (nA === 2) return hasCov ? "ancova" : "ttest2";
    if (nA > 2) return hasCov ? "ancova" : "anova1";
    if (hasCov) return "regress";
    return "ttest";
  }

  function spmHTML() {
    const sp = st.spm, test = sp.test || spmSuggest();
    const labelOf = (k) => L("spm_" + k).replace("{A}", sp.names.A).replace("{B}", sp.names.B);
    return `<div class="card"><div class="labHead"><b>SPM</b><button type="button" class="ghost anSmall" id="anSpmEx">${L("example")}</button></div>
      <p class="note">${L("spmIntro")}</p>
      ${curvesLoaderHTML()}</div>
      ${sp.curves.length ? `<div class="card"><div class="labHead"><b>${L("analysis")}</b></div>
        <label class="anRole"><span>${L("test")}</span>${sel("anSpmTest", Object.keys(TESTS).map((k) => [k, labelOf(k) + (k === spmSuggest() ? " ★" : "")]), test)}</label>
        <p class="note">${L("spmn_" + test).replace(/\{A\}/g, sp.names.A).replace(/\{B\}/g, sp.names.B)} ${L("suggested")}</p>
        <div class="anRoles">
          <label class="anRole"><span>α</span><input type="number" id="anSpmAlpha" min="0.001" max="0.2" step="0.005" value="${sp.alpha}"></label>
          ${test === "ttest" ? `<label class="anRole"><span>${L("role_mu")}</span><input type="number" step="any" id="anSpmMu" value="${sp.mu}"></label>` : ""}
          <label class="anRole"><span>${L("inference")}</span>${sel("anSpmInf", [["rft", L("rft")], ["perm", L("perm")]], sp.perm ? "perm" : "rft")}</label>
          ${sp.perm ? `<label class="anRole"><span>${L("iterations")}</span><input type="number" id="anSpmIters" min="200" max="20000" step="100" value="${sp.iters}"></label>` : ""}
        </div>
        ${["ttest", "ttest_paired", "ttest2", "regress"].includes(test) ? `<label class="anCheck"><input type="checkbox" id="anSpmTwo"${sp.two ? " checked" : ""}> ${L("twoTailed")}</label>` : ""}
        <button type="button" id="anSpmRun">${L("run")}</button></div>` : ""}
      ${resultCard(sp.result, "anSpmExport")}`;
  }

  function runSpmUI() {
    const sp = st.spm, test = sp.test || spmSuggest();
    const curves = sp.curves.filter((c) => c.use && c.y);
    if (curves.length < 4) throw new Error(L("errFewCurves"));
    const r = runSpm(curves.map((c) => ({ y: c.y, subject: c.subject, A: c.A, B: c.B, cov: c.cov })), { test, alpha: +sp.alpha || 0.05, twoTailed: sp.two, mu: +sp.mu || 0, nonparam: sp.perm ? { iterations: Math.max(200, +sp.iters || 1000) } : false });
    const B = [], Q = r.Q, pct = (x) => S.fmt((100 * x) / (Q - 1), 1), yl = sp.ylabel || sp.variable || L("value");
    const nm = (s) => s.replace(/^A = /, `${sp.names.A} = `).replace(/^B = /, `${sp.names.B} = `).replace(/^A \(between\)$/, `${sp.names.A} (${L("between")})`).replace(/^B \(within\)$/, `${sp.names.B} (${L("within")})`).replace(/^A × B$/, `${sp.names.A} × ${sp.names.B}`).replace(/^A$/, sp.names.A).replace(/^B$/, sp.names.B).replace(/^group \(adjusted\)$/, `${sp.names.A} (${L("adjusted")})`).replace(/^group$/, sp.names.A).replace(/^condition$/, sp.names.B);
    // assumptions
    const A = r.assumptions, checks = [];
    if (A.normality) {
      const n = A.normality;
      checks.push({ test: `${L("normality")} – ${L("residuals")} (${n.k2 ? "D'Agostino-Pearson K², SPM{χ²}" : "Shapiro-Wilk"})`, stat: n.k2 ? `max K² = ${S.fmt(Math.max(...n.k2.z))}, K²* = ${S.fmt(n.k2.zstar)}` : "", p: n.k2 && n.k2.clusters.length ? Math.min(...n.k2.clusters.map((c) => c.p)) : "", ok: n.ok, hint: n.ok ? "" : L("hintPerm") });
      checks.push({ test: `${L("normality")} – Shapiro-Wilk ${L("perNode")}`, stat: `${Math.round(n.swShare * 100)} % ${L("nodesBelow")}`, p: "", ok: null, hint: n.J < 8 ? L("fewForK2") : "" });
    }
    if (A.variance) checks.push({ test: `${L("eqVar")} (Levene) ${L("perNode")}`, stat: `${Math.round(A.variance.share * 100)} % ${L("nodesBelow")}`, p: A.variance.minP, ok: A.variance.ok, hint: A.variance.ok ? `min p` : L("hintVarSpm") });
    if (A.sphericity) checks.push({ test: `${L("sphericity")} (Mauchly) ${L("perNode")}`, stat: `${Math.round(A.sphericity.share * 100)} % ${L("nodesBelow")}, min ε GG = ${S.fmt(A.sphericity.minEps)}`, p: "", ok: A.sphericity.ok, hint: A.sphericity.ok ? "" : L("hintSphSpm") });
    if (A.slopes) checks.push({ test: `${L("slopes")} (SPM{F} ${sp.names.A} × ${L("covariate")})`, stat: `F* = ${S.fmt(A.slopes.spmi.zstar)}`, p: A.slopes.spmi.clusters.length ? Math.min(...A.slopes.spmi.clusters.map((c) => c.p)) : "", ok: A.slopes.ok, hint: A.slopes.ok ? "" : L("hintSlopes") });
    B.push({ type: "check", name: L("assumptions"), rows: checks });
    for (const note of r.notes) B.push({ type: "note", warn: true, text: note });
    // descriptives figure(s)
    const groupsDesc = r.descriptives;
    const descFig = (list, title) => G.curvesSVG(list.map((d, j) => ({ y: d.mean, lo: d.mean.map((v, q) => v - d.sd[q]), hi: d.mean.map((v, q) => v + d.sd[q]), color: C[j % C.length], label: `${nm(d.name)} (n = ${d.n})` })), { ylabel: yl, xlabel: L("cycle"), title });
    const aDesc = groupsDesc.filter((d) => d.name.startsWith("A = ")), bDesc = groupsDesc.filter((d) => d.name.startsWith("B = ")), plain = groupsDesc.filter((d) => !/^[AB] = /.test(d.name));
    if (plain.length) B.push({ type: "fig", name: `${L("meanSD")} – ${yl}`, svg: descFig(plain) });
    if (aDesc.length) B.push({ type: "fig", name: `${L("meanSD")} – ${sp.names.A}`, svg: descFig(aDesc) });
    if (bDesc.length) B.push({ type: "fig", name: `${L("meanSD")} – ${sp.names.B}`, svg: descFig(bDesc) });
    if (r.adjustedMeans) B.push({ type: "fig", name: `${L("adjMeans")} – ${sp.names.A}`, svg: G.curvesSVG(r.adjustedMeans.map((d, j) => ({ y: d.mean, color: C[j % C.length], label: d.name })), { ylabel: yl, xlabel: L("cycle") }) });
    // effects
    const crow = [];
    for (const e of r.effects) {
      const s = e.spmi;
      B.push({ type: "fig", name: `${nm(e.name)} – ${s.STAT === "T" ? "SPM{t}" : "SPM{F}"} (${s.method === "rft" ? "RFT" : L("perm")})`, svg: G.spmSVG(s, { xlabel: L("cycle") }),
        caption: `${s.STAT}(${s.df[0] === 1 && s.STAT === "T" ? s.df[1] : s.df.map((v) => S.fmt(v, 0)).join(", ")}) · α = ${s.alpha} · ${s.STAT}* = ${S.fmt(s.zstar)}${s.fwhm ? ` · FWHM = ${S.fmt(s.fwhm, 1)}` : ""} · ${s.clusters.length ? L("clustersFound", { list: s.clusters.map((c) => `${pct(c.x0)}–${pct(c.x1)} % (p ${S.fmtP(c.p)})`).join("; ") }) : L("noClusters")}` });
      if (!s.clusters.length) crow.push([nm(e.name), s.STAT, s.df.map((v) => S.fmt(v, 0)).join(", "), s.zstar, "–", "", "", "", "", P(NaN)]);
      for (const c of s.clusters) crow.push([nm(e.name), s.STAT, s.df.map((v) => S.fmt(v, 0)).join(", "), s.zstar, `${pct(c.x0)} – ${pct(c.x1)}`, S.fmt(c.extent * 100 / (Q - 1), 1), c.peak, `${pct(c.peakAt)}`, c.sign > 0 ? "+" : "−", P(c.p)]);
    }
    B.push({ type: "table", name: L("clusters"), head: [L("effect"), L("stat"), "df", L("threshold"), `${L("cluster")} (%)`, `${L("extent")} (%)`, L("peak"), `${L("peakAt")} (%)`, L("sign"), "p"], rows: crow, note: L("clusterNote") });
    if (r.effectSize) B.push({ type: "fig", name: `${L("effectSize")} – ${r.effectSize.name}`, svg: G.curvesSVG([{ y: r.effectSize.y, color: C[4], label: r.effectSize.name }], { ylabel: r.effectSize.name, xlabel: L("cycle"), hlines: r.effectSize.name === "r" ? [] : [{ y: 0.8, label: "0.8", color: "var(--muted)", dash: "2 4" }, { y: -0.8, color: "var(--muted)", dash: "2 4" }] }) });
    if (r.posthoc.length) {
      const prow = [];
      for (const ph of r.posthoc) {
        const s = ph.spmi;
        B.push({ type: "fig", name: `${L("posthoc")} – ${ph.name} (α = ${S.fmt(ph.alpha, 4)})`, svg: G.spmSVG(s, { xlabel: L("cycle") }) });
        if (!s.clusters.length) prow.push([ph.name, ph.alpha, s.zstar, "–", "", P(NaN)]);
        for (const c of s.clusters) prow.push([ph.name, ph.alpha, s.zstar, `${pct(c.x0)} – ${pct(c.x1)}`, c.sign > 0 ? "+" : "−", P(c.p)]);
      }
      B.push({ type: "table", name: L("posthoc"), head: [L("comparison"), "α (Šidák)", "t*", `${L("cluster")} (%)`, L("sign"), "p"], rows: prow });
    }
    // cluster means: one value per curve per significant cluster, for JASP / SPSS follow-ups
    const cm = [];
    for (const e of r.effects) for (const [ci, c] of e.spmi.clusters.entries()) cm.push({ label: `${safeName(nm(e.name))}_c${ci + 1}_${Math.round(pct(c.x0))}_${Math.round(pct(c.x1))}`, i0: c.i0, i1: c.i1 });
    return { title: `SPM – ${L("spm_" + test).replace("{A}", sp.names.A).replace("{B}", sp.names.B)}`, blocks: B, spm: r, test, clusterMeans: cm, curves };
  }

  async function exportSpm() {
    const res = st.spm.result, sp = st.spm, r = res.spm, Q = r.Q, curves = res.curves;
    const files = curveFiles(curves);
    const nodeHead = ["node", "percent", ...r.effects.flatMap((e) => [`${safeName(e.name)}_${e.spmi.STAT}`, `${safeName(e.name)}_threshold`]), ...r.descriptives.flatMap((d) => [`mean_${safeName(d.name)}`, `sd_${safeName(d.name)}`])];
    files.push({ name: "tables/spm_nodes.csv", data: csvOf([nodeHead, ...Array.from({ length: Q }, (_, q) => [q, (100 * q) / (Q - 1), ...r.effects.flatMap((e) => [e.spmi.z[q], e.spmi.zstar]), ...r.descriptives.flatMap((d) => [d.mean[q], d.sd[q]])])]) });
    if (res.clusterMeans.length) {
      const head = ["file", "subject", sp.names.A, sp.names.B, L("covariate"), ...res.clusterMeans.map((c) => c.label)];
      const rows = curves.map((c) => [c.name, c.subject, c.A, c.B, fin(c.cov) ? c.cov : "", ...res.clusterMeans.map((k) => { let s = 0; for (let q = k.i0; q <= k.i1; q++) s += c.y[q]; return s / (k.i1 - k.i0 + 1); })]);
      files.push({ name: "data/cluster_means_for_jasp_spss.csv", data: "﻿" + csvOf([head, ...rows]) });
    }
    const t = res.test, a = +sp.alpha || 0.05, two = sp.two ? "True" : "False";
    const code = {
      ttest: `m = meta.groupby("subject").groups if (meta.subject != "").any() else None\nYs = np.array([Y[i].mean(0) for i in m.values()]) if m else Y\nt = spm1d.stats.ttest(Ys, ${+sp.mu || 0}).inference(${a}, two_tailed=${two})\nprint(t); t.plot(); plt.show()`,
      ttest_paired: `lv = sorted(meta.condition.unique())\ncell = lambda s, c: Y[(meta.subject == s) & (meta.condition == c)].mean(0)\nsubs = [s for s in sorted(meta.subject.unique()) if all(((meta.subject == s) & (meta.condition == c)).any() for c in lv)]\nYA = np.array([cell(s, lv[0]) for s in subs]); YB = np.array([cell(s, lv[1]) for s in subs])\nt = spm1d.stats.ttest_paired(YA, YB).inference(${a}, two_tailed=${two})\nprint(t); t.plot(); plt.show()`,
      ttest2: `g = meta.assign(i=range(len(meta))).groupby(["subject", "group"]).i.apply(list)\nYs = np.array([Y[i].mean(0) for i in g]); G = np.array([k[1] for k in g.index])\nlv = sorted(set(G))\nt = spm1d.stats.ttest2(Ys[G == lv[0]], Ys[G == lv[1]], equal_var=True).inference(${a}, two_tailed=${two})\nprint(t); t.plot(); plt.show()`,
      regress: `g = meta.assign(i=range(len(meta))).groupby("subject").i.apply(list)\nYs = np.array([Y[i].mean(0) for i in g]); x = np.array([float(meta.covariate.iloc[i[0]]) for i in g])\nt = spm1d.stats.regress(Ys, x).inference(${a}, two_tailed=${two})\nprint(t); t.plot(); plt.show()`,
      anova1: `g = meta.assign(i=range(len(meta))).groupby(["subject", "group"]).i.apply(list)\nYs = np.array([Y[i].mean(0) for i in g]); A = pd.factorize(np.array([k[1] for k in g.index]), sort=True)[0]\nF = spm1d.stats.anova1(Ys, A, equal_var=True).inference(${a})\nprint(F); F.plot(); plt.show()`,
      anova1rm: `g = meta.assign(i=range(len(meta))).groupby(["subject", "condition"]).i.apply(list)\nYs = np.array([Y[i].mean(0) for i in g])\nS = pd.factorize(np.array([k[0] for k in g.index]), sort=True)[0]; A = pd.factorize(np.array([k[1] for k in g.index]), sort=True)[0]\nF = spm1d.stats.anova1rm(Ys, A, S, equal_var=True).inference(${a})\nprint(F); F.plot(); plt.show()`,
      anova2: `g = meta.assign(i=range(len(meta))).groupby(["subject", "group", "condition"]).i.apply(list)\nYs = np.array([Y[i].mean(0) for i in g])\nA = pd.factorize(np.array([k[1] for k in g.index]), sort=True)[0]; B = pd.factorize(np.array([k[2] for k in g.index]), sort=True)[0]\nF = spm1d.stats.anova2(Ys, A, B, equal_var=True).inference(${a})\nprint(F); F.plot(); plt.show()`,
      anova2onerm: `g = meta.assign(i=range(len(meta))).groupby(["subject", "group", "condition"]).i.apply(list)\nYs = np.array([Y[i].mean(0) for i in g])\nS = pd.factorize(np.array([k[0] for k in g.index]), sort=True)[0]\nA = pd.factorize(np.array([k[1] for k in g.index]), sort=True)[0]; B = pd.factorize(np.array([k[2] for k in g.index]), sort=True)[0]\nF = spm1d.stats.anova2onerm(Ys, A, B, S, equal_var=True).inference(${a})\nprint(F); F.plot(); plt.show()`,
      ancova: `# spm1d has no ANCOVA front end: the same GLM node by node with statsmodels (type III).\nimport statsmodels.formula.api as smf, statsmodels.api as sm\ng = meta.assign(i=range(len(meta))).groupby(["subject", "group"]).i.apply(list)\nYs = np.array([Y[i].mean(0) for i in g]); grp = [k[1] for k in g.index]; cov = [float(meta.covariate.iloc[i[0]]) for i in g]\nF = []\nfor q in range(Ys.shape[1]):\n    dq = pd.DataFrame(dict(y=Ys[:, q], g=grp, c=cov))\n    F.append(sm.stats.anova_lm(smf.ols("y ~ C(g, Sum) + c", data=dq).fit(), typ=3).loc["C(g, Sum)", "F"])\nR = np.array([smf.ols("y ~ C(g, Sum) + c", data=pd.DataFrame(dict(y=Ys[:, q], g=grp, c=cov))).fit().resid for q in range(Ys.shape[1])]).T\nfwhm = spm1d.geom.estimate_fwhm(R)\nk = len(set(grp)) - 1; v = len(grp) - k - 2\nFstar = spm1d.rft1d.f.isf(${a}, (k, v), Ys.shape[1], fwhm)\nprint("F* =", Fstar, "FWHM =", fwhm); plt.plot(F); plt.axhline(Fstar, ls="--"); plt.show()`,
    }[t];
    files.push({ name: "analysis.py", data: pyHeader(" spm1d") + curvesPyLoader() + "import spm1d\n\n" + code + "\n" });
    await exportBundle({ base: "bioscout_spm", tables: blocksToTables(res.blocks), figures: res.blocks.filter((b) => b.type === "fig"), files, readme: readme(res.title, null, "spm") }, download);
  }

  function readme(title, map, kind) {
    const lines = [`BioScout Web – Analysis`, `${title}`, `Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, "",
      "results.xlsx            all result tables, one sheet each", "tables/*.csv            the same tables as CSV", "figures/*.svg, *.png     every figure (SVG for editing, PNG for slides)"];
    if (kind === "stats" || kind === "rel") lines.push("data/data_wide.csv      the analysed variables, original names and labels  -> open in JASP (File > Open)",
      "data/data_spss.csv      SPSS/Python-safe names; nominal variables also as numeric codes (<name>_code)", "analysis.sps            SPSS syntax: loads data_spss.csv and runs the same analysis (File > Open > Syntax, Run All)", "analysis.py             Python (pandas + pingouin) that repeats it");
    else lines.push("data/curves_long.csv    one row per curve: file, subject, group, condition, covariate, n000..nQ (time-normalised nodes)", "data/cluster_means_for_jasp_spss.csv  (when clusters were found) each curve's mean inside each significant cluster - for follow-up tests in JASP or SPSS", "tables/spm_nodes.csv    statistic curve(s), thresholds and mean/SD curves node by node", "analysis.py             Python (pandas + spm1d) that repeats the analysis");
    if (map) { lines.push("", "Variable names (original -> SPSS/Python):"); for (const m of map) lines.push(`  ${m.orig} -> ${m.safe}${m.codeName ? ` (codes in ${m.codeName}: ${m.levels.map((l, i) => `${i + 1}=${l}`).join(", ")})` : ""}`); }
    lines.push("", L("readmeMethods"));
    return lines.join("\r\n") + "\r\n";
  }

  /* ---------------- render + events ---------------- */
  function render() {
    root.innerHTML = `<div class="card"><div class="labHead"><b style="font-size:16px">${L("title")}</b>
        <button type="button" class="ghost labHomeBtn anSmall">${t("labHome")}</button></div>
      <div class="anTabs">${tabBtn("rel", L("tabRel"))}${tabBtn("stats", L("tabStats"))}${tabBtn("spm", "SPM")}</div>
      ${st.msg ? `<p class="note bad anNote">${esc(st.msg)}</p>` : ""}${st.busy ? `<p class="note">${L("working")}</p>` : ""}</div>
      ${st.tab === "rel" ? relHTML() : st.tab === "stats" ? statsHTML() : spmHTML()}`;
  }

  const run = (fn, set) => {
    st.busy = true; st.msg = ""; render();
    setTimeout(() => {
      try { set(fn()); } catch (e) { st.msg = e.message || String(e); console.error(e); }
      st.busy = false; render();
      root.querySelector(".anResult")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 20);
  };
  const doExport = async (fn) => { try { st.msg = ""; await fn(); } catch (e) { st.msg = e.message || String(e); console.error(e); render(); } };

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !root.contains(b)) return;
    if (b.dataset.tab) { st.tab = b.dataset.tab; st.msg = ""; render(); return; }
    if (b.dataset.relmode) { st.rel.mode = b.dataset.relmode; st.rel.result = null; render(); return; }
    switch (b.id) {
      case "anStatsEx": st.stats.table = typeTable(exampleStats(), "example_jump_training.csv"); st.stats.roles = { dv: "jump_post", group: "group", vars: ["jump_pre", "jump_post", "peak_force"], levels: ["jump_pre", "jump_post", "jump_6w"], a: "jump_pre", b: "jump_post", A: "group", B: "sex", covs: ["mass"], preds: ["mass", "speed"], split: "group" }; st.stats.result = null; render(); break;
      case "anStatsRun": run(runStats, (r) => (st.stats.result = r)); break;
      case "anStatsExport": doExport(exportStats); break;
      case "anRelEx": st.rel.table = typeTable(exampleReliability(), "example_strength_retest.csv"); st.rel.result = null; render(); break;
      case "anRelRun": run(runRelDiscrete, (r) => (st.rel.result = r)); break;
      case "anRelContRun": run(runRelCont, (r) => (st.rel.result = r)); break;
      case "anRelExport": doExport(exportRel); break;
      case "anRelCurvesEx": Object.assign(st.spm, { curves: exampleCurves("rel"), cols: [], variable: "", ylabel: "Knee flexion (°)", names: { A: st.spm.names.A, B: "Session" }, pattern: "{subject}_{session}", result: null }); st.rel.session = "B"; st.rel.result = null; render(); break;
      case "anSpmEx": Object.assign(st.spm, { curves: exampleCurves("spm"), cols: [], variable: "", ylabel: "Knee flexion (°)", names: { A: "Group", B: "Speed" }, pattern: "{subject}_{group}_{condition}", test: "", result: null }); render(); break;
      case "anCurveClear": Object.assign(st.spm, { curves: [], cols: [], variable: "", result: null }); render(); break;
      case "anPatternApply": applyPattern(); render(); break;
      case "anSpmRun": run(runSpmUI, (r) => (st.spm.result = r)); break;
      case "anSpmExport": doExport(exportSpm); break;
    }
  });

  root.addEventListener("change", async (e) => {
    const el = e.target, sp = st.spm;
    if (el.id === "anStatsFile" || el.id === "anRelFile") {
      const f = el.files[0]; if (!f) return;
      try {
        const T = typeTable(await readTableFile(f), f.name);
        if (el.id === "anStatsFile") { st.stats.table = T; st.stats.roles = {}; st.stats.result = null; } else { st.rel.table = T; st.rel.result = null; }
        st.msg = "";
      } catch (err) { st.msg = L("errRead", { msg: err.message }); }
      render(); return;
    }
    if (el.id === "anCurveFiles" || el.id === "anCurveDir") { st.busy = true; render(); await addCurveFiles(el.files); st.busy = false; sp.result = null; render(); return; }
    if (el.id === "anCurveTable") { try { await addCurveTable(el.files[0]); st.msg = ""; } catch (err) { st.msg = L("errRead", { msg: err.message }); } sp.result = null; render(); return; }
    if (el.dataset.vtype != null) { st.stats.table.vars[+el.dataset.vtype].type = el.value; render(); return; }
    if (el.dataset.role) { st.stats.roles[el.dataset.role] = el.value; return; }
    if (el.dataset.mrole) {
      const r = el.dataset.mrole, cur = new Set(st.stats.roles[r] || []);
      if (el.checked) cur.add(el.value); else cur.delete(el.value);
      // keep the table's column order (it is the level order of a repeated factor)
      st.stats.roles[r] = st.stats.table.vars.map((v) => v.name).filter((n) => cur.has(n));
      el.closest(".anChip")?.classList.toggle("on", el.checked); return;
    }
    if (el.dataset.cuse != null) { sp.curves[+el.dataset.cuse].use = el.checked; return; }
    if (el.dataset.ci != null) { const c = sp.curves[+el.dataset.ci], f = el.dataset.cf; c[f] = f === "cov" ? asNum(el.value) : el.value.trim(); return; }
    switch (el.id) {
      case "anKind": {
        st.stats.kind = el.value; st.stats.result = null;
        // the two-group tests need a two-level factor: pick one if the current one is not
        const R = st.stats.roles, T = st.stats.table, two = (n) => { const v = T.vars.find((x) => x.name === n); return v && S.levelsOf(valuesOf(v)).length === 2; };
        if (el.value === "ttest_ind" && !two(R.group)) { const v = T.vars.find((x) => x.type === "nominal" && two(x.name)); if (v) R.group = v.name; }
        render(); break;
      }
      case "anNonpar": st.stats.nonpar = el.checked; break;
      case "anIccType": st.rel.type = el.value; break;
      case "anRelSep": st.rel.sep = el.value || "-"; render(); break;
      case "anRelZero": st.rel.zero = el.checked; break;
      case "anRelSession": st.rel.session = el.value; break;
      case "anCurveVar": sp.variable = el.value; rebuildCurves(); sp.result = null; render(); break;
      case "anCurveQ": sp.Q = Math.max(11, Math.min(1001, Math.round(+el.value) || 101)); for (const c of sp.curves) if (!c.ds && c.raw) c.y = normalise(c.raw, sp.Q); else if (!c.ds && c.y) c.y = normalise(c.y, sp.Q); rebuildCurves(); render(); break;
      case "anYlabel": sp.ylabel = el.value; break;
      case "anNameA": sp.names.A = el.value || "Group"; render(); break;
      case "anNameB": sp.names.B = el.value || "Condition"; render(); break;
      case "anPattern": sp.pattern = el.value; break;
      case "anCurveFilter": sp.filter = el.value.trim(); break;
      case "anSpmTest": sp.test = el.value; sp.result = null; render(); break;
      case "anSpmAlpha": sp.alpha = +el.value || 0.05; break;
      case "anSpmMu": sp.mu = +el.value || 0; break;
      case "anSpmInf": sp.perm = el.value === "perm"; render(); break;
      case "anSpmIters": sp.iters = +el.value || 1000; break;
      case "anSpmTwo": sp.two = el.checked; break;
    }
  });

  render();
  return { render };
}
