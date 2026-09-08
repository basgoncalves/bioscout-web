/**
 * gesture.js -- starting and stopping a recording from across the room.
 *
 * The athlete sets the phone up four metres away, presses record, walks to
 * their mark, does the test, walks back. The walk back is in the recording and
 * the walk out is too, and for a test that stops itself on a count that is
 * merely untidy -- but for anything they stop by hand it means the clip is
 * bracketed by them fetching the phone. Two quick fists is the signal to start
 * or stop instead.
 *
 * WHAT THIS CAN SEE. The pose model is not a hand model: there are four points
 * on each hand -- wrist, index, pinky, thumb -- and no fingers. So "open" and
 * "closed" here means how far those three sit from the wrist, scaled by the
 * forearm, and nothing finer. A fist and a pinch look alike to it. That is
 * enough for a deliberate signal and nowhere near enough for hand tracking,
 * and the thresholds below are set for the first job only.
 *
 * WHY TWO. One fist happens by accident -- carrying something, scratching,
 * the hand simply leaving frame and the points collapsing. Two inside a short
 * window is a thing a person does on purpose. The window is deliberately
 * short for the same reason.
 */

/* Wrist, and the three points that fan out from it, per side. */
const HAND = {
  l: { wrist: 15, elbow: 13, tips: [17, 19, 21] },
  r: { wrist: 16, elbow: 14, tips: [18, 20, 22] },
};

const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : NaN);

/**
 * How open a hand is, as a fraction of the forearm.
 *
 * The forearm is the scale rather than the torso or the image, because it is
 * the segment nearest the hand and so shrinks with it as the athlete walks
 * away from the camera. Distance to the phone then cancels, which is the whole
 * point: the same gesture has to read the same at one metre and at five.
 */
export function handOpenness(lm, side) {
  const H = HAND[side];
  if (!lm || !H) return null;
  const wrist = lm[H.wrist], elbow = lm[H.elbow];
  const forearm = dist(wrist, elbow);
  if (!(forearm > 1e-6)) return null;
  const spread = H.tips.map((i) => dist(wrist, lm[i])).filter((d) => Number.isFinite(d));
  if (!spread.length) return null;
  return (spread.reduce((a, b) => a + b, 0) / spread.length) / forearm;
}

/* Open and closed, with a gap between them nothing is called.
 *
 * A single threshold makes the hand flicker between states while it is halfway,
 * and a flicker is two clenches, which is the signal. The gap is where the
 * state simply does not change. */
export const OPEN_AT = 0.42;
export const CLOSED_AT = 0.30;

export const DEFAULT_GESTURE_CFG = {
  // Both fists have to land inside this. Slower than this is a person moving
  // their hands, not signalling.
  windowMs: 1800,
  // Nothing is read for this long after a trigger. Without it the fist that
  // started a recording is still in the buffer to stop it.
  cooldownMs: 3000,
  clenches: 2,
};

/**
 * Watches one stream of landmarks and calls back on the signal.
 *
 * Either hand can give it, and the two are watched separately rather than
 * averaged: signalling with one hand while the other hangs at your side is the
 * normal way to do this, and an average of the two would never cross either
 * threshold.
 */
export function gestureWatcher(cfg = DEFAULT_GESTURE_CFG) {
  const conf = { ...DEFAULT_GESTURE_CFG, ...cfg };
  const state = { l: { open: null, at: [] }, r: { open: null, at: [] } };
  let until = 0;                       // cooldown expiry

  return {
    /** Feed a frame. Returns true on the frame the signal completes. */
    see(lm, now = Date.now()) {
      if (now < until) return false;
      let fired = false;
      for (const side of ["l", "r"]) {
        const v = handOpenness(lm, side);
        const s = state[side];
        if (v == null) { s.open = null; continue; }   // hand not visible: no state
        const wasOpen = s.open;
        if (v >= OPEN_AT) s.open = true;
        else if (v <= CLOSED_AT) s.open = false;
        // Between the thresholds nothing changes, deliberately.
        if (wasOpen === true && s.open === false) {
          s.at.push(now);
          s.at = s.at.filter((t) => now - t <= conf.windowMs);
          if (s.at.length >= conf.clenches) {
            s.at = [];
            fired = true;
          }
        }
      }
      if (fired) {
        until = now + conf.cooldownMs;
        state.l.at = []; state.r.at = [];
      }
      return fired;
    },
    /** Start of a take, or when the toggle is switched on. */
    reset(now = Date.now()) {
      state.l = { open: null, at: [] };
      state.r = { open: null, at: [] };
      until = now + conf.cooldownMs;
    },
    get armed() { return Date.now() >= until; },
  };
}
