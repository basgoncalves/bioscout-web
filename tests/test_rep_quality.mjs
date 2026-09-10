/**
 * Rep windows cropped to the movement, and each rep graded clean /
 * acceptable / poor.
 *
 * The case that prompted both: a real pull-up set where rep 1's window carried
 * three seconds of dead hang and rep 4's carried a half-pull the counter had
 * refused. Rebuilt here synthetically, side-on, with the truth known:
 *
 *   hang 3 s | pull-up | hang 1.5 s | pull-up from BENT arms | hang | pull-up |
 *   a small half-pull that is not a rep | hang
 *
 *   node tests/test_rep_quality.mjs
 */
const K = await import("../src/kinematics.js");
const Q = await import("../src/repquality.js");
const I18N = await (async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  Object.defineProperty(globalThis, "navigator", { value: { languages: ["en"] }, configurable: true });
  return import("../src/i18n.js");
})();

let bad = 0;
const check = (ok, msg, detail = "") => {
  if (!ok) bad++;
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${msg}${detail ? "  " + detail : ""}`);
};

const FPS = 30, PX = 250, UA = 0.30, FA = 0.28;
const BAR = [0.05, 2.30];
const px = (p) => [500 + p[0] * PX, 1000 - p[1] * PX];
function elbowIK(S, W) {
  const dx = W[0] - S[0], dy = W[1] - S[1], D = Math.hypot(dx, dy);
  const d = Math.min(D, UA + FA - 1e-6);
  const a = (UA * UA - FA * FA + d * d) / (2 * d), h = Math.sqrt(Math.max(0, UA * UA - a * a));
  const ux = dx / D, uy = dy / D, m = [S[0] + a * ux, S[1] + a * uy];
  return [m[0] + h * uy, m[1] - h * ux];            // elbow forward
}

/** Shoulder height below the bar per frame, from a list of segments. */
function pullupClip(segs) {
  const low = UA + FA - 0.005;                     // straight arms
  const y = [], truth = [];
  const push = (d) => y.push(BAR[1] - d);
  for (const s of segs) {
    if (s.hang) {
      // Settle into the hang over half a second rather than teleporting there.
      const prev = y.length ? BAR[1] - y[y.length - 1] : (s.from ?? low), to = s.from ?? low;
      const n = Math.round(s.hang * FPS), ramp = Math.min(n, Math.round(0.5 * FPS));
      for (let i = 1; i <= n; i++) push(i <= ramp ? prev + (to - prev) * 0.5 * (1 - Math.cos(Math.PI * i / ramp)) : to);
      continue;
    }
    const from = s.from ?? low, to = s.to ?? 0.12, back = s.back ?? from;
    const up = Math.round(s.up * FPS), dn = Math.round(s.down * FPS);
    const t0 = y.length;
    for (let i = 1; i <= up; i++) push(from + (to - from) * 0.5 * (1 - Math.cos(Math.PI * i / up)));
    for (let i = 1; i <= dn; i++) push(to + (back - to) * 0.5 * (1 - Math.cos(Math.PI * i / dn)));
    truth.push({ start: t0 / FPS, top: (t0 + up) / FPS, end: (t0 + up + dn) / FPS, partial: !!s.partial });
  }
  let seed = 7;
  const noise = () => { seed = (seed * 16807) % 2147483647; return ((seed / 2147483647) - 0.5) * 3; };
  const poses = {};
  y.forEach((sy, i) => {
    const S = [0, sy], E = elbowIK(S, BAR);
    const H = [0, sy - 0.50], Kn = [0.02, H[1] - 0.45], A = [0, Kn[1] - 0.43];
    const lm = {};
    for (const sd of ["left", "right"]) {
      const o = sd === "left" ? -0.01 : 0.01, P = (p) => { const q = px([p[0] + o, p[1]]); return [q[0] + noise(), q[1] + noise()]; };
      lm[`${sd}_shoulder`] = P(S); lm[`${sd}_elbow`] = P(E); lm[`${sd}_wrist`] = P(BAR);
      lm[`${sd}_hip`] = P(H); lm[`${sd}_knee`] = P(Kn); lm[`${sd}_ankle`] = P(A);
      lm[`${sd}_foot_index`] = P([A[0] + 0.12, A[1] - 0.03]);
    }
    lm.nose = px([0.08, sy + 0.25]);
    poses[i] = lm;
  });
  return { poses, truth };
}

console.log("cropping a pull-up set with rests in it");
const { poses, truth } = pullupClip([
  { hang: 3.0 },
  { up: 1.2, down: 1.2 },
  { hang: 1.5, from: 0.40 },                              // resting on bent arms
  { up: 1.1, down: 1.3, from: 0.40, back: UA + FA - 0.005 },  // ...down to straight arms
  { hang: 1.5 },
  { up: 1.2, down: 1.2 },
  { hang: 0.8 },
  { up: 0.5, down: 0.5, to: 0.50, partial: true },        // a half-pull, not a rep
  { hang: 1.5 },
]);
const res = K.analyse(poses, FPS, { heightM: 1.81, activity: "pullup" });
const real = truth.filter((t) => !t.partial);
check(res.reps.length === real.length, "three reps, the half-pull not counted", `${res.reps.length} found`);
res.reps.forEach((r, k) => {
  const t = real[k]; if (!t) return;
  const s = r.bounds[0] / FPS, e = r.bounds[2] / FPS;
  check(s >= t.start - 0.3 && s <= t.start + 0.2 && e <= t.end + 0.3 && e >= t.end - 0.25,
        `rep ${k + 1} window hugs the movement`,
        `${s.toFixed(2)}-${e.toFixed(2)} s vs true ${t.start.toFixed(2)}-${t.end.toFixed(2)} s`);
  check(Math.abs(r.concentric_s - (t.top - t.start)) < 0.3,
        `rep ${k + 1} "up" time is the pull, not the hang`, `${r.concentric_s.toFixed(2)} s vs ${(t.top - t.start).toFixed(2)} s`);
});
const half = truth.find((t) => t.partial);
check(res.reps.every((r) => r.bounds[2] / FPS < half.start), "no window reaches into the half-pull");
const raw = K.analyse(poses, FPS, { heightM: 1.81, activity: "pullup", trim: false });
check(raw.reps[0].bounds[0] / FPS < 2.5, "(and without the crop, rep 1 would have started in the hang)",
      `${(raw.reps[0].bounds[0] / FPS).toFixed(2)} s`);

console.log("grading");
const counts = Q.gradeReps(res);
check(res.reps[0].quality === "clean" && res.reps[2].quality === "clean",
      "full reps from a dead hang are clean", res.reps.map((r) => r.quality).join(", "));
const r2 = res.reps[1];
check(r2.quality !== "clean" && r2.qualityNotes.some((n) => n.code === "lockout"),
      "the rep started from bent arms is not clean, and says why",
      `${r2.quality}: ${JSON.stringify(r2.qualityNotes)}`);
check(counts.clean + counts.acceptable + counts.poor === res.reps.length, "every rep graded");

{
  const mk = (h, extra = {}) => ({ height_flight_m: h, ...extra });
  const set = { activity: "cmj", reps: [mk(0.40), mk(0.39), mk(0.33), mk(0.25), mk(0.40, { mismatch: true })] };
  Q.gradeReps(set);
  check(set.reps.map((r) => r.quality).join() === "clean,clean,acceptable,poor,acceptable",
        "jumps: against your best jump, and the jump type", set.reps.map((r) => r.quality).join(", "));
}
{
  const set = { activity: "run", reps: [1, 2, 3, 4, 5, 6].map((k) => ({ stance_side: k % 2 ? "l" : "r",
    duration_s: k === 5 ? 0.95 : 0.70 })) };
  Q.gradeReps(set);
  check(set.reps[4].quality === "poor" && set.reps[0].quality === "clean", "a stride unlike the others stands out");
}

console.log("translations");
for (const lang of ["en", "pt", "de"]) {
  I18N.setLang(lang);
  const missing = Q.NOTE_CODES.filter((c) => I18N.t("qn_" + c, { v: 1 }) === "qn_" + c)
    .concat(Q.GRADES.filter((g) => I18N.t("qGrade_" + g) === "qGrade_" + g));
  check(!missing.length, `${lang}: every grade and reason has text`, missing.join(", "));
}

console.log(bad ? `\n${bad} check(s) FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
