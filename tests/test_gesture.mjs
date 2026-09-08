/**
 * The two-fist gesture that starts and stops a recording.
 *
 * Most of these checks are about NOT firing. A false positive mid-test stops
 * the recording the athlete is in the middle of, four metres from the phone,
 * and they find out when they walk back -- which is worse than the gesture
 * simply not existing.
 *
 *   node tests/test_gesture.mjs
 */
import { handOpenness, gestureWatcher, OPEN_AT, CLOSED_AT } from "../src/gesture.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

/* A body with one arm, at a given hand spread and a given distance from the
 * camera. `scale` shrinks everything, as walking away does. */
function body({ spread = 0.5, scale = 1, side = "r", visible = true } = {}) {
  const lm = [];
  const F = 100 * scale;                       // forearm in pixels
  const idx = side === "r" ? { w: 16, e: 14, t: [18, 20, 22] }
                           : { w: 15, e: 13, t: [17, 19, 21] };
  lm[idx.e] = [500, 500];
  lm[idx.w] = [500, 500 + F];
  if (visible) for (const t of idx.t) lm[t] = [500, 500 + F + spread * F];
  return lm;
}

ok(Math.abs(handOpenness(body({ spread: 0.5 }), "r") - 0.5) < 1e-9,
   "openness is the fingertip spread as a fraction of the forearm");
ok(Math.abs(handOpenness(body({ spread: 0.5, scale: 0.3 }), "r") - 0.5) < 1e-9,
   "and does not change when the athlete walks away from the camera");
ok(handOpenness(body({ visible: false }), "r") === null,
   "a hand with no points is null, not a fist");
ok(handOpenness(null, "r") === null, "and no body at all is null");

/* The shape the CAMERA hands it.
 *
 * MediaPipe emits {x, y} objects; every test above feeds [x, y] pairs. For one
 * build the watcher read only pairs, so all of the above passed and the live
 * gesture never once fired -- the distances were NaN and the watcher declined
 * silently, which is indistinguishable from an athlete not signalling. This
 * check is the one that would have caught it. */
const asObjects = (lm) => lm.map((p) => (p ? { x: p[0], y: p[1] } : p));
ok(Math.abs(handOpenness(asObjects(body({ spread: 0.5 })), "r") - 0.5) < 1e-9,
   "openness reads MediaPipe's {x,y} landmarks, not just [x,y] pairs");
{
  const g = gestureWatcher();
  g.reset(0);
  const t = 4000;
  ok(g.see(asObjects(body({ spread: 0.6 })), t) === false, "object frames: open");
  ok(g.see(asObjects(body({ spread: 0.15 })), t + 100) === false, "object frames: one fist is not the signal");
  ok(g.see(asObjects(body({ spread: 0.6 })), t + 200) === false, "object frames: open again");
  ok(g.see(asObjects(body({ spread: 0.15 })), t + 300) === true,
     "and two fists on object landmarks fires, exactly as on pairs");
}

const open = body({ spread: 0.6 }), fist = body({ spread: 0.15 });
const half = body({ spread: (OPEN_AT + CLOSED_AT) / 2 });

/* Two fists inside the window is the signal. */
{
  const g = gestureWatcher();
  const t0 = 100000;
  g.reset(t0 - 4000);                                   // cooldown long past
  ok(g.see(open, t0) === false, "an open hand is not a signal");
  ok(g.see(fist, t0 + 200) === false, "one fist is not a signal");
  ok(g.see(open, t0 + 400) === false, "opening again is not a signal");
  ok(g.see(fist, t0 + 600) === true, "the second fist is");
}

/* Slowly is not the signal: that is a person using their hands. */
{
  const g = gestureWatcher();
  const t0 = 200000;
  g.reset(t0 - 4000);
  g.see(open, t0); g.see(fist, t0 + 100);
  g.see(open, t0 + 2000);
  ok(g.see(fist, t0 + 2400) === false,
     "two fists two seconds apart do not fire");
}

/* Halfway between the thresholds is no state change, so a hand hovering there
 * cannot flicker its way to two clenches. */
{
  const g = gestureWatcher();
  const t0 = 300000;
  g.reset(t0 - 4000);
  let fired = false;
  g.see(open, t0);
  for (let i = 1; i < 40; i++) fired = g.see(half, t0 + i * 30) || fired;
  ok(!fired, "a hand held between the thresholds never fires");
}

/* The fist that started a recording must not stop it. */
{
  const g = gestureWatcher();
  const t0 = 400000;
  g.reset(t0 - 4000);
  g.see(open, t0); g.see(fist, t0 + 100); g.see(open, t0 + 200);
  ok(g.see(fist, t0 + 300) === true, "the signal fires");
  g.see(open, t0 + 400);
  ok(g.see(fist, t0 + 500) === false, "and cannot fire again during the cooldown");
  ok(g.see(open, t0 + 3400) === false && g.see(fist, t0 + 3500) === false,
     "one clench after the cooldown is still only one");
  g.see(open, t0 + 3600);
  ok(g.see(fist, t0 + 3700) === true, "two of them fire again");
}

/* A hand that leaves frame drops its state rather than counting as a fist:
 * landmarks collapse toward the wrist when the model loses them, which would
 * otherwise read as clenching. */
{
  const g = gestureWatcher();
  const t0 = 500000;
  g.reset(t0 - 4000);
  g.see(open, t0);
  ok(g.see(body({ visible: false }), t0 + 100) === false, "a vanished hand is not a fist");
  ok(g.see(fist, t0 + 200) === false, "and does not leave half a signal behind");
}

/* Either hand can give it, and one hand hanging still does not cancel it. */
{
  const g = gestureWatcher();
  const t0 = 600000;
  g.reset(t0 - 4000);
  const both = (l, r) => Object.assign([], l, r);
  const lOpen = body({ spread: 0.6, side: "l" }), lFist = body({ spread: 0.15, side: "l" });
  const rRest = body({ spread: 0.5, side: "r" });
  g.see(both(lOpen, rRest), t0);
  g.see(both(lFist, rRest), t0 + 100);
  g.see(both(lOpen, rRest), t0 + 200);
  ok(g.see(both(lFist, rRest), t0 + 300) === true,
     "the left hand can signal while the right hand rests");
}

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
