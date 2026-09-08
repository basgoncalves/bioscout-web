/**
 * muscle_groups.js -- functional groups over the model's muscle names.
 *
 * The surrogate predicts 80 individual muscle forces. Eighty numbers is not a
 * training record: nobody tracks vasint separately from vaslat between sets,
 * and the one that happens to peak highest changes from stride to stride for
 * reasons that are about the model, not the athlete. What does carry between
 * sets is the group -- did the plantar flexors produce less this set than the
 * last one.
 *
 * MEMBERSHIP IS BY ACTION, NOT BY JOINT. muscle_joints.json says which muscles
 * CROSS a joint, which is a different question: the hamstrings cross the hip
 * and the knee, and they extend the first and flex the second, so they belong
 * to two groups here with different roles. The lists below are the standard
 * Rajagopal-model naming, and the borderline cases are left OUT rather than
 * assigned on a guess:
 *
 *   - the adductors are omitted from the hip groups. Their sagittal action
 *     reverses with hip angle -- extensors from flexion, flexors from
 *     extension -- so a single group label is wrong at one end of every
 *     stride.
 *   - gracilis and sartorius are in the knee flexors (their knee action is
 *     unambiguous) but not the hip flexors, where they are minor.
 *   - tibialis posterior is a plantar flexor and is included; the peroneals
 *     and the long toe flexors are omitted, being primarily everters and toe
 *     flexors.
 *
 * These are summaries for tracking, not an anatomy reference, and the peaks
 * they carry come from a surrogate whose limits are stated wherever its
 * numbers are shown.
 */
export const MUSCLE_GROUPS = {
  hip_ext:   { label: "Hip extensors",
               members: ["glmax1", "glmax2", "glmax3",
                         "bflh", "semimem", "semiten"] },
  hip_flex:  { label: "Hip flexors",
               members: ["iliacus", "psoas", "recfem", "sart", "tfl"] },
  knee_ext:  { label: "Knee extensors",
               members: ["vasint", "vaslat", "vasmed", "recfem"] },
  knee_flex: { label: "Knee flexors",
               members: ["bflh", "bfsh", "semimem", "semiten", "grac", "sart"] },
  ankle_pf:  { label: "Ankle plantar flexors",
               members: ["gasmed", "gaslat", "soleus", "tibpost"] },
};

/** "vaslat_r" -> "vaslat"; anything without a side suffix is left alone. */
export const baseMuscle = (n) => String(n).replace(/_[lr]$/, "");
export const muscleSide = (n) => (/_l$/.test(n) ? "l" : /_r$/.test(n) ? "r" : null);

/**
 * Peak force per group, in the units the forces came in.
 *
 * `forces` is one row per frame, one column per muscle, matching `names`.
 * `side` picks a limb ("l" or "r"); with none given, each group takes the
 * larger of the two sides, because a summary that silently averaged a strong
 * limb with a weak one would hide the asymmetry it exists to show.
 *
 * A group with no member present in `names` is absent from the result rather
 * than zero: zero is a force the athlete produced, and "not modelled" is not.
 */
export function groupPeaks(forces, names, side = null) {
  if (!Array.isArray(forces) || !forces.length || !Array.isArray(names)) return {};
  const cols = new Map();
  names.forEach((n, i) => {
    const s = muscleSide(n);
    if (side && s && s !== side) return;
    const b = baseMuscle(n);
    if (!cols.has(b)) cols.set(b, []);
    cols.get(b).push(i);
  });
  const out = {};
  for (const [key, g] of Object.entries(MUSCLE_GROUPS)) {
    const idx = g.members.flatMap((m) => cols.get(m) || []);
    if (!idx.length) continue;
    let peak = 0, seen = false;
    for (const row of forces) {
      for (const i of idx) {
        const v = Math.abs(row[i]);
        if (Number.isFinite(v)) { seen = true; if (v > peak) peak = v; }
      }
    }
    if (seen) out[key] = peak;
  }
  return out;
}
