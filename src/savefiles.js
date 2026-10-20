/* Save a set of files as real files: the user picks a folder and they land in
 * <folder>/<name>/ (File System Access API, Chrome/Edge on a computer). Where
 * the browser cannot pick folders (phones, Firefox, Safari) they go out as
 * <name>.zip instead. Used by BioFeedback and Record; Process opens the
 * folder again with "Open folder". */
import { makeZip } from "./zip.js";

// Phones are excluded: Android Chrome offers the picker, but folders from cloud apps
// (Google Drive, ...) get created while the files never arrive. Phones get the .zip.
const isMobile = () => (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
export const canPickFolder = () => typeof window.showDirectoryPicker === "function" && !isMobile();

/** files: [{ name: "a/b.csv", data: string|Uint8Array }].
 *  Resolves { how: "folder", where } | { how: "zip", where, bytes } | { how: "cancel" }. */
export async function saveFiles(files, name, onProgress = () => {}) {
  if (canPickFolder()) {
    let root = null;
    try { root = await window.showDirectoryPicker({ mode: "readwrite", id: "bioscout-save", startIn: "documents" }); }
    catch (e) { if (e && e.name === "AbortError") return { how: "cancel" }; }   // other errors: fall back to the zip
    if (root) {
      try {
        const dir = await root.getDirectoryHandle(name, { create: true });
        for (const [i, f] of files.entries()) {
          onProgress(i, files.length);
          const parts = f.name.split("/").filter(Boolean); let d = dir;
          for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
          const h = await d.getFileHandle(parts[parts.length - 1], { create: true });
          const w = await h.createWritable(); await w.write(f.data); await w.close();
          const want = typeof f.data === "string" ? new TextEncoder().encode(f.data).length : f.data.length;
          if ((await h.getFile()).size !== want) throw new Error(`${f.name} was not written`);
        }
        onProgress(files.length, files.length);
        return { how: "folder", where: `${root.name}/${name}` };
      } catch (e) { console.warn("folder save failed, falling back to .zip:", e); }   // the zip below still delivers the data
    }
  }
  onProgress(files.length - 1, files.length);
  const blob = makeZip(files), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = `${name}.zip`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  return { how: "zip", where: `${name}.zip`, bytes: blob.size };
}
