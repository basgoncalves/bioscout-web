/**
 * neckload.js -- the 1-6 g neck-loading reference panel shown with any neck
 * session. The neck test measures range of motion only; this panel puts
 * beside it what the neck is up against in a car: the roll moment and the
 * top muscle forces a cervical-spine model needs to hold the head at each
 * g-level (data and provenance in neck_gload.js).
 *
 * Pure: takes the reference table and returns HTML with an inline SVG, so
 * it renders the same in the live summary and in an archived session, and
 * can be tested without a DOM.
 */
import { t as tr } from "./i18n.js";
import { NECK_GLOAD, NECK_MUSCLE_LABEL, NECK_MUSCLE_FMAX, NECK_GLOAD_SOURCE } from "./neck_gload.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Roll moment vs g as bars, muscle-saturated levels hatched in the warn
 *  colour: from 4 g the model has run out of muscle and the numbers stop
 *  meaning "what the neck does" and start meaning "what it can't". */
export function neckLoadSVG(rows, { width = 420, height = 170 } = {}) {
  const padL = 44, padR = 10, padT = 16, padB = 26;
  const w = width - padL - padR, h = height - padT - padB;
  const max = Math.max(...rows.map((r) => r.rollNm)) * 1.12;
  const bw = w / rows.length;
  const y = (v) => padT + h - (v / max) * h;
  const ticks = [0, 50, 100, 150, 200].filter((v) => v <= max);
  const grid = ticks.map((v) => `<line x1="${padL}" x2="${padL + w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
      stroke="var(--line)" stroke-width="1"/>
    <text x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`).join("");
  const bars = rows.map((r, i) => {
    const x = padL + i * bw + bw * 0.18, bwid = bw * 0.64;
    const top = y(r.rollNm);
    const sat = r.saturated >= 20;
    return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bwid.toFixed(1)}" height="${(padT + h - top).toFixed(1)}"
        rx="3" fill="${sat ? "var(--warn)" : "var(--accent)"}" opacity="${sat ? 0.7 : 0.9}"/>
      <text x="${(x + bwid / 2).toFixed(1)}" y="${(top - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--ink)">${r.rollNm.toFixed(0)}</text>
      <text x="${(x + bwid / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">${r.g} g</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(tr("neckLoadAria"))}"
      style="display:block;max-width:${width}px">
    ${grid}${bars}
    <text x="${padL}" y="10" font-size="10" fill="var(--muted)">N·m</text>
  </svg>`;
}

export function neckLoadHTML(kase = "lateral") {
  const rows = NECK_GLOAD[kase] || NECK_GLOAD.lateral;
  const muscles = Object.keys(NECK_MUSCLE_LABEL);
  const head = muscles.map((m) => `<th style="text-align:right">${esc(NECK_MUSCLE_LABEL[m])}</th>`).join("");
  const body = rows.map((r) => `<tr><td><b>${r.g} g</b></td><td style="text-align:right">${r.forceN.toFixed(0)}</td>
    <td style="text-align:right">${r.rollNm.toFixed(0)}</td>${muscles.map((m) => {
      const f = r.muscles[m];
      const capped = f != null && NECK_MUSCLE_FMAX[m] && f >= NECK_MUSCLE_FMAX[m] * 0.98;
      return `<td style="text-align:right;${capped ? "color:var(--warn)" : ""}">${f == null ? "—" : f.toFixed(0)}${capped ? "*" : ""}</td>`;
    }).join("")}</tr>`).join("");
  return `<div class="daybox" id="neckLoadBox">
    <div style="font-weight:600">${esc(tr("neckLoadTitle"))}</div>
    <p class="sub" style="margin:2px 0 8px">${esc(tr("neckLoadSub"))}</p>
    ${neckLoadSVG(rows)}
    <div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th></th><th style="text-align:right">${esc(tr("neckLoadForce"))}</th>
      <th style="text-align:right">${esc(tr("neckLoadRoll"))}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="note">${esc(tr("neckLoadNote"))}<br><span style="opacity:.7">${esc(NECK_GLOAD_SOURCE)}</span></p>
  </div>`;
}
