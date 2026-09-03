/* Event alignment.
 *
 * Two reps with the same underlying shape but very different phase
 * proportions -- a 0.09 s flight against a 0.62 s flight -- must produce a
 * mean that looks like the shape, not like a smear between two versions of it.
 * The check is the between-rep SD: once the events line up, identical shapes
 * agree everywhere and the SD collapses.
 */
const { ensembleRep } = await import('./ensemble.js');

// A smooth, physiological-looking rep: rises to the turnaround, falls to
// touch-down, settles. Identical shape in every rep; only the phase DURATIONS
// differ, which is exactly what varies between real jumps.
function rep(pushN, flightN, landN, amp = 100) {
  const n = pushN + flightN + landN;
  const y = [];
  for (let i = 0; i < pushN; i++) y.push(amp * 0.5 * (1 - Math.cos(Math.PI * i / pushN)));
  for (let i = 0; i < flightN; i++) y.push(amp * (1 - 0.6 * (i / flightN)));
  for (let i = 0; i < landN; i++) y.push(amp * 0.4 * (1 - i / landN));
  const times = Array.from({ length: n }, (_, i) => i / 60);
  return { rep: 1, times, duration_s: n / 60,
           bounds: [0, pushN, n - 1], land_frame: pushN + flightN,
           coords: { knee_angle_r: y } };
}

function report(label, reps) {
  const m = ensembleRep(reps);
  const sd = m.sd.coords.knee_angle_r;
  console.log(`${label}
  event-aligned : ${m.eventAligned}
  turnaround at : ${m.topPct.toFixed(1)}%   touch-down at ${m.landPct?.toFixed(1)}%
  max between-rep SD : ${Math.max(...sd).toFixed(2)}  (identical shapes -> ~0 when aligned)`);
}

report('two jumps, 5 and 37 frames of flight (the real case):',
       [rep(20, 5, 25), rep(20, 37, 25)]);
report('three jumps, push and landing also varying:',
       [rep(14, 24, 20), rep(20, 30, 28), rep(26, 36, 34)]);
report('three squats, different tempos:',
       [rep(30, 4, 30), rep(45, 4, 40), rep(38, 4, 52)]);
