/* Save a set of files as real files: the user picks a folder and they land in
 * <folder>/<name>/ (File System Access API, Chrome/Edge on a computer). Where
 * the browser cannot pick folders (phones, Firefox, Safari) they go out as
 * <name>.zip instead. Used by BioFeedback and Record; Process opens the
 * folder again with "Open folder". */
import { makeZip } from "./zip.js";

// Phones (Android Chrome) get the picker too, but write FLAT into the chosen folder
// ("<name>_timeseries.csv" ...): a new sub-folder made inside a phone folder came out
// empty in Google Drive. Every file is read back; anything missing -> the .zip instead.
const isMobile = () => (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
export const canPickFolder = () => typeof window.showDirectoryPicker === "function";

/** files: [{ name: "a/b.csv", data: string|Uint8Array }].
 *  Resolves { how: "folder"|"files", where } | { how: "zip", where, bytes } | { how: "cancel" }. */
export async function saveFiles(files, name, onProgress = () => {}) {
  let reason = canPickFolder() ? "" : "this browser has no folder picker";
  if (canPickFolder()) {
    let root = null;
    try { root = await window.showDirectoryPicker({ mode: "readwrite", id: "bioscout-save", startIn: "documents" }); }
    catch (e) { if (e && e.name === "AbortError") return { how: "cancel" }; reason = `folder picker: ${e && e.message || e}`; }   // other errors: fall back to the zip
    if (root) {
      try {
        const flat = isMobile(), dir = flat ? root : await root.getDirectoryHandle(name, { create: true });
        for (const [i, f] of files.entries()) {
          onProgress(i, files.length);
          const parts = flat ? [`${name}_${f.name.replace(/\//g, "_")}`] : f.name.split("/").filter(Boolean); let d = dir;
          for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
          const h = await d.getFileHandle(parts[parts.length - 1], { create: true });
          const w = await h.createWritable(); await w.write(f.data); await w.close();
          const want = typeof f.data === "string" ? new TextEncoder().encode(f.data).length : f.data.length;
          let got = -1; try { got = (await h.getFile()).size; } catch { /* cannot read back: trust the write */ }
          if (got === 0 && want > 0) throw new Error(`${f.name} came out empty`);
        }
        onProgress(files.length, files.length);
        return { how: "folder", where: flat ? `${root.name} (${name}_…)` : `${root.name}/${name}` };
      } catch (e) { reason = `writing to the folder: ${e && e.message || e}`; console.warn("folder save failed, falling back to .zip:", e); }   // the zip below still delivers the data
    }
  }
  // a phone browser without a folder picker (Android Chrome today): download each file on
  // its own into Downloads, named "<name>_<file>" — real files, no zip. Chrome may ask once
  // to "allow multiple downloads".
  if (isMobile() && !reason.startsWith("writing")) {
    for (const [i, f] of files.entries()) {
      onProgress(i, files.length);
      const fn = `${name}_${f.name.replace(/\//g, "_")}`, u = URL.createObjectURL(new Blob([f.data])), a = document.createElement("a");
      a.href = u; a.download = fn; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 8000);
      await new Promise((r) => setTimeout(r, 400));          // spaced out, so the browser keeps every one
    }
    onProgress(files.length, files.length);
    return { how: "files", where: `Downloads (${name}_…)` };
  }
  onProgress(files.length - 1, files.length);
  const blob = makeZip(files), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = `${name}.zip`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  return { how: "zip", where: `${name}.zip`, bytes: blob.size, reason };
}
