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
  const O = asObjects(body({ spread: 0.7 })), F = asObjects(body({ spread: 0.15 }));
  const step = (p, t) => { let f = false;
    for (let i = 0; i < 4; i++) f = g.see(p, t + i * 33) || f; return f; };
  let t = 4000;
  ok(step(O, t) === false, "object frames: open"); t += 200;
  ok(step(F, t) === false, "object frames: one fist is not the signal"); t += 200;
  ok(step(O, t) === false, "object frames: open again"); t += 200;
  ok(step(F, t) === true,
     "and two fists on object landmarks fires, exactly as on pairs");
}

const open = body({ spread: 0.7 }), fist = body({ spread: 0.15 });
const half = body({ spread: (OPEN_AT + CLOSED_AT) / 2 });

/* A state has to HOLD, so the tests feed frames the way a camera does: several
 * in a row saying the same thing. One frame no longer changes anything, which
 * is the entire point -- a single-frame crossing was the false trigger that
 * stopped recordings by itself. */
const HOLD = 4;                                    // comfortably over holdFrames
function feed(g, pose, t, n = HOLD, step = 33) {
  let fired = false;
  for (let i = 0; i < n; i++) fired = g.see(pose, t + i * step) || fired;
  return fired;
}

/* Two fists inside the window is the signal. */
{
  const g = gestureWatcher();
  const t0 = 100000;
  g.reset(t0 - 4000);                                   // cooldown long past
  ok(feed(g, open, t0) === false, "an open hand is not a signal");
  ok(feed(g, fist, t0 + 200) === false, "one fist is not a signal");
  ok(feed(g, open, t0 + 400) === false, "opening again is not a signal");
  ok(feed(g, fist, t0 + 600) === true, "the second fist is");
}

/* Slowly is not the signal: that is a person using their hands. */
{
  const g = gestureWatcher();
  const t0 = 200000;
  g.reset(t0 - 4000);
  feed(g, open, t0); feed(g, fist, t0 + 200);
  feed(g, open, t0 + 2000);
  ok(feed(g, fist, t0 + 2400) === false,
     "two fists two seconds apart do not fire");
}

/* Halfway between the thresholds is no state change, so a hand hovering there
 * cannot flicker its way to two clenches. */
{
  const g = gestureWatcher();
  const t0 = 300000;
  g.reset(t0 - 4000);
  let fired = false;
  feed(g, open, t0);
  for (let i = 1; i < 40; i++) fired = g.see(half, t0 + 200 + i * 30) || fired;
  ok(!fired, "a hand held between the thresholds never fires");
}

/* The fist that started a recording must not stop it. */
{
  const g = gestureWatcher();
  const t0 = 400000;
  g.reset(t0 - 4000);
  feed(g, open, t0); feed(g, fist, t0 + 200); feed(g, open, t0 + 400);
  ok(feed(g, fist, t0 + 600) === true, "the signal fires");
  feed(g, open, t0 + 800);
  ok(feed(g, fist, t0 + 1000) === false, "and cannot fire again during the cooldown");
  ok(feed(g, open, t0 + 4200) === false && feed(g, fist, t0 + 4400) === false,
     "one clench after the cooldown is still only one");
  feed(g, open, t0 + 4600);
  ok(feed(g, fist, t0 + 4800) === true, "two of them fire again");
}

/* A hand that leaves frame drops its state rather than counting as a fist:
 * landmarks collapse toward the wrist when the model loses them, which would
 * otherwise read as clenching. */
{
  const g = gestureWatcher();
  const t0 = 500000;
  g.reset(t0 - 4000);
  feed(g, open, t0);
  ok(feed(g, body({ visible: false }), t0 + 200) === false, "a vanished hand is not a fist");
  ok(feed(g, fist, t0 + 400) === false, "and does not leave half a signal behind");
}

/* Either hand can give it, and one hand hanging still does not cancel it. */
{
  const g = gestureWatcher();
  const t0 = 600000;
  g.reset(t0 - 4000);
  const both = (l, r) => Object.assign([], l, r);
  const lOpen = body({ spread: 0.6, side: "l" }), lFist = body({ spread: 0.15, side: "l" });
  const rRest = body({ spread: 0.5, side: "r" });
  feed(g, both(lOpen, rRest), t0);
  feed(g, both(lFist, rRest), t0 + 200);
  feed(g, both(lOpen, rRest), t0 + 400);
  ok(feed(g, both(lFist, rRest), t0 + 600) === true,
     "the left hand can signal while the right hand rests");
}

/* --- the three things that were firing it by accident --------------------- */

/* 1. A single-frame crossing. The model jitters; a hand does not open and
 *    shut inside 33 ms. */
{
  const g = gestureWatcher();
  const t0 = 700000;
  g.reset(t0 - 5000);
  let fired = false;
  feed(g, open, t0);
  // Alternating frames: noise, at the fastest rate a camera can produce it.
  for (let i = 0; i < 60; i++) {
    fired = g.see(i % 2 ? fist : open, t0 + 200 + i * 33) || fired;
  }
  ok(!fired, "a hand flickering every other frame is noise, not a signal");
}

/* 2. Two clenches on consecutive frames. Two deliberate fists take time. */
{
  const g = gestureWatcher();
  const t0 = 800000;
  g.reset(t0 - 5000);
  /* At 120 fps, where the frames are 8 ms apart: holding a state for three
   * frames takes 24 ms, so a flicker CAN produce two clenches inside a fifth
   * of a second. That is the case minGapMs exists for, and it is the case a
   * high-frame-rate phone actually produces. */
  const fast = (p, t) => feed(g, p, t, 4, 8);
  fast(open, t0);
  fast(fist, t0 + 40);
  fast(open, t0 + 80);
  ok(fast(fist, t0 + 120) === false,
     "two fists a few tens of milliseconds apart are one fist that flickered");
}

/* 3. Landmarks the model cannot actually see. This is the one that was ending
 *    takes: MediaPipe emits a point for a hand that is out of frame or behind
 *    the body, with a low visibility and violent jitter, and those points were
 *    being read as a hand. */
{
  const dim = (lm, v) => lm.map((p) => (p ? { x: p[0], y: p[1], visibility: v } : p));
  ok(handOpenness(dim(body({ spread: 0.7 }), 0.2), "r") === null,
     "landmarks below the visibility floor are not a hand");
  ok(handOpenness(dim(body({ spread: 0.7 }), 0.9), "r") != null,
     "and confident ones still are");
  const g = gestureWatcher();
  const t0 = 900000;
  g.reset(t0 - 5000);
  let fired = false;
  for (let i = 0; i < 60; i++) {
    fired = g.see(dim(i % 2 ? fist : open, 0.2), t0 + 200 + i * 33) || fired;
  }
  ok(!fired, "and a low-confidence hand cannot start or stop a recording");
}

/* The aspect ratio has to be applied, or a portrait phone measures a sideways
 * finger spread against an upright forearm in different units. */
{
  // A hand whose fingers fan out SIDEWAYS from an upright forearm -- which is
  // what a raised open hand looks like, and the case where separately
  // normalised axes distort the ratio.
  const lm = [];
  lm[14] = [500, 500]; lm[16] = [500, 600];          // elbow, wrist: vertical
  for (const t of [18, 20, 22]) lm[t] = [560, 600];  // tips: horizontal
  const a = handOpenness(lm, "r", 1), b = handOpenness(lm, "r", 0.5);
  ok(a != null && b != null && Math.abs(a - b) > 1e-6,
     "aspect changes a sideways spread against an upright forearm",
     `${a?.toFixed(3)} vs ${b?.toFixed(3)}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
