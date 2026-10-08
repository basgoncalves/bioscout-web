/**
 * The OpenSim-style session export.
 *
 *   node tests/test_osimexport.mjs
 */
import { writeSto, trialName, sessionName, writeTrc, buildSessionFiles } from "../src/osimexport.js";

let bad = 0;
const ok = (c, m, extra = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`); if (!c) bad++; };

/** Read a storage file back the way OpenSim does: header to endheader, then
 *  a tab-separated column line and one row per frame. */
function readSto(text) {
  const L = text.trimEnd().split("\n");
  const e = L.findIndex((l) => l.trim() === "endheader");
  const head = L.slice(0, e);
  const cols = L[e + 1].split("\t");
  const rows = L.slice(e + 2).map((l) => l.split("\t").map(Number));
  const n = +head.find((l) => l.startsWith("nRows=")).split("=")[1];
  const c = +head.find((l) => l.startsWith("nColumns=")).split("=")[1];
  return { head, cols, rows, n, c };
}

console.log("Storage files");
{
  const s = readSto(writeSto("Static Optimization", ["soleus_r", "vaslat_r"], [0, 0.01],
    [[100, 200], [110, NaN]], { note: "line one\nmentions endheader here" }));
  ok(s.cols.join() === "time,soleus_r,vaslat_r" && s.n === 2 && s.c === 3, "OpenSim header: rows and columns counted, time first");
  ok(s.rows.length === 2 && s.rows.every((r) => r.length === 3) && s.rows[1][2] === 0, "every row complete; a missing value is written as 0");
  ok(s.head.filter((l) => l.trim() === "endheader").length === 0, "a note cannot end the header early");
}

console.log("Names");
ok(trialName("squat", 3) === "Squat_03" && trialName("cmj", 12) === "Cmj_12", "trials are named like lab trials");
ok(sessionName(new Date(2024, 2, 11)) === "24_03_11", "sessions are YY_MM_DD");

console.log("A set, end to end");
{
  const times = [1, 1.1, 1.2];
  const rep = (k) => ({
    rep: k, times, coords: { hip_flexion_r: [10, 20, 30], knee_angle_r: [-5, -40, -10] },
    forces: times.map(() => Float64Array.from([300, 500])), forceNames: ["soleus_r", "vaslat_r"],
    jrf: times.map(() => Float64Array.from([2, 3])), jrfNames: ["hip_r_mag", "knee_r_mag"],
    dyn: { hip_moment: [1, 2, 3], knee_moment: [4, 5, 6] },
    osimOut: { activations: times.map(() => Float64Array.from([0.2, 0.4])), activationNames: ["soleus_r", "vaslat_r"],
               moments: times.map(() => Float64Array.from([50, -20])), momentNames: ["hip_flexion_r_moment", "knee_angle_r_moment"],
               grf: times.map(() => Float64Array.from([0, 800, 0])), grfNames: ["grf_r_fx", "grf_r_fy", "grf_r_fz"],
               jrfComp: times.map(() => Float64Array.from([10, -1500, 30])), jrfCompNames: ["hip_r_fx", "hip_r_fy", "hip_r_fz"] },
  });
  const res = { activity: "squat", osimModel: "gpk", pxPerM: 400, columns: ["hip_flexion_r", "knee_angle_r"], reps: [rep(1), rep(2)] };
  const frames = [0, 1, 2].map((i) => ({ t: 1000 + i * 33, lm: { left_hip: [100, 600, 10], right_hip: [120, 602, -10] } }));
  const { root, files } = buildSessionFiles({ athlete: "Bas W.", date: new Date(2026, 9, 8), massKg: 80,
    set: { res, fps: 30, setIndex: 2, frames, video: { name: "video.webm", data: new Uint8Array(3) } },
    extra: [{ name: "summary_kinematics.png", data: new Uint8Array(1) }] });
  const names = files.map((f) => f.name);
  const has = (p) => names.includes(`${root}/${p}`);
  ok(root === "Bas_W/26_10_08", "Athlete/YY_MM_DD", root);
  ok(has("session.yaml") && has("2_experimental/Squat_02/marker_experimental.trc") && has("2_experimental/Squat_02/video.webm"),
     "session.yaml, and the trial's experimental folder with pose markers and video");
  const it = "3_iterations/bioscout_web/Squat_02_rep01/";
  ok(["external_biomechanics/joint_angles.mot", "external_biomechanics/inverse_dynamics.sto",
      "external_biomechanics/inverse_dynamics_2d.sto", "static_optimisation/StaticOptimization_force.sto",
      "static_optimisation/StaticOptimization_activation.sto", "joint_contact_forces/output_so.sto"].every((p) => has(it + p)),
     "each rep has the pipeline's folders and file names");
  ok(has("4_outputs/summary_kinematics.png"), "figures go to 4_outputs");
  const get = (p) => files.find((f) => f.name === `${root}/${p}`).data;
  const act = readSto(get(it + "static_optimisation/StaticOptimization_activation.sto"));
  ok(act.cols.join() === "time,soleus_r,vaslat_r" && act.rows[0][2] === 0.4, "activations by muscle name, 0-1");
  const frc = readSto(get(it + "static_optimisation/StaticOptimization_force.sto"));
  ok(frc.cols.includes("grf_r_fy") && frc.rows[0][1] === 300, "forces in N, with the predicted ground reaction alongside");
  const jr = readSto(get(it + "joint_contact_forces/output_so.sto"));
  ok(jr.cols.includes("hip_r_fy") && jr.cols.includes("knee_r_resultant")
     && Math.abs(jr.rows[0][jr.cols.indexOf("knee_r_resultant")] - 3 * 80 * 9.80665) < 1e-3, "joint loads in N: components and resultants");
  const ang = readSto(get(it + "external_biomechanics/joint_angles.mot"));
  ok(ang.head.includes("inDegrees=yes") && ang.rows[1][0] === 1.1, "angles in degrees on the clip's own clock");
  const y = get("session.yaml");
  ok(/subject: Bas_W/.test(y) && /Squat_02_rep02:/.test(y) && /time_range: \[1\.000, 1\.200\]/.test(y) && /bioscout_web:/.test(y),
     "session.yaml lists the trials, their windows and the iteration");
  const trc = get("2_experimental/Squat_02/marker_experimental.trc").split("\n");
  ok(trc[0].startsWith("PathFileType") && trc[3].includes("left_hip") && trc[6].split("\t")[3] === "0.00500", "TRC in metres, y up from the floor");
}

console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
