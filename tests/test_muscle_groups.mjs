/**
 * Functional muscle groups.
 *
 *   node tests/test_muscle_groups.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { MUSCLE_GROUPS, groupPeaks, baseMuscle, muscleSide }
  from "../src/muscle_groups.js";

let bad = 0;
const ok = (c, m, extra = "") => {
  console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`);
  if (!c) bad++;
};

ok(baseMuscle("vaslat_r") === "vaslat", "the side suffix comes off the name");
ok(baseMuscle("soleus") === "soleus", "a name without one is untouched");
ok(muscleSide("bflh_l") === "l" && muscleSide("bflh_r") === "r", "and is read back");

/* The groups must name muscles the MODEL actually has. A typo here is silent:
 * the group simply never appears, and a measure that never appears looks like
 * a measure the athlete never produced. */
if (existsSync("data/muscle_joints.json")) {
  const mj = JSON.parse(readFileSync("data/muscle_joints.json", "utf8"));
  const known = new Set(Object.values(mj.byJoint || {}).flat().map(baseMuscle));
  for (const [key, g] of Object.entries(MUSCLE_GROUPS)) {
    const missing = g.members.filter((m) => !known.has(m));
    ok(!missing.length, `${key}: every member exists in the model`, missing.join(" "));
  }
} else {
  console.log("skip  data/muscle_joints.json is not in this checkout");
}

/* The hamstrings extend the hip and flex the knee, so they are in both. That
 * is the whole reason these are not just the joint lists. */
ok(MUSCLE_GROUPS.hip_ext.members.includes("semimem")
   && MUSCLE_GROUPS.knee_flex.members.includes("semimem"),
   "a two-joint muscle belongs to a group at each joint");
ok(MUSCLE_GROUPS.knee_ext.members.includes("recfem")
   && MUSCLE_GROUPS.hip_flex.members.includes("recfem"),
   "and rectus femoris likewise");
ok(!MUSCLE_GROUPS.hip_ext.members.some((m) => m.startsWith("addmag")),
   "the adductors are left out rather than assigned a sagittal role they change");

const names = ["glmax1_r", "glmax1_l", "vaslat_r", "soleus_r", "notamuscle_r"];
const forces = [[10, 90, 5, 1, 999], [20, 80, 50, 3, 999]];
{
  const g = groupPeaks(forces, names, "r");
  ok(g.hip_ext === 20, "the right side's peak is the right side's", String(g.hip_ext));
  ok(g.knee_ext === 50, "knee extensors read their own columns");
  ok(g.ankle_pf === 3, "and the plantar flexors theirs");
  ok(g.knee_flex === undefined,
     "a group with no muscle present is absent, not zero");
}
{
  const g = groupPeaks(forces, names);
  ok(g.hip_ext === 90, "with no side asked for, the larger side wins", String(g.hip_ext));
}
ok(Object.keys(groupPeaks([], names, "r")).length === 0, "no frames, no peaks");
ok(Object.keys(groupPeaks(forces, null)).length === 0, "no names, no peaks");

console.log(bad ? `\nFAIL ${bad} check(s)` : "\nAll checks passed");
if (bad) process.exit(1);
