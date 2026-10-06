/**
 * The ball tracker, on pictures made of rectangles.
 *
 *   node tests/test_balltrack.mjs
 *
 * A grey court, a yellow banner that never moves, a blue thing that does, a
 * player's box, and a 4-pixel yellow ball hit at a wall on the left twice. The
 * truth is known exactly, so what is checked is that the tracker follows the
 * ball and nothing else, and that the two speeds mean what they claim.
 */
import { makeBallTracker, ballAfterStrokes, bodyBox, isBallColour, strokeSummary } from "../src/balltrack.js";

let bad = 0;
const ok = (c, m, extra = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`); if (!c) bad++; };

const W = 480, H = 270, FPS = 30;
const PX_PER_M = 40;                 // the picture is 12 m wide at the player
const WALL_X = 60, PLAYER_X = 380;   // 8 m apart
const WALL_M = (PLAYER_X - WALL_X) / PX_PER_M;

function rect(buf, x0, y0, w, h, [r, g, b]) {
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, (y0 + h) | 0); y++) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(W, (x0 + w) | 0); x++) {
      const q = (y * W + x) * 4; buf[q] = r; buf[q + 1] = g; buf[q + 2] = b; buf[q + 3] = 255;
    }
  }
}
/** Ball x at time since a hit: out at `out` m/s, back at half that. */
function ballAt(dt, out) {
  const tWall = WALL_M / out;
  if (dt < 0) return null;
  if (dt <= tWall) return [PLAYER_X - out * dt * PX_PER_M, 150 - 40 * Math.sin(Math.PI * dt / tWall) * 0.5];
  const back = (dt - tWall) * (out / 2) * PX_PER_M;
  return back < PLAYER_X - WALL_X ? [WALL_X + back, 150 + 0.1 * back] : null;
}
const hits = [{ t: 0.5, out: 16 }, { t: 2.5, out: 24 }];
const tracker = makeBallTracker();
const box = { x0: (PLAYER_X - 5) / W, y0: 90 / H, x1: (PLAYER_X + 50) / W, y1: 250 / H };
const truth = [];
for (let i = 0; i < 4.5 * FPS; i++) {
  const t = i / FPS;
  const buf = new Uint8ClampedArray(W * H * 4);
  rect(buf, 0, 0, W, H, [120, 120, 124]);
  rect(buf, 200, 20, 60, 14, [210, 230, 60]);                 // a yellow banner, still
  rect(buf, 100 + 30 * t, 220, 20, 20, [40, 70, 200]);        // something blue, moving
  rect(buf, PLAYER_X + 10 + 6 * Math.sin(t * 9), 120, 14, 14, [215, 235, 70]);   // yellow on the player
  const h = hits.filter((x) => x.t <= t).pop();
  const b = h ? ballAt(t - h.t, h.out) : null;
  if (b) { rect(buf, b[0] - 2, b[1] - 2, 4, 4, [205, 232, 62]); truth.push({ t: t * 1000, x: b[0] / W, y: b[1] / H }); }
  tracker.push(buf, W, H, t * 1000, box);
}

console.log("Colour");
ok(isBallColour(205, 232, 62) && isBallColour(150, 170, 80), "optic yellow, bright and in shade");
ok(!isBallColour(120, 120, 124) && !isBallColour(220, 170, 140) && !isBallColour(200, 120, 80)
   && !isBallColour(60, 140, 70), "not concrete, skin, clay or turf");

console.log("Tracking");
const tr = tracker.track;
const near = tr.filter((p) => truth.some((q) => Math.abs(q.t - p.t) < 1 && Math.hypot((q.x - p.x) * W, (q.y - p.y) * H) < 6));
ok(tr.length > truth.length * 0.7, "most frames with a ball in flight have a detection", `${tr.length}/${truth.length}`);
ok(near.length >= tr.length * 0.95, "and they are on the ball -- not the banner, the blue thing or the player",
   `${near.length}/${tr.length}`);

console.log("After each stroke");
const contacts = hits.map((h) => h.t * 1000);
const tof = ballAfterStrokes(tr, contacts, { w: W, h: H, pxPerM: PX_PER_M, wallM: WALL_M });
ok(tof.every((r) => r.method === "tof"), "with the wall distance given, speed is distance over flight time");
ok(tof.every((r, i) => Math.abs(r.speed_ms - hits[i].out) / hits[i].out < 0.15), "within 15% of the truth",
   tof.map((r) => r.speed_ms).join(" ") + " vs " + hits.map((h) => h.out).join(" "));
ok(tof.every((r) => r.impact && Math.abs(r.impact.x * W - WALL_X) < 30), "placement is where it turned round: at the wall",
   tof.map((r) => r.impact && (r.impact.x * W).toFixed(0)).join(" "));
const plane = ballAfterStrokes(tr, contacts, { w: W, h: H, pxPerM: PX_PER_M });
ok(plane.every((r) => r.method === "plane"), "without it, speed is read across the picture");
ok(plane.every((r, i) => Math.abs(r.speed_ms - hits[i].out) / hits[i].out < 0.2), "which for a ball crossing the picture is the same number",
   plane.map((r) => r.speed_ms).join(" "));
const none = ballAfterStrokes([], contacts, { w: W, h: H, pxPerM: PX_PER_M, wallM: WALL_M });
ok(none.every((r) => r.speed_ms === null && r.impact === null), "no track, no number");

console.log("Helpers");
const bb = bodyBox({ a: [100, 50], b: [200, 250] }, 400, 300, 0.1);
ok(Math.abs(bb.x0 - 0.225) < 1e-9 && Math.abs(bb.y1 - 0.9) < 1e-9, "the player's box, grown a tenth");
const sum = strokeSummary([
  { stroke_type: "forehand", ball_speed_ms: 20, hand_speed_ms: 9, ball_method: "tof" },
  { stroke_type: "backhand", ball_speed_ms: 10, hand_speed_ms: 7, ball_method: "tof" },
  { stroke_type: null, hand_speed_ms: 8 }, { stroke_type: "forehand", removed: true, ball_speed_ms: 99 }]);
ok(sum.strokes === 3 && sum.forehand === 1 && sum.backhand === 1 && sum.unnamed === 1, "counts leave removed strokes out");
ok(sum.ball_mean_ms === 15 && sum.ball_peak_ms === 20 && sum.nBall === 2 && sum.ball_forehand_ms === 20,
   "ball means are over the strokes that have a ball speed");

console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
