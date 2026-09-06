/**
 * media.js -- photos, kept out of localStorage.
 *
 * Everything else this app stores is small: a session summary is a few kB, a
 * set's curves about 10 kB, and the whole localStorage budget is around 5 MB
 * shared between profiles, fifty archived sessions and the meal log. A single
 * photo off a phone camera is 3-8 MB on its own. Putting one in localStorage
 * would not merely be wasteful, it would break the app -- write() there fails
 * silently when the quota is hit, and the thing it takes down is the profile
 * somebody is standing there trying to use.
 *
 * So photos live in IndexedDB, which has a quota measured in hundreds of
 * megabytes, and they are shrunk on the way in. A meal photo is a reminder of
 * what you ate, not evidence: 640 px on the long edge at JPEG 0.7 comes out
 * around 40-60 kB, which is a hundred meals for the size of one original.
 *
 * The arithmetic is separated from the storage so the parts that can be wrong
 * can be tested without a browser.
 */

const DB = "bioscout.media.v1";
const STORE = "photos";

/* ---- pure ------------------------------------------------------------- */

/** A photo's key. Stable, derived, and scoped like everything else: two
 *  athletes on one phone must not collide, and deleting a meal must be able
 *  to name its photo without having stored a second id anywhere. */
export function photoId(at, profile = null) {
  return `${profile ?? ""}|${at}`;
}

/**
 * Dimensions to draw at, preserving aspect ratio and never enlarging.
 *
 * Upscaling a small photo would cost bytes and add nothing, so a source that
 * is already under the limit is left exactly as it is.
 */
export function targetDims(w, h, maxEdge = 640) {
  if (!(w > 0 && h > 0)) return null;
  const long = Math.max(w, h);
  if (long <= maxEdge) return { w: Math.round(w), h: Math.round(h) };
  const k = maxEdge / long;
  // Math.max(1, ...) because a very long thin image would otherwise round its
  // short edge to zero, and a canvas of width 0 throws.
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/* ---- storage ----------------------------------------------------------- */

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const putPhoto = (id, blob) => tx("readwrite", (s) => s.put(blob, id));
export const getPhoto = (id) => tx("readonly", (s) => s.get(id));
export const delPhoto = (id) => tx("readwrite", (s) => s.delete(id));
export const photoKeys = () => tx("readonly", (s) => s.getAllKeys());

/**
 * A camera file, shrunk to something worth keeping.
 *
 * createImageBitmap handles EXIF orientation, which matters: a portrait photo
 * from a phone is landscape pixels plus a rotation flag, and drawing it
 * without honouring that stores it on its side.
 */
export async function shrink(file, maxEdge = 640, quality = 0.7) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const d = targetDims(bmp.width, bmp.height, maxEdge);
  if (!d) throw new Error("not an image");
  const c = document.createElement("canvas");
  c.width = d.w; c.height = d.h;
  c.getContext("2d").drawImage(bmp, 0, 0, d.w, d.h);
  bmp.close?.();
  const out = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
  if (!out) throw new Error("could not encode");
  // A shrink that made things bigger is a shrink not worth having -- small
  // originals and already-compressed screenshots both hit this.
  return out.size < file.size ? out : file;
}
