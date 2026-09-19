# Vision-model benchmark

Which pose model should BioScout ship, and what would change if we switched?

The app runs one model today: MediaPipe Pose **full**, vendored in
`assets/pose_landmarker_full.task`, loaded by `makeLandmarker()` in
`index.html`. This folder measures that model and its alternatives **through
the app's own analysis** — `classify()`, `analyse()`, `clipAngles()` — against
marker-based OpenSim inverse kinematics.

That framing is the point. A pose model is not judged here on its landmarks. It
is judged on whether BioScout then counts the right number of reps, calls the
right movement, and reports a knee angle the lab agrees with. A model can win
on a landmark benchmark and lose here, and it is this one that decides what an
athlete reads on their phone.

## Quick start

```bash
npm i -D playwright && npx playwright install chromium   # tracking only
node tests/vision_model/fetch_models.mjs                 # lite + heavy (~35 MB)
cp tests/vision_model/clips/manifest.example.json tests/vision_model/clips/manifest.json
# put your clips in clips/, your IK in gt/, edit manifest.json
node tests/vision_model/run.mjs
```

Results land in `results/`: `report.md` (the decision), `report.html` (the
evidence, with waveforms), `results.json` (everything).

Nothing here is needed to work on the app, and none of it runs in `npm test` —
except `selftest.mjs`, which does, through `tests/test_vision_model.mjs`.

## What it measures

**Against the lab** — per joint, per clip: RMSE, RMSE after the constant offset
is removed, bias, Bland–Altman limits, range-of-motion error, peak error, r.
Bias and shape error are kept apart on purpose: a constant offset is a
reference-posture problem and does not stop a model being usable for change
over time; an ROM error means the movement itself is under-read, and no
calibration fixes that.

**What the app then says** — the movement `classify()` picked, how many reps
`analyse()` found, and the headline numbers per task (peak knee flexion, squat
depth, jump height, stride time…). Plus *drift*: how far each outcome moves
from the shipped model, in percent. Drift needs no ground truth, so it is the
number to quote for clips the lab never saw.

**Tracking quality, no ground truth needed** — detection rate, per-landmark
presence (a model can be "detected" in every frame and still never see a heel,
which ends gait, heel raises and the tip-toe test), jitter as a percentage of
torso length, segment-length CV (a femur that changes length is depth error
leaking into the image plane), and left/right label swaps — one swap puts
thousands of newtons into an arm moment.

**Cost** — file size, engine load, first-frame latency and steady-state
ms/frame. Measured in headless Chromium on whatever machine ran it. **Read the
ratios, not the milliseconds**: that machine is not a phone.

Thresholds for all of this are in `config.mjs`, in one block, with the
reasoning attached. They are judgement calls and are meant to be argued with.

## The clips and the ground truth

`clips/manifest.json` ties a video to the task it contains and to the IK that
was recorded with it. `clips/manifest.example.json` documents every field.

The ground truth is an OpenSim `.mot`/`.sto` (or a CSV) of joint angles.
`lib/gt.mjs` maps its columns onto the app's angle keys, taking the knee sign
from the app's own `KNEE_SIGN` table so the harness cannot drift from the
exporter. Clocks are aligned either from a stated `offsetS` or by
cross-correlation, and an alignment that only reaches r < 0.5 is **refused**
rather than accepted quietly — a silently wrong offset turns a good model into
a bad one and looks exactly like a bad model.

Clips, IK and downloaded weights are gitignored: a recording of a participant
is theirs, and consent to record is not consent to publish.

## What a result does and does not mean

A model that passes every threshold here has stopped being the limiting factor
on this set of clips. It has not thereby validated anything: 2D video and a
marker set disagree for reasons that are the camera and the joint-centre
definitions rather than the model, and the claims BioScout may make about its
outputs are settled elsewhere (see the test-validity notes), not by this
benchmark. What this folder answers is narrower and useful: *of the models we
could ship, which one makes the app least wrong, and what would switching
change?*

## Adding a model

Same landmark family (any MediaPipe Pose `.task`): one entry in `MODELS` in
`config.mjs`. Nothing else.

A different landmark set is not a config change. MoveNet's 17 keypoints have no
heel and no foot index, so gait, heel raises and the tip-toe test lose their
measurement entirely — and the harness must be made to report *nothing* for
those tasks rather than a plausible number derived from an ankle. Write the
converter in `lib/format.mjs`, list what the model cannot do, and make
`runTask` refuse those tasks for it.

## Files

| | |
|---|---|
| `run.mjs` | the benchmark: track → quality → analyse → score → report |
| `config.mjs` | which models, and the pass/fail thresholds |
| `fetch_models.mjs` | downloads `lite` and `heavy` into `models/` |
| `selftest.mjs` | proves the harness measures what it claims — no browser, no clips |
| `bench/harness.html` | the page the models run in; mirrors the app's tracking loop |
| `bench/browser.mjs` | Playwright driver, with a track cache |
| `bench/serve.mjs` | static server rooted at the repo, so the vendored MediaPipe is the one under test |
| `lib/format.mjs` | the frame format, and the app's visibility cut |
| `lib/mot.mjs` | OpenSim storage reader/writer |
| `lib/gt.mjs` | column mapping, signs, clock alignment |
| `lib/quality.mjs` | ground-truth-free tracking quality |
| `lib/score.mjs` | agreement statistics |
| `lib/tasks.mjs` | runs the app's own pipeline on a model's landmarks |
| `lib/report.mjs` | markdown and self-contained HTML |

## Useful invocations

```bash
node tests/vision_model/run.mjs --models full,heavy    # just these two
node tests/vision_model/run.mjs --clip sub01_squat_sideon
node tests/vision_model/run.mjs --no-track             # re-score cached tracks
node tests/vision_model/run.mjs --retrack              # ignore the cache
node tests/vision_model/run.mjs --headed               # watch it run
node tests/vision_model/run.mjs --models full,full-cpu # what a phone with no GPU path gets
node tests/vision_model/selftest.mjs
```

Tracking is the slow half (about a minute per clip per model) and is cached in
`results/tracks/`; scoring is the half you iterate on. Failing a threshold is a
*result* and does not fail the process — only a run that could not measure
anything at all exits non-zero.
