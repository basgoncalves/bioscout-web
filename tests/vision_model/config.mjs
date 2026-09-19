/**
 * config.mjs -- which models are compared, and what a clip manifest looks like.
 *
 * `full` is the model the app ships today and is the BASELINE: every report is
 * read as "what would change if we switched". It is the vendored file, not a
 * fresh download, so the baseline is literally what users are running.
 *
 * `lite` and `heavy` are the same architecture family at different sizes and
 * so need no new adapter code -- same landmarks, same 33 names, same options.
 * That is the whole reason to start here: any difference the harness reports
 * is the model, not a mapping, a landmark set or a convention.
 *
 * Adding a model with a DIFFERENT landmark set (MoveNet's 17, say) means more
 * than a line in this table: it has no heels and no foot index, so gait,
 * heel raises and the tip-toe test lose their measurement entirely. Add it
 * with a converter in lib/format.mjs and a documented list of tasks it cannot
 * do -- do not let it report a number for those.
 */

export const MODELS = [
  {
    id: "lite",
    label: "MediaPipe Pose lite (float16)",
    task: "tests/vision_model/models/pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    delegate: "GPU",
  },
  {
    id: "full",
    label: "MediaPipe Pose full (float16) -- SHIPPED",
    // The vendored file the app actually loads.
    task: "assets/pose_landmarker_full.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    delegate: "GPU",
    baseline: true,
  },
  {
    id: "heavy",
    label: "MediaPipe Pose heavy (float16)",
    task: "tests/vision_model/models/pose_landmarker_heavy.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
    delegate: "GPU",
  },
  {
    // Same weights as the shipped model on the CPU delegate. Not in the default
    // set; run it with --models full,full-cpu to see what an athlete on a phone
    // with no working GPU path is getting, which is a real population.
    id: "full-cpu",
    label: "MediaPipe Pose full, CPU delegate",
    task: "assets/pose_landmarker_full.task",
    delegate: "CPU",
    optional: true,
  },
];

export const DEFAULT_MODEL_IDS = ["lite", "full", "heavy"];

/**
 * How good is good enough. These are the harness's PASS/FAIL lines, and they
 * are judgement calls rather than measurements -- stated here, in one place, so
 * they can be argued with.
 *
 * The joint-angle line is the one that matters: 5 deg RMSE against marker-based
 * IK is roughly where 2D video and a marker set stop agreeing for reasons that
 * are the camera rather than the model (soft tissue, the sagittal assumption,
 * joint-centre definitions). A model that beats it is not thereby "valid" --
 * see bioscout_test_validity notes -- it is merely no longer the limiting
 * factor.
 */
export const THRESHOLDS = {
  rmseDeg: 5.0,          // per joint, against IK
  romErrDeg: 8.0,        // range of motion
  repDiff: 0,            // reps must match exactly
  detection: 0.95,       // frames with a body
  keyPresence: 0.90,     // the lower-limb landmarks the tasks need
  jitterPct: 1.0,        // % of torso length, RMS second difference
  segmentCV: 6.0,        // % length variation of a bone that cannot change
  swapsPerS: 0.05,       // left/right label crossings
};

/** A manifest entry, annotated. Copy clips/manifest.example.json to start. */
export const CLIP_SCHEMA = {
  id: "unique id, used in filenames",
  video: "path from the repo root, e.g. tests/vision_model/clips/sub01_squat.mp4",
  activity: "one of the ACTIVITIES keys in src/kinematics.js",
  fps: "filmed frame rate; null means assume 30 and say so",
  from: "start of the analysed window, seconds (optional)",
  to: "end of the analysed window, seconds (optional)",
  heightM: "the athlete's height -- sets the pixel-to-metre scale",
  massKg: "body mass, for anything kinetic",
  groundTruth: {
    file: "path to an OpenSim .mot/.sto/csv of IK angles",
    convention: "rajagopal | gait2392 | gpk",
    offsetS: "lab clock minus video clock; null to recover by cross-correlation",
    syncChannel: "angle key to align on; null picks the busiest shared one",
    events: { repStartsS: "optional list of event times, lab clock" },
  },
  expect: { activity: "what classify() should say", reps: "how many reps there are" },
};
