/**
 * The joint-load figure (src/jointload.js): frames, signs, events, and that it
 * draws in both planes.
 *
 *   node tests/test_jointload.mjs
 */
import { jointLoadSVG, jointVectors, loadEvents, verticalGrf, niceCeiling, poseAt,
         kneeSignOf, hasJointLoad, eventFamily, JL_KEYS } from "../src/jointload.js";
import { loadTargetNames } from "../src/forces.js";
const i18n = await import("../src/i18n.js");

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) failed++; };

// every key the module can ask for exists in every language
for (const lang of i18n.ALL_LANGS) {
  i18n.setLang(lang);
  const missing = JL_KEYS.filter((k) => i18n.t(k) === k);
  check(!missing.length, `${lang}: all ${JL_KEYS.length} jointload keys translated ${missing.join(",")}`);
}
i18n.setLang("en");

// a synthetic squat: 101 frames, knee to 100 deg and back, GPK-signed (negative)
const names = loadTargetNames({ targ: { includes: () => true } });
check(names.length === 24, "24 load components asked of the model");
const n = 101, times = Array.from({ length: n }, (_, i) => i / 50);
const bell = (i) => Math.sin(Math.PI * i / (n - 1)) ** 2;
const coords = { pelvis_tilt: [], pelvis_ty: [], lumbar_extension: [] };
for (const s of ["r", "l"]) { coords[`hip_flexion_${s}`] = []; coords[`knee_angle_${s}`] = []; coords[`ankle_angle_${s}`] = []; }
const loads = [];
for (let i = 0; i < n; i++) {
  const b = bell(i);
  coords.pelvis_tilt.push(-20 * b); coords.pelvis_ty.push(0.95 - 0.35 * b); coords.lumbar_extension.push(-10 * b);
  for (const s of ["r", "l"]) {
    coords[`hip_flexion_${s}`].push(90 * b); coords[`knee_angle_${s}`].push(-100 * b); coords[`ankle_angle_${s}`].push(25 * b);
  }
  const row = new Float64Array(24);
  names.forEach((nm, k) => {
    const left = /_l_/.test(nm);
    if (/^hip_._pelvis_fy/.test(nm)) row[k] = -(1 + 2 * b);          // pelvis pushes the femur DOWN
    else if (/^hip_._pelvis_fz/.test(nm)) row[k] = (left ? -1 : 1) * 0.4;  // ...and laterally (mirrored)
    else if (/^hip_._pelvis_fx/.test(nm)) row[k] = 0.3;
    else if (/^knee_._fy/.test(nm)) row[k] = -(1 + 3 * b);
    else if (/^ankle_._fy/.test(nm)) row[k] = -(1 + 1.5 * b);
    else if (/^grf_._fy/.test(nm)) row[k] = 0.5 + 0.3 * b * (i > n / 2 ? 1.2 : 1);
  });
  loads.push(row);
}
const rep = { times, coords, loads, loadNames: names, jm: {} };

check(hasJointLoad(rep, "squat") && !hasJointLoad(rep, "pullup"), "drawn for a squat, refused for a pull-up");
check(!hasJointLoad({ ...rep, loads: null }, "squat"), "refused without force vectors (a /1 model)");
check(kneeSignOf(rep) === -1, "GPK-signed knee read off the data as flexion-negative");

// hip: shown as the load ON THE ACETABULUM -> up, medial, posterior
const hr = jointVectors(rep, "hip", "r")[50], hl = jointVectors(rep, "hip", "l")[50];
check(hr[1] > 0 && hr[2] < 0 && hr[0] < 0, `right hip load points superior + medial + posterior (${[...hr].map((v) => v.toFixed(1))})`);
check(Math.abs(hr[2] - hl[2]) < 1e-12, "left leg mirrored: lateral means lateral on both sides");
check(jointVectors(rep, "knee", "r")[50][1] < 0, "knee load on the tibia points inferior");

const grf = verticalGrf(rep, "r", 80 * 9.80665);
check(grf.source === "model", "falls back to the model GRF when the app has no foot estimate");
const own = verticalGrf({ ...rep, jm: { feet_grf_r: times.map(() => 400) } }, "r", 800);
check(own.source === "newton" && Math.abs(own.v[0] - 0.5) < 1e-9, "uses the app's own foot force, in bodyweights");

const ev = loadEvents(rep, "squat", {}, "r", grf.v, -1);
check(ev.map((e) => e.key).join() === "jlEvStart,jlEvPeakDescent,jlEvBottom,jlEvPeakAscent",
      `squat events: ${ev.map((e) => e.key + "@" + e.i).join(" ")}`);
check(ev[2].i === 50 && ev[1].i > 0 && ev[1].i < 50 && ev[3].i > 50, "bottom at the deepest frame, descent before; peak load AT the bottom yields peak ascent instead");
check(eventFamily("run", { gait: true }) === "gait" && eventFamily("cmj", { jump: true }) === "jump", "task families");

const deep = poseAt(rep, 50, -1), up = poseAt(rep, 0, -1);
check(deep.limbs.r.knee[0] > 0.1 && deep.limbs.r.ankle[0] < deep.limbs.r.knee[0],
      "deep squat: knee ahead of the hip, shank folded back under it");
check(Math.abs(up.limbs.r.ankle[0]) < 1e-9 && up.limbs.r.ankle[1] < -0.45, "standing: leg straight down");

check(niceCeiling(22.6) === 30 && niceCeiling(3.2) === 4 && niceCeiling(0) === 1, "rim ladder matches the Python figure");

for (const plane of ["sagittal", "frontal"]) {
  const fig = jointLoadSVG(rep, { plane, side: "r", activity: "squat", massKg: 80, tr: i18n.t });
  check(fig && fig.svg.startsWith("<svg") && !/NaN|undefined/.test(fig.svg), `${plane}: draws, no NaN/undefined in the markup`);
  check(fig.events.length === 4 && fig.rim === 4, `${plane}: 4 events, shared rim ${fig.rim} BW`);
  check(fig.svg.includes(plane === "frontal" ? ">LAT<" : ">ANT<"), `${plane}: axis labelled for its plane`);
}
// the dial's length is the table's number: the model's *_mag target
{
  const jrfNames = ["hip_r_mag", "knee_r_mag", "ankle_r_mag", "hip_l_mag", "knee_l_mag", "ankle_l_mag"];
  const jrf = loads.map((_, i) => Float64Array.from([5 + i / 100, 6, 7, 1, 1, 1]));
  const fig = jointLoadSVG({ ...rep, jrf, jrfNames }, { plane: "sagittal", side: "r", activity: "squat", massKg: 80, tr: i18n.t });
  check(Math.abs(fig.peaks.hip - 6) < 1e-9 && fig.peaks.knee === 6 && fig.peaks.ankle === 7,
        `peaks come from the magnitude targets (hip ${fig.peaks.hip}, knee ${fig.peaks.knee}, ankle ${fig.peaks.ankle})`);
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
