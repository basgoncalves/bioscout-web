/**
 * usimage.js -- Process > Images: measure ultrasound (or any) images.
 *
 * Built for BD2II L06 (muscle architecture): students load the vastus
 * lateralis images from Stations A and B, set the scale from the depth marks,
 * and measure fascicle length and pennation angle -- the ImageJ steps of the
 * station sheet, in the app. Results export in the column order of
 * L06_Muscle_Architecture_template.xlsx (sheet Data), as CSV or as
 * tab-separated rows to paste straight into the yellow cells.
 *
 * Tools
 *   scale     two clicks on the depth marks + the distance in mm -> mm/px
 *   length    two clicks -> length (mm)
 *   angle     three clicks (arm, vertex, arm) -> angle (deg)
 *   fascicle  three lines: fascicle, deep aponeurosis, superficial aponeurosis
 *             -> pennation (fascicle vs deep aponeurosis) and fascicle length
 *             between the two aponeuroses, extrapolated as straight lines when
 *             the fascicle leaves the image (flagged, as the sheet asks).
 *
 * The geometry (lineIntersect, acuteAngle, fascicleFromLines, toTemplateRows)
 * is pure and exported for tests/test_usimage.mjs. Images are read on this
 * device and never uploaded.
 */

const fin = Number.isFinite;
const r1 = (v) => (fin(v) ? Math.round(v * 10) / 10 : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- pure geometry --------------------------------------------------------------
export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Intersection of the infinite lines a1-a2 and b1-b2 (null if parallel). */
export function lineIntersect(a1, a2, b1, b2) {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  return { x: a1.x + u * (a2.x - a1.x), y: a1.y + u * (a2.y - a1.y) };
}

/** Acute angle (0-90 deg) between two lines, each given by two points. */
export function acuteAngle(a1, a2, b1, b2) {
  const ta = Math.atan2(a2.y - a1.y, a2.x - a1.x), tb = Math.atan2(b2.y - b1.y, b2.x - b1.x);
  let d = Math.abs(ta - tb) * 180 / Math.PI % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/** Angle at vertex v between arms a and b (0-180 deg). */
export function vertexAngle(a, v, b) {
  const t1 = Math.atan2(a.y - v.y, a.x - v.x), t2 = Math.atan2(b.y - v.y, b.x - v.x);
  let d = Math.abs(t1 - t2) * 180 / Math.PI;
  return d > 180 ? 360 - d : d;
}

/**
 * Fascicle length and pennation from three drawn lines (pixel coordinates).
 * fas, deep, sup: [p1, p2]. mmPerPx: scale. box: {w, h} of the image, so an
 * intersection outside it is reported as extrapolated.
 */
export function fascicleFromLines(fas, deep, sup, mmPerPx, box) {
  const pen = acuteAngle(fas[0], fas[1], deep[0], deep[1]);
  const iD = lineIntersect(fas[0], fas[1], deep[0], deep[1]);
  const iS = lineIntersect(fas[0], fas[1], sup[0], sup[1]);
  if (!iD || !iS) return { pen, lenPx: NaN, lenMm: NaN, iD, iS, extrapolated: false };
  const lenPx = dist(iD, iS);
  const out = (p) => box && (p.x < 0 || p.y < 0 || p.x > box.w || p.y > box.h);
  // beyond the drawn fascicle segment also counts as extrapolated
  const along = (p) => { const L = dist(fas[0], fas[1]) || 1; return Math.min(dist(p, fas[0]), dist(p, fas[1])) > 0.02 * L &&
    Math.abs(dist(p, fas[0]) + dist(p, fas[1]) - L) > 0.02 * L; };
  return { pen, lenPx, lenMm: fin(mmPerPx) ? lenPx * mmPerPx : NaN, iD, iS,
    extrapolated: !!(out(iD) || out(iS)), beyondDrawn: along(iD) || along(iS) };
}

/** Mean colour of a size x size square centred on (x, y) in RGBA pixel data. */
export function sampleMean(data, w, h, x, y, size = 1) {
  const r = Math.floor(size / 2), cx = Math.round(x), cy = Math.round(y);
  let R = 0, G = 0, B = 0, n = 0;
  for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) {
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const k = 4 * (j * w + i); R += data[k]; G += data[k + 1]; B += data[k + 2]; n++;
  }
  return n ? [R / n, G / n, B / n] : null;
}
/**
 * Colour statistics in a rectangle (corners a, b, pixel coordinates; clipped
 * to the image). Per channel R, G, B and grey: mean, median, min, max, SD,
 * from 256-bin histograms so the median is exact for 8-bit images.
 */
export function roiStats(data, w, h, a, b, inside = null) {
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x))), x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x)) - 1);
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y))), y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y)) - 1);
  if (x1 < x0 || y1 < y0) return null;
  const H = [0, 1, 2, 3].map(() => new Float64Array(256)), S = [0, 0, 0, 0], Q = [0, 0, 0, 0];
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (inside && !inside(x + 0.5, y + 0.5)) continue;   // pixel centre in the polygon
    const k = 4 * (y * w + x), v = [data[k], data[k + 1], data[k + 2]];
    v.push(Math.round(0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]));
    for (let c = 0; c < 4; c++) { H[c][v[c]]++; S[c] += v[c]; Q[c] += v[c] * v[c]; }
    n++;
  }
  if (!n) return null;
  const median = (hist) => {          // mean of the two middle values when n is even
    const at = (r) => { let cum = 0; for (let i = 0; i < 256; i++) { cum += hist[i]; if (cum > r) return i; } return 255; };
    return n % 2 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
  };
  const ch = ["R", "G", "B", "grey"].map((name, c) => {
    let mn = 0, mx = 255; while (!H[c][mn]) mn++; while (!H[c][mx]) mx--;
    const mean = S[c] / n;
    return { name, mean, median: median(H[c]), min: mn, max: mx, sd: n > 1 ? Math.sqrt(Math.max(0, (Q[c] - n * mean * mean) / (n - 1))) : 0 };
  });
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n, ch, hex: rgbToHex(ch.slice(0, 3).map((q) => q.mean)) };
}
/** Even-odd rule: is (x, y) inside the polygon? */
export function pointInPoly(x, y, poly) {
  let inn = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inn = !inn;
  }
  return inn;
}
/** Colour statistics inside a polygon (>= 3 points): the pixels whose centre lies inside. */
export function polyStats(data, w, h, poly) {
  if (!poly || poly.length < 3) return null;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const st = roiStats(data, w, h, { x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) }, (x, y) => pointInPoly(x, y, poly));
  return st && Object.assign(st, { shape: "polygon" });
}
export const rgbToHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Grey level (0-255), ITU-R BT.601 luma -- what ImageJ's 8-bit conversion gives. */
export const greyOf = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
/** Hue (deg), saturation and value (%) of an RGB colour. */
export function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? (100 * d) / mx : 0, 100 * mx];
}

/** mm per pixel from two points and the real distance between them. */
export const scaleFrom = (p1, p2, mm) => (dist(p1, p2) > 0 && mm > 0 ? mm / dist(p1, p2) : NaN);

/**
 * Template rows (sheet Data, columns A-E): knee angle, relaxed L_f, relaxed
 * pennation, contracted L_f, contracted pennation. Several measurements of
 * the same angle and condition are averaged.
 */
export function toTemplateRows(results, angles = [30, 45, 60, 75, 90]) {
  const pick = (ang, cond, key) => {
    const v = results.filter((r) => +r.angle === ang && r.cond === cond && fin(r[key])).map((r) => r[key]);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
  };
  return angles.map((a) => [a, pick(a, "relaxed", "lf"), pick(a, "relaxed", "pen"), pick(a, "contracted", "lf"), pick(a, "contracted", "pen")]);
}

/** Guess condition and knee angle from a file name (e.g. "VL_relaxed_60.png"). */
export function guessMeta(name) {
  const n = String(name).toLowerCase();
  const cond = /contr|mvc|activ|max|kontra/.test(n) ? "contracted" : /relax|rest|entsp|passiv/.test(n) ? "relaxed" : "";
  const m = n.match(/(?:^|[^0-9])(30|45|60|75|90)(?:[^0-9]|$)/);
  return { cond, angle: m ? +m[1] : "" };
}

// ---- page ---------------------------------------------------------------------------
const TOOLS = ["scale", "length", "angle", "colour", "pan"];   // "fascicle" (three-line tool) kept in code, not offered
const NEED = { scale: 2, length: 2, angle: 3, colour: 2, fascicle: 6 };
const LINE_COL = ["#ffd400", "#2fd3ff", "#ff5fa2"];   // fascicle, deep, superficial

export function mountImages(root, { t, download }) {
  const imgs = [];            // {name, url, el, w, h, cond, angle, mmPerPx, items: [], scalePts}
  let cur = -1, tool = "length", pts = [], view = { k: 1, x: 0, y: 0 }, adj = { b: 100, c: 100 };
  let drag = null, hover = null, msg = "", sampleSize = 1, roiShape = "rect";

  root.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <b>${t("us_title")}</b>
      <span style="display:flex;gap:6px">
        <button type="button" class="ghost labBackBtn" style="margin:0;width:auto;padding:6px 12px">${t("labBack")}</button>
        <button type="button" class="ghost labHomeBtn" style="margin:0;width:auto;padding:6px 12px">${t("labHome")}</button>
      </span>
    </div>
    <p class="note">${t("us_intro")}</p>
    <label class="ghost usDrop" style="display:inline-block;cursor:pointer;padding:8px 14px;border:1px dashed currentColor;border-radius:10px">
      ${t("us_open")}<input type="file" id="usFile" accept="image/*" multiple style="display:none"></label>
    <div id="usThumbs" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"></div>
  </div>
  <div class="card" id="usWork" style="display:none">
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center" id="usTools"></div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0">
      <label>${t("us_bright")} <input type="range" id="usB" min="40" max="250" value="100" style="width:110px"></label>
      <label>${t("us_contrast")} <input type="range" id="usC" min="40" max="300" value="100" style="width:110px"></label>
      <button type="button" class="ghost" id="usFit" style="width:auto">${t("us_fit")}</button>
      <label id="usShapeL" style="display:none">${t("us_shape")} <select id="usShape"><option value="rect">${t("us_rect")}</option><option value="poly">${t("us_poly")}</option></select></label>
      <button type="button" id="usClosePoly" style="width:auto;display:none">${t("us_closePoly")}</button>
    </div>
    <p class="sub" id="usHint" style="min-height:1.3em;margin:4px 0"></p>
    <div style="position:relative;width:100%;height:min(70vh,620px);background:#000;border-radius:10px;overflow:hidden;touch-action:none">
      <canvas id="usCv" style="width:100%;height:100%;display:block;cursor:crosshair;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none"></canvas>
    </div>
    <div id="usItems" style="margin-top:8px"></div>
  </div>
  <div class="card" id="usRes" style="display:none"></div>`;

  const $ = (id) => root.querySelector("#" + id);
  const cv = $("usCv"), ctx = cv.getContext("2d");
  const I = () => imgs[cur];

  // ---- loading ----
  $("usFile").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  root.addEventListener("dragover", (e) => e.preventDefault());
  root.addEventListener("drop", (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files].filter((f) => /^image\//.test(f.type))); });
  function addFiles(files) {
    files.forEach((f) => {
      const url = URL.createObjectURL(f), el = new Image();
      const g = guessMeta(f.name);
      const rec = { name: f.name, url, el, w: 0, h: 0, cond: g.cond, angle: g.angle, mmPerPx: NaN, scaleMm: NaN, scalePts: null, items: [] };
      el.onload = () => { rec.w = el.naturalWidth; rec.h = el.naturalHeight; if (cur < 0 || imgs[cur] === rec) select(imgs.indexOf(rec)); renderThumbs(); };
      el.src = url; imgs.push(rec);
    });
    renderThumbs();
  }
  function renderThumbs() {
    $("usThumbs").innerHTML = imgs.map((m, i) => `<div style="position:relative">
      <button type="button" data-i="${i}" class="ghost" style="width:auto;padding:4px;border:2px solid ${i === cur ? "#2f6fe4" : "transparent"};border-radius:8px;text-align:left">
      <img src="${m.url}" style="height:64px;display:block;border-radius:4px"><small>${esc(m.name.slice(0, 22))}<br>${m.items.length} ✓</small></button>
      <button type="button" data-rm="${i}" title="${esc(t("us_remove"))}" aria-label="${esc(t("us_remove"))}"
        style="position:absolute;top:-6px;right:-6px;width:24px;height:24px;min-height:0;padding:0;margin:0;border-radius:50%;background:#c0392b;color:#fff;border:2px solid #fff;font-size:13px;line-height:1;cursor:pointer">✕</button></div>`).join("");
    $("usThumbs").querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => select(+b.dataset.i)));
    $("usThumbs").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); removeImage(+b.dataset.rm); }));
  }
  /* The X on a thumbnail: drop the image and its measurements (asks first
   * when there are measurements to lose). */
  function removeImage(i) {
    const m = imgs[i]; if (!m) return;
    if (m.items.length && !confirm(t("us_removeAsk", { name: m.name, n: m.items.length }))) return;
    imgs.splice(i, 1); try { URL.revokeObjectURL(m.url); } catch { /* */ }
    pts = [];
    if (!imgs.length) { cur = -1; $("usWork").style.display = "none"; renderThumbs(); renderResults(); return; }
    select(i < cur || cur >= imgs.length ? Math.max(0, Math.min(cur - (i < cur ? 1 : 0), imgs.length - 1)) : Math.min(cur, imgs.length - 1));
  }
  function select(i) {
    cur = i; pts = []; $("usWork").style.display = "";
    fit(); renderThumbs(); renderTools(); renderItems(); renderResults(); draw();
  }
  $("usB").oninput = (e) => { adj.b = +e.target.value; drawSoon(); };
  $("usC").oninput = (e) => { adj.c = +e.target.value; drawSoon(); };
  $("usFit").onclick = () => { fit(); draw(); };
  $("usShape").onchange = (e) => { roiShape = e.target.value; pts = []; hint(); draw(); };
  $("usClosePoly").onclick = () => finishPoly();
  /* Polygon ROI: click the corners; close it by clicking the first point
   * again, double-clicking, or the Close button. */
  function finishPoly() {
    const P = pts.filter((p, i) => !i || dist(p, pts[i - 1]) * view.k > 3);   // drop double-click duplicates
    if (P.length < 3) { msg = t("us_polyNeed3"); hint(); return; }
    pts = [];
    const it = { type: "colour", shape: "poly", pts: P }; recompute(I(), it); I().items.push(it);
    renderItems(); renderResults(); renderThumbs(); hint(); draw();
  }
  cv.addEventListener("dblclick", (e) => { if (tool === "colour" && roiShape === "poly") { e.preventDefault(); finishPoly(); } });

  /* The ORIGINAL pixels (not the brightness/contrast view) -- colour readings
   * must not change when a student moves the sliders. */
  function pixels(m) {
    if (m.px) return m.px;
    try { const c = document.createElement("canvas"); c.width = m.w; c.height = m.h; const g = c.getContext("2d"); g.drawImage(m.el, 0, 0); m.px = g.getImageData(0, 0, m.w, m.h).data; }
    catch { m.px = null; }
    return m.px;
  }
  function colourAt(m, p) {
    const d = pixels(m); if (!d || !p) return null;
    const c = sampleMean(d, m.w, m.h, p.x, p.y, sampleSize); if (!c) return null;
    return { rgb: c, hex: rgbToHex(c), grey: greyOf(c), hsv: rgbToHsv(c), size: sampleSize, x: Math.round(p.x), y: Math.round(p.y) };
  }
  const colourText = (c) => `RGB ${c.rgb.map((v) => Math.round(v)).join(", ")} · ${c.hex} · ${t("us_grey")} ${r1(c.grey)} · HSV ${Math.round(c.hsv[0])}°, ${Math.round(c.hsv[1])} %, ${Math.round(c.hsv[2])} %`;
  const swatch = (hex) => `<i style="display:inline-block;width:1.1em;height:1.1em;vertical-align:-0.2em;border:1px solid #888;border-radius:3px;background:${hex}"></i>`;

  // ---- tools ----
  function renderTools() {
    $("usTools").innerHTML = TOOLS.map((k) => `<button type="button" data-k="${k}" class="${k === tool ? "" : "ghost"}" style="width:auto">${t("us_t_" + k)}</button>`).join("")
      + `<button type="button" class="ghost" id="usUndo" style="width:auto">${t("us_undo")}</button>`;
    $("usTools").querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { tool = b.dataset.k; pts = []; renderTools(); draw(); }));
    $("usUndo").onclick = () => { if (pts.length) pts.pop(); else if (I().items.length) I().items.pop(); renderItems(); renderResults(); renderThumbs(); draw(); };
    hint();
  }
  function hint() {
    const m = I();
    let h = tool === "pan" ? t("us_h_pan") : t("us_h_" + tool + (tool === "fascicle" ? Math.floor(pts.length / 2) : ""));
    if (tool !== "scale" && tool !== "pan" && tool !== "colour" && m && !fin(m.mmPerPx)) h = t("us_h_noscale") + " " + h;
    $("usShapeL").style.display = tool === "colour" ? "" : "none";
    $("usClosePoly").style.display = tool === "colour" && roiShape === "poly" && pts.length >= 3 ? "" : "none";
    if (tool === "colour" && roiShape === "poly") h = t("us_h_poly");
    if (tool === "colour" && !msg && m) {
      const live = pending || hover;
      if (roiShape === "poly" && pts.length >= 2 && live) {
        const st = polyStats(pixels(m) || [], m.w, m.h, [...pts, live]);
        if (st) { $("usHint").innerHTML = `${swatch(st.hex)} ${t("us_poly")} ${pts.length + 1} ${t("us_points")}, n = ${st.n} px · ${t("us_mean")} RGB ${st.ch.slice(0, 3).map((q) => Math.round(q.mean)).join(", ")} · ${t("us_grey")} ${r1(st.ch[3].mean)}`; return; }
      }
      if (roiShape === "rect" && pts.length === 1 && live) {
        const st = roiStats(pixels(m) || [], m.w, m.h, pts[0], live);
        if (st) { $("usHint").innerHTML = `${swatch(st.hex)} ROI ${st.w} × ${st.h} px · ${t("us_mean")} RGB ${st.ch.slice(0, 3).map((q) => Math.round(q.mean)).join(", ")} · ${t("us_grey")} ${r1(st.ch[3].mean)}`; return; }
      }
      const c = colourAt(m, live);
      $("usHint").innerHTML = (c ? `${swatch(c.hex)} ${esc(colourText(c))} <span class="sub">(x ${c.x}, y ${c.y})</span><br>` : "") + `<span class="sub">${esc(h)}</span>`;
      return;
    }
    if (!msg && m && m.items.length && !pts.length) h += " " + t("us_h_edit");
    $("usHint").textContent = msg || h; msg = "";
  }

  // ---- view ----
  function size() { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d; return d; }
  function fit() { const m = I(); if (!m || !m.w) return; const d = size(); const k = Math.min(cv.width / m.w, cv.height / m.h); view = { k, x: (cv.width - m.w * k) / 2, y: (cv.height - m.h * k) / 2, d }; }
  const toImg = (e) => { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; return { x: ((e.clientX - r.left) * d - view.x) / view.k, y: ((e.clientY - r.top) * d - view.y) / view.k }; };
  cv.addEventListener("wheel", (e) => {
    e.preventDefault(); const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
    const sx = (e.clientX - r.left) * d, sy = (e.clientY - r.top) * d, f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.x = sx - (sx - view.x) * f; view.y = sy - (sy - view.y) * f; view.k *= f; draw();
  }, { passive: false });
  /* Pointers. A point is placed where the finger (or mouse button) is LIFTED,
   * and follows it while pressed -- on a phone there is no hover, and the
   * finger covers the spot, so press, slide to the exact place, release.
   * Two fingers pinch-zoom and pan; Shift/right/middle mouse or Move pans. */
  const touches = new Map();
  let pending = null, pinch = null;
  const screenPt = (e) => { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; return { x: (e.clientX - r.left) * d, y: (e.clientY - r.top) * d }; };
  function startPinch() {
    const [a, b] = [...touches.values()];
    pinch = { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k: view.k, vx: view.x, vy: view.y };
  }
  cv.addEventListener("pointerdown", (e) => {
    if (!I()) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch { /* old Safari */ }
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, screenPt(e));
      if (touches.size === 2) { pending = null; drag = null; startPinch(); draw(); return; }
      if (touches.size > 2) return;
    }
    if (tool === "pan" || e.button === 1 || e.button === 2 || e.shiftKey) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; return; }
    if (!pts.length) { const h = handleAt(toImg(e)); if (h) { edit = h; draw(); return; } }   // grab a set point to move it
    pending = toImg(e); hover = pending;
    if (tool === "colour" && roiShape === "rect" && !pts.length) pts = [pending];   // ROI: first corner where the press starts
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && touches.has(e.pointerId)) touches.set(e.pointerId, screenPt(e));
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()], d = Math.hypot(b.x - a.x, b.y - a.y) || 1, f = d / pinch.d;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      view.k = pinch.k * f; view.x = cx - (pinch.cx - pinch.vx) * f; view.y = cy - (pinch.cy - pinch.vy) * f; draw(); return;
    }
    if (edit) { const q = toImg(e); edit.pt.x = q.x; edit.pt.y = q.y; refresh(edit, false); draw(); return; }
    if (!pts.length && !pending && e.pointerType === "mouse") cv.style.cursor = handleAt(toImg(e)) ? "move" : "crosshair";
    if (drag) { const d = devicePixelRatio || 1; view.x = drag.vx + (e.clientX - drag.x) * d; view.y = drag.vy + (e.clientY - drag.y) * d; draw(); return; }
    hover = toImg(e);
    if (pending) pending = hover;
    if (tool === "colour") hint();
    if (pending || pts.length) draw();
  });
  const up = (e) => {
    if (edit) { refresh(edit, true); edit = null; if (e.pointerType === "touch") touches.delete(e.pointerId); return; }
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (pinch) { if (!touches.size) pinch = null; return; }   // no point after a pinch
    }
    drag = null;
    if (pending && e.type === "pointerup") {
      const p = pending; pending = null;
      // a press without a drag on the first ROI corner: wait for a second click
      if (tool === "colour" && roiShape === "rect" && pts.length === 1 && dist(pts[0], p) * view.k < 8) { hint(); draw(); return; }
      click(p);
    }
    pending = null;
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("resize", () => { if (I() && root.offsetParent) { fit(); draw(); } });
  window.addEventListener("keydown", (e) => {
    if (!root.offsetParent || !I() || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if (e.key === "Escape") { pts = []; draw(); hint(); }
    if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); $("usUndo").click(); }
  });

  // ---- editing set points ----
  /* Every point already set (scale, length, angle, ROI corners) can be
   * dragged to a new place; the measurement updates as it moves. */
  let edit = null;
  function handleAt(p) {
    const m = I(); if (!m) return null;
    const R = 14 * (devicePixelRatio || 1) / view.k;   // ~14 screen px
    let best = null, bd = R;
    const test = (pt, it) => { const d = dist(pt, p); if (d < bd) { bd = d; best = { pt, it }; } };
    m.items.forEach((it) => it.pts.forEach((pt) => test(pt, it)));
    if (m.scalePts) m.scalePts.forEach((pt) => test(pt, "scale"));
    return best;
  }
  function refresh(h, final) {
    const m = I();
    if (h.it === "scale") {
      imgs.filter((o) => o.scalePts === m.scalePts).forEach((o) => { o.mmPerPx = scaleFrom(o.scalePts[0], o.scalePts[1], o.scaleMm); o.items.forEach((it) => recompute(o, it)); });
    } else {
      if (h.it.type === "colour") { if (!final) return; h.it.st = null; }   // colour stats once, on release
      recompute(m, h.it);
    }
    if (final) { renderItems(); renderResults(); renderThumbs(); hint(); }
    draw();
  }

  // ---- measuring ----
  function click(p) {
    if (tool === "pan") return;
    if (tool === "colour" && roiShape === "poly") {
      if (pts.length >= 3 && dist(p, pts[0]) * view.k < 14) { finishPoly(); return; }
      pts.push(p); hint(); draw(); return;
    }
    pts.push(p);
    if (pts.length < NEED[tool]) { hint(); draw(); return; }
    const m = I(), P = pts; pts = [];
    if (tool === "scale") {
      const prev = fin(m.scaleMm) ? m.scaleMm : 10;
      const mm = parseFloat(String(prompt(t("us_askMm"), prev)).replace(",", "."));
      if (!(mm > 0)) { msg = t("us_scaleCancel"); hint(); draw(); return; }
      m.scaleMm = mm; m.scalePts = P; m.mmPerPx = scaleFrom(P[0], P[1], mm);
      const others = imgs.filter((o) => o !== m && !fin(o.mmPerPx) && o.w === m.w && o.h === m.h);
      if (others.length && confirm(t("us_scaleAll", { n: others.length }))) others.forEach((o) => { o.mmPerPx = m.mmPerPx; o.scaleMm = mm; o.scalePts = P; });
      imgs.forEach((o) => o.items.forEach((it) => recompute(o, it)));
    } else {
      const it = { type: tool, pts: P }; recompute(m, it); m.items.push(it);
    }
    renderItems(); renderResults(); renderThumbs(); hint(); draw();
  }
  function recompute(m, it) {
    const k = m.mmPerPx;
    if (it.type === "length") { it.px = dist(it.pts[0], it.pts[1]); it.mm = it.px * k; }
    if (it.type === "angle") it.deg = vertexAngle(it.pts[0], it.pts[1], it.pts[2]);
    if (it.type === "colour" && !it.st) { const d = pixels(m); it.st = !d ? null : it.shape === "poly" ? polyStats(d, m.w, m.h, it.pts) : roiStats(d, m.w, m.h, it.pts[0], it.pts[1]); }
    if (it.type === "fascicle") Object.assign(it, fascicleFromLines([it.pts[0], it.pts[1]], [it.pts[2], it.pts[3]], [it.pts[4], it.pts[5]], k, { w: m.w, h: m.h }));
  }

  function renderItems() {
    const m = I(); if (!m) return;
    const sc = fin(m.mmPerPx) ? `${t("us_scale")}: ${m.scaleMm} mm = ${r1(m.scaleMm / m.mmPerPx)} px (${(m.mmPerPx * 1000).toFixed(1)} µm/px)` : t("us_noScale");
    const rows = m.items.map((it, i) => {
      const v = it.type === "colour" ? (it.st ? `${swatch(it.st.hex)} ${it.shape === "poly" ? `${t("us_poly")}, ${it.pts.length} ${t("us_points")}` : `${it.st.w} × ${it.st.h} px`} (n = ${it.st.n}) · <b>${it.st.hex}</b> · ${t("us_rgbSum")} <b>${r1(it.st.ch[0].mean + it.st.ch[1].mean + it.st.ch[2].mean)}</b>
          <table style="margin-top:4px"><thead><tr><th></th><th>${t("us_mean")}</th><th>${t("us_median")}</th><th>min</th><th>max</th><th>SD</th></tr></thead><tbody>
          ${it.st.ch.map((q) => `<tr><td>${q.name === "grey" ? t("us_grey") : q.name}</td><td>${r1(q.mean)}</td><td>${r1(q.median)}</td><td>${q.min}</td><td>${q.max}</td><td>${r1(q.sd)}</td></tr>`).join("")}</tbody></table>` : "–")
        : it.type === "length" ? (fin(it.mm) ? `${r1(it.mm)} mm` : `${r1(it.px)} px`) : it.type === "angle" ? `${r1(it.deg)}°`
        : `L<sub>f</sub> ${r1(it.lenMm)} mm · ${t("us_pen")} ${r1(it.pen)}°${it.extrapolated || it.beyondDrawn ? ` <i>(${t("us_extrap")})</i>` : ""}`;
      return `<tr><td>${i + 1}</td><td>${t("us_t_" + it.type)}</td><td>${v}</td><td><button type="button" class="ghost" data-del="${i}" style="width:auto;padding:0 8px">✕</button></td></tr>`;
    }).join("");
    const anyCol = imgs.some((o) => o.items.some((x) => x.type === "colour" && x.st));
    $("usItems").innerHTML = `<p class="sub">${sc}</p>${rows ? `<table><tbody>${rows}</tbody></table>` : ""}`
      + (anyCol ? `<button type="button" class="ghost" id="usColCsv" style="width:auto;margin-top:6px">${t("us_colCsv")}</button>` : "");
    if (anyCol) $("usColCsv").onclick = () => {
      const head = ["file", "roi", "shape", "x_px", "y_px", "width_px", "height_px", "n_pixels", "mean_hex", "RGB_mean_sum"];
      // grouped by statistic: R_mean, G_mean, B_mean, grey_mean, R_median, ...
      const STATS = ["mean", "median", "min", "max", "sd"];
      STATS.forEach((k) => ["R", "G", "B", "grey"].forEach((c) => head.push(`${c}_${k}`)));
      const L = [head.join(",")];
      imgs.forEach((o) => o.items.filter((x) => x.type === "colour" && x.st).forEach((x, i) => {
        const q = x.st;
        L.push([JSON.stringify(o.name), i + 1, x.shape === "poly" ? "polygon" : "rectangle", q.x, q.y, q.w, q.h, q.n, q.hex, r1(q.ch[0].mean + q.ch[1].mean + q.ch[2].mean), ...STATS.flatMap((k) => q.ch.map((c) => (k === "min" || k === "max" ? c[k] : r1(c[k]))))].join(","));
      }));
      download("image_colour_roi.csv", L.join("\n"));
    };
    $("usItems").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { m.items.splice(+b.dataset.del, 1); renderItems(); renderResults(); renderThumbs(); draw(); }));
  }

  /* Per image: fascicle length = mean of its Length measurements, pennation
   * = mean of its Angle measurements (students often measure two or three). */
  function results() {
    return imgs.map((m) => {
      const mean = (type, k) => { const v = m.items.filter((x) => x.type === type).map((x) => x[k]).filter(fin); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
      const nL = m.items.filter((x) => x.type === "length").length, nA = m.items.filter((x) => x.type === "angle").length;
      return { name: m.name, cond: m.cond, angle: m.angle, n: nL + nA, nL, nA, lf: mean("length", "mm"), pen: mean("angle", "deg"), extrap: false };
    });
  }
  function renderResults() {
    const R = results(), box = $("usRes");
    if (!R.some((r) => r.n)) { box.style.display = "none"; return; }
    box.style.display = "";
    const T = toTemplateRows(R);
    box.innerHTML = `<b>${t("us_resTitle")}</b>
      <table><thead><tr><th>${t("us_file")}</th><th>${t("us_cond")}</th><th>${t("us_angle")}</th><th>n (L/∠)</th><th>L<sub>f</sub> (mm)</th><th>${t("us_pen")} (°)</th></tr></thead><tbody>
      ${R.filter((r) => r.n).map((r) => `<tr><td>${esc(r.name)}</td><td>${r.cond ? t("us_" + r.cond) : "<b style='color:#c0392b'>?</b>"}</td><td>${r.angle || "<b style='color:#c0392b'>?</b>"}</td><td>${r.nL}/${r.nA}</td><td>${r1(r.lf)}${r.extrap ? "*" : ""}</td><td>${r1(r.pen)}</td></tr>`).join("")}
      </tbody></table>
      <p class="sub" style="margin-top:10px">${t("us_tplTitle")}</p>
      <table><thead><tr><th>${t("us_angle")}</th><th>${t("us_relaxed")} L<sub>f</sub></th><th>${t("us_relaxed")} ${t("us_pen")}</th><th>${t("us_contracted")} L<sub>f</sub></th><th>${t("us_contracted")} ${t("us_pen")}</th></tr></thead>
      <tbody>${T.map((row) => `<tr>${row.map((v) => `<td>${r1(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button type="button" id="usCopy" style="width:auto">${t("us_copy")}</button>
        <button type="button" class="ghost" id="usCsv" style="width:auto">${t("us_csv")}</button>
        <button type="button" class="ghost" id="usPng" style="width:auto">${t("us_png")}</button>
      </div>
      <p class="note">${t("us_resNote")}</p>`;
    $("usCopy").onclick = async () => {
      const txt = T.map((row) => row.slice(1).map((v) => (fin(v) ? r1(v) : "")).join("\t")).join("\n");
      try { await navigator.clipboard.writeText(txt); msg = t("us_copied"); } catch { msg = t("us_copyFail"); }
      hint();
    };
    $("usCsv").onclick = () => {
      const lines = ["file,condition,knee_angle_deg,n_lengths,n_angles,fascicle_length_mm,pennation_deg,mm_per_px"];
      R.filter((r) => r.n).forEach((r, i) => lines.push([JSON.stringify(r.name), r.cond, r.angle, r.nL, r.nA, r1(r.lf), r1(r.pen), imgs.find((m) => m.name === r.name)?.mmPerPx?.toFixed(5) ?? ""].join(",")));
      lines.push("", "knee_angle_deg,relaxed_Lf_mm,relaxed_pennation_deg,contracted_Lf_mm,contracted_pennation_deg");
      T.forEach((row) => lines.push(row.map((v) => (fin(v) ? r1(v) : "")).join(",")));
      download("L06_ultrasound_measurements.csv", lines.join("\n"));
    };
    $("usPng").onclick = () => {
      const m = I(); if (!m) return;
      const c = document.createElement("canvas"); c.width = m.w; c.height = m.h;
      paint(c.getContext("2d"), { k: 1, x: 0, y: 0 }, m, true);
      c.toBlob((b) => download(m.name.replace(/\.[^.]+$/, "") + "_measured.png", b), "image/png");
    };
  }

  // ---- drawing ----
  /* Brightness/contrast baked into a cached copy of the pixels, so it looks
   * the same everywhere (ctx.filter is missing in Safari before 18). */
  function adjusted(m) {
    if (adj.b === 100 && adj.c === 100) return m.el;
    const key = adj.b + "/" + adj.c;
    if (m.adjKey === key) return m.adjCv;
    const c = m.adjCv || document.createElement("canvas"); c.width = m.w; c.height = m.h;
    const g = c.getContext("2d"); g.drawImage(m.el, 0, 0);
    try {
      const im = g.getImageData(0, 0, m.w, m.h), a = im.data, B = adj.b / 100, C = adj.c / 100;
      const lut = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) lut[i] = (i * B - 128) * C + 128;
      for (let i = 0; i < a.length; i += 4) { a[i] = lut[a[i]]; a[i + 1] = lut[a[i + 1]]; a[i + 2] = lut[a[i + 2]]; }
      g.putImageData(im, 0, 0);
    } catch { return m.el; }
    m.adjCv = c; m.adjKey = key; return c;
  }
  let raf = 0;
  const drawSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  function draw() { const m = I(); if (!m || !m.w) return; size(); paint(ctx, view, m, false); }
  function paint(g, v, m, still) {
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#000"; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    g.setTransform(v.k, 0, 0, v.k, v.x, v.y);
    g.drawImage(adjusted(m), 0, 0);
    const lw = Math.max(1.5, 2 / v.k) * (still ? 1.5 : (devicePixelRatio || 1)), fs = 14 * (still ? 1.6 : (devicePixelRatio || 1)) / v.k;
    const line = (a, b, col, dash) => { if (!a || !b) return; g.strokeStyle = col; g.lineWidth = lw; g.setLineDash(dash ? [6 / v.k, 5 / v.k] : []); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.setLineDash([]); };
    const dot = (p, col) => { if (!p) return; g.fillStyle = col; g.beginPath(); g.arc(p.x, p.y, 3.5 * lw, 0, 7); g.fill(); };
    const label = (p, s, col) => { if (!p) return; g.font = `bold ${fs}px system-ui,sans-serif`; g.lineWidth = fs / 4; g.strokeStyle = "#000"; g.strokeText(s, p.x + fs / 2, p.y - fs / 2); g.fillStyle = col; g.fillText(s, p.x + fs / 2, p.y - fs / 2); };
    const ext = (a, b, len) => { const L = dist(a, b) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L; return [{ x: a.x - ux * len, y: a.y - uy * len }, { x: b.x + ux * len, y: b.y + uy * len }]; };
    if (m.scalePts) { line(m.scalePts[0], m.scalePts[1], "#7CFC00"); m.scalePts.forEach((p) => dot(p, "#7CFC00")); label(m.scalePts[1], `${m.scaleMm} mm`, "#7CFC00"); }
    const drawItem = (it, live) => {
      const P = it.pts;
      if (it.type === "colour" && (it.shape === "poly" || (live && roiShape === "poly"))) {
        const Q = live ? [...P, pending || hover].filter(Boolean) : P;
        if (Q.length < 2) { dot(Q[0], "#fff"); return; }
        const path = () => { g.beginPath(); g.moveTo(Q[0].x, Q[0].y); Q.slice(1).forEach((q) => g.lineTo(q.x, q.y)); if (!live) g.closePath(); };
        g.setLineDash([]); g.strokeStyle = "#000"; g.lineWidth = lw * 2.2; path(); g.stroke();
        g.strokeStyle = "#fff"; g.lineWidth = lw; path(); g.stroke();
        if (live && Q.length >= 3) line(Q[Q.length - 1], Q[0], "#fff", true);   // where it will close
        P.forEach((q) => dot(q, "#fff"));
        if (live) { if (P[0]) { g.strokeStyle = "#ff3b30"; g.lineWidth = lw; g.beginPath(); g.arc(P[0].x, P[0].y, 14 / v.k, 0, 7); g.stroke(); } }
        if (!live && it.st) label(P.reduce((a, q) => (q.y < a.y ? q : a), P[0]), it.st.hex, it.st.hex);
        return;
      }
      if (it.type === "colour") {
        const a = P[0], b = P[1] || (live ? pending || hover : null);
        if (!a || !b) { dot(a, "#fff"); return; }
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        g.setLineDash(live ? [6 / v.k, 4 / v.k] : []);
        g.strokeStyle = "#000"; g.lineWidth = lw * 2.2; g.strokeRect(x, y, w, h);
        g.strokeStyle = "#fff"; g.lineWidth = lw; g.strokeRect(x, y, w, h); g.setLineDash([]);
        if (!live) P.forEach((q) => dot(q, "#fff"));
        if (!live && it.st) label({ x, y: y + 4 * lw }, `${it.st.hex}`, it.st.hex);
        return;
      }
      if (it.type === "length") { line(P[0], P[1] || hover, "#2fd3ff"); if (!live) label(P[1], fin(it.mm) ? `${r1(it.mm)} mm` : `${r1(it.px)} px`, "#2fd3ff"); }
      if (it.type === "angle") { line(P[1] ?? hover, P[0], "#ffd400"); if (P[1]) line(P[1], P[2] ?? hover, "#ffd400"); if (!live) label(P[1], `${r1(it.deg)}°`, "#ffd400"); }
      if (it.type === "fascicle") {
        for (let j = 0; j < 3; j++) {
          const a = P[2 * j], b = P[2 * j + 1] ?? (live && P.length === 2 * j + 1 ? hover : null);
          if (!a || !b) continue;
          if (j > 0 && !live) { const [e1, e2] = ext(a, b, Math.max(m.w, m.h)); line(e1, e2, LINE_COL[j], true); }
          line(a, b, LINE_COL[j]);
        }
        if (!live && it.iD && it.iS) {
          line(it.iD, it.iS, LINE_COL[0], true); dot(it.iD, LINE_COL[1]); dot(it.iS, LINE_COL[2]);
          label({ x: (it.iD.x + it.iS.x) / 2, y: (it.iD.y + it.iS.y) / 2 }, `${fin(it.lenMm) ? r1(it.lenMm) + " mm" : r1(it.lenPx) + " px"} · ${r1(it.pen)}°`, LINE_COL[0]);
        }
      }
      P.forEach((p) => dot(p, "#fff"));
    };
    m.items.forEach((it) => drawItem(it, false));
    if (!still && pending && I() === m) dot(pending, "#ff3b30");
    if (!still && pts.length && I() === m) {
      if (tool === "scale") { line(pts[0], hover || pts[0], "#7CFC00"); dot(pts[0], "#7CFC00"); }
      else drawItem({ type: tool, pts }, true);
    }
  }

  return { load: (files) => addFiles(files), images: imgs };
}
