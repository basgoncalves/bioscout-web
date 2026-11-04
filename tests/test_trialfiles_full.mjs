/* Every metric the surrogate predicts must reach a file. The download used to
 * drop muscle power, the 3D ground reaction and the JCF contributions on the
 * floor, and "Open in Process" handed over only angles and moments. */
import { trialFiles } from "../src/osimexport.js";

const n = 5, times = [0, 0.1, 0.2, 0.3, 0.4];
const col = (v) => Array.from({ length: n }, () => v);
const rep = {
  times,
  coords: { hip_flexion_r: col(10), knee_angle_r: col(-20) },
  dyn: { hip_moment: col(1), knee_moment: col(2), ankle_moment: col(3),
         grf_vertical: col(800), grf_horizontal: col(20) },
  forces: Array.from({ length: n }, () => [100, 200]),
  forceNames: ["vaslat_r", "glmax1_r"],
  jrf: Array.from({ length: n }, () => [3.2, 2.1]),
  jrfNames: ["knee_r_mag", "hip_r_mag"],
  osimOut: {
    moments: Array.from({ length: n }, () => [5]), momentNames: ["hip_flexion_r"],
    activations: Array.from({ length: n }, () => [0.3, 0.4]), activationNames: ["vaslat_r", "glmax1_r"],
    power: Array.from({ length: n }, () => [12, -4]), powerNames: ["vaslat_r", "glmax1_r"],
    grf: Array.from({ length: n }, () => [20, 800, 7, -18, 790, -6]),
    grfNames: ["grf_r_fx", "grf_r_fy", "grf_r_fz", "grf_l_fx", "grf_l_fy", "grf_l_fz"],
    jrfComp: Array.from({ length: n }, () => [1, 2, 3]), jrfCompNames: ["knee_r_fx", "knee_r_fy", "knee_r_fz"],
  },
};
const contrib = { r: { knee: { total: col(3.2), groups: { vas: col(2.0), oth: col(0.4) }, seg: col(0.8) } } };

const files = trialFiles("squat_01", rep,
  { columns: ["hip_flexion_r", "knee_angle_r"], osimModel: "gpk", massKg: 80, contrib });
const leaves = files.map((f) => f.name.split("/").pop());
const want = ["joint_angles.mot", "inverse_dynamics.sto", "inverse_dynamics_2d.sto",
  "StaticOptimization_force.sto", "StaticOptimization_activation.sto", "muscle_power.sto",
  "ground_reaction.mot", "output_so.sto", "contributions_so.sto"];
for (const w of want) {
  if (!leaves.includes(w)) throw new Error(`trialFiles did not write ${w} (got ${leaves.join(", ")})`);
}

const txt = (leaf) => files.find((f) => f.name.endsWith(leaf)).data;

// Medio-lateral must be a column of its own, not only buried in the force file.
const grf = txt("ground_reaction.mot");
if (!/\bgrf_r_fz\b/.test(grf) || !/\bgrf_l_fz\b/.test(grf)) throw new Error("ground_reaction.mot has no medio-lateral column");
if (!/\b7\b/.test(grf)) throw new Error("ground_reaction.mot lost its values");

const pow = txt("muscle_power.sto");
if (!/\bvaslat_r\b/.test(pow) || !/-4/.test(pow)) throw new Error("muscle_power.sto is wrong");

const con = txt("contributions_so.sto");
for (const c of ["knee_r_total", "knee_r_vas", "knee_r_intersegmental"]) {
  if (!new RegExp(`\\b${c}\\b`).test(con)) throw new Error(`contributions_so.sto has no ${c}`);
}
// Columns must line up with the right series, not be shuffled by indexOf games.
const rows = con.trim().split("\n");
const hdr = rows[rows.findIndex((l) => /^time\b/.test(l))].trim().split(/\s+/);
const vals = rows[rows.findIndex((l) => /^time\b/.test(l)) + 1].trim().split(/\s+/).map(Number);
const at = (c) => vals[hdr.indexOf(c)];
if (Math.abs(at("knee_r_total") - 3.2) > 1e-9) throw new Error("contrib total column misaligned");
if (Math.abs(at("knee_r_vas") - 2.0) > 1e-9) throw new Error("contrib group column misaligned");
if (Math.abs(at("knee_r_intersegmental") - 0.8) > 1e-9) throw new Error("contrib remainder misaligned");

// No power, no contributions -> no empty files.
const bare = trialFiles("squat_01", { times, coords: rep.coords }, { columns: ["hip_flexion_r"] })
  .map((f) => f.name.split("/").pop());
for (const no of ["muscle_power.sto", "ground_reaction.mot", "contributions_so.sto"]) {
  if (bare.includes(no)) throw new Error(`${no} written with nothing in it`);
}

console.log("ok    trialFiles writes power, 3D GRF and JCF contributions");
