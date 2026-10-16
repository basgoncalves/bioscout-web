/* "Scale to me": lengths are measured, anchored to height, and constraining
 * keeps joint angles while setting bone lengths. */
import { measure, summarise, constrain } from "../src/bodyscale.js";
let bad = 0; const ok = (c, m) => { console.log((c ? "ok    " : "FAIL  ") + m); if (!c) bad++; };
const P = (x, y, z, v = 1) => ({ x, y, z, visibility: v });
const w = Array.from({ length: 33 }, () => P(0, 0, 0));
Object.assign(w, { 23: P(-.1, 0, 0), 24: P(.1, 0, 0), 25: P(-.1, .38, .05), 26: P(.1, .38, 0), 27: P(-.1, .76, 0), 28: P(.1, .76, 0),
  11: P(-.18, -.5, 0), 12: P(.18, -.5, 0), 13: P(-.2, -.22, 0), 14: P(.2, -.22, 0), 15: P(-.2, 0, .1), 16: P(.2, 0, 0) });
const prof = summarise(Array.from({ length: 40 }, () => measure(w)), 1.81);
ok(Math.abs(prof.seg.thigh + prof.seg.shank - 0.491 * 1.81) < 1e-6, "legs anchored to height (Winter 0.491 H)");
ok(prof.seg.upperarm / prof.seg.forearm > 1.05, "the person's own proportions kept (upper arm vs forearm)");
const ang = (a, b, c) => { const u = [a.x - b.x, a.y - b.y, a.z - b.z], v = [c.x - b.x, c.y - b.y, c.z - b.z];
  return Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / Math.hypot(...u) / Math.hypot(...v)) * 180 / Math.PI; };
const c = constrain(w, prof), dd = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
ok(Math.abs(dd(c[23], c[25]) - prof.seg.thigh) < 1e-9 && Math.abs(dd(c[13], c[15]) - prof.seg.forearm) < 1e-9, "bones set to profile lengths");
ok(Math.abs(ang(c[23], c[25], c[27]) - ang(w[23], w[25], w[27])) < 1e-6 && Math.abs(ang(c[11], c[13], c[15]) - ang(w[11], w[13], w[15])) < 1e-6, "knee and elbow angles unchanged");
const few = summarise([measure(w.map((p) => ({ ...p, visibility: 0.1 })))], 1.7);
ok(Math.abs(few.seg.thigh - 0.245 * 1.7) < 1e-9, "no visible frames -> height-based estimate");
console.log(bad ? `${bad} FAILED` : "ALL BODYSCALE CHECKS PASSED"); process.exit(bad ? 1 : 0);
