/**
 * The ball in the OpenSim export (src/ballmodel.js).
 *
 *   node tests/test_ballmodel.mjs
 *
 * A jump shot from the jump-shot test's geometry: the ball sits between the
 * hands until release and then flies a parabola; the exported model gets a
 * ball body, joint and BALL marker with the basketball's mass and radius.
 */
import { readFileSync } from "node:fs";
import { analyse } from "../src/kinematics.js";
import { ballFor, ballPath, framesWithBall, addBallToOsim } from "../src/ballmodel.js";

let bad = 0;
const ok = (c, m, x = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${x ? "  " + x : ""}`); if (!c) bad++; };

// a person whose hands come up together and part at the top (a set shot, no jump needed)
const FPS = 30, FLOOR = 1000;
const frames = [];
for (let k = 0; k < 90; k++) {
  const t = k / FPS, up = Math.max(0, Math.min(1, (t - 0.8) / 0.5));   // hands rise 0.8-1.3 s
  const sh = [500, 500], hip = [500, 640];
  const hy = 620 - up * 330, held = t < 1.3;
  const lw = held ? [505, hy] : [505 + (t - 1.3) * 40, 290 + (t - 1.3) * 200];
  const rw = held ? [515, hy] : [515, 290];
  frames.push({ i: k, t: k * 1000 / FPS, lm: { left_shoulder: sh, right_shoulder: sh, left_hip: hip, right_hip: hip,
    left_wrist: lw, right_wrist: rw, left_ankle: [495, FLOOR], right_ankle: [505, FLOOR], nose: [505, 440] } });
}
const res = { activity: "jumpshot", pxPerM: 420, reps: [{ release_i: 39 }] };
const p = ballPath(res, frames, FPS);
ok(!!p && p.size > 30, "ball found in most frames", `${p ? p.size : 0}`);
const k0 = 30, kRel = 39;
ok(p.has(k0) && Math.abs(p.get(k0)[0] - 510) < 1, "held: between the hands");
// after release it rises (y px falls) then comes down
const ys = [...p.entries()].filter(([k]) => k > kRel).map(([, v]) => v[1]);
const top = Math.min(...ys);
ok(ys.length > 5 && top < ys[0] && ys[ys.length - 1] > top, "flight: up then down", `${ys.length} frames`);
const fb = framesWithBall(frames, p);
ok(fb[k0].lm.BALL && fb[k0].lm.BALL.length === 3 && !frames[k0].lm.BALL, "BALL marker added, frames untouched");

const osim = readFileSync(new URL("../data/opensim/models/GPK_v4_016.osim", import.meta.url), "utf8");
const spec = ballFor("jumpshot"), out = addBallToOsim(osim, spec);
ok(/<Body name="ball">[\s\S]*<mass>0\.62<\/mass>/.test(out), "ball body with 0.62 kg");
ok(/<radius>0\.12<\/radius>/.test(out) && /<color>0\.5 0\.5 0\.5<\/color>/.test(out), "grey sphere, 0.12 m");
ok(/<CustomJoint name="ball_free">/.test(out) && /<Marker name="BALL">/.test(out), "free joint and BALL marker");
ok(addBallToOsim(out, spec) === out, "adding twice keeps one ball");
ok(ballFor("squat") === null && ballFor("kick").massKg === 0.43, "ball per sport");
console.log(bad ? `\n${bad} failed` : "\nall ok");
process.exit(bad ? 1 : 0);
