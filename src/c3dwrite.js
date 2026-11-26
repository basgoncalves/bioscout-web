/**
 * c3dwrite.js -- a minimal C3D writer (Intel, float data) for the Process tab's
 * "Save C3D": markers, analog channels, force-plate geometry (type 2) and events.
 * Read back by proc_io.readC3d and by Vicon Nexus / Mokka / ezc3d.
 *
 *   writeC3d({ rate, markers: [{ name, x, y, z }], units: "mm",
 *              analog: { ratio, channels: [{ name, unit, y }] },
 *              plates: [{ corners: [12], origin: [3], channels: [6 indices into analog, 0-based] }],
 *              events: [{ label, context, t }] }) -> ArrayBuffer
 */
export function writeC3d({ rate, markers = [], units = "mm", analog = null, plates = [], events = [] }) {
  const nPts = markers.length, ratio = analog ? Math.max(1, analog.ratio | 0) : 0;
  const ach = analog ? analog.channels : [];
  const nFrames = nPts ? markers[0].x.length : Math.floor((ach[0] ? ach[0].y.length : 0) / Math.max(1, ratio));
  if (!nFrames) throw new Error("nothing to write");
  if (nFrames > 65535) throw new Error("too many frames for a C3D header (max 65535)");

  // ---- parameters
  const groups = [];                        // [{ name, params: [{ name, type, dims, data }] }]
  const grp = (name) => { const g = { name, params: [] }; groups.push(g); return g; };
  const i16 = (name, v, dims) => ({ name, type: 2, dims: dims || (Array.isArray(v) ? [v.length] : []), data: [].concat(v) });
  const f32 = (name, v, dims) => ({ name, type: 4, dims: dims || (Array.isArray(v) ? [v.length] : []), data: [].concat(v) });
  const chr = (name, v) => {                // one string (dims [w]) or many (dims [w, n])
    if (!Array.isArray(v)) return { name, type: -1, dims: [Math.max(1, String(v).length)], data: [String(v)] };
    const w = Math.max(1, ...v.map((s) => String(s).length));
    return { name, type: -1, dims: [w, v.length], data: v.map(String) };
  };
  const chunked = (g, base, arr, w) => {    // LABELS, LABELS2, ... (at most 255 per parameter)
    for (let k = 0, j = 1; k < arr.length || k === 0; k += 255, j++) {
      const p = chr(j === 1 ? base : base + j, arr.slice(k, k + 255).length ? arr.slice(k, k + 255) : [""]);
      if (w) p.dims[0] = Math.max(p.dims[0], w);
      g.params.push(p); if (arr.length <= k + 255) break;
    }
  };
  const P = grp("POINT");
  P.params.push(i16("USED", nPts), f32("SCALE", -1), f32("RATE", rate), i16("DATA_START", 0), i16("FRAMES", nFrames > 32767 ? nFrames - 65536 : nFrames), chr("UNITS", units));
  chunked(P, "LABELS", markers.map((m) => m.name));
  chunked(P, "DESCRIPTIONS", markers.map(() => ""));
  const A = grp("ANALOG");
  A.params.push(i16("USED", ach.length), f32("RATE", rate * (ratio || 1)), f32("GEN_SCALE", 1));
  if (ach.length) {
    chunked(A, "LABELS", ach.map((c) => c.name)); chunked(A, "DESCRIPTIONS", ach.map(() => ""));
    chunked(A, "UNITS", ach.map((c) => c.unit || ""));
    A.params.push(f32("SCALE", ach.map(() => 1)), i16("OFFSET", ach.map(() => 0)));
  }
  const F = grp("FORCE_PLATFORM");
  F.params.push(i16("USED", plates.length));
  if (plates.length) {
    F.params.push(i16("TYPE", plates.map(() => 2)), i16("ZERO", [1, 0]),
      f32("CORNERS", plates.flatMap((p) => p.corners), [3, 4, plates.length]),
      f32("ORIGIN", plates.flatMap((p) => (p.origin && p.origin.length === 3 ? p.origin : [0, 0, 0])), [3, plates.length]),
      i16("CHANNEL", plates.flatMap((p) => p.channels.map((i) => i + 1)), [6, plates.length]));
  }
  const evs = events.filter((e) => Number.isFinite(e.t) && e.t >= 0);
  const E = grp("EVENT");
  E.params.push(i16("USED", evs.length));
  if (evs.length) {
    E.params.push(f32("TIMES", evs.flatMap((e) => [Math.floor(e.t / 60), e.t - 60 * Math.floor(e.t / 60)]), [2, evs.length]),
      chr("LABELS", evs.map((e) => e.label || "")), chr("CONTEXTS", evs.map((e) => e.context || "")), chr("DESCRIPTIONS", evs.map(() => "")));
  }

  // ---- serialise the parameter section
  const bytes = [];
  const u8 = (v) => bytes.push(v & 255), s16 = (v) => { u8(v); u8(v >> 8); };
  const fl = (v) => { const t = new DataView(new ArrayBuffer(4)); t.setFloat32(0, v, true); for (let k = 0; k < 4; k++) u8(t.getUint8(k)); };
  const str = (s) => { for (const ch of s) u8(ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63); };
  const records = [];
  groups.forEach((g, gi) => records.push({ group: true, id: gi + 1, ...g }));
  groups.forEach((g, gi) => g.params.forEach((p) => records.push({ group: false, id: gi + 1, ...p })));
  u8(1); u8(0x50); u8(0); u8(84);                       // block count patched below
  records.forEach((r, ri) => {
    const last = ri === records.length - 1;
    u8(r.name.length); u8(r.group ? -r.id : r.id); str(r.name);
    const offAt = bytes.length; s16(0);
    if (!r.group) {
      u8(r.type); u8(r.dims.length); r.dims.forEach(u8);
      if (r.type === -1) {
        const w = r.dims[0];
        for (const s of r.data) str(String(s).slice(0, w).padEnd(w, " "));
      } else for (const v of r.data) r.type === 2 ? s16(v) : fl(v);
    }
    u8(0);                                              // no description
    if (!last) { const rel = bytes.length - offAt; bytes[offAt] = rel & 255; bytes[offAt + 1] = (rel >> 8) & 255; }
  });
  const pBlocks = Math.ceil(bytes.length / 512);
  bytes[2] = pBlocks;
  const dataStart = 2 + pBlocks;                        // header = block 1, parameters from block 2

  // ---- header + data
  const frameBytes = 4 * (4 * nPts + ratio * ach.length);
  const total = (dataStart - 1) * 512 + nFrames * frameBytes;
  const buf = new ArrayBuffer(Math.ceil(total / 512) * 512), dv = new DataView(buf), out = new Uint8Array(buf);
  out.set(bytes, 512);
  const pd = P.params.find((p) => p.name === "DATA_START"); void pd;
  // patch POINT:DATA_START in place (it was written as 0)
  {
    let o = 512 + 4;
    for (const r of records) {
      const nl = r.name.length, body = o + 4 + nl;
      if (!r.group && r.name === "DATA_START" && r.id === 1) dv.setInt16(body + 2 + r.dims.length, dataStart, true);
      o = o + 2 + nl + dv.getInt16(o + 2 + nl, true);
    }
  }
  dv.setUint8(0, 2); dv.setUint8(1, 0x50);
  dv.setInt16(2, nPts, true); dv.setInt16(4, ratio * ach.length, true);
  dv.setUint16(6, 1, true); dv.setUint16(8, nFrames, true);
  dv.setInt16(10, 10, true); dv.setFloat32(12, -1, true);
  dv.setInt16(16, dataStart, true); dv.setInt16(18, ratio, true); dv.setFloat32(20, rate, true);
  let q = (dataStart - 1) * 512;
  for (let f = 0; f < nFrames; f++) {
    for (const m of markers) {
      const x = m.x[f], y = m.y[f], z = m.z[f], ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
      dv.setFloat32(q, ok ? x : 0, true); dv.setFloat32(q + 4, ok ? y : 0, true); dv.setFloat32(q + 8, ok ? z : 0, true);
      dv.setFloat32(q + 12, ok ? 0 : -1, true); q += 16;
    }
    for (let s = 0; s < ratio; s++) for (const c of ach) { const v = c.y[f * ratio + s]; dv.setFloat32(q, Number.isFinite(v) ? v : 0, true); q += 4; }
  }
  return buf;
}
