/**
 * Camera body fat: the geometry and the equation, not the camera.
 *
 *   node tests/test_bodyfat.mjs
 */
import * as B from "../src/bodyfat.js";

let bad = 0;
const ok = (c, msg) => { if (!c) { bad++; console.error("  - " + msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Circle and a known ellipse.
near(B.ellipseCircumference(10, 10), Math.PI * 10, 1e-9, "circle");
near(B.ellipseCircumference(30, 20), 79.3272, 1e-3, "ellipse 15x10");
ok(B.ellipseCircumference(0, 5) === null, "zero axis");

// Navy, metric, against hand-worked values.
near(B.navyBodyFat({ sex: "male", heightCm: 181, neckCm: 38, waistCm: 85 }), 15.94, 0.05, "male navy");
near(B.navyBodyFat({ sex: "female", heightCm: 165, neckCm: 33, waistCm: 72, hipCm: 97 }), 26.4, 0.7, "female navy");
ok(B.navyBodyFat({ sex: "male", heightCm: 181, neckCm: 40, waistCm: 38 }) === null, "waist<=neck");
ok(B.navyBodyFat({ sex: "female", heightCm: 165, neckCm: 33, waistCm: 72 }) === null, "female needs hips");
ok(B.navyBodyFat({ sex: "unspecified", heightCm: 165, neckCm: 33, waistCm: 72, hipCm: 90 }) === null, "sex needed");
// Monotone in waist.
ok(B.navyBodyFat({ sex: "male", heightCm: 181, neckCm: 38, waistCm: 95 }) >
   B.navyBodyFat({ sex: "male", heightCm: 181, neckCm: 38, waistCm: 85 }), "more waist more fat");

// A synthetic silhouette: a 200x400 image, a person 360 px tall = 1.80 m,
// neck 20 px wide, torso 60 px, hips 70 px, arms away from the body.
const W = 200, H = 400, mask = new Float32Array(W * H);
const fill = (y0, y1, x0, x1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * W + x] = 1; };
fill(20, 60, 85, 115);    // head 31
fill(61, 90, 90, 109);    // neck 20
fill(91, 200, 70, 129);   // torso 60
fill(201, 240, 65, 134);  // hips 70
fill(241, 379, 70, 129);  // legs
const L = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
const set = (i, x, y) => { L[i] = { x: x / W, y: y / H, visibility: 1 }; };
set(B.LM.nose, 100, 40); set(B.LM.mouthL, 95, 50); set(B.LM.mouthR, 105, 50);
set(B.LM.shL, 70, 100); set(B.LM.shR, 130, 100);
set(B.LM.hipL, 85, 210); set(B.LM.hipR, 115, 210);
set(B.LM.anL, 85, 370); set(B.LM.anR, 115, 370);
for (const i of [B.LM.wrL, B.LM.elL]) set(i, 20, 180);
for (const i of [B.LM.wrR, B.LM.elR]) set(i, 180, 180);
ok(B.viewOf(L, W, H) === "front", "front view");

const f = B.measureFrame({ mask, w: W, h: H, lms: L, heightM: 1.8, sex: "male" });
ok(f.ok, "frame ok");
near(f.pxPerM, 359 / 1.8, 1e-6, "scale");
near(f.neck, 20 / f.pxPerM, 1e-9, "neck width");
near(f.waist, 60 / f.pxPerM, 1e-9, "waist width");
near(f.hip, 70 / f.pxPerM, 1e-9, "hip width");
ok(!f.warn.includes("armsTouch") && !f.warn.includes("notWhole"), "no warnings: " + f.warn);

// Arms hanging inside the waist run are flagged.
set(B.LM.wrL, 72, 170);
ok(B.measureFrame({ mask, w: W, h: H, lms: L, heightM: 1.8, sex: "male" }).warn.includes("armsTouch"), "arms flagged");
ok(!B.measureFrame({ mask, w: W, h: H, lms: L, heightM: 1.8, sex: "male", view: "side" }).warn.includes("armsTouch"), "arms ignored from the side");

// Cut off at the top.
const cut = mask.slice(); for (let x = 0; x < W; x++) cut[0 * W + x] = 1;
ok(B.measureFrame({ mask: cut, w: W, h: H, lms: L, heightM: 1.8, sex: "male" }).warn.includes("notWhole"), "cut flagged");

// Side view classification.
const S = L.map((p) => ({ ...p }));
S[B.LM.shL] = { x: 0.5, y: 0.25, visibility: 1 }; S[B.LM.shR] = { x: 0.52, y: 0.25, visibility: 1 };
ok(B.viewOf(S, W, H) === "side", "side view");

// Combining and estimating.
const c = B.combineFrames([{ ok: true, neck: 0.12, waist: 0.3, hip: 0.34, warn: [] },
                           { ok: true, neck: 0.13, waist: 0.32, hip: 0.35, warn: ["x"] },
                           { ok: false, warn: ["noBody"] }]);
ok(c.n === 2 && Math.abs(c.waist - 0.31) < 1e-9, "median of ok frames");
const circ = B.circumferences({ neck: 0.12, waist: 0.30, hip: 0.34 }, { neck: 0.12, waist: 0.22, hip: 0.25 });
near(circ.neck, Math.PI * 12, 1e-6, "neck circ");
const e = B.bodyFatEstimate({ sex: "male", heightM: 1.81, circ });
ok(e && e.low < e.bf && e.bf < e.high && e.half >= B.NAVY_SEE, "range around estimate");
const ec = B.bodyFatEstimate({ sex: "male", heightM: 1.81, circ, calibrated: true });
ok(ec.half < e.half, "calibration narrows the range");

const cal = B.calibrationFrom({ neck: 40, waist: 90, hip: 200 }, { neck: 38, waist: 85, hip: 95 });
ok(cal.neck && cal.waist && !cal.hip, "absurd calibration rejected");
near(B.circumferences({ neck: 0.12, waist: 0.3, hip: 0.34 }, { neck: 0.12, waist: 0.22, hip: 0.25 }, { neck: 1.1 }).neck,
     Math.PI * 12 * 1.1, 1e-6, "calibration applied");

ok(B.implausibleSites({ neck: 120, waist: 85, hip: null }).join() === "neck", "implausible neck flagged");
ok(B.implausibleSites({ neck: 38, waist: 85, hip: 98 }).length === 0, "normal body passes");

if (bad) { console.error(`bodyfat: ${bad} failed`); process.exit(1); }
console.log("bodyfat: ok");
