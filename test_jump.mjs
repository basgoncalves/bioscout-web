// Synthetic jumps with a known truth, at several frame rates and heights.
const K = await import('./kinematics.js');
const G = 9.80665;

function clip({ fps, jumpH, cmv, pxPerM = 500, shank = 0.42, thigh = 0.42 }) {
  const H = [], FOOT = [];
  const stand = 0.95, dip = stand - cmv;
  const flight = 2 * Math.sqrt(2 * jumpH / G);
  const dipN = Math.round(0.40 * fps), pushN = Math.round(0.30 * fps);
  const flightN = Math.round(flight * fps);
  for (let i = 0; i < Math.round(0.5 * fps); i++) { H.push(stand); FOOT.push(0); }
  for (let i = 0; i < dipN; i++) { H.push(stand - cmv * (i + 1) / dipN); FOOT.push(0); }
  for (let i = 0; i < pushN; i++) { H.push(dip + cmv * (i + 1) / pushN); FOOT.push(0); }
  const v = G * flight / 2;
  for (let i = 0; i < flightN; i++) {
    const s = (i + 1) / fps, y = v * s - 0.5 * G * s * s;
    H.push(stand + y); FOOT.push(Math.max(0, y));
  }
  for (let i = 0; i < Math.round(0.7 * fps); i++) { H.push(stand); FOOT.push(0); }
  const poses = {};
  H.forEach((h, i) => {
    const hipY = 1000 - h * pxPerM, footY = 1000 - FOOT[i] * pxPerM;
    const kneeY = footY - shank * pxPerM, shY = hipY - 0.45 * pxPerM;
    poses[i] = {
      left_shoulder: [240, shY], right_shoulder: [260, shY],
      left_hip: [245, hipY], right_hip: [255, hipY],
      left_knee: [245, kneeY], right_knee: [255, kneeY],
      left_ankle: [245, footY], right_ankle: [255, footY],
      left_foot_index: [265, footY + 4], right_foot_index: [275, footY + 4],
      left_elbow: [235, shY + 120], right_elbow: [265, shY + 120],
      left_wrist: [235, shY + 220], right_wrist: [265, shY + 220],
    };
  });
  return { poses, flight, jumpH, cmv };
}

const rows = [];
for (const fps of [30, 60]) {
  for (const jumpH of [0.20, 0.30, 0.45]) {
    const c = clip({ fps, jumpH, cmv: 0.25 });
    const res = K.analyse(c.poses, fps, { heightM: 1.81, activity: 'cmj', osimModel: 'gpk' });
    const r = res.reps[0];
    if (!r) { rows.push([fps, jumpH, 'NO REP']); continue; }
    rows.push({
      fps, true_h: jumpH.toFixed(3), true_flight: c.flight.toFixed(3),
      flight_s: r.flight_s, h_flight: r.height_flight_m,
      err_cm: ((r.height_flight_m - jumpH) * 100).toFixed(1),
      pm_cm: (r.flight_uncertainty_m * 100).toFixed(1),
      h_com: r.height_com_m, cmv: r.countermovement_m, mism: r.mismatch,
    });
  }
}
console.table(rows);

// squat jump: no countermovement at all
const sj = clip({ fps: 60, jumpH: 0.30, cmv: 0.0 });
const a = K.analyse(sj.poses, 60, { heightM: 1.81, activity: 'sj', osimModel: 'gpk' });
console.log('SJ (no dip):', a.reps.map(r => ({ h: r.height_flight_m, cmv: r.countermovement_m,
  hasCmv: r.has_countermovement, mismatch: r.mismatch })));
const asCmj = K.analyse(sj.poses, 60, { heightM: 1.81, activity: 'cmj', osimModel: 'gpk' });
console.log('same clip called a CMJ -> mismatch:', asCmj.reps.map(r => r.mismatch));

// a squat must NOT be detected as a jump
const sq = clip({ fps: 60, jumpH: 0.0001, cmv: 0.30 });
const noJump = K.analyse(sq.poses, 60, { heightM: 1.81, activity: 'cmj', osimModel: 'gpk' });
console.log('a squat analysed as a jump -> reps found:', noJump.reps.length, '(want 0)');
