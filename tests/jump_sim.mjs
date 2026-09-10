/**
 * A jump the way a phone films it -- for testing the detector against what it
 * actually meets, not against a clean line of numbers.
 *
 * The clean fixtures in test_jump.mjs move a single foot point straight up and
 * down, with the floor exactly where it was on every frame. Real clips differ
 * in the ways that break a foot-threshold detector:
 *
 *   the foot rotates     take-off is a heel lift then a toe push; landing is
 *                        toe first, heel after. The lowest point of the foot
 *                        is the toe for all of it.
 *   jitter               MediaPipe's foot landmarks wobble by a centimetre or
 *                        two frame to frame; the toe worse than the ankle.
 *   dropouts             a foot landmark under 0.3 visibility is dropped by
 *                        the app, and fast feet are the likeliest to blur.
 *   drift                athletes creep: each landing a few centimetres
 *                        nearer or further from the camera, which moves the
 *                        feet up or down the picture.
 *
 * Truth is the simulated flight (toe off to toe down) and its height g t^2/8.
 * Deterministic: every clip comes from a seeded generator.
 */
const G = 9.80665;

export function rng(seed) {
  let s = seed >>> 0 || 1;
  const u = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const n = () => { let a = 0; for (let k = 0; k < 6; k++) a += u(); return (a - 3) / Math.sqrt(0.5); };
  return { u, n };
}

/**
 * @param o.fps, o.jumps [{h, cmv}], o.pxPerM, o.noiseCm (body), o.footNoiseCm,
 *        o.dropFrac (foot landmarks), o.dropFlight (extra, while airborne),
 *        o.driftCm (per landing, feet y in the picture), o.seed, o.walkInCm
 */
export function simJumps(o = {}) {
  const fps = o.fps ?? 30, px = o.pxPerM ?? 300;
  const R = rng(o.seed ?? 1);
  const jumps = o.jumps ?? [{ h: 0.30, cmv: 0.28 }, { h: 0.32, cmv: 0.30 }, { h: 0.28, cmv: 0.26 }];
  const AH = 0.07, SH = 0.44, TH = 0.44, TR = 0.52, FOOT = 0.15, HEEL = 0.05;
  const stand = AH + SH + TH;              // hip height standing, knees straight
  const toeUp = 0.09;                      // how far the ankle rises on the toes
  // Hip height relative to standing, foot pitch (0 flat .. 1 on toes), and the
  // toe's height above the floor: three tracks built phase by phase.
  const hip = [], pitch = [], toe = [], air = [];
  const push = (h, p, t, a) => { hip.push(h); pitch.push(p); toe.push(t); air.push(a); };
  const hold = (s) => { for (let i = 0; i < Math.round(s * fps); i++) push(0, 0, 0, 0); };
  const truth = [];
  hold(0.8 + 0.4 * R.u());
  for (const j of jumps) {
    const dipN = Math.round(0.45 * fps), pushN = Math.round(0.28 * fps);
    for (let i = 1; i <= dipN; i++) {
      const s = 0.5 * (1 - Math.cos(Math.PI * i / dipN));
      push(-j.cmv * s, 0, 0, 0);
    }
    for (let i = 1; i <= pushN; i++) {
      const s = 0.5 * (1 - Math.cos(Math.PI * i / pushN));
      // the last third of the push is the heel coming up
      const p = Math.max(0, (i / pushN - 0.66) / 0.34);
      push(-j.cmv + (j.cmv + toeUp) * s, p, 0, 0);
    }
    // Flight: the body leaves on its toes and comes back on them, so the hip
    // and toe share one parabola. Sampled at true time, sub-frame phase random.
    const tf = 2 * Math.sqrt(2 * j.h / G), v = G * tf / 2;
    const t0 = (hip.length - 1 + R.u()) / fps;       // take-off between frames
    const nF = Math.ceil(tf * fps) + 1;
    const frames = [];
    for (let k = 0; k < nF; k++) {
      const t = (hip.length) / fps - t0;
      if (t > tf) break;
      const y = v * t - 0.5 * G * t * t;
      push(toeUp + y, 1, Math.max(0, y), 1);
      frames.push(hip.length - 1);
    }
    truth.push({ h: j.h, flight_s: tf, takeoffT: t0, landT: t0 + tf });
    // Landing: toe down, heel follows, knees soak it up, stand.
    const heelN = Math.max(2, Math.round(0.06 * fps)), soakN = Math.round(0.35 * fps);
    for (let i = 1; i <= heelN; i++) push(toeUp * (1 - i / heelN), 1 - i / heelN, 0, 0);
    for (let i = 1; i <= soakN; i++) {
      const s = Math.sin(Math.PI * i / soakN);
      push(-0.16 * s, 0, 0, 0);
    }
    hold(1.0 + 0.6 * R.u());
  }
  // Pixels. Facing +x; the foot pivots about the toe as pitch rises.
  const poses = {}, n = hip.length;
  let drift = 0, landIdx = 0;
  const x0 = 400, floor = 900;
  const noise = (cm) => (cm / 100) * px * R.n();
  for (let i = 0; i < n; i++) {
    if (i > 0 && air[i - 1] === 1 && air[i] === 0) drift += (o.driftCm ?? 0) / 100 * (R.u() < 0.5 ? -1 : 1) * (0.5 + R.u());
    const toeH = toe[i];
    const ang = pitch[i] * 0.75;           // ~43 deg of plantarflexion at full pitch
    const toeP = [0.10, toeH];
    const ank = [toeP[0] - FOOT * Math.cos(ang), toeH + AH * 0 + FOOT * Math.sin(ang) + AH * Math.cos(ang) * (1 - pitch[i]) + AH * pitch[i] * 0.4];
    const heel = [ank[0] - HEEL, ank[1] - AH * Math.cos(ang) * 0.8];
    const hipH = stand + hip[i];
    const hipP = [0, hipH];
    // Knee by two-link IK between ankle and hip, knee forward.
    const dx = hipP[0] - ank[0], dy = hipP[1] - ank[1], d = Math.min(Math.hypot(dx, dy), SH + TH - 1e-4);
    const a = (SH * SH - TH * TH + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, SH * SH - a * a));
    const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
    const knee = [ank[0] + a * ux + hh * uy, ank[1] + a * uy - hh * ux];
    const lean = Math.max(0, -hip[i]) * 0.9;
    const sh = [hipP[0] + TR * Math.sin(lean), hipH + TR * Math.cos(lean)];
    const P = (p, cm = o.noiseCm ?? 0.6) => [x0 + p[0] * px + noise(cm), floor - p[1] * px + drift * px + noise(cm)];
    const lm = {};
    const fN = o.footNoiseCm ?? 1.2;
    for (const [sd, dz] of [["left", -0.01], ["right", 0.01]]) {
      const S = (p) => [p[0] + dz, p[1]];
      lm[`${sd}_shoulder`] = P(S(sh));
      lm[`${sd}_hip`] = P(S(hipP));
      lm[`${sd}_knee`] = P(S(knee));
      lm[`${sd}_ankle`] = P(S(ank), fN * 0.8);
      lm[`${sd}_heel`] = P(S(heel), fN);
      lm[`${sd}_foot_index`] = P(S(toeP), fN);
      lm[`${sd}_elbow`] = P(S([sh[0] + 0.05, sh[1] - 0.28]));
      lm[`${sd}_wrist`] = P(S([sh[0] + 0.12, sh[1] - 0.52]));
      const drop = (o.dropFrac ?? 0) + (air[i] ? (o.dropFlight ?? 0) : 0);
      for (const k of ["ankle", "heel", "foot_index"]) if (R.u() < drop) delete lm[`${sd}_${k}`];
    }
    lm.nose = P([sh[0] + 0.08, sh[1] + 0.22]);
    lm.left_ear = P([sh[0] - 0.01, sh[1] + 0.2]); lm.right_ear = P([sh[0] + 0.01, sh[1] + 0.2]);
    poses[i] = lm;
  }
  return { poses, fps, truth, heightM: 1.81 };
}
