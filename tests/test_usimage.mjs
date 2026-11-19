// Geometry behind Process > Images (src/usimage.js): node tests/test_usimage.mjs
import { polyStats, pointInPoly, roiStats, sampleMean, rgbToHex, greyOf, rgbToHsv, lineIntersect, acuteAngle, vertexAngle, fascicleFromLines, scaleFrom, toTemplateRows, guessMeta } from "../src/usimage.js";

let bad = 0;
const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);
const P = (x, y) => ({ x, y });

const X = lineIntersect(P(0, 0), P(10, 10), P(0, 10), P(10, 0));
near(X.x, 5, 1e-9, "intersect x"); near(X.y, 5, 1e-9, "intersect y");
ok(lineIntersect(P(0, 0), P(1, 0), P(0, 1), P(1, 1)) === null, "parallel");
near(acuteAngle(P(0, 0), P(10, 0), P(0, 0), P(10, 10)), 45, 1e-9, "45");
near(acuteAngle(P(10, 0), P(0, 0), P(0, 0), P(10, 10)), 45, 1e-9, "direction-free");
near(vertexAngle(P(10, 0), P(0, 0), P(0, 10)), 90, 1e-9, "vertex 90");
near(scaleFrom(P(0, 0), P(0, 200), 40), 0.2, 1e-12, "scale");

// Synthetic VL: deep aponeurosis y = 300 (flat), superficial y = 100, fascicle at 20 deg.
// Length between aponeuroses = 200 / sin(20) px; at 0.1 mm/px.
const th = 20 * Math.PI / 180, x0 = 50;
const fas = [P(x0, 300), P(x0 + 50 * Math.cos(th), 300 - 50 * Math.sin(th))];   // short drawn segment
const r = fascicleFromLines(fas, [P(0, 300), P(600, 300)], [P(0, 100), P(600, 100)], 0.1, { w: 640, h: 480 });
near(r.pen, 20, 1e-9, "pennation");
near(r.lenMm, 20 / Math.sin(th), 1e-6, "fascicle length");
ok(r.beyondDrawn, "flagged as extrapolated beyond the drawn segment");
ok(!r.extrapolated, "intersections inside the image");
// Fascicle leaving the image on the right: superficial meeting point x > w
const r2 = fascicleFromLines([P(500, 300), P(520, 293)], [P(0, 300), P(600, 300)], [P(0, 100), P(600, 100)], 0.1, { w: 640, h: 480 });
ok(r2.extrapolated, "outside the image -> extrapolated");

const T = toTemplateRows([
  { angle: 30, cond: "relaxed", lf: 64, pen: 15 }, { angle: 30, cond: "relaxed", lf: 66, pen: 15 },
  { angle: 30, cond: "contracted", lf: 55, pen: 19 },
]);
ok(T.length === 5 && T[0][0] === 30, "five angles");
near(T[0][1], 65, 1e-9, "mean of two"); near(T[0][4], 19, 1e-9, "contracted pen");
ok(Number.isNaN(T[1][1]), "empty angle -> NaN");

const g = guessMeta("VL_contracted_75deg.png"); ok(g.cond === "contracted" && g.angle === 75, "guess contracted 75");
const g2 = guessMeta("relaxed-30.jpg"); ok(g2.cond === "relaxed" && g2.angle === 30, "guess relaxed 30");
ok(guessMeta("IMG_0012.png").angle === "", "no false angle");

// pixel colour
const px = new Uint8ClampedArray(4 * 9); for (let i = 0; i < 9; i++) { px[4 * i] = i * 10; px[4 * i + 1] = 100; px[4 * i + 2] = 255; px[4 * i + 3] = 255; }
ok(sampleMean(px, 3, 3, 1, 1, 1)[0] === 40, "one pixel");
near(sampleMean(px, 3, 3, 1, 1, 3)[0], 40, 1e-9, "3x3 mean");
near(sampleMean(px, 3, 3, 0, 0, 3)[0], (0 + 10 + 30 + 40) / 4, 1e-9, "edge clipped");
ok(rgbToHex([255, 0, 16]) === "#ff0010", "hex");
near(greyOf([255, 255, 255]), 255, 1e-9, "grey white");
const hsv = rgbToHsv([0, 0, 255]); near(hsv[0], 240, 1e-9, "hue blue"); near(hsv[1], 100, 1e-9, "sat");

// ROI: 3x3 image, red 0..80 step 10; ROI covering all of it
const st = roiStats(px, 3, 3, P(0, 0), P(3, 3));
ok(st.n === 9 && st.w === 3 && st.h === 3, "roi size");
near(st.ch[0].mean, 40, 1e-9, "roi mean"); ok(st.ch[0].median === 40, "roi median");
ok(st.ch[0].min === 0 && st.ch[0].max === 80, "roi min/max");
near(st.ch[0].sd, Math.sqrt(750), 1e-9, "roi sd");
const st2 = roiStats(px, 3, 3, P(2, 2), P(0, 1));   // corners in any order -> x 0-1, y 1
ok(st2.n === 2 && st2.ch[0].median === 35, "even-n median");
ok(roiStats(px, 3, 3, P(5, 5), P(9, 9)) === null, "roi off the image");

// polygon ROI: lower-left triangle of the 3x3 image -> pixel centres with y > x
ok(pointInPoly(1, 1, [P(0, 0), P(2, 0), P(2, 2), P(0, 2)]) && !pointInPoly(3, 1, [P(0, 0), P(2, 0), P(2, 2), P(0, 2)]), "point in poly");
const tri = polyStats(px, 3, 3, [P(0, 0), P(0, 3), P(3, 3)]);
ok(tri && tri.n === 3, "triangle pixels: " + (tri && tri.n));   // (0,1) (0,2) (1,2)
near(tri.ch[0].mean, (30 + 60 + 70) / 3, 1e-9, "triangle mean");
ok(polyStats(px, 3, 3, [P(0, 0), P(1, 1)]) === null, "needs 3 points");
const sq = polyStats(px, 3, 3, [P(0, 0), P(3, 0), P(3, 3), P(0, 3)]); ok(sq.n === 9 && sq.ch[0].median === 40, "square polygon = rectangle");

console.log(bad ? `${bad} failed` : "usimage: all passed");
process.exit(bad ? 1 : 0);
