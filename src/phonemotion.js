/* Phone accelerometer for BioFeedback running (DeviceMotion API).
 *
 * Works only in a browser ON the phone, over https (the live site or a
 * tunnel, not plain http://localhost on the PC), and iOS asks the user
 * once ("Allow motion & orientation"). Put the phone where it moves with
 * the trunk: armband, chest strap or a tight waist pocket. A hand-held phone
 * also works but adds arm swing.
 *
 * From |acceleration incl. gravity| (in g) it finds steps (impact peaks) and
 * reports:
 *   cadence   steps / min, from the last ~6 step intervals
 *   impact    peak |a| per step (g), mean of the last 4 steps
 *   stepTime  ms between steps
 * These are estimates from one sensor, not force-plate or IMU-lab values:
 * impact depends on where the phone sits, cadence is the robust one.
 */
export const G = 9.80665;

/** Step detector on |a| samples (g). Feed with push(t_ms, a_g); pure, testable. */
export function makeStepDetector({ minGap = 240, floor = 1.25, maxGap = 2000 } = {}) {
  let lp = NaN, mean = 1, prev2 = NaN, prev1 = NaN, prevT = 0, lastStep = -1e9;
  const steps = [], raw = [];  // steps: { t, peak }; raw: last samples, for the true (unfiltered) impact peak
  return {
    push(t, a) {
      raw.push(a); if (raw.length > 8) raw.shift();
      lp = Number.isFinite(lp) ? lp + 0.35 * (a - lp) : a;          // light low-pass (~10 Hz at 60 Hz sampling)
      mean += 0.01 * (lp - mean);                                    // slow running mean (~1.6 s)
      let step = null;
      // local maximum of the low-passed signal, above the floor and the running mean, far enough from the last step
      if (Number.isFinite(prev2) && prev1 > prev2 && prev1 >= lp && prev1 > Math.max(floor, mean + 0.25) && prevT - lastStep >= minGap) {
        lastStep = prevT; step = { t: prevT, peak: Math.max(...raw) }; steps.push(step);
        while (steps.length > 12) steps.shift();
      }
      prev2 = prev1; prev1 = lp; prevT = t;
      return step;
    },
    /** Current values at time t (ms): NaN when no steps for maxGap ms. */
    /** Current low-passed |a| in g (the live acceleration). */
    level() { return lp; },
    values(t) {
      if (!steps.length || t - steps[steps.length - 1].t > maxGap) return { cadence: NaN, impact: NaN, stepTime: NaN, steps: steps.length };
      const s = steps.slice(-7), gaps = [];
      for (let i = 1; i < s.length; i++) { const d = s[i].t - s[i - 1].t; if (d < maxGap) gaps.push(d); }
      const stepTime = gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : NaN;
      const pk = steps.slice(-4).map((x) => x.peak);
      return { cadence: stepTime ? 60000 / stepTime : NaN, impact: pk.reduce((x, y) => x + y, 0) / pk.length, stepTime, steps: steps.length };
    },
    reset() { lp = NaN; mean = 1; prev2 = prev1 = NaN; lastStep = -1e9; steps.length = 0; raw.length = 0; },
  };
}

/** iOS / iPadOS (an iPad asks for a desktop site, so also a "Mac" with touch). */
export const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent || "")
  || (/Macintosh/.test(navigator.userAgent || "") && navigator.maxTouchPoints > 1);

/** Start listening. onSample(t_ms, a_g, [x,y,z] in g). Resolves to a stop() function, or throws with a readable message. */
export async function startMotion(onSample) {
  if (!("DeviceMotionEvent" in window)) throw new Error("no motion sensor in this browser");
  if (!window.isSecureContext) throw new Error("needs https (open the live site on the phone)");
  if (typeof DeviceMotionEvent.requestPermission === "function") {          // iOS 13+
    const r = await DeviceMotionEvent.requestPermission();
    if (r !== "granted") throw new Error("motion access was not allowed");
  }
  // iPhone/iPad (Safari and every iOS browser, all WebKit) report accelerationIncludingGravity
  // with the opposite sign to Android and the W3C spec: flat on a table, z reads -1 g instead
  // of +1 g. Flip it so x, y, z and the segment angles mean the same on both. |a| is unchanged.
  const sign = isIOS() ? -1 : 1;
  let got = false;
  const h = (e) => {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
    got = true;
    onSample(performance.now(), Math.hypot(a.x, a.y, a.z) / G, [sign * a.x / G, sign * a.y / G, sign * a.z / G]);
  };
  window.addEventListener("devicemotion", h);
  await new Promise((r) => setTimeout(r, 1200));
  if (!got) { window.removeEventListener("devicemotion", h); throw new Error("no motion data (a computer has no accelerometer: use the phone)"); }
  return () => window.removeEventListener("devicemotion", h);
}
