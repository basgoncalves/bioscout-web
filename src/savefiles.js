/* Save a set of files as real files: the user picks a folder and they land in
 * <folder>/<name>/ (File System Access API, Chrome/Edge on a computer). Where
 * the browser cannot pick folders (phones, Firefox, Safari) they go out as
 * <name>.zip instead. Used by BioFeedback and Record; Process opens the
 * folder again with "Open folder". */
import { makeZip } from "./zip.js";

export const canPickFolder = () => typeof window.showDirectoryPicker === "function";

/** files: [{ name: "a/b.csv", data: string|Uint8Array }].
 *  Resolves { how: "folder", where } | { how: "zip", where, bytes } | { how: "cancel" }. */
export async function saveFiles(files, name) {
  if (canPickFolder()) {
    let root = null;
    try { root = await window.showDirectoryPicker({ mode: "readwrite", id: "bioscout-save", startIn: "documents" }); }
    catch (e) { if (e && e.name === "AbortError") return { how: "cancel" }; }   // other errors: fall back to the zip
    if (root) {
      const dir = await root.getDirectoryHandle(name, { create: true });
      for (const f of files) {
        const parts = f.name.split("/").filter(Boolean); let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
        await w.write(f.data); await w.close();
      }
      return { how: "folder", where: `${root.name}/${name}` };
    }
  }
  const blob = makeZip(files), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = `${name}.zip`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  return { how: "zip", where: `${name}.zip`, bytes: blob.size };
}
