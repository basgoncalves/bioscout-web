/**
 * multiplayer.js -- up to four players in one camera picture (padel, tennis).
 *
 * The pose model is asked for up to four bodies per frame. It returns them in
 * no fixed order, so this module keeps each one's identity from frame to frame:
 * a body is matched to the player whose feet were nearest a moment ago (greedy,
 * closest pair first, gated), a new body takes the lowest free number, and a
 * player not seen for LOST_MS gives the number back.
 *
 * Per player it keeps:
 *   - time tracked, distance covered, mean and top speed, number of sprints
 *     (feet moving faster than SPRINT_MS for at least SPRINT_MIN_S)
 *   - strokes: peaks of the faster wrist's speed, in body heights per second,
 *     at least STROKE_GAP_S apart; forehand vs backhand from whether the
 *     hitting wrist is on its own side of the body or across it at the peak
 *   - where on the picture the feet were (a coarse 3 x 3 grid of time shares)
 *
 * Scale is per player: metres per pixel from that player's own height in the
 * picture (nose to ankles) and an assumed standing height. That copes with near
 * and far players, but a single camera still cannot see movement toward or
 * away from it: distances and speeds are approximate and read low for running
 * along the line of sight. They are for comparing players in the same clip.
 */
export const MAX_PLAYERS = 4;
export const PLAYER_COLOURS = ["#5b93f5", "#f2a33a", "#3cc48a", "#e0567a"];
const LOST_MS = 2000, GATE = 0.25;
const SPRINT_MS = 4.0, SPRINT_MIN_S = 0.5;
const STROKE_THR = 3.0, STROKE_GAP_S = 0.6;
const NOSE = 0, LS = 11, RS = 12, LW = 15, RW = 16, LH = 23, RH = 24, LA = 27, RA = 28;

const vis = (p) => p && (p.visibility ?? 1) >= 0.3;
function feet(lm) {
  const a = [LA, RA].map((i) => lm[i]).filter(vis);
  const src = a.length ? a : [LH, RH].map((i) => lm[i]).filter(vis);
  if (!src.length) return null;
  return { x: src.reduce((s, p) => s + p.x, 0) / src.length, y: src.reduce((s, p) => s + p.y, 0) / src.length };
}
/** Whether a detected "body" is shaped like a standing or moving person.
 *  On broadcast and screen-recorded clips the model also finds bodies in
 *  logos, score boxes and player graphics (Bas's padel clip: a skeleton on the
 *  energy-drink logo in the corner). Those are small or stacked wrong. */
export function plausibleBody(lm, w, h) {
  const y = (i) => (vis(lm[i]) ? lm[i].y * h : null), x = (i) => lm[i].x * w;
  const sh = [LS, RS].map(y).filter((v) => v != null), hp = [LH, RH].map(y).filter((v) => v != null);
  const an = [LA, RA].map(y).filter((v) => v != null);
  if (!sh.length || !hp.length) return false;
  const shY = sh.reduce((a, b) => a + b) / sh.length, hpY = hp.reduce((a, b) => a + b) / hp.length;
  const torso = hpY - shY;
  if (torso < h * 0.03) return false;                       // tiny or upside down
  if (vis(lm[NOSE]) && y(NOSE) > shY) return false;          // head below the shoulders
  if (an.length) {
    const leg = an.reduce((a, b) => a + b) / an.length - hpY;
    if (leg < torso * 0.5 || leg > torso * 3) return false;  // legs no person has
  }
  const shW = vis(lm[LS]) && vis(lm[RS]) ? Math.abs(x(LS) - x(RS)) : 0;
  if (shW > torso * 2.5) return false;
  const key = [NOSE, LS, RS, LH, RH, LA, RA].map((i) => lm[i]?.visibility ?? 1);
  return key.reduce((a, b) => a + b) / key.length >= 0.5;
}

/** Body height in pixels: nose to ankle midpoint, plus the head above the nose. */
function bodyPx(lm, w, h) {
  const f = feet(lm), n = lm[NOSE];
  if (!f || !vis(n)) return null;
  const d = Math.hypot((f.x - n.x) * w, (f.y - n.y) * h) * 1.12;
  return d > 20 ? d : null;
}

function newPlayer(id) {
  return { id, colour: PLAYER_COLOURS[id - 1], last: null, lastT: null, seen: 0, firstT: null,
    lm: null, mPerPx: null, pos: null, vel: 0, dist: 0, vmax: 0, tTracked: 0,
    fastFor: 0, sprints: 0, strokes: 0, fore: 0, back: 0, hmax: 0, lastStroke: -1e9,
    prevW: null, prevWT: null, wPeak: null, grid: new Array(9).fill(0), hand: { l: 0, r: 0 } };
}

export function createMultiTracker({ heightM = 1.75 } = {}) {
  let players = [];
  const free = () => { for (let i = 1; i <= MAX_PLAYERS; i++) if (!players.some((p) => p.id === i)) return i; return null; };

  /** One frame: `list` is the model's landmarks array (normalised), t in ms. */
  function update(list, t, w, h) {
    players = players.filter((p) => t - p.lastT <= LOST_MS);
    const bodies = (list || []).filter((lm) => plausibleBody(lm, w, h)).map((lm) => ({ lm, f: feet(lm) })).filter((b) => b.f);
    const pairs = [];
    bodies.forEach((b, bi) => players.forEach((p, pi) => {
      const d = Math.hypot(b.f.x - p.last.x, b.f.y - p.last.y);
      if (d < GATE) pairs.push({ d, bi, pi });
    }));
    pairs.sort((a, b) => a.d - b.d);
    const usedB = new Set(), usedP = new Set(), matched = [];
    for (const q of pairs) {
      if (usedB.has(q.bi) || usedP.has(q.pi)) continue;
      usedB.add(q.bi); usedP.add(q.pi); matched.push([players[q.pi], bodies[q.bi]]);
    }
    bodies.forEach((b, bi) => {
      if (usedB.has(bi)) return;
      const id = free(); if (id == null) return;
      const p = newPlayer(id); players.push(p); matched.push([p, b]);
    });
    for (const [p, b] of matched) step(p, b, t, w, h);
    players.sort((a, b) => a.id - b.id);
    return players.filter((p) => p.lastT === t);
  }

  function step(p, b, t, w, h) {
    const px = bodyPx(b.lm, w, h);
    if (px) p.mPerPx = p.mPerPx ? 0.9 * p.mPerPx + 0.1 * (heightM / px) : heightM / px;
    const pos = { x: b.f.x * w, y: b.f.y * h };
    const dt = p.lastT != null ? (t - p.lastT) / 1000 : 0;
    if (p.pos && dt > 0 && dt < 0.5 && p.mPerPx) {
      // Light smoothing: foot landmarks jitter by a few pixels a frame, and
      // summing raw jitter would invent metres for a player standing still.
      const sm = { x: 0.5 * p.pos.x + 0.5 * pos.x, y: 0.5 * p.pos.y + 0.5 * pos.y };
      const dm = Math.hypot(sm.x - p.pos.x, sm.y - p.pos.y) * p.mPerPx;
      const v = dm / dt;
      p.vel = 0.7 * p.vel + 0.3 * v;
      if (p.vel > 0.3) p.dist += dm;      // below walking pace it is jitter, not movement
      if (p.vel > p.vmax && p.tTracked > 0.5) p.vmax = p.vel;
      p.tTracked += dt;
      if (p.vel >= SPRINT_MS) { p.fastFor += dt; if (p.fastFor >= SPRINT_MIN_S && p.fastFor - dt < SPRINT_MIN_S) p.sprints++; }
      else p.fastFor = 0;
      p.pos = sm;
    } else p.pos = pos;
    const gx = Math.min(2, Math.max(0, Math.floor(b.f.x * 3))), gy = Math.min(2, Math.max(0, Math.floor(b.f.y * 3)));
    if (dt > 0 && dt < 0.5) p.grid[gy * 3 + gx] += dt;
    strokeStep(p, b.lm, t, w, h, dt, px);
    if (p.firstT == null) p.firstT = t;
    p.last = b.f; p.lastT = t; p.lm = b.lm; p.seen++;
  }

  function strokeStep(p, lm, t, w, h, dt, px) {
    if (!px || !(dt > 0 && dt < 0.5)) { p.prevW = null; return; }
    const W = { l: lm[LW], r: lm[RW] };
    if (p.prevW) {
      let best = null;
      for (const s of ["l", "r"]) {
        if (!vis(W[s]) || !vis(p.prevW[s])) continue;
        const sp = Math.hypot((W[s].x - p.prevW[s].x) * w, (W[s].y - p.prevW[s].y) * h) / px / dt;  // body heights / s
        if (!best || sp > best.sp) best = { s, sp };
      }
      if (best) {
        if (best.sp > STROKE_THR) {
          if (!p.wPeak || best.sp > p.wPeak.sp) p.wPeak = { ...best, cross: crossed(lm, best.s) };
        } else if (p.wPeak) {
          // The peak is over: one stroke, unless the last was too recent.
          if ((t - p.lastStroke) / 1000 >= STROKE_GAP_S) {
            p.strokes++; p.hand[p.wPeak.s]++; p.lastStroke = t;
            if (p.wPeak.cross) p.back++; else p.fore++;
            const ms = p.wPeak.sp * (p.mPerPx ? px * p.mPerPx : 1.75);
            if (ms > p.hmax) p.hmax = ms;
          }
          p.wPeak = null;
        }
      }
    }
    p.prevW = { l: W.l, r: W.r };
  }

  /** Whether wrist `s` is across the body (past the other shoulder's side of the chest). */
  function crossed(lm, s) {
    const l = lm[LS], r = lm[RS], wr = lm[s === "l" ? LW : RW];
    if (!vis(l) || !vis(r) || !vis(wr)) return false;
    const mid = (l.x + r.x) / 2, own = (s === "l" ? l.x : r.x) - mid;
    return own !== 0 && (wr.x - mid) / own < 0;
  }

  /** Per-player metrics so far, players by number. */
  function summary() {
    return players.concat(gone).sort((a, b) => a.id - b.id || a.firstT - b.firstT).filter((p) => p.tTracked > 1).map((p) => ({
      id: p.id, colour: p.colour, time_s: p.tTracked, distance_m: p.dist,
      mean_speed_ms: p.tTracked ? p.dist / p.tTracked : 0, max_speed_ms: p.vmax, sprints: p.sprints,
      strokes: p.strokes, forehand: p.fore, backhand: p.back, max_hand_speed_ms: p.hmax,
      hand: p.hand.r >= p.hand.l ? "r" : "l",
      zones: p.grid.map((g) => (p.tTracked ? g / p.tTracked : 0)),
    }));
  }
  // Players that dropped out keep their numbers in the summary.
  const gone = [];
  const _update = update;
  function updateKeep(list, t, w, h) {
    const before = players.slice();
    const out = _update(list, t, w, h);
    for (const p of before) if (!players.includes(p) && p.tTracked > 1) gone.push(p);
    return out;
  }
  function reset() { players = []; gone.length = 0; }
  return { update: updateKeep, summary, reset, get players() { return players; } };
}
