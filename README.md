# Movement Lab

Pull-up and squat kinematics from a phone camera, computed entirely in the
browser. No app store, no APK, no server. Open a URL, press record, get reps,
joint angles and an OpenSim `.mot` file.

## Why this exists and not an APK

The Kivy app in `../android_app` cannot currently be built into an APK:
`mediapipe` ships no ARM wheel, so python-for-android bundles the x86_64 build
and it fails at `dlopen` on any phone
([python-for-android#2999](https://github.com/kivy/python-for-android/issues/2999)).

MediaPipe *does* ship a supported
[JavaScript/WASM build](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
of the same Pose Landmarker task, which runs on-device in mobile Chrome. That
removes the packaging problem entirely, so this is the version that actually
reaches a phone.

The Python package stays the source of truth for desktop and batch work. This is
a second front end over the same algorithm, not a fork of it — see *Verification*.

## Privacy

Video is never uploaded, never recorded to disk, and never leaves the device.
Frames go from the camera to the pose model in memory; only the 33 landmark
coordinates per frame are kept, and those are discarded when you reload. There is
no analytics, no network call after the initial page load, and no server to send
anything to. After the first visit the app runs with the network off.

## Putting it on your phone

1. Create a repository and push this folder:

   ```bash
   cd C:/Users/Basilio/Desktop/pullups/web
   git init && git add -A
   git commit -m "Movement Lab: in-browser pull-up and squat kinematics"
   git branch -M main
   git remote add origin git@github.com:<you>/movement-lab.git
   git push -u origin main
   ```

2. On GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.

3. Wait a minute, then open `https://<you>.github.io/movement-lab/` on your Pixel.

4. Check it works before granting the camera: open `?demo=1`. That renders a
   stored result with no camera and no model download. `?demo=squat` shows the
   squat view.

5. Optional: Chrome → ⋮ → *Add to Home screen*. It then launches like an app and
   works offline.

**HTTPS is required** — browsers refuse camera access otherwise. GitHub Pages
provides it. Opening `index.html` as a `file://` URL will load the page but the
camera will not start.

**First load is about 45 MB** (34 MB pose engine + 9.4 MB model). Do it on wi-fi.
A service worker caches everything afterwards, so later visits are instant and
work offline.

## Filming

- Side on, whole body in frame, from about 3 m.
- **Prop the phone against something.** Everything is measured in image
  coordinates, so a camera that moves is indistinguishable from a body that moves.
- Set your height before recording. Every metre-valued output scales with it.
- Pull-ups: the dead hang is the datum. A set that never returns to a full hang
  reads as less travel than it was.
- Squats: stand still for a moment at the start, so there is a standing
  reference to measure depth against.

## What it measures, and what it does not

**Measured, and trustworthy:** rep count, joint angles through the rep, range of
motion, squat depth and pull-up travel in metres.

**Approximate:** tempo. The browser delivers frames at a rate that varies with
lighting, thermal state and load, so durations are only as good as the achieved
frame rate — which the results panel reports.

**Not shown: muscle forces.** The one available model fails its own audit,
returning non-physiological forces (>100 kN) even on the gait data it was trained
on. See `../android_app/models/MODEL_CARD.md`. Joint kinematics are unaffected by
this; they never went through that model.

**Structural limits.** One camera cannot separate left from right, so `*_r` and
`*_l` carry identical values. Nor can it recover out-of-plane motion — this is a
sagittal measurement, and anything the subject does towards or away from the
camera is invisible to it.

## Verification

`pullupkit.js` is a deliberate line-by-line port of the Python `pullupkit`,
including numpy's exact semantics for percentile interpolation, `convolve`
`'same'` offset and NaN handling. It is checked, not assumed:

```bash
python ../android_app/tests/dump_reference.py   # Python output -> reference.json
node test_port.mjs                              # JS must reproduce it
```

Current status: every rep boundary, timestamp and exported coordinate agrees to
within 5e-12 on a real pull-up clip (2 reps) and a synthetic squat (3 reps).
Re-run both whenever either implementation changes.

## Files

```
index.html                 the whole app (UI, camera, analysis, export)
pullupkit.js               ported analysis core - shared with the node test
sw.js                      service worker, for offline use
vendor/                    MediaPipe tasks-vision, vendored (not a CDN)
pose_landmarker_full.task  the pose model
reference.json             Python output, for the port test and ?demo
test_port.mjs              asserts the JS matches the Python
```

`reference.json` is 1.1 MB and only used by the test and demo mode. Delete it
from a deployment if you want a smaller repo; `?demo` stops working if you do.
