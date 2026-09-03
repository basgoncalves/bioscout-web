/* Synthetic clips for the three tasks added on 3 Sep: a single-leg squat, a
 * run and a side step -- plus the four that already existed, because the way a
 * new class breaks a classifier is by stealing an old one's clips.
 *
 * Every clip is built from geometry, not from recorded footage, so what is
 * being tested is the decision rule and not a particular camera. */
const D = await import('./detect.js');
const K = await import('./kinematics.js');

const T = 180;                      // torso length, px
const FLOOR = 1000;
const px = (m) => m * 500;

/* Build a clip from per-frame descriptions. Each entry gives the hip height
 * above the floor (m), the hip's sideways offset (m), and each foot's height
 * above the floor (m). Joint centres are placed so that the knee angle follows
 * from the geometry rather than being asserted. */
function build(frames) {
  const poses = {};
  frames.forEach((f, i) => {
    const hipY = FLOOR - px(f.hip);
    const shY = hipY - T;
    const lFootY = FLOOR - px(f.lf), rFootY = FLOOR - px(f.rf);
    // Knee sits between hip and foot, pushed forward by however much the leg
    // is compressed -- a straight leg has the knee on the hip-ankle line.
    const leg = (hipTop, footY) => {
      const span = footY - hipTop;
      const full = px(0.88);
      const comp = Math.max(0, full - span);
      return [footY - span / 2, comp * 1.1];
    };
    const [lky, lkx] = leg(hipY, lFootY);
    const [rky, rkx] = leg(hipY, rFootY);
    const hx = px(f.x || 0);
    poses[i] = {
      nose: [250 + hx, shY - 90], left_ear: [244 + hx, shY - 80], right_ear: [256 + hx, shY - 80],
      left_shoulder: [240 + hx, shY], right_shoulder: [260 + hx, shY],
      left_hip: [245 + hx, hipY], right_hip: [255 + hx, hipY],
      left_knee: [245 + hx + lkx, lky], right_knee: [255 + hx + rkx, rky],
      left_ankle: [245 + hx, lFootY], right_ankle: [255 + hx, rFootY],
      left_foot_index: [265 + hx, lFootY + 4], right_foot_index: [275 + hx, rFootY + 4],
      left_elbow: [238 + hx, shY + 110], right_elbow: [262 + hx, shY + 110],
      left_wrist: [236 + hx, shY + 215], right_wrist: [264 + hx, shY + 215],
    };
  });
  return poses;
}

const fps = 60;
const ramp = (n, a, b) => Array.from({ length: n }, (_, i) => a + (b - a) * (i + 1) / n);

// ---------------------------------------------------------------- single-leg squat
function slSquat({ reps = 3, depth = 0.28, side = 'r' } = {}) {
  const f = [];
  const stand = 0.95, upFoot = 0.22;
  const put = (h) => f.push(side === 'r'
    ? { hip: h, rf: 0, lf: upFoot } : { hip: h, lf: 0, rf: upFoot });
  for (let i = 0; i < 30; i++) put(stand);
  for (let r = 0; r < reps; r++) {
    ramp(25, stand, stand - depth).forEach(put);
    for (let i = 0; i < 6; i++) put(stand - depth);
    ramp(25, stand - depth, stand).forEach(put);
    for (let i = 0; i < 12; i++) put(stand);
  }
  return build(f);
}

// ---------------------------------------------------------------- running
function running({ strides = 4, contactS = 0.20, flightS = 0.11 } = {}) {
  const f = [];
  const stand = 0.92, cN = Math.round(contactS * fps), fN = Math.round(flightS * fps);
  const swingH = 0.20;
  for (let i = 0; i < 15; i++) f.push({ hip: stand, lf: 0, rf: 0 });
  // Two steps per stride, alternating which foot is down. During flight both
  // feet are up and the hip rides a shallow arc -- nothing like a jump's.
  for (let s = 0; s < strides * 2; s++) {
    const down = s % 2 === 0 ? 'r' : 'l';
    for (let i = 0; i < cN; i++) {
      const dip = 0.05 * Math.sin(Math.PI * (i + 1) / cN);
      const other = swingH * Math.sin(Math.PI * (i + 1) / cN);
      f.push(down === 'r' ? { hip: stand - dip, rf: 0, lf: other }
                          : { hip: stand - dip, lf: 0, rf: other });
    }
    for (let i = 0; i < fN; i++) {
      const rise = 0.05 * Math.sin(Math.PI * (i + 1) / fN);
      f.push({ hip: stand + rise, lf: 0.09 + rise, rf: 0.09 + rise });
    }
  }
  for (let i = 0; i < 15; i++) f.push({ hip: stand, lf: 0, rf: 0 });
  return build(f);
}

// ---------------------------------------------------------------- side step
function sideStep({ cuts = 3, reach = 0.42 } = {}) {
  const f = [];
  const stand = 0.93;
  const put = (x, h) => f.push({ hip: h, x, lf: 0, rf: 0 });
  for (let i = 0; i < 20; i++) put(0, stand);
  for (let c = 0; c < cuts; c++) {
    const dir = c % 2 === 0 ? 1 : -1;
    ramp(16, 0, dir * reach).forEach((x, i) => put(x, stand - 0.09 * (i + 1) / 16));
    for (let i = 0; i < 5; i++) put(dir * reach, stand - 0.09);
    ramp(16, dir * reach, 0).forEach((x) => put(x, stand - 0.05));
    for (let i = 0; i < 8; i++) put(0, stand);
  }
  return build(f);
}

// ---------------------------------------------------------------- the old ones
function twoLegSquat({ reps = 3, depth = 0.34 } = {}) {
  const f = [];
  const stand = 0.95;
  const put = (h) => f.push({ hip: h, lf: 0, rf: 0 });
  for (let i = 0; i < 25; i++) put(stand);
  for (let r = 0; r < reps; r++) {
    ramp(25, stand, stand - depth).forEach(put);
    for (let i = 0; i < 5; i++) put(stand - depth);
    ramp(25, stand - depth, stand).forEach(put);
    for (let i = 0; i < 12; i++) put(stand);
  }
  return build(f);
}

function cmj({ jumps = 2, h = 0.34 } = {}) {
  const g = 9.80665, f = [], stand = 0.95;
  for (let j = 0; j < jumps; j++) {
    for (let i = 0; i < 25; i++) f.push({ hip: stand, lf: 0, rf: 0 });
    ramp(24, stand, stand - 0.26).forEach((y) => f.push({ hip: y, lf: 0, rf: 0 }));
    ramp(16, stand - 0.26, stand).forEach((y) => f.push({ hip: y, lf: 0, rf: 0 }));
    const flight = 2 * Math.sqrt(2 * h / g), v = g * flight / 2;
    for (let i = 0; i < Math.round(flight * fps); i++) {
      const t = (i + 1) / fps, y = v * t - 0.5 * g * t * t;
      f.push({ hip: stand + y, lf: y, rf: y });
    }
    for (let i = 0; i < 25; i++) f.push({ hip: stand, lf: 0, rf: 0 });
  }
  return build(f);
}

// ---------------------------------------------------------------- run them
const CASES = [
  ['single-leg squat (right)', slSquat({ side: 'r' }), 'slsquat'],
  ['single-leg squat (left)', slSquat({ side: 'l' }), 'slsquat'],
  ['running', running(), 'run'],
  ['running, slower cadence', running({ strides: 3, contactS: 0.26, flightS: 0.08 }), 'run'],
  ['side step', sideStep(), 'sidestep'],
  ['two-leg squat', twoLegSquat(), 'squat'],
  ['countermovement jump', cmj(), 'cmj'],
];

let bad = 0;
console.log('--- classification ---');
for (const [name, poses, want] of CASES) {
  const c = D.classify(poses);
  const ok = c.activity === want;
  if (!ok) bad++;
  const sc = Object.entries(c.scores).sort((a, b) => b[1] - a[1])
    .slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} -> ${
    String(c.activity).padEnd(9)} (want ${want})  [${sc}]`);
  if (!ok) console.log('        reason:', c.reason);
}

console.log('\n--- rep finding and metrics ---');
for (const [name, poses, want] of CASES) {
  if (!['slsquat', 'run', 'sidestep'].includes(want)) continue;
  const res = K.analyse(poses, fps, { heightM: 1.81, activity: want, osimModel: 'gpk' });
  const r = res.reps[0];
  console.log(`${name}: ${res.reps.length} reps`,
    res.refused ? `REFUSED(${res.refused})` : '',
    r ? JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) =>
      !['times', 'coords', 'bounds'].includes(k)).map(([k, v]) =>
        [k, typeof v === 'number' ? +v.toFixed(3) : v])), null, 0) : '');
  if (!res.reps.length) bad++;
}

// Every rep must carry per-leg curves that actually differ on an asymmetric
// task; identical left and right would mean the averaging was never removed.
const sl = K.analyse(slSquat({ side: 'r' }), fps,
  { heightM: 1.81, activity: 'slsquat', osimModel: 'gpk' });
if (sl.reps.length) {
  const r = sl.reps[0];
  const diff = Math.max(...r.coords.knee_angle_r.map((v, i) =>
    Math.abs(v - r.coords.knee_angle_l[i])));
  console.log(`\nper-leg knee curves differ by up to ${diff.toFixed(1)} deg`,
    `(stance ${r.stance_side}, stance knee peak ${r.stance_knee_flex_max_deg.toFixed(0)} deg)`);
  if (diff < 10) { console.log('FAIL: left and right are the same curve'); bad++; }
}

/* Stride timing against the truth the clip was built from. A classifier that
 * says "running" and then reports a 0.42 s stride for a 0.63 s one is worse
 * than one that says nothing, because the number looks usable. */
console.log('\n--- stride timing vs truth ---');
for (const [name, opts] of [['running', { strides: 4, contactS: 0.20, flightS: 0.11 }],
                            ['slower cadence', { strides: 3, contactS: 0.26, flightS: 0.08 }]]) {
  const res = K.analyse(running(opts), fps,
    { heightM: 1.81, activity: 'run', osimModel: 'gpk' });
  const trueStride = 2 * (opts.contactS + opts.flightS);
  const trueCad = 120 / trueStride;
  const r = res.reps[0];
  if (!r) { console.log(`FAIL  ${name}: no strides found`); bad++; continue; }
  const dStride = Math.abs(r.stride_s - trueStride);
  const dCad = Math.abs(r.cadence_spm - trueCad);
  const ok = dStride <= 0.05 && dCad <= 12 && r.walking === false && r.flight_s > 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: stride ${r.stride_s}s `
    + `(true ${trueStride.toFixed(3)}s, off ${dStride.toFixed(3)}s), `
    + `cadence ${r.cadence_spm} (true ${trueCad.toFixed(1)}), `
    + `flight ${r.flight_s}s, duty ${r.duty_factor}, walking=${r.walking}`);
}

// A walk must NOT be reported as a run with a straight face: the duty factor is
// the check, and it has to come out at or above 0.5 with no flight.
{
  const walk = running({ strides: 4, contactS: 0.34, flightS: 0 });
  const res = K.analyse(walk, fps, { heightM: 1.81, activity: 'run', osimModel: 'gpk' });
  const r = res.reps[0];
  const ok = !r || (r.duty_factor >= 0.5 && r.walking === true);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  a walk analysed as running -> `
    + (r ? `duty ${r.duty_factor}, walking=${r.walking}` : 'no strides'));
}

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
