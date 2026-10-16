/**
 * Personal segment lengths for BioFeedback ("scale to me").
 *
 *   measure(w)            one frame of MediaPipe world landmarks -> lengths (m)
 *   summarise(frames, h)  many frames + body height -> profile {seg: metres, spread, n}
 *   constrain(w, prof)    landmarks with each limb bone set to the profile length
 *   fromOsim(xmlText)     best-effort lengths + mass from an OpenSim .osim
 *
 * Why: the camera's 3D landmarks wobble in length from frame to frame and run
 * short overall, and every lever arm (arm moments) inherits that. A guided
 * capture gives the person's own proportions; the overall size is anchored to
 * their height, because MediaPipe's absolute scale is the least reliable part.
 * Constraining keeps each bone's DIRECTION from the camera and only fixes its
 * LENGTH, so joint angles are unchanged.
 */
export const SEGS = {
  thigh:    { l: [23, 25], r: [24, 26], frac: 0.245 },   // Winter (2009) fractions of height
  shank:    { l: [25, 27], r: [26, 28], frac: 0.246 },
  upperarm: { l: [11, 13], r: [12, 14], frac: 0.186 },
  forearm:  { l: [13, 15], r: [14, 16], frac: 0.146 },
  shoulders:{ one: [11, 12], frac: 0.200 },               // shoulder landmarks (not biacromial)
  hips:     { one: [23, 24], frac: 0.110 },               // MediaPipe hip points ~ joint centres
};
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const vis = (p) => (p.visibility == null ? 1 : p.visibility);

export function measure(w, minVis = 0.6) {
  const out = {};
  for (const [k, s] of Object.entries(SEGS)) {
    const pairs = s.one ? [s.one] : [s.l, s.r];
    const v = pairs.filter(([a, b]) => w[a] && w[b] && vis(w[a]) >= minVis && vis(w[b]) >= minVis).map(([a, b]) => d(w[a], w[b]));
    if (v.length) out[k] = v.reduce((x, y) => x + y, 0) / v.length;   // left/right averaged
  }
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const iqr = (a) => { const s = [...a].sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; return s.length ? q(0.75) - q(0.25) : NaN; };

export function summarise(frames, heightM = 1.75) {
  const per = {}; for (const k of Object.keys(SEGS)) per[k] = [];
  for (const f of frames) for (const [k, v] of Object.entries(f)) if (Number.isFinite(v)) per[k].push(v);
  const raw = {}, spread = {}, n = {};
  for (const k of Object.keys(SEGS)) { raw[k] = median(per[k]); spread[k] = iqr(per[k]); n[k] = per[k].length; }
  // one size factor from the legs (largest, most visible), so proportions stay the person's own
  const legM = raw.thigh + raw.shank, legE = (SEGS.thigh.frac + SEGS.shank.frac) * heightM;
  const k = Number.isFinite(legM) && legM > 0.3 ? legE / legM : 1;
  const seg = {};
  for (const key of Object.keys(SEGS)) seg[key] = Number.isFinite(raw[key]) ? raw[key] * k : SEGS[key].frac * heightM;
  return { seg, spread, n, sizeFactor: k, heightM, made: new Date().toISOString(), source: "camera" };
}

/* Limb chains: [proximal, distal, segment, landmarks that ride with the distal end] */
const CHAINS = [
  [23, 25, "thigh", []], [25, 27, "shank", [29, 31]], [24, 26, "thigh", []], [26, 28, "shank", [30, 32]],
  [11, 13, "upperarm", []], [13, 15, "forearm", [17, 19, 21]], [12, 14, "upperarm", []], [14, 16, "forearm", [18, 20, 22]],
];
export function constrain(w, prof) {
  if (!prof || !prof.seg || !w) return w;
  const o = w.map((p) => ({ ...p }));
  const ride = { 25: [27, 29, 31], 26: [28, 30, 32], 13: [15, 17, 19, 21], 14: [16, 18, 20, 22] };
  for (const [a, b, seg, tail] of CHAINS) {
    const L = prof.seg[seg]; if (!(L > 0)) continue;
    const A = o[a], B = o[b], len = d(A, B); if (!(len > 1e-6)) continue;
    const nb = { x: A.x + (B.x - A.x) * L / len, y: A.y + (B.y - A.y) * L / len, z: A.z + (B.z - A.z) * L / len };
    const dx = nb.x - B.x, dy = nb.y - B.y, dz = nb.z - B.z;
    for (const i of [b, ...(ride[b] || tail)]) if (o[i]) { o[i].x += dx; o[i].y += dy; o[i].z += dz; }
  }
  return o;
}

/* OpenSim .osim: lengths from the joint offset frames (parent side), mass
 * from the bodies. Works for Rajagopal / gait-style models with offset
 * frames; anything not found stays from the height-based estimate. */
export function fromOsim(xml, heightM = 1.75) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("not a readable .osim (XML) file");
  let mass = 0; for (const b of doc.querySelectorAll("Body")) { const m = b.querySelector(":scope > mass"); if (m) mass += +m.textContent || 0; }
  const offsets = {};
  for (const j of doc.querySelectorAll("JointSet objects > *")) {
    const name = (j.getAttribute("name") || "").toLowerCase();
    const parentName = (j.querySelector(":scope > socket_parent_frame") || {}).textContent || "";
    for (const f of j.querySelectorAll(":scope > frames > PhysicalOffsetFrame")) {
      if (!parentName.includes(f.getAttribute("name"))) continue;
      const t = (f.querySelector(":scope > translation") || {}).textContent || "";
      const v = t.trim().split(/\s+/).map(Number);
      if (v.length === 3 && v.every(Number.isFinite)) offsets[name] = Math.hypot(...v);
    }
  }
  const pick = (re) => { const vals = Object.entries(offsets).filter(([k]) => re.test(k)).map(([, v]) => v).filter((v) => v > 0.05); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN; };
  const found = { thigh: pick(/^(knee|walker_knee)/), shank: pick(/^ankle/), upperarm: pick(/^(elbow|humeroulnar)/), forearm: pick(/^(radiocarpal|wrist|radius_lunate)/) };
  const seg = {}, from = {};
  for (const k of Object.keys(SEGS)) { seg[k] = Number.isFinite(found[k]) ? found[k] : SEGS[k].frac * heightM; from[k] = Number.isFinite(found[k]) ? "osim" : "height"; }
  return { seg, from, massKg: mass > 0 ? mass : NaN, heightM, made: new Date().toISOString(), source: "osim" };
}
