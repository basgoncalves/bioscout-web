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

/* Landmarks arrive from MediaPipe as {x, y} objects and from the tests as
 * [x, y] pairs. Both are read here.
 *
 * This is not tidiness. The watcher was written against pairs, the tests fed
 * it pairs, the tests passed -- and the live camera hands it objects, where
 * a[0] is undefined, every distance is NaN, and the watcher silently never
 * fires. The feature looked finished and did nothing. Reading both shapes is
 * what makes the passing test mean the live path works. */
const px = (p) => (Array.isArray(p) ? p[0] : p && p.x);
const py = (p) => (Array.isArray(p) ? p[1] : p && p.y);

/* Confidence, where the source has it.
 *
 * The live camera hands this the model's RAW landmarks, and the model emits a
 * point for every joint whether or not it can see one -- a hand out of frame or
 * behind the body still gets coordinates, with a low visibility and violent
 * frame-to-frame jitter. Those points were being read as a hand: the openness
 * ratio swung across both thresholds within a few frames, that read as two
 * clenches, and the recording started or stopped by itself. Anything the model
 * is not reasonably sure it can see is not a hand for this purpose.
 *
 * 0.6 rather than the 0.3 used for drawing a skeleton: a wrong bone on the
 * overlay is cosmetic, a wrong gesture ends the take. */
export const MIN_VISIBILITY = 0.6;
const seen = (p) => !!p && (Array.isArray(p) ? true
  : (p.visibility == null || p.visibility >= MIN_VISIBILITY));

const dist = (a, b, aspect = 1) => {
  if (!a || !b) return NaN;
  const dx = (px(a) - px(b)) * aspect, dy = py(a) - py(b);
  return Number.isFinite(dx) && Number.isFinite(dy) ? Math.hypot(dx, dy) : NaN;
};

/**
 * How open a hand is, as a fraction of the forearm.
 *
 * The forearm is the scale rather than the torso or the image, because it is
 * the segment nearest the hand and so shrinks with it as the athlete walks
 * away from the camera. Distance to the phone then cancels, which is the whole
 * point: the same gesture has to read the same at one metre and at five.
 */
export function handOpenness(lm, side, aspect = 1) {
  const H = HAND[side];
  if (!lm || !H) return null;
  const wrist = lm[H.wrist], elbow = lm[H.elbow];
  if (!seen(wrist) || !seen(elbow)) return null;
  const forearm = dist(wrist, elbow, aspect);
  if (!(forearm > 1e-6)) return null;
  /* At least two of the three tips. One point is not a hand shape: with a
   * single tip visible the "average spread" is that one point's distance, and
   * whichever finger the model happened to keep decides whether the hand is
   * open. */
  const spread = H.tips.filter((i) => seen(lm[i]))
    .map((i) => dist(wrist, lm[i], aspect))
    .filter((d) => Number.isFinite(d));
  if (spread.length < 2) return null;
  return (spread.reduce((a, b) => a + b, 0) / spread.length) / forearm;
}

/* Open and closed, with a gap between them nothing is called.
 *
 * A single threshold makes the hand flicker between states while it is halfway,
 * and a flicker is two clenches, which is the signal. The gap is where the
 * state simply does not change. */
export const OPEN_AT = 0.46;
export const CLOSED_AT = 0.26;

export const DEFAULT_GESTURE_CFG = {
  // Both fists have to land inside this. Slower than this is a person moving
  // their hands, not signalling.
  windowMs: 1800,
  // Nothing is read for this long after a trigger. Without it the fist that
  // started a recording is still in the buffer to stop it.
  cooldownMs: 3000,
  clenches: 2,
  /* A state must HOLD before it counts.
   *
   * A hand crossing a threshold on one frame and back on the next is noise;
   * a hand that is open, or shut, for three frames running is a hand. Without
   * this the whole signal is decided by single frames, which is where the
   * false triggers came from -- and three frames is 100 ms at 30 fps, far
   * shorter than any gesture a person can actually make.
   */
  holdFrames: 3,
  /* And the two fists cannot be adjacent frames.
   *
   * A person opening and shutting their hand twice takes at least a fifth of a
   * second between the two. Two clenches closer together than this are one
   * clench that flickered, and reading them as the signal is how a recording
   * stopped itself the instant it started.
   */
  minGapMs: 180,
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
  const blank = () => ({ open: null, at: [], pending: null, run: 0 });
  const state = { l: blank(), r: blank() };
  let until = 0;                       // cooldown expiry

  return {
    /**
     * Feed a frame. Returns true on the frame the signal completes.
     *
     * `aspect` scales x before distances are taken. The live camera hands over
     * landmarks normalised separately by width and height, so on a portrait
     * phone a horizontal finger spread and a vertical forearm are measured in
     * different units and their ratio is not the openness of anything.
     */
    see(lm, now = Date.now(), aspect = 1) {
      if (now < until) return false;
      let fired = false;
      for (const side of ["l", "r"]) {
        const v = handOpenness(lm, side, aspect);
        const s = state[side];
        if (v == null) { s.open = null; s.pending = null; s.run = 0; continue; }
        // What this frame says, if anything. Between the thresholds it says
        // nothing, deliberately.
        const says = v >= OPEN_AT ? true : v <= CLOSED_AT ? false : null;
        if (says === null) { s.pending = null; s.run = 0; continue; }
        if (says === s.pending) s.run++;
        else { s.pending = says; s.run = 1; }
        if (s.run < conf.holdFrames) continue;      // not held long enough yet
        const wasOpen = s.open;
        s.open = says;
        if (wasOpen === true && s.open === false) {
          const lastAt = s.at.length ? s.at[s.at.length - 1] : -Infinity;
          if (now - lastAt < conf.minGapMs) continue;   // one flicker, not two
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
        state.l = blank(); state.r = blank();
      }
      return fired;
    },
    /** Start of a take, or when the toggle is switched on. */
    reset(now = Date.now()) {
      state.l = blank();
      state.r = blank();
      until = now + conf.cooldownMs;
    },
    get armed() { return Date.now() >= until; },
  };
}
