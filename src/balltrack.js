/**
 * balltrack.js -- finding a tennis or padel ball in the camera picture, and
 * what can honestly be said about it afterwards.
 *
 * There is no ball model here. A ball is the one small thing in the picture
 * that is optic yellow AND moved since the last frame AND is not part of the
 * player, and that is all the tracker looks for: colour, frame difference,
 * and the pose model's own box around the body to leave out. It needs a fixed
 * phone and a ball that stands out from what is behind it; it will lose a
 * ball against yellow leaves, in deep shade, or when it is two pixels wide at
 * the far end of a court. Every number below says how it was got.
 *
 * Two speeds, and they are not the same quantity:
 *
 *   tof     distance to the wall divided by the time from the hit to the ball
 *           turning round. A real average speed over the outbound flight --
 *           it needs the distance typed in, and wall practice.
 *   plane   how fast the ball crossed the picture just after the hit, scaled
 *           by the player's own pixels-per-metre. Right for a ball travelling
 *           across the picture, an underestimate for one travelling away from
 *           the camera, and never better than the frame rate allows.
 *
 * Placement is where the outbound track ends -- the point the ball turned
 * round -- as a fraction of the picture. On a wall filmed from behind or the
 * side that is where it hit the wall.
 *
 * Pure: frames in, numbers out. tests/test_balltrack.mjs feeds it synthetic
 * pictures.
 */
const CELL = 8;

/** Optic yellow, including one smeared by motion or dulled by shade: red and
 *  green both up, green at least level with red, blue well under both. Skin,
 *  clay and concrete all fail the green-over-red or the blue test. */
export function isBallColour(r, g, b) {
  return r > 90 && g > 100 && g >= 0.9 * r && b < 0.72 * Math.min(r, g)
      && Math.abs(r - g) < 0.45 * Math.max(r, g);
}

/**
 * A tracker for one take. push() one downscaled RGBA frame at a time, in
 * order; each call returns the ball found in it or null and appends to
 * `.track` ({ t, x, y, n }: time in ms, centre as a fraction of the frame,
 * pixels in the blob).
 */
export function makeBallTracker({ minDiff = 22, minPix = 3, maxPix = 500 } = {}) {
  let prev = null, pw = 0, ph = 0;
  const track = [];
  return {
    track,
    reset() { prev = null; track.length = 0; },
    /** `box`: the player, { x0, y0, x1, y1 } in frame fractions, or null. */
    push(rgba, w, h, t, box = null) {
      const first = !prev || pw !== w || ph !== h;
      if (first) { prev = new Uint8Array(w * h); pw = w; ph = h; }
      const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
      const cnt = new Uint32Array(cw * ch), sx = new Float32Array(cw * ch), sy = new Float32Array(cw * ch);
      const bx0 = box ? box.x0 * w : -1, bx1 = box ? box.x1 * w : -1;
      const by0 = box ? box.y0 * h : -1, by1 = box ? box.y1 * h : -1;
      for (let y = 0, k = 0, q = 0; y < h; y++) {
        const inRow = box && y >= by0 && y <= by1;
        for (let x = 0; x < w; x++, k++, q += 4) {
          const r = rgba[q], g = rgba[q + 1], b = rgba[q + 2];
          const L = (r * 77 + g * 150 + b * 29) >> 8;
          const d = L > prev[k] ? L - prev[k] : prev[k] - L;
          prev[k] = L;
          if (first || d < minDiff) continue;
          if (inRow && x >= bx0 && x <= bx1) continue;
          if (!isBallColour(r, g, b)) continue;
          const c = (y / CELL | 0) * cw + (x / CELL | 0);
          cnt[c]++; sx[c] += x; sy[c] += y;
        }
      }
      if (first) return null;
      // The busiest 3x3 block of cells: a ball straddles cell edges.
      let best = 0, bi = -1;
      for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        if (!cnt[cy * cw + cx]) continue;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = cy + dy, xx = cx + dx;
          if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) s += cnt[yy * cw + xx];
        }
        if (s > best) { best = s; bi = cy * cw + cx; }
      }
      if (bi < 0 || best < minPix || best > maxPix) return null;
      const cy = (bi / cw) | 0, cx = bi % cw;
      let n = 0, X = 0, Y = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = cy + dy, xx = cx + dx;
        if (yy < 0 || yy >= ch || xx < 0 || xx >= cw) continue;
        const c = yy * cw + xx;
        n += cnt[c]; X += sx[c]; Y += sy[c];
      }
      const hit = { t, x: X / n / w, y: Y / n / h, n };
      track.push(hit);
      return hit;
    },
  };
}

/** The player's box from named landmarks ({ name: [x, y] } in video pixels),
 *  as frame fractions, grown a little: the racket hand's blur, loose clothing. */
export function bodyBox(lm, w, h, grow = 0.12) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of Object.values(lm || {})) {
    if (!p) continue;
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  if (!Number.isFinite(x0)) return null;
  const gx = (x1 - x0) * grow, gy = (y1 - y0) * grow;
  return { x0: (x0 - gx) / w, y0: (y0 - gy) / h, x1: (x1 + gx) / w, y1: (y1 + gy) / h };
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

/**
 * The ball after each stroke.
 *
 * `contacts`: the time of each hit in ms, on the track's clock, in order.
 * `w`, `h`: the video's size in pixels (the track is in fractions of it).
 * `pxPerM`: the player's scale. `wallM`: distance from player to wall, if known.
 * Returns one entry per contact: { speed_ms, method, impact: {x, y} | null,
 * points } -- speed_ms null when the ball was not followed well enough.
 */
export function ballAfterStrokes(track, contacts, { w, h, pxPerM = 0, wallM = null,
                                                    maxWindowS = 3, maxWidthsPerS = 4 } = {}) {
  return contacts.map((tc, k) => {
    const out = { speed_ms: null, method: null, impact: null, points: 0 };
    if (!Number.isFinite(tc)) return out;
    const next = contacts[k + 1];
    const until = Math.min(Number.isFinite(next) ? next - 80 : Infinity, tc + maxWindowS * 1000);
    const pts = track.filter((p) => p.t > tc - 40 && p.t < until);
    // One ball, one path: drop a detection that would need the ball to cross
    // the picture faster than any ball does.
    const chain = [];
    for (const p of pts) {
      const q = chain[chain.length - 1];
      if (q) {
        const dt = (p.t - q.t) / 1000;
        if (dt <= 0) continue;
        if (Math.hypot(p.x - q.x, (p.y - q.y) * (h / w)) / dt > maxWidthsPerS) continue;
      }
      chain.push(p);
    }
    out.points = chain.length;
    if (chain.length < 3) return out;
    // Outbound: for as long as the ball keeps going the way it set off.
    const a = chain[0], ref = chain[Math.min(3, chain.length - 1)];
    const dx = (ref.x - a.x) * w, dy = (ref.y - a.y) * h, dn = Math.hypot(dx, dy) || 1;
    let end = chain.length - 1, back = 0, turned = false;
    for (let i = 1; i < chain.length; i++) {
      const sx = (chain[i].x - chain[i - 1].x) * w, sy = (chain[i].y - chain[i - 1].y) * h;
      if ((sx * dx + sy * dy) / dn < 0) { if (++back >= 2) { end = i - 2; turned = true; break; } }
      else back = 0;
    }
    if (end < 2) return out;
    const leg = chain.slice(0, end + 1);
    if (turned) out.impact = { x: +leg[end].x.toFixed(4), y: +leg[end].y.toFixed(4) };
    const flight = (leg[end].t - tc) / 1000;
    if (turned && wallM > 0 && flight >= 0.08) {
      out.speed_ms = +(wallM / flight).toFixed(2);
      out.method = "tof";
    } else if (pxPerM > 0) {
      const steps = [];
      for (let i = 1; i < Math.min(leg.length, 6); i++) {
        const dt = (leg[i].t - leg[i - 1].t) / 1000;
        if (dt > 0) steps.push(Math.hypot((leg[i].x - leg[i - 1].x) * w, (leg[i].y - leg[i - 1].y) * h) / dt);
      }
      if (steps.length >= 2) { out.speed_ms = +(median(steps) / pxPerM).toFixed(2); out.method = "plane"; }
    }
    // Faster than any racket sport's ball: a mistrack, not a measurement.
    if (out.speed_ms != null && !(out.speed_ms > 0.5 && out.speed_ms < 75)) { out.speed_ms = null; out.method = null; }
    return out;
  });
}

/** The tiles above the stroke table. Means are over the strokes that have the
 *  number; `n*` say how many that was. */
export function strokeSummary(reps) {
  const live = reps.filter((r) => !r.removed);
  const count = (t) => live.filter((r) => r.stroke_type === t).length;
  const nums = (k) => live.map((r) => r[k]).filter((v) => typeof v === "number" && Number.isFinite(v));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const ball = nums("ball_speed_ms"), hand = nums("hand_speed_ms");
  const of = (t) => mean(live.filter((r) => r.stroke_type === t).map((r) => r.ball_speed_ms ?? null)
                             .filter((v) => v != null));
  return {
    strokes: live.length, forehand: count("forehand"), backhand: count("backhand"),
    overhead: count("overhead"), unnamed: live.filter((r) => !r.stroke_type).length,
    ball_mean_ms: mean(ball), ball_peak_ms: ball.length ? Math.max(...ball) : null, nBall: ball.length,
    ball_forehand_ms: of("forehand"), ball_backhand_ms: of("backhand"),
    hand_mean_ms: mean(hand), hand_peak_ms: hand.length ? Math.max(...hand) : null,
    methods: [...new Set(live.map((r) => r.ball_method).filter(Boolean))],
  };
}
