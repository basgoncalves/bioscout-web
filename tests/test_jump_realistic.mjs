/**
 * Jumps as a phone films them: jitter, dropped foot landmarks, drift between
 * jumps, 30 and 60 fps. See jump_sim.mjs for what is simulated and why.
 *
 * Before the local-floor / parabola-timing rework this is where the detector
 * fell over: +7 cm of height on average from ordinary jitter, 1 jump in 5 lost
 * to drift, and 60 cm errors at worst. The bars below are what it does now,
 * with some room -- a regression past them is a real one.
 *
 *   node tests/test_jump_realistic.mjs
 */
const K = await import("../src/kinematics.js");
const { simJumps } = await import("./jump_sim.mjs");

let bad = 0;
const check = (ok, msg, detail = "") => {
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${msg}${detail ? "  " + detail : ""}`);
};

const SCEN = {
  "ordinary jitter":            { bias: 1.5, rms: 2.0 },
  "heavy jitter":               { o: { noiseCm: 1.0, footNoiseCm: 2.0 }, bias: 1.5, rms: 3.0 },
  "feet dropped in flight":     { o: { dropFrac: 0.08, dropFlight: 0.3 }, bias: 1.5, rms: 3.0 },
  "drift between jumps":        { o: { driftCm: 3 }, bias: 1.5, rms: 3.0 },
  "all of it, 30 fps":          { o: { noiseCm: 0.8, footNoiseCm: 1.8, dropFrac: 0.08, dropFlight: 0.3, driftCm: 3 }, bias: 2.0, rms: 4.0 },
  "all of it, 60 fps":          { o: { fps: 60, noiseCm: 0.8, footNoiseCm: 1.8, dropFrac: 0.08, dropFlight: 0.3, driftCm: 3 }, bias: 2.0, rms: 4.0 },
  "small jumps (12-18 cm)":     { o: { jumps: [{ h: 0.15, cmv: 0.2 }, { h: 0.18, cmv: 0.22 }, { h: 0.12, cmv: 0.18 }] }, bias: 1.5, rms: 2.0 },
};

for (const [name, s] of Object.entries(SCEN)) {
  let found = 0, total = 0;
  const err = [];
  for (let seed = 1; seed <= 20; seed++) {
    const c = simJumps({ ...(s.o || {}), seed });
    const res = K.analyse(c.poses, c.fps, { heightM: 1.81, activity: "cmj" });
    total += c.truth.length;
    for (const t of c.truth) {
      const r = res.reps.find((q) => q.takeoff_frame != null
        && Math.abs(q.takeoff_frame / c.fps - t.takeoffT) < 0.25);
      if (!r) continue;
      found++;
      err.push((r.height_flight_m - t.h) * 100);
    }
  }
  const bias = err.reduce((a, v) => a + v, 0) / (err.length || 1);
  const rms = Math.sqrt(err.reduce((a, v) => a + v * v, 0) / (err.length || 1));
  check(found === total && Math.abs(bias) <= s.bias && rms <= s.rms, name,
        `found ${found}/${total}, height error bias ${bias.toFixed(1)} cm, rms ${rms.toFixed(1)} cm`);
}

// And the other way round: the same noise on squats with a tip-toe finish and
// no flight must not produce a jump.
{
  let fp = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const c = simJumps({ seed, noiseCm: 0.8, footNoiseCm: 1.8, dropFrac: 0.08, driftCm: 3,
                         jumps: [{ h: 0.0005, cmv: 0.35 }, { h: 0.0005, cmv: 0.3 }] });
    fp += K.analyse(c.poses, c.fps, { heightM: 1.81, activity: "cmj" }).reps.length;
  }
  check(fp === 0, "no flight, no jump -- squats onto the toes under the same noise", `${fp} false jumps in 20 clips`);
}

console.log(bad ? `\n${bad} check(s) FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
