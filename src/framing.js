/**
 * framing.js -- is the body actually inside the picture?
 *
 * The pose model reports a position for a landmark that has left the frame:
 * it extrapolates rather than admitting it cannot see, and that guess drifts.
 * A jump is measured entirely from the feet, so feet that wander out of shot
 * are the difference between a jump height and a refusal -- and the athlete
 * finds out only after the take, having already done the jumps.
 *
 * This says so while there is still time to step back. It is deliberately not
 * the same check as the one the analysis runs afterwards: that one judges a
 * whole clip and can afford to be exact, this one judges the live frame and
 * has to be stable enough to read.
 */

/* Normalised coordinates run 0..1 across the picture and leave that range
 * exactly when the model is guessing. A couple of percent of margin keeps a
 * foot resting on the very bottom edge from counting as lost. */
export const FRAME_MARGIN = 0.02;

export const inShot = (p) => !!p && p.y > FRAME_MARGIN && p.y < 1 - FRAME_MARGIN
                             && p.x > -FRAME_MARGIN && p.x < 1 + FRAME_MARGIN;

/* MediaPipe indices: 27/28 ankles, 31/32 toes, 0 nose. */
const FOOT = [27, 28, 31, 32], HEAD = 0;

/** What is out of shot in THIS frame, ignoring how long it has been so. */
export function frameIssue(lm) {
  if (!lm) return null;
  // One foot is enough: filmed side on, the far leg is regularly hidden
  // behind the near one, and calling that "out of shot" would cry wolf.
  const feet = FOOT.some((i) => inShot(lm[i]));
  const head = inShot(lm[HEAD]);
  return !feet && !head ? "both" : !feet ? "feet" : !head ? "head" : null;
}

/**
 * The same judgement, held steady over time.
 *
 * Landmarks jitter, and a warning that blinks on one bad frame is noise rather
 * than a warning -- the athlete learns to ignore it, which is worse than not
 * showing it. A state has to hold for `frames` frames running before it is
 * shown, in both directions, so the pill appears once and stays put.
 */
export function framingWatcher(frames = 5) {
  let bad = 0, good = 0, shown = null;
  return {
    /** Feed one frame's landmarks; returns what to show, or null. */
    see(lm) {
      const now = frameIssue(lm);
      if (now) { bad++; good = 0; } else { good++; bad = 0; }
      if (bad >= frames) shown = now;
      if (good >= frames) shown = null;
      return shown;
    },
    /** Between takes, so a new recording does not inherit the last one. */
    reset() { bad = 0; good = 0; shown = null; },
    get shown() { return shown; },
  };
}
