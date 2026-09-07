/**
 * dynamics.js -- sagittal inverse dynamics, ported from kinematics/dynamics.py.
 *
 * Joint moments from kinematics and body mass alone, no force plate. The
 * ground reaction is DERIVED, not guessed: Newton's second law on the whole
 * body gives GRF = m*(a_com + g), and every segment centre of mass is
 * measured. What is assumed is the centre of pressure (midfoot), left-right
 * symmetry, and planarity -- see the Python module for the full discussion.
 *
 * Sign conventions are declared, not derived, and pinned by
 * android_app/tests/test_dynamics.py. Extension is POSITIVE at every joint.
 */
export const G = 9.80665;

// Winter, Biomechanics and Motor Control of Human Movement (4th ed.) Table 4.1.
export const SEGMENTS = {
  foot:  { mass: 0.0145, com: 0.50,  rg: 0.475 },
  shank: { mass: 0.0465, com: 0.433, rg: 0.302 },
  thigh: { mass: 0.1000, com: 0.433, rg: 0.323 },
  hat:   { mass: 0.6780, com: 0.626, rg: 0.496 },
};

const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[v.length >> 1] : 0; };

function smooth(x, win) {
  if (win < 3 || x.length < win) return [...x];
  if (win % 2 === 0) win += 1;
  const pad = win >> 1, out = new Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let j = -pad; j <= pad; j++) {
      const k = Math.min(x.length - 1, Math.max(0, i + j));
      s += x[k];
    }
    out[i] = s / win;
  }
  return out;
}

function deriv(x, dt) {
  const n = x.length, d = new Array(n).fill(0);
  if (n < 2) return d;
  for (let i = 1; i < n - 1; i++) d[i] = (x[i + 1] - x[i - 1]) / (2 * dt);
  d[0] = (x[1] - x[0]) / dt;
  d[n - 1] = (x[n - 1] - x[n - 2]) / dt;
  return d;
}

function unwrap(a) {
  const out = [...a];
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > Math.PI) { out[i] -= 2 * Math.PI; d = out[i] - out[i - 1]; }
    while (d < -Math.PI) { out[i] += 2 * Math.PI; d = out[i] - out[i - 1]; }
  }
  return out;
}

function segment(name, prox, dist, massKg, dt, win) {
  const p = SEGMENTS[name], n = prox.length;
  const mass = p.mass * massKg;
  const length = med(prox.map((q, i) => Math.hypot(q[0] - dist[i][0], q[1] - dist[i][1])));
  const inertia = mass * (p.rg * length) ** 2;
  const com = prox.map((q, i) => [q[0] + p.com * (dist[i][0] - q[0]),
                                  q[1] + p.com * (dist[i][1] - q[1])]);
  const ax = deriv(deriv(smooth(com.map((c) => c[0]), win), dt), dt);
  const ay = deriv(deriv(smooth(com.map((c) => c[1]), win), dt), dt);
  const ang = smooth(unwrap(prox.map((q, i) =>
    Math.atan2(dist[i][1] - q[1], dist[i][0] - q[0]))), win);
  const alpha = deriv(deriv(ang, dt), dt);
  return { mass, inertia, length, com, acc: ax.map((v, i) => [v, ay[i]]), alpha, n };
}

const crossZ = (r, f) => r.map((v, i) => v[0] * f[i][1] - v[1] * f[i][0]);
const sub = (a, b) => a.map((v, i) => [v[0] - b[i][0], v[1] - b[i][1]]);

export function inverseDynamics(coordsM, massKg, fps,
                                { smoothWin = 9, barMassKg = 0 } = {}) {
  const dt = 1 / fps;
  const { ankle, knee, hip, shoulder, toe } = coordsM;
  const n = ankle.length;
  const totalMass = massKg + barMassKg;

  const segs = {
    foot: segment("foot", ankle, toe, massKg, dt, smoothWin),
    shank: segment("shank", knee, ankle, massKg, dt, smoothWin),
    thigh: segment("thigh", hip, knee, massKg, dt, smoothWin),
    hat: segment("hat", hip, shoulder, massKg, dt, smoothWin),
  };
  const count = { foot: 2, shank: 2, thigh: 2, hat: 1 };

  let mTot = 0;
  for (const k in segs) mTot += segs[k].mass * count[k];
  const com = new Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (const k in segs) {
      const w = segs[k].mass * count[k];
      x += segs[k].com[i][0] * w; y += segs[k].com[i][1] * w;
    }
    com[i] = [x / mTot, y / mTot];
  }
  const comY = smooth(com.map((c) => c[1]), smoothWin);
  let accX = deriv(deriv(smooth(com.map((c) => c[0]), smoothWin), dt), dt);
  let accY = deriv(deriv(comY, dt), dt);
  if (barMassKg) {
    const bx = deriv(deriv(smooth(shoulder.map((s) => s[0]), smoothWin), dt), dt);
    const by = deriv(deriv(smooth(shoulder.map((s) => s[1]), smoothWin), dt), dt);
    accX = accX.map((v, i) => (mTot * v + barMassKg * bx[i]) / totalMass);
    accY = accY.map((v, i) => (mTot * v + barMassKg * by[i]) / totalMass);
  }
  const grf = accX.map((v, i) => [totalMass * v, totalMass * (accY[i] + G)]);
  const half = grf.map((g) => [0.5 * g[0], 0.5 * g[1]]);

  const cop = ankle.map((a, i) => [a[0] + 0.5 * (toe[i][0] - a[0]),
                                   Math.min(a[1], toe[i][1])]);

  const W = (m) => new Array(n).fill(0).map(() => [0, m * G]);
  const addAll = (...arrs) => arrs[0].map((_, i) =>
    arrs.reduce((s, a) => [s[0] + a[i][0], s[1] + a[i][1]], [0, 0]));
  const neg = (a) => a.map((v) => [-v[0], -v[1]]);
  const scale = (a, k) => a.map((v) => [v[0] * k, v[1] * k]);

  const f = segs.foot;
  const F_ankle = addAll(scale(f.acc, f.mass), neg(half), W(f.mass));
  const M_ankle = f.alpha.map((al, i) => f.inertia * al)
    .map((v, i) => v - crossZ(sub(cop, f.com), half)[i] - crossZ(sub(ankle, f.com), F_ankle)[i]);

  const s = segs.shank;
  const F_knee = addAll(scale(s.acc, s.mass), F_ankle, W(s.mass));
  const M_knee = s.alpha.map((al) => s.inertia * al)
    .map((v, i) => v + M_ankle[i] + crossZ(sub(ankle, s.com), F_ankle)[i]
                     - crossZ(sub(knee, s.com), F_knee)[i]);

  const t = segs.thigh;
  const F_hip = addAll(scale(t.acc, t.mass), F_knee, W(t.mass));
  const M_hip = t.alpha.map((al) => t.inertia * al)
    .map((v, i) => v + M_knee[i] + crossZ(sub(knee, t.com), F_knee)[i]
                     - crossZ(sub(hip, t.com), F_hip)[i]);

  const facing = Math.sign(med(toe.map((p, i) => p[0] - ankle[i][0]))) || 1;

  // Extension positive. M_knee acts on the SHANK, whose extension sense is
  // opposite to the thigh's about the same axis, so it takes the opposite
  // sign to hip and ankle. A small FLEXOR knee moment in a shallow squat is
  // physical, not a bug.
  return {
    ankle_moment: M_ankle.map((v) => -facing * v),
    knee_moment: M_knee.map((v) => +facing * v),
    hip_moment: M_hip.map((v) => -facing * v),
    grf_vertical: grf.map((g) => g[1]),
    grf_horizontal: grf.map((g) => g[0]),
    com_y: comY,
    body_weight_n: totalMass * G,
    facing,
  };
}
