/**
 * Upper-body muscle forces for the arm tasks.
 *
 *   node tests/test_armmuscles.mjs
 */
import { armMuscleForces, ARM_MUSCLES, ARM_TASKS } from "../src/armmuscles.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};
const LEG = /^(soleus|gas|vas|recfem|glmax|bf|semi|tib|psoas|iliacus)/;
ok(!ARM_MUSCLES.some((m) => LEG.test(m.name)), "no lower-limb muscle in the arm set");
ok(ARM_TASKS.has("pullup") && ARM_TASKS.has("dip"), "pull-up and dip use the arm model");

const rowOf = (out, n, t) => out.forces[t][out.muscleNames.indexOf(n)];
const moments = (out, t) => {
  let e = 0, s = 0;
  out.muscleNames.forEach((n, i) => {
    const m = ARM_MUSCLES.find((x) => x.name === n);
    e += m.elbow * out.forces[t][i]; s += m.shoulder * out.forces[t][i];
  });
  return [e, s];
};

// Pull-up, side on: elbow flexion (M<0), shoulder extension (M>0).
{
  const out = armMuscleForces({ elbow_moment: [-30, -40], shoulder_moment: [50, 60] });
  const [e, s] = moments(out, 1);
  ok(Math.abs(e + 40) < 1e-6 && Math.abs(s - 60) < 1e-6, "moments are reproduced exactly",
     `${e.toFixed(3)} ${s.toFixed(3)}`);
  ok(out.forces.every((r) => [...r].every((v) => v >= 0)), "no muscle pushes");
  ok(rowOf(out, "bic", 1) > 0 && rowOf(out, "brachialis", 1) > 0, "elbow flexors work");
  ok(rowOf(out, "ter_maj", 1) > 0 && rowOf(out, "pect_maj_t", 1) > 0, "shoulder extensors work");
  ok(rowOf(out, "tric_lat", 1) === 0 && rowOf(out, "delt_clav", 1) === 0,
     "antagonists stay silent");
}
// Dip bottom: elbow extension (M>0), shoulder flexion (M<0).
{
  const out = armMuscleForces({ elbow_moment: [45], shoulder_moment: [-35] });
  const [e, s] = moments(out, 0);
  ok(Math.abs(e - 45) < 1e-6 && Math.abs(s + 35) < 1e-6, "dip moments reproduced");
  ok(rowOf(out, "tric_lat", 0) > 0 && rowOf(out, "delt_clav", 0) > 0, "triceps and anterior deltoid work");
  ok(rowOf(out, "bic", 0) >= 0 && rowOf(out, "ter_maj", 0) === 0, "pullers stay silent");
}
// Face-on: shoulder only, so no elbow-only muscles are reported.
{
  const out = armMuscleForces({ shoulder_moment: [40] });
  ok(!out.muscleNames.includes("brachialis") && out.muscleNames.includes("ter_maj"),
     "face-on leaves the elbow-only muscles out");
}
ok(armMuscleForces({ knee_moment: [1] }) === null, "no arm moments, no arm muscles");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
