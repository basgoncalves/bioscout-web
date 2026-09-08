/**
 * tiptoe_ref.js -- what the literature actually says about tip-toe capacity
 * and running distance.
 *
 * These values are collated from published return-to-running frameworks and
 * normative work; the internal review that assembled them is unpublished and
 * does not ship with this build, so nothing here cites it.
 *
 * The review's finding is a NEGATIVE one, and this file exists to keep it that
 * way in the app. No peer-reviewed study establishes a tip-toe threshold -- in
 * repetitions, seconds or hops -- that predicts the ability to run any given
 * distance. The numbers below are consensus thresholds of convenience,
 * assembled from expert-opinion return-to-running frameworks and normative
 * data. The distance gradient in particular (why 20 km should need more than
 * 5 km) is an assumption, not a finding.
 *
 * So they are carried here WITH their grading attached, every row, and the
 * app is required to show the grading next to the number. A threshold that
 * arrives in the interface stripped of "very low" becomes an evidence-based
 * prerequisite in the reader's head within about one second, which is the
 * specific misreading the review was written to prevent.
 *
 * What is better supported than any count here: the symptom and load-response
 * criteria, and graded walk-run progression. Those are in SYMPTOM_CRITERIA and
 * belong on screen beside any of this.
 */

export const TIPTOE_SOURCE =
  "Collated from published return-to-running consensus and normative work — no validated threshold exists";

export const DISTANCES = ["5 km", "10 km", "20 km"];

/* Grade is for the specific claim "this value discriminates readiness for this
 * distance", NOT for the test's reliability, which is separately good. */
export const TIPTOE_THRESHOLDS = [
  {
    key: "slhr_reps",
    test: "Single-leg heel raise, reps to failure",
    protocol: "~30/min metronome, full range, fingertip support",
    by: [[20, 25], [25, 25], [25, 30]],       // [low, high] per distance
    unit: "reps",
    basis: "Normative data (age/sex adjusted) + return-to-running consensus",
    grade: "very low",
    note: "Norms are descriptive; no outcome validation.",
    measured: true,                            // BioScout counts this one
  },
  {
    key: "slhr_lsi",
    test: "Heel-raise limb symmetry index",
    protocol: "weaker side / stronger side",
    by: [[90, 90], [90, 90], [90, 90]],
    unit: "%",
    basis: "Borrowed from return-to-sport literature",
    grade: "very low",
    note: "Indirect: the LSI evidence sits in ACL rehabilitation, not running.",
    measured: true,
  },
  {
    key: "hold_s",
    test: "Sustained bilateral tip-toe hold",
    protocol: "heels up, still",
    by: [[30, 30], [45, 45], [60, 60]],
    unit: "s",
    basis: "Expert opinion only",
    grade: "very low",
    measured: false,
  },
  {
    key: "toe_walk_s",
    test: "Continuous tip-toe walking",
    protocol: "",
    by: [[60, 60], [120, 120], [120, 180]],
    unit: "s",
    basis: "Expert opinion only",
    grade: "very low",
    note: "No study reports this test at all.",
    measured: false,
  },
  {
    key: "pogo_double",
    test: "Double-leg pogo hops, continuous",
    protocol: "~2.2–2.5 Hz, stiff ankle, minimal knee flexion, pain-free",
    by: [[30, 40], [50, 50], [60, 60]],
    unit: "reps",
    basis: "Expert opinion / clinical protocols",
    grade: "very low",
    measured: false,
  },
  {
    key: "pogo_single",
    test: "Single-leg pogo hops, continuous",
    protocol: "~2.2–2.5 Hz, stiff ankle, minimal knee flexion, pain-free",
    by: [[20, 25], [25, 30], [30, 30]],
    unit: "reps",
    basis: "Expert opinion / clinical protocols",
    grade: "very low",
    measured: false,
  },
  {
    key: "hop_lsi",
    test: "Single-leg hop for distance, LSI",
    protocol: "",
    by: [[90, 90], [90, 90], [90, 90]],
    unit: "%",
    basis: "The only functional test with a signal in the tibial bone-stress-injury review",
    grade: "low",
    note: "The least unsupported row in the table.",
    measured: false,
  },
];

/* Better supported than any repetition count above, and the review is explicit
 * that this is where the actual gate lives. */
export const SYMPTOM_CRITERIA = [
  { text: "Pain during the test or run no more than 2/10", grade: "low–moderate" },
  { text: "Symptoms settle within 24 h, with no increase in next-morning stiffness", grade: "low–moderate" },
  { text: "The preceding walk–run progression step was tolerated without a flare", grade: "low" },
];

export const TIPTOE_CAVEAT =
  "No study has tested a tip-toe threshold against a running-distance outcome. "
  + "These are consensus values of convenience, and the difference between the "
  + "distances is an assumption rather than a finding. They are a starting point "
  + "for progressive loading, not a gate on who can run a distance.";

/** Where a measured value sits against a row, without calling it a pass. */
export function standing(value, row, distanceIndex) {
  if (!Number.isFinite(value) || !row?.by?.[distanceIndex]) return null;
  const [lo, hi] = row.by[distanceIndex];
  return { value, lo, hi, meets: value >= lo, comfortably: value >= hi };
}
