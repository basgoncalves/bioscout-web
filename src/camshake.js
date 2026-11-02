/**
 * Handheld video: estimating what the CAMERA did, so what the BODY did can be
 * read separately.
 *
 * With a phone on a tripod, a landmark that moves in the picture moved in the
 * room. Handheld, it may have done neither -- the camera panned. Everything
 * downstream that treats image motion as body motion is then wrong: travel
 * distance, jump height, bar path, the floor map, and any moment computed from
 * an acceleration. The pose model itself also suffers, because a body that
 * jumps across the frame between frames breaks the temporal tracking it uses
 * to stay locked on (the collapsed legs in a shaky clip).
 *
 * WHAT THIS DOES
 * Per frame, estimate the camera's own translation and zoom from the
 * BACKGROUND, then subtract it from the landmarks.
 *
 * The background is everything that is not the athlete, and the athlete's
 * position is already known from the landmarks -- so their bounding box, grown
 * by a margin, is masked out and the rest of the picture is matched against the
 * previous frame. Matching is a coarse-to-fine search over a small grayscale
 * thumbnail: cheap enough to run on every frame of a clip on a phone, and
 * blind to anything finer than the thumbnail's pixels, which is the point --
 * fine detail is where a moving background (a crowd, leaves) would mislead it.
 *
 * WHAT IT CANNOT DO
 * It recovers translation and zoom, not rotation or parallax. A camera that
 * swings around the athlete changes which side of them is visible, and no
 * 2D correction fixes that. The estimate is also relative: it says how the
 * camera moved between frames, never where it is in the room, so positions
 * stay relative to the first frame. Confidence is reported per frame, and a
 * stretch where the background offers nothing to match (a blank wall, a close
 * shot filling the frame) comes back low -- the caller is meant to say so
 * rather than quietly present a corrected number as a measured one.
 */

export const THUMB_W = 48, THUMB_H = 64;

/** Downsample an image source to a small grayscale thumbnail. */
export function grayThumb(src, cv, w = THUMB_W, h = THUMB_H) {
  cv.width = w; cv.height = h;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(src, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  return g;
}

/** Mean absolute difference between two thumbnails at offset (dx, dy), masked. */
function cost(a, b, dx, dy, mask, w, h) {
  let sum = 0, n = 0;
  for (let y = 0; y < h; y++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let x = 0; x < w; x++) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const i = y * w + x, j = yy * w + xx;
      if (mask[i] || mask[j]) continue;        // the athlete is not background
      sum += Math.abs(a[i] - b[j]); n++;
    }
  }
  return n > w * h * 0.15 ? sum / n : Infinity; // too little background to judge
}

/**
 * Camera motion between consecutive frames.
 *
 * step(thumb, bodyBox) -> { dx, dy, conf } in THUMBNAIL pixels, where dx/dy is
 * how far the camera moved (not the picture), and conf is 0-1.
 */
export function makeShakeTracker({ w = THUMB_W, h = THUMB_H, range = 6 } = {}) {
  let prev = null, prevMask = null;
  const mask = () => new Uint8Array(w * h);
  return {
    step(thumb, bodyBox) {
      const m = mask();
      if (bodyBox) {
        // Grow the body box by a fifth: the model's landmarks sit inside the
        // silhouette, and the edges of a person (hair, loose clothing) move
        // with them.
        const gx = (bodyBox.x1 - bodyBox.x0) * 0.2, gy = (bodyBox.y1 - bodyBox.y0) * 0.2;
        const x0 = Math.floor((bodyBox.x0 - gx) * w), x1 = Math.ceil((bodyBox.x1 + gx) * w);
        const y0 = Math.floor((bodyBox.y0 - gy) * h), y1 = Math.ceil((bodyBox.y1 + gy) * h);
        for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
          for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) m[y * w + x] = 1;
      }
      if (!prev) { prev = thumb; prevMask = m; return { dx: 0, dy: 0, conf: 0 }; }
      const both = new Uint8Array(w * h);
      for (let i = 0; i < both.length; i++) both[i] = prev[i] !== undefined && (prevMask[i] || m[i]) ? 1 : 0;
      let best = { dx: 0, dy: 0, c: Infinity }, second = Infinity;
      for (let dy = -range; dy <= range; dy++) {
        for (let dx = -range; dx <= range; dx++) {
          const c = cost(prev, thumb, dx, dy, both, w, h);
          if (c < best.c) { second = best.c; best = { dx, dy, c }; }
          else if (c < second) second = c;
        }
      }
      prev = thumb; prevMask = m;
      if (!Number.isFinite(best.c)) return { dx: 0, dy: 0, conf: 0 };
      /* Confidence is how much better the winner is than the runner-up: a
       * blank wall matches every offset equally well, and that must read as
       * "no idea", not as "no motion". */
      const conf = Number.isFinite(second) && second > 0
        ? Math.max(0, Math.min(1, (second - best.c) / (second + 1e-6) * 4)) : 0;
      // The picture shifted by (dx, dy), so the camera moved the other way.
      return { dx: -best.dx || 0, dy: -best.dy || 0, conf };
    },
    reset() { prev = null; prevMask = null; },
  };
}

/** The athlete's bounding box in 0-1 image coordinates, from named landmarks. */
export function bodyBox(named, w, h) {
  const pts = named ? Object.values(named) : [];
  if (pts.length < 6) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0: x0 / w, x1: x1 / w, y0: y0 / h, y1: y1 / h };
}

/**
 * Turn per-frame camera steps into a cumulative offset in FULL-FRAME pixels,
 * and subtract it from every landmark.
 *
 * Steps with low confidence contribute nothing rather than a guess, so a
 * stretch the tracker could not read leaves the correction where it was
 * instead of drifting. The result carries the fraction of frames that were
 * readable, for the caller to show.
 */
export function stabilise(frames, steps, { frameW, frameH, w = THUMB_W, h = THUMB_H, minConf = 0.08 } = {}) {
  const sx = frameW / w, sy = frameH / h;
  let cx = 0, cy = 0, good = 0;
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const st = steps[i];
    if (st && st.conf >= minConf) { cx += st.dx * sx; cy += st.dy * sy; good++; }
    const lm = {};
    for (const [k, p] of Object.entries(frames[i].lm || {})) lm[k] = [p[0] - cx, p[1] - cy, p[2]];
    out.push({ ...frames[i], lm, cam: { x: cx, y: cy, conf: st ? st.conf : 0 } });
  }
  return { frames: out, readable: frames.length ? good / frames.length : 0 };
}
