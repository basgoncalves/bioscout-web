/**
 * Racket strokes, from a body made of geometry.
 *
 *   node tests/test_stroke.mjs
 *
 * A right-hander filmed from behind: a forehand takes the hand from out on
 * the right to across the left, a backhand the other way, a serve goes over
 * the head. Between strokes the player jogs sideways with the arms swinging,
 * which must not count.
 */
import { analyse, buildStrokeFeatures, findStrokeReps } from "../src/kinematics.js";

let bad = 0;
const ok = (c, m, extra = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`); if (!c) bad++; };

const FPS = 30, FLOOR = 1000, HIP = 380;
/** One frame. `bx` body x; `hand` = [cross, down, forward] of the right
 *  wrist from the mid-shoulder in hip-heights: cross positive = out on the
 *  racket side, forward = toward the net. From behind the picture shows cross;
 *  side-on it shows forward, and cross is depth. */
function frame(bx, hand, { sideOn = false } = {}) {
  const hipY = FLOOR - HIP, shY = hipY - 150;
  const half = sideOn ? 2 : 90;                    // shoulders: apart, or stacked
  const P = (x, y, z = 0) => [x, y, z];
  const zR = sideOn ? -90 : 0, zL = sideOn ? 90 : 0;
  const rw = sideOn ? P(bx + hand[2] * HIP, shY + hand[1] * HIP, -hand[0] * 180)
                    : P(bx + hand[0] * HIP, shY + hand[1] * HIP, -hand[2] * 180);
  const lw = sideOn ? P(bx + 8, shY + 0.6 * HIP, zL) : P(bx - 0.45 * HIP, shY + 0.6 * HIP, 0);
  return {
    nose: P(bx, shY - 60), left_ear: P(bx - 6, shY - 55), right_ear: P(bx + 6, shY - 55),
    left_shoulder: P(bx - half, shY, zL), right_shoulder: P(bx + half, shY, zR),
    left_elbow: P((bx - half + lw[0]) / 2, (shY + lw[1]) / 2), right_elbow: P((bx + half + rw[0]) / 2, (shY + rw[1]) / 2),
    left_wrist: lw, right_wrist: rw,
    left_hip: P(bx - 50, hipY), right_hip: P(bx + 50, hipY),
    left_knee: P(bx - 50, hipY + HIP / 2), right_knee: P(bx + 50, hipY + HIP / 2),
    left_ankle: P(bx - 50, FLOOR - 30), right_ankle: P(bx + 50, FLOOR - 30),
    left_heel: P(bx - 55, FLOOR), right_heel: P(bx + 45, FLOOR),
    left_foot_index: P(bx - 30, FLOOR), right_foot_index: P(bx + 70, FLOOR),
  };
}
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
/** A clip: `events` = [{ at (s), kind }]. Swing lasts 0.3 s. */
function clip(events, { secs = 12, sideOn = false, z = true } = {}) {
  const poses = {};
  const REST = [0.45, 0.6, 0.1];
  const PATH = { forehand: [[1.0, 0.45, -0.6], [-0.7, 0.05, 0.7]], backhand: [[-0.7, 0.45, -0.5], [1.0, 0.15, 0.7]],
                 overhead: [[0.6, 0.45, -0.4], [0.1, -0.9, 0.5]] };
  for (let i = 0; i < secs * FPS; i++) {
    const t = i / FPS;
    let hand = [REST[0], REST[1], REST[2] + 0.12 * Math.sin(t * 7)];  // jogging arm
    for (const e of events) {
      const [p0, p1] = PATH[e.kind];
      const prep = (t - (e.at - 0.55)) / 0.4, sw = (t - (e.at - 0.15)) / 0.3, rec = (t - (e.at + 0.35)) / 0.8;
      if (prep > 0 && rec < 1) {
        const from = sw <= 0 ? REST : rec <= 0 ? p0 : p1;
        const to = sw <= 0 ? p0 : rec <= 0 ? p1 : REST;
        const k = ease(sw <= 0 ? prep : rec <= 0 ? sw : rec);
        hand = from.map((v, j) => v + (to[j] - v) * k);
      }
    }
    const f = frame(500 + 120 * Math.sin(t * 0.9), hand, { sideOn });
    if (!z) for (const k of Object.keys(f)) f[k] = f[k].slice(0, 2);
    poses[i] = f;
  }
  return poses;
}

const plan = [{ at: 2, kind: "forehand" }, { at: 4, kind: "backhand" }, { at: 6, kind: "forehand" },
              { at: 8, kind: "overhead" }, { at: 10, kind: "backhand" }];

console.log("From behind, no depth in the frames");
{
  const res = analyse(clip(plan, { z: false }), FPS, { heightM: 1.8, activity: "stroke" });
  const got = res.reps.map((r) => r.stroke_type);
  ok(res.reps.length === 5, "five strokes, and the jog between them is none", String(res.reps.length));
  ok(got.join() === plan.map((e) => e.kind).join(), "each named for what it was", got.join());
  ok(res.reps.every((r, i) => Math.abs(r.contact_s - plan[i].at) < 0.15), "contact within 0.15 s of the swing's middle",
     res.reps.map((r) => r.contact_s).join(" "));
  ok(res.reps.every((r) => r.racket_side === "r"), "the racket hand is the right");
  ok(res.reps.every((r) => r.hand_speed_ms > 3 && r.hand_speed_ms < 25), "hand speed is a human's",
     res.reps.map((r) => r.hand_speed_ms).join(" "));
  ok(res.reps.every((r) => Number.isInteger(r.contact_frame)), "each carries the frame the ball track lines up on");
}

console.log("Side-on: the shoulder line points at the camera");
{
  const flat = analyse(clip(plan, { sideOn: true, z: false }), FPS, { heightM: 1.8, activity: "stroke" });
  ok(flat.reps.filter((r) => r.stroke_type === "forehand" || r.stroke_type === "backhand").length === 0,
     "without depth, ground strokes are counted and left unnamed",
     flat.reps.map((r) => r.stroke_type).join());
  ok(flat.reps.length === 5, "all five are still counted", String(flat.reps.length));
  ok(flat.reps.some((r) => r.stroke_type === "overhead"), "an overhead needs no shoulder line");
  const deep = analyse(clip(plan, { sideOn: true }), FPS, { heightM: 1.8, activity: "stroke" });
  ok(deep.reps.map((r) => r.stroke_type).join() === plan.map((e) => e.kind).join(),
     "with the pose model's depth they are named", deep.reps.map((r) => r.stroke_type).join());
}

console.log("Nothing to find");
{
  const res = analyse(clip([], { z: false }), FPS, { heightM: 1.8, activity: "stroke" });
  ok(res.reps.length === 0, "a jog with swinging arms is not a rally", String(res.reps.length));
  const F = buildStrokeFeatures(clip([], { z: false })); F._fps = FPS;
  ok(findStrokeReps(F).refused === "noStrokes", "and says so");
}

console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
