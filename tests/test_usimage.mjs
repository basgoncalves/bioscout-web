// Geometry behind Process > Images (src/usimage.js): node tests/test_usimage.mjs
import { lineIntersect, acuteAngle, vertexAngle, fascicleFromLines, scaleFrom, toTemplateRows, guessMeta } from "../src/usimage.js";

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

console.log(bad ? `${bad} failed` : "usimage: all passed");
process.exit(bad ? 1 : 0);
