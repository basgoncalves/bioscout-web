/**
 * zip.js -- minimal ZIP writer, store method only (no compression).
 *
 * A dependency-free alternative to pulling in a compression library: the
 * payload here is mostly PNG and already-compressed data, so DEFLATE would buy
 * little, and a store-only archive is about sixty lines and understandable in
 * one sitting. Produces a standard .zip that any tool opens.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();

function dosTime(d = new Date()) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
  };
}

/** files: [{ name, data: Uint8Array|string }] -> Blob */
export function makeZip(files) {
  const { time, date } = dosTime();
  const chunks = [], central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034B50, true);       // local file header
    lv.setUint16(4, 20, true);               // version needed
    lv.setUint16(6, 0x0800, true);           // UTF-8 names
    lv.setUint16(8, 0, true);                // stored
    lv.setUint16(10, time, true); lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);     // compressed size
    lv.setUint32(22, data.length, true);     // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014B50, true);       // central directory header
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);          // offset of local header
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054B50, true);         // end of central directory
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: "application/zip" });
}

/** Rasterise an inline <svg> to a PNG blob at the given pixel width. */
export function svgToPng(svgEl, width = 1000, background = "#ffffff") {
  return new Promise((resolve) => {
    const clone = svgEl.cloneNode(true);
    // Inline the CSS variables the chart relies on -- a detached SVG has no
    // stylesheet, so var(--line) etc. would resolve to nothing.
    const cs = getComputedStyle(document.documentElement);
    let xml = new XMLSerializer().serializeToString(clone);
    for (const v of ["--line", "--muted", "--ink", "--accent"]) {
      xml = xml.split(`var(${v})`).join(cs.getPropertyValue(v).trim() || "#888");
    }
    const vb = (clone.getAttribute("viewBox") || "0 0 320 190").split(/\s+/).map(Number);
    const ar = (vb[3] || 190) / (vb[2] || 320);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = width; c.height = Math.round(width * ar);
      const g = c.getContext("2d");
      g.fillStyle = background; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => resolve(b), "image/png");
    };
    img.onerror = () => resolve(null);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  });
}

export async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
