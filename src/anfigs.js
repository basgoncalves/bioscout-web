/**
 * anfigs.js -- the figures of Analysis, as standalone SVG strings.
 *
 * Every figure is drawn once, with CSS variables for the page (so it follows
 * light / dark mode), and exported through lightSvg() with those variables
 * replaced by fixed print colours -- a figure dropped into a manuscript, a
 * JASP report or a Python notebook must look the same whatever theme the page
 * was in. Font: the system sans; sizes in px at a 720-wide viewBox.
 */

export const PALETTE = ["#2f6fe4", "#e8871a", "#1d7a45", "#c0392b", "#7d5bbe", "#0f8f9c", "#b8860b", "#d6336c"];
const LIGHT = { "--ink": "#14161a", "--muted": "#5d626e", "--line": "#d5d9e0", "--card": "#ffffff", "--accent": "#2d706c", "--warn": "#b4540f", "--good": "#1d7a45" };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fin = Number.isFinite;
const f3 = (v) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : +v.toPrecision(3));

/** "Nice" axis ticks. */
export function ticks(lo, hi, n = 5) {
  if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
  const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function frame({ W, H, m, xr, yr, xlabel, ylabel, title, xt, yt }) {
  const X = (v) => m.l + ((v - xr[0]) / (xr[1] - xr[0])) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - yr[0]) / (yr[1] - yr[0])) * (H - m.t - m.b);
  let s = "";
  for (const v of yt) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="var(--muted)">${f3(v)}</text>`;
  for (const v of xt) s += `<line x1="${X(v)}" x2="${X(v)}" y1="${H - m.b}" y2="${H - m.b + 4}" stroke="var(--muted)"/><text x="${X(v)}" y="${H - m.b + 17}" text-anchor="middle" font-size="12" fill="var(--muted)">${f3(v)}</text>`;
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="var(--muted)"/><line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)"/>`;
  if (xlabel) s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle" font-size="13" fill="var(--ink)">${esc(xlabel)}</text>`;
  if (ylabel) s += `<text transform="translate(14 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="var(--ink)">${esc(ylabel)}</text>`;
  if (title) s += `<text x="${m.l}" y="16" font-size="14" font-weight="600" fill="var(--ink)">${esc(title)}</text>`;
  return { X, Y, s };
}

const wrap = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" class="anFig">${body}</svg>`;

function legend(items, x, y, W) {
  let s = "", cx = x, cy = y;
  for (const it of items) {
    const w = 26 + it.label.length * 6.6;
    if (cx + w > W - 10) { cx = x; cy += 16; }
    s += it.band ? `<rect x="${cx}" y="${cy - 8}" width="18" height="9" fill="${it.color}" opacity=".25"/>` : "";
    s += `<line x1="${cx}" x2="${cx + 18}" y1="${cy - 3.5}" y2="${cy - 3.5}" stroke="${it.color}" stroke-width="2.2" ${it.dash ? 'stroke-dasharray="5 3"' : ""}/>`;
    s += `<text x="${cx + 22}" y="${cy}" font-size="12" fill="var(--ink)">${esc(it.label)}</text>`;
    cx += w;
  }
  return { s, h: cy - y + 16 };
}

/**
 * Curves with optional bands.
 * series: [{ y, lo?, hi?, color, label, dash?, width? }], x shared (default 0..100 %).
 * opts: { x, title, xlabel, ylabel, hlines: [{ y, color, dash, label }], shade: [{ x0, x1, color, label }], yr }
 */
export function curvesSVG(series, opts = {}) {
  const W = opts.W || 720, H = opts.H || 300;
  const Q = series[0].y.length, x = opts.x || Array.from({ length: Q }, (_, i) => (100 * i) / (Q - 1));
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (let i = 0; i < Q; i++) for (const v of [s.y[i], s.lo ? s.lo[i] : NaN, s.hi ? s.hi[i] : NaN]) if (fin(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const h of opts.hlines || []) if (fin(h.y)) { lo = Math.min(lo, h.y); hi = Math.max(hi, h.y); }
  if (opts.yr) [lo, hi] = opts.yr;
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const yt = ticks(lo, hi, 5), xt = ticks(x[0], x[Q - 1], 5);
  const lg = legend(series.filter((s) => s.label).map((s) => ({ label: s.label, color: s.color, dash: s.dash, band: !!s.lo })), 60, 0, W);
  const m = { l: 58, r: 14, t: (opts.title ? 26 : 10) + (lg.h > 16 ? lg.h : 16), b: 40 };
  const F = frame({ W, H, m, xr: [x[0], x[Q - 1]], yr: [lo, hi], xlabel: opts.xlabel, ylabel: opts.ylabel, title: opts.title, xt, yt });
  let s = "";
  for (const sh of opts.shade || []) {
    s += `<rect x="${F.X(sh.x0)}" y="${m.t}" width="${Math.max(1, F.X(sh.x1) - F.X(sh.x0))}" height="${H - m.t - m.b}" fill="${sh.color || "#888"}" opacity="${sh.opacity || 0.16}"/>`;
    if (sh.label) s += `<text x="${(F.X(sh.x0) + F.X(sh.x1)) / 2}" y="${m.t + 13}" text-anchor="middle" font-size="11.5" fill="var(--ink)">${esc(sh.label)}</text>`;
  }
  s += F.s;
  for (const sr of series) {
    if (sr.lo && sr.hi) {
      const up = x.map((xv, i) => `${F.X(xv)},${F.Y(sr.hi[i])}`), dn = x.map((xv, i) => `${F.X(xv)},${F.Y(sr.lo[i])}`).reverse();
      s += `<polygon points="${up.concat(dn).join(" ")}" fill="${sr.color}" opacity=".18"/>`;
    }
  }
  if (lo < 0 && hi > 0 && opts.zero !== false) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${F.Y(0)}" y2="${F.Y(0)}" stroke="var(--muted)" stroke-width="1" opacity=".6"/>`;
  for (const h of opts.hlines || []) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${F.Y(h.y)}" y2="${F.Y(h.y)}" stroke="${h.color || "var(--warn)"}" stroke-width="1.4" stroke-dasharray="${h.dash || "6 4"}"/>`;
    if (h.label) s += `<text x="${W - m.r - 4}" y="${F.Y(h.y) - 4}" text-anchor="end" font-size="11.5" fill="${h.color || "var(--warn)"}">${esc(h.label)}</text>`;
  }
  for (const sr of series) {
    const pts = x.map((xv, i) => (fin(sr.y[i]) ? `${F.X(xv).toFixed(1)},${F.Y(sr.y[i]).toFixed(1)}` : null)).filter(Boolean);
    s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${sr.color}" stroke-width="${sr.width || 2}" ${sr.dash ? 'stroke-dasharray="6 4"' : ""}/>`;
  }
  s += `<g transform="translate(0 ${(opts.title ? 26 : 10) + 4})">${lg.s}</g>`;
  return wrap(W, H, s);
}

/** Bland-Altman plot. */
export function blandAltmanSVG(ba, opts = {}) {
  const W = 720, H = opts.H || 320, { mean: mx, diff: dy } = ba.ba;
  const [l1, l2] = ba.loa;
  const xs = mx, ys = [...dy, l1, l2, ba.bias];
  let xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
  const px = (xhi - xlo) * 0.08 || 1, py = (yhi - ylo) * 0.12 || 1;
  xlo -= px; xhi += px; ylo -= py; yhi += py;
  const m = { l: 58, r: 110, t: opts.title ? 28 : 12, b: 40 };
  const F = frame({ W, H, m, xr: [xlo, xhi], yr: [ylo, yhi], xlabel: opts.xlabel || "Mean of the two trials", ylabel: opts.ylabel || "Difference (2nd − 1st)", title: opts.title, xt: ticks(xlo, xhi), yt: ticks(ylo, yhi) });
  let s = F.s;
  const hl = (y, c, lab, dash) => `<line x1="${m.l}" x2="${W - m.r}" y1="${F.Y(y)}" y2="${F.Y(y)}" stroke="${c}" stroke-width="1.5" ${dash ? 'stroke-dasharray="6 4"' : ""}/><text x="${W - m.r + 6}" y="${F.Y(y) + 4}" font-size="12" fill="${c}">${esc(lab)} ${f3(y)}</text>`;
  s += hl(0, "var(--muted)", "", false).replace(/<text[\s\S]*<\/text>/, "");
  s += hl(ba.bias, PALETTE[0], "bias", false) + hl(l1, PALETTE[3], "−1.96 SD", true) + hl(l2, PALETTE[3], "+1.96 SD", true);
  for (let i = 0; i < xs.length; i++) s += `<circle cx="${F.X(xs[i])}" cy="${F.Y(dy[i])}" r="4" fill="${PALETTE[0]}" fill-opacity=".55" stroke="${PALETTE[0]}"/>`;
  // regression of difference on mean (proportional bias) as a faint line
  const n = xs.length, mxm = xs.reduce((a, b) => a + b, 0) / n, mym = dy.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mxm) * (dy[i] - mym); sxx += (xs[i] - mxm) ** 2; }
  const b = sxy / sxx, a0 = mym - b * mxm;
  s += `<line x1="${F.X(xlo + px)}" x2="${F.X(xhi - px)}" y1="${F.Y(a0 + b * (xlo + px))}" y2="${F.Y(a0 + b * (xhi - px))}" stroke="${PALETTE[1]}" stroke-width="1.2" opacity=".8" stroke-dasharray="2 3"/>`;
  return wrap(W, H, s);
}

/** Scatter with optional fitted line. */
export function scatterSVG(x, y, opts = {}) {
  const W = 720, H = opts.H || 320;
  const ok = x.map((v, i) => fin(v) && fin(y[i]));
  const xs = x.filter((_, i) => ok[i]), ys = y.filter((_, i) => ok[i]);
  let xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
  if (opts.identity) { xlo = ylo = Math.min(xlo, ylo); xhi = yhi = Math.max(xhi, yhi); }
  const px = (xhi - xlo) * 0.06 || 1, py = (yhi - ylo) * 0.08 || 1;
  const m = { l: 58, r: 14, t: opts.title ? 28 : 12, b: 40 };
  const F = frame({ W, H, m, xr: [xlo - px, xhi + px], yr: [ylo - py, yhi + py], xlabel: opts.xlabel, ylabel: opts.ylabel, title: opts.title, xt: ticks(xlo - px, xhi + px), yt: ticks(ylo - py, yhi + py) });
  let s = F.s;
  if (opts.identity) s += `<line x1="${F.X(xlo)}" y1="${F.Y(xlo)}" x2="${F.X(xhi)}" y2="${F.Y(xhi)}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;
  const col = opts.colors || null;
  xs.forEach((v, i) => { s += `<circle cx="${F.X(v)}" cy="${F.Y(ys[i])}" r="4" fill="${col ? col[i] : PALETTE[0]}" fill-opacity=".6" stroke="${col ? col[i] : PALETTE[0]}"/>`; });
  if (opts.fit) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const b = sxy / sxx, a = my - b * mx;
    s += `<line x1="${F.X(xlo)}" x2="${F.X(xhi)}" y1="${F.Y(a + b * xlo)}" y2="${F.Y(a + b * xhi)}" stroke="${PALETTE[3]}" stroke-width="2"/>`;
  }
  return wrap(W, H, s);
}

/** Q-Q plot from [theoretical, standardised] pairs. */
export function qqSVG(pts, opts = {}) {
  const x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
  return scatterSVG(x, y, { ...opts, identity: true, xlabel: opts.xlabel || "Theoretical quantiles", ylabel: opts.ylabel || "Standardised residuals" });
}

/**
 * Groups as box plots with the individual points and the mean ± 95% CI.
 * groups: [{ label, values }]
 */
export function groupsSVG(groups, opts = {}) {
  const W = 720, H = opts.H || 320, k = groups.length;
  const all = groups.flatMap((g) => g.values.filter(fin));
  let lo = Math.min(...all), hi = Math.max(...all); const p = (hi - lo) * 0.1 || 1; lo -= p; hi += p;
  const m = { l: 58, r: 14, t: opts.title ? 28 : 12, b: 46 };
  const F = frame({ W, H, m, xr: [0, k], yr: [lo, hi], xlabel: opts.xlabel, ylabel: opts.ylabel, title: opts.title, xt: [], yt: ticks(lo, hi) });
  let s = F.s;
  const q = (v, pp) => { const a = [...v].sort((x, y) => x - y), h = (a.length - 1) * pp, i = Math.floor(h); return a[i] + (h - i) * ((a[Math.min(i + 1, a.length - 1)]) - a[i]); };
  groups.forEach((g, i) => {
    const v = g.values.filter(fin), c = PALETTE[i % PALETTE.length], cx = F.X(i + 0.5), bw = Math.min(70, (W - m.l - m.r) / k / 3);
    if (!v.length) return;
    const q1 = q(v, 0.25), q3 = q(v, 0.75), md = q(v, 0.5), iqr = q3 - q1;
    const wl = Math.min(...v.filter((x) => x >= q1 - 1.5 * iqr)), wh = Math.max(...v.filter((x) => x <= q3 + 1.5 * iqr));
    s += `<line x1="${cx}" x2="${cx}" y1="${F.Y(wl)}" y2="${F.Y(wh)}" stroke="${c}"/>`;
    s += `<rect x="${cx - bw / 2}" y="${F.Y(q3)}" width="${bw}" height="${Math.max(1, F.Y(q1) - F.Y(q3))}" fill="${c}" fill-opacity=".14" stroke="${c}"/>`;
    s += `<line x1="${cx - bw / 2}" x2="${cx + bw / 2}" y1="${F.Y(md)}" y2="${F.Y(md)}" stroke="${c}" stroke-width="2"/>`;
    v.forEach((x, j) => { const jit = ((j * 0.618) % 1 - 0.5) * bw * 0.6; s += `<circle cx="${cx + bw * 0.9 + jit / 2}" cy="${F.Y(x)}" r="3" fill="${c}" fill-opacity=".5"/>`; });
    const n = v.length, mu = v.reduce((a, b) => a + b, 0) / n, sdv = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, n - 1)), e = (1.96 * sdv) / Math.sqrt(n);
    s += `<line x1="${cx - bw * 0.9}" x2="${cx - bw * 0.9}" y1="${F.Y(mu - e)}" y2="${F.Y(mu + e)}" stroke="var(--ink)" stroke-width="1.5"/><circle cx="${cx - bw * 0.9}" cy="${F.Y(mu)}" r="4.5" fill="var(--ink)"/>`;
    s += `<text x="${cx}" y="${H - m.b + 17}" text-anchor="middle" font-size="12.5" fill="var(--ink)">${esc(g.label)}</text><text x="${cx}" y="${H - m.b + 31}" text-anchor="middle" font-size="11" fill="var(--muted)">n = ${n}</text>`;
  });
  return wrap(W, H, s);
}

/** Paired / repeated lines: one line per subject across levels, plus the mean. */
export function profileSVG(levels, rows, opts = {}) {
  const W = 720, H = opts.H || 320, k = levels.length;
  const all = rows.flat().filter(fin);
  let lo = Math.min(...all), hi = Math.max(...all); const p = (hi - lo) * 0.1 || 1; lo -= p; hi += p;
  const m = { l: 58, r: 14, t: opts.title ? 28 : 12, b: 40 };
  const F = frame({ W, H, m, xr: [0, k], yr: [lo, hi], xlabel: opts.xlabel, ylabel: opts.ylabel, title: opts.title, xt: [], yt: ticks(lo, hi) });
  let s = F.s;
  levels.forEach((L, j) => { s += `<text x="${F.X(j + 0.5)}" y="${H - m.b + 17}" text-anchor="middle" font-size="12.5" fill="var(--ink)">${esc(L)}</text>`; });
  const colOf = opts.colors || (() => PALETTE[0]);
  rows.forEach((r, i) => { const pts = r.map((v, j) => (fin(v) ? `${F.X(j + 0.5)},${F.Y(v)}` : null)).filter(Boolean); s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${colOf(i)}" stroke-opacity=".35"/>`; });
  const mean = levels.map((_, j) => { const v = rows.map((r) => r[j]).filter(fin); return v.reduce((a, b) => a + b, 0) / v.length; });
  s += `<polyline points="${mean.map((v, j) => `${F.X(j + 0.5)},${F.Y(v)}`).join(" ")}" fill="none" stroke="var(--ink)" stroke-width="3"/>`;
  mean.forEach((v, j) => { s += `<circle cx="${F.X(j + 0.5)}" cy="${F.Y(v)}" r="5" fill="var(--ink)"/>`; });
  return wrap(W, H, s);
}

/**
 * SPM figure: the statistic curve, the critical threshold and the
 * supra-threshold clusters (shaded, with p).
 */
export function spmSVG(spmi, opts = {}) {
  const z = Array.from(spmi.z), Q = z.length, tt = spmi.twoTailed;
  const hl = [{ y: spmi.zstar, label: `${spmi.STAT}* = ${f3(spmi.zstar)}`, color: PALETTE[3] }];
  if (tt) hl.push({ y: -spmi.zstar, color: PALETTE[3] });
  const shade = spmi.clusters.map((c) => ({ x0: (100 * c.x0) / (Q - 1), x1: (100 * c.x1) / (Q - 1), color: PALETTE[3], opacity: 0.14, label: `p ${c.p < 0.001 ? "< .001" : "= " + c.p.toFixed(3).replace(/^0/, "")}` }));
  const label = spmi.STAT === "T" ? "SPM{t}" : spmi.STAT === "F" ? "SPM{F}" : "SPM{χ²}";
  return curvesSVG([{ y: z, color: "var(--ink)", label, width: 2.2 }], { ...opts, hlines: hl, shade, ylabel: opts.ylabel || label, xlabel: opts.xlabel || "% of the cycle", yr: opts.yr });
}

/** Swap CSS variables for print colours: what is exported. */
export function lightSvg(svg) {
  let s = svg;
  for (const [k, v] of Object.entries(LIGHT)) s = s.split(`var(${k})`).join(v);
  s = s.replace(/width="100%"/, 'width="1440"');
  return s.replace(/<svg /, '<svg style="background:#fff" ');
}

/** Rasterise an exported SVG string to a PNG blob (2x). */
export function svgStringToPng(svg, width = 1440) {
  return new Promise((resolve) => {
    const vb = (svg.match(/viewBox="([^"]+)"/) || [, "0 0 720 300"])[1].split(/\s+/).map(Number);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = width; c.height = Math.round((width * vb[3]) / vb[2]);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => resolve(b), "image/png");
    };
    img.onerror = () => resolve(null);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
