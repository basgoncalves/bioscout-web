/* Event alignment.
 *
 * Two reps with the same underlying shape but very different phase
 * proportions -- a 0.09 s flight against a 0.62 s flight -- must produce a
 * mean that looks like the shape, not like a smear between two versions of it.
 * The check is the between-rep SD: once the events line up, identical shapes
 * agree everywhere and the SD collapses.
 */
const { ensembleRep } = await import('../src/ensemble.js');

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

/* --- left and right on one cycle ------------------------------------------ */
{
  const { mergeSides } = await import('../src/ensemble.js');
  let bad2 = 0;
  const ok2 = (c, m) => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}`); if (!c) bad2++; };
  const side = (n, kl, kr, sdv) => ({
    nReps: n, times: [0, 50, 100], timeUnit: "%", bounds: [0, 5, 10],
    topPct: 30, landPct: 60, eventAligned: true,
    coords: { knee_angle_l: kl, knee_angle_r: kr,
              hip_flexion_l: kl, hip_flexion_r: kr },
    sd: { coords: { knee_angle_l: sdv, knee_angle_r: sdv,
                    hip_flexion_l: sdv, hip_flexion_r: sdv } },
    dyn: { knee_moment: kl },
  });
  const L = side(3, [1, 2, 3], [9, 9, 9], [0.1, 0.1, 0.1]);
  const R = side(3, [8, 8, 8], [4, 5, 6], [0.2, 0.2, 0.2]);
  const m = mergeSides(L, R);
  ok2(JSON.stringify(m.coords.knee_angle_l) === JSON.stringify([1, 2, 3]),
      "the left curve comes from the left ensemble");
  ok2(JSON.stringify(m.coords.knee_angle_r) === JSON.stringify([4, 5, 6]),
      "and the right curve from the right ensemble, not the left's own _r");
  ok2(m.sd.coords.knee_angle_l[0] === 0.1 && m.sd.coords.knee_angle_r[0] === 0.2,
      "each side keeps its own band");
  ok2(m.nLeft === 3 && m.nRight === 3, "both counts are carried for the label");
  ok2(JSON.stringify(m.dyn.knee_moment) === JSON.stringify([1, 2, 3]),
      "the left cycle's moment is kept as dyn");
  ok2(m.dynRight && JSON.stringify(m.dynRight.knee_moment) === JSON.stringify([8, 8, 8]),
      "and the right cycle's moment as dynRight");
  ok2(mergeSides(L, null).coords.knee_angle_r === undefined,
      "one foot alone yields one side, not a fabricated other");
  ok2(mergeSides(null, null) === null, "nothing in, nothing out");
  const solo = mergeSides(side(1, [1], [2], null), side(1, [3], [4], null));
  ok2(solo.soloRep === true, "one stride per foot is a solo pair, so no band is claimed");
  if (bad2) { console.error(`\nFAIL ${bad2}`); process.exit(1); }
}
