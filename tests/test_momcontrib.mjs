/* Muscle contributions to a joint moment, stacked, for all three hip DOF. */
import { momentContributions, momContribSVG, armAt, MOM_DOFS } from "../src/momcontrib.js";

const n = 5;
const arms = { joints: {
  hip:           { coord: "hip_flexion_r", grid: [0, 50, 100], muscles: { psoas_r: [0.05, 0.05, 0.05], glmax1_r: [-0.06, -0.06, -0.06] } },
  hip_adduction: { coord: "hip_adduction_r", grid: [-10, 0, 10], muscles: { addlong_r: [0.058, 0.058, 0.058], glmed1_r: [-0.04, -0.04, -0.04] } },
  hip_rotation:  { coord: "hip_rotation_r", grid: [-10, 0, 10], muscles: { piri_r: [-0.026, -0.026, -0.026] } },
} };
const rep = {
  times: [0, 1, 2, 3, 4],
  coords: { hip_flexion_r: [0, 25, 50, 75, 100] },
  forceNames: ["psoas_r", "glmax1_r", "addlong_r", "glmed1_r", "piri_r", "psoas_l"],
  forces: Array.from({ length: n }, () => [100, 200, 300, 400, 500, 999]),
};
const mj = { muscleJoints: { psoas_r: ["hip"], glmax1_r: ["hip"], addlong_r: ["hip"],
                             glmed1_r: ["hip"], piri_r: ["hip"], psoas_l: ["hip"] } };

const dof = (k) => MOM_DOFS.find((d) => d.key === k);

// Sagittal: psoas +5 N·m, glute max -12 N·m. The other side must not appear.
const h = momentContributions(rep, { dof: dof("hip"), side: "r", arms, muscleJoints: mj,
                                     net: new Array(n).fill(-5) });
if (!h) throw new Error("no sagittal hip decomposition");
if (!h.angleKnown) throw new Error("hip_flexion_r is measured, angleKnown should be true");
const g = (c, k) => c.groups.find((x) => x.key === k);
if (Math.abs(g(h, "ilio").y[0] - 5) > 1e-9) throw new Error(`iliopsoas ${g(h, "ilio").y[0]}, expected 5`);
if (Math.abs(g(h, "glmax").y[0] + 12) > 1e-9) throw new Error(`glute max ${g(h, "glmax").y[0]}, expected -12`);
// Residual closes the books: net minus the muscle sum.
if (Math.abs(h.residual[0] - (-5 - (5 - 12))) > 1e-9) throw new Error(`residual ${h.residual[0]}`);
if (h.nMuscles !== 2) throw new Error(`${h.nMuscles} muscles crossed the sagittal hip, expected 2 (the left side must not count)`);

/* The whole point of the change: the frontal and transverse hip are their own
 * decompositions, not a copy of the sagittal one. */
const ad = momentContributions(rep, { dof: dof("hip_adduction"), side: "r", arms, muscleJoints: mj });
if (!ad) throw new Error("no frontal hip decomposition");
if (ad.angleKnown) throw new Error("one camera cannot measure hip adduction: angleKnown must be false");
if (Math.abs(g(ad, "add").y[0] - 300 * 0.058) > 1e-9) throw new Error("adductor contribution wrong in the frontal plane");
if (Math.abs(g(ad, "glmed").y[0] + 400 * 0.04) > 1e-9) throw new Error("glute med contribution wrong in the frontal plane");
if (g(ad, "ilio")) throw new Error("a muscle with no frontal arm must not appear in the frontal plane");

const ro = momentContributions(rep, { dof: dof("hip_rotation"), side: "r", arms, muscleJoints: mj });
if (!ro || !g(ro, "oth")) throw new Error("no transverse hip decomposition");
if (Math.abs(g(ro, "oth").y[0] + 500 * 0.026) > 1e-9) throw new Error("piriformis contribution wrong in the transverse plane");

// An unmeasured angle reads the table at neutral, not at the first grid point.
const flat = armAt(arms.joints.hip_adduction, "addlong_r", [0, 0, 0]);
if (flat.some((v) => Math.abs(v - 0.058) > 1e-12)) throw new Error("neutral lookup wrong");
if (armAt(arms.joints.hip, "nosuch_r", [0]) !== null) throw new Error("a muscle not in the table must return null");

/* The stack grows both ways from zero: a flexor and an extensor must not be
 * piled on top of each other as if they agreed. */
const svg = momContribSVG(h, { t: (k) => k });
if (!/polygon/.test(svg) || !/polyline/.test(svg)) throw new Error("stacked areas and the net line must both be drawn");
const ys = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) =>
  m[1].split(" ").map((p) => +p.split(",")[1]));
const zero = Math.min(...ys.flat()), full = Math.max(...ys.flat());
if (!(full > zero)) throw new Error("degenerate stack");
if (momContribSVG(null) !== "") throw new Error("nothing to draw should draw nothing");

// No net moment given: still a figure, just no line and no residual band.
const noNet = momentContributions(rep, { dof: dof("hip"), side: "r", arms, muscleJoints: mj });
if (noNet.net !== null || noNet.residual !== null) throw new Error("net invented from nothing");
if (/polyline/.test(momContribSVG(noNet, { t: (k) => k }))) throw new Error("a net line was drawn without a net moment");

console.log("ok    moment contributions stack per DOF, all three hip planes");
