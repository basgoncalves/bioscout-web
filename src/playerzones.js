/**
 * playerzones.js -- the user draws, on a still of the picture, one rectangle
 * per player (P1..Pn). The multi-player tracker then gives each area's body
 * that player's number and ignores everyone outside the areas
 * (src/multiplayer.js createMultiTracker({ zones })).
 *
 * Areas are fractions of the picture, so the same areas fit the camera, a file
 * or a cropped screen recording of the same view. They are remembered in this
 * browser (localStorage, wrapped: storage may be missing).
 */
import { PLAYER_COLOURS } from "./multiplayer.js";

const KEY = "bioscout.mpzones.v1";
export function loadZoneSettings() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") return { n: v.n || 2, use: !!v.use, zones: Array.isArray(v.zones) ? v.zones : [] }; }
  catch { /* no storage */ }
  return { n: 2, use: false, zones: [] };
}
export function saveZoneSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* no storage */ } }

/** Open the drawing dialog over a still of `src` (video or canvas).
 *  Resolves to the zones array (may be shorter than n), or null on cancel. */
export function askZones({ src, n, zones = [], tr }) {
  return new Promise((resolve) => {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    if (!sw || !sh) { resolve(null); return; }
    const dlg = document.createElement("dialog");
    dlg.style.cssText = "width:min(96vw,960px);max-width:none";
    dlg.innerHTML = `<h2 style="margin:0 0 6px">${tr("mpZonesTitle")}</h2>
      <p class="note" id="pzHint" style="margin:0 0 8px"></p>
      <div style="position:relative"><canvas id="pzCv" style="max-width:100%;max-height:68vh;width:auto;height:auto;margin:0 auto;display:block;touch-action:none;border-radius:8px;cursor:crosshair"></canvas></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button type="button" class="ghost" id="pzUndo">${tr("mpZonesUndo")}</button>
        <button type="button" class="ghost" id="pzClear">${tr("mpZonesClear")}</button>
        <button type="button" class="ghost" id="pzCancel">${tr("cancel")}</button>
        <button type="button" id="pzDone" style="margin-left:auto">${tr("mpZonesDone")}</button>
      </div>`;
    document.body.appendChild(dlg);
    const cv = dlg.querySelector("#pzCv"), cx = cv.getContext("2d");
    cv.width = sw; cv.height = sh;
    const still = document.createElement("canvas"); still.width = sw; still.height = sh;
    still.getContext("2d").drawImage(src, 0, 0, sw, sh);
    let Z = zones.slice(0, n).map((z) => ({ ...z })), drag = null;
    const hint = () => { dlg.querySelector("#pzHint").textContent = Z.length < n ? tr("mpZonesHint", { p: Z.length + 1, n }) : tr("mpZonesAll", { n }); };
    const paint = () => {
      cx.drawImage(still, 0, 0);
      const all = drag ? Z.concat([drag]) : Z, fs = Math.max(14, sw / 45);
      all.forEach((z, k) => {
        const c = PLAYER_COLOURS[k % 4];
        cx.fillStyle = c + "33"; cx.strokeStyle = c; cx.lineWidth = Math.max(2, sw / 300);
        cx.fillRect(z.x * sw, z.y * sh, z.w * sw, z.h * sh); cx.strokeRect(z.x * sw, z.y * sh, z.w * sw, z.h * sh);
        cx.fillStyle = c; cx.font = `700 ${fs}px system-ui,sans-serif`; cx.fillText("P" + (k + 1), z.x * sw + 6, z.y * sh + fs + 4);
      });
      hint();
    };
    const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
    let a = null;
    cv.addEventListener("pointerdown", (e) => { if (Z.length >= n) return; a = pt(e); cv.setPointerCapture(e.pointerId); });
    cv.addEventListener("pointermove", (e) => {
      if (!a) return; const b = pt(e);
      drag = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; paint();
    });
    cv.addEventListener("pointerup", () => { if (drag && drag.w > 0.02 && drag.h > 0.02) Z.push(drag); a = null; drag = null; paint(); });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector("#pzUndo").onclick = () => { Z.pop(); paint(); };
    dlg.querySelector("#pzClear").onclick = () => { Z = []; paint(); };
    dlg.querySelector("#pzCancel").onclick = () => close(null);
    dlg.querySelector("#pzDone").onclick = () => close(Z);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(null); });
    paint(); dlg.showModal();
  });
}
