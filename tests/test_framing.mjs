/**
 * The live framing check: what it calls out, and how steadily.
 *
 *   node tests/test_framing.mjs
 */
import { inShot, frameIssue, framingWatcher, FRAME_MARGIN } from "../src/framing.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

const P = (x, y) => ({ x, y });
/** A body with everything where it should be, then parts moved out. */
const body = (over = {}) => {
  const lm = [];
  lm[0] = P(0.5, 0.15);                       // nose
  lm[27] = P(0.48, 0.92); lm[28] = P(0.52, 0.93);   // ankles
  lm[31] = P(0.47, 0.96); lm[32] = P(0.53, 0.96);   // toes
  return Object.assign(lm, over);
};

ok(inShot(P(0.5, 0.5)), "the middle of the picture is in shot");
ok(!inShot(P(0.5, 1.04)), "below the bottom edge is not");
ok(!inShot(P(0.5, -0.2)), "above the top edge is not");
ok(!inShot(null), "a landmark the model never produced is not");
ok(!inShot(P(0.5, FRAME_MARGIN / 2)), "and the margin is respected at the edge");

ok(frameIssue(body()) === null, "a whole body in frame is no issue");
ok(frameIssue(body({ 27: P(0.48, 1.1), 28: P(0.52, 1.1), 31: P(0.47, 1.2), 32: P(0.53, 1.2) }))
   === "feet", "feet below the frame are called out");
ok(frameIssue(body({ 0: P(0.5, -0.1) })) === "head", "so is a head above it");
ok(frameIssue(body({ 0: P(0.5, -0.1), 27: P(0, 1.1), 28: P(0, 1.1), 31: P(0, 1.2), 32: P(0, 1.2) }))
   === "both", "and both at once");
ok(frameIssue(null) === null, "no body at all is not a framing problem");

/* Side on, the far leg hides behind the near one: one foot is enough. */
const oneFoot = body({ 28: P(9, 9), 32: P(9, 9) });
ok(frameIssue(oneFoot) === null, "one visible foot is enough, filmed side on");

/* Hysteresis: a warning that blinks on one bad frame teaches the athlete to
 * ignore it, so it has to hold before it shows and before it clears. */
const w = framingWatcher(5);
const bad = body({ 27: P(0, 1.1), 28: P(0, 1.1), 31: P(0, 1.2), 32: P(0, 1.2) });
ok(w.see(bad) === null, "one bad frame shows nothing");
ok(w.see(bad) === null && w.see(bad) === null && w.see(bad) === null, "nor do four");
ok(w.see(bad) === "feet", "the fifth in a row does");
ok(w.see(body()) === "feet", "and one good frame does not clear it");
w.see(body()); w.see(body()); w.see(body());
ok(w.shown === "feet", "nor do four");
ok(w.see(body()) === null, "the fifth good frame clears it");

const w2 = framingWatcher(3);
w2.see(bad); w2.see(bad); w2.see(bad);
ok(w2.shown === "feet", "the run length is configurable");
w2.reset();
ok(w2.shown === null, "and a reset forgets the last take");

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
