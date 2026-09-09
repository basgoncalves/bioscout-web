# BioScout Web

**[Open the app → basgoncalves.github.io/bioscout-web](https://basgoncalves.github.io/bioscout-web/)**

A physics-informed, AI-powered bio tracker. Pose estimation from a phone
camera, inverse dynamics on the joint angles, and a log of what you did around
it — training, meals, weight, mood and cycle — all computed in the browser. No
app store, no APK, no server, and the video never leaves the device.

Open the link, press record, get reps, joint angles and an OpenSim `.mot` file.

The browser front end of [BioScout](https://github.com/basgoncalves/bioscout).
It is a **separate repository on purpose**: this deploys as a static site on
every push, while `bioscout` is a Python package released to PyPI, and the 45 MB
of vendored pose engine here has no business in a `pip install`. What the two
share is the analysis core, and that link is enforced rather than assumed — see
*Verification*.

## Running it locally

    python serve.py          # then open http://localhost:8000

Serves the working tree with caching switched off, so a reload shows the file
you just saved rather than whatever the service worker kept. The camera works
because browsers treat `localhost` as a secure context -- open it by that name,
not by 127.0.0.1.

Testing on a phone needs HTTPS, since the phone is not localhost: put a tunnel
in front of it (`npx localtunnel --port 8000`, or `cloudflared tunnel --url
http://localhost:8000`) and open the https address it gives you.

## What is not in this repository

Two things are deliberately absent from the public build, and the app is
written to work without them:

| Missing | Why | What degrades |
|---|---|---|
| `data/reference.json` | One of its three cases is a recording of a research participant. Consent to record is not consent to publish. | `?demo=1` says so; `tests/test_port.mjs` skips instead of failing. |
| `src/neck_gload.js` values | Unpublished BSc thesis results, which are their author's to publish first. | The 1-6 g neck panel does not render. |

`data/force_model.json` used to be on this list and is now published. Muscle
and joint contact forces cannot exist on a static site without a model the
browser can fetch, and a model the browser can fetch is a model anyone can
download; there is no third option, and the feature was judged worth the trade.

The remaining items live in `_private/`, which is gitignored. To develop with
them, copy them back into place; do not commit them. `.gitignore` explains the reasoning at
the point where somebody would otherwise undo it.

Note that removing a file from the working tree does not remove it from git
history. If any of the above was ever committed, it is still recoverable from
earlier commits until the history is rewritten.

## Analysing a video from a link (optional)

The page cannot download a video itself. The bytes are not served with
permissive CORS headers, an embedded player's pixels cannot be read from
script, and deriving a stream URL means running code the site changes every
few weeks. That is the platform working as designed, not a gap here.

`tools/bioscout_fetch.py` does it on your own device instead:

```
pip install yt-dlp
python tools/bioscout_fetch.py
```

Reload the app and a link box appears on the recording page. It is only there
while the helper is running -- a control that cannot work is worse than no
control, because the person learns the app is broken rather than that a helper
is not started.

It binds `127.0.0.1` and nothing else. Browsers exempt loopback from
mixed-content blocking, so an HTTPS page may call it; nothing on the network
can. On a phone, run it in Termux and helper and browser are the same device.
The page sends an 11-character video id, never a URL, so it cannot talk the
helper into fetching an arbitrary address.

This does not change what the app uploads, which is still nothing. It does
mean your device requests a video from YouTube, which is a network request the
app does not otherwise make. Downloading from YouTube is against their terms
of service; that call is yours to make for your own footage, Creative Commons
material, or anything you hold the rights to. It lives in `tools/` as
something you start deliberately, rather than inside the app.

## Importing from Strava (optional)

Same shape of problem as the link box above, and the same answer.

The page cannot talk to Strava itself for two independent reasons. Strava's
token exchange requires the application's **client secret**, and a static site
has nowhere to keep one -- shipping it in the JavaScript publishes it to
everybody who opens the page, and there is no PKCE flow for public clients to
fall back on. Separately, the API sends no CORS headers, so even holding a
valid token the browser would be refused at the door. Both are Strava working
as designed, not a gap here.

So the OAuth dance happens on your own device:

```
python tools/bioscout_strava.py
```

First run tells you what it needs: an app at
<https://www.strava.com/settings/api> with its Authorization Callback Domain
set to `127.0.0.1`, then

```
export STRAVA_CLIENT_ID=...  STRAVA_CLIENT_SECRET=...
```

or the same two values in `~/.bioscout/strava.json`. Reload BioScout and the
dashboard's *Your data* box offers **Connect Strava**, then **Import**.

It binds `127.0.0.1`, answers only this app's origin, and asks for
`activity:read_all` -- read-only, so nothing here can modify your Strava
account. Tokens are written `0600` and **never leave the helper**: the page
asks it for activities and cannot ask it for a credential, so a compromised
page has nothing to lift. Imports are incremental, fetching only what has
happened since the newest activity already stored.

Activities land on the **training calendar**, on the same days as your sets,
described in time and distance rather than reps -- a 40-minute run has no
reps, and adding some would corrupt every volume figure in the app. They do
not become sessions and carry no joint angles; they are a record of what a
watch measured, labelled as such.

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

`bioscout.movement_detector.markerless` stays the source of truth for desktop
and batch work. This is a second front end over the same algorithm, not a fork
of it — see *Verification*.

## Privacy

Video is never uploaded, never recorded to disk, and never leaves the device.
Frames go from the camera to the pose model in memory; only the 33 landmark
coordinates per frame are kept, and those are discarded when you reload. There is
no analytics, no network call after the initial page load, and no server to send
anything to. After the first visit the app runs with the network off.

## Putting it on your phone

1. Push this folder:

   ```bash
   cd C:/Users/Basilio/Desktop/pullups/web
   git push
   ```

2. On GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.

3. Wait a minute, then open `https://basgoncalves.github.io/bioscout-web/` on
   your Pixel.

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

## Outputs

Per rep, downloadable:

| File | Contents |
|---|---|
| `<activity>_rep<N>_<model>_joint_angles.mot` | OpenSim coordinates, signed for the chosen model family |
| `<activity>_rep<N>_joint_moments.sto` | hip / knee / ankle moments (N·m, extension positive) and ground reaction (N) |

## Joint moments

Sagittal inverse dynamics from kinematics and body mass, no force plate. The
ground reaction is **derived, not assumed**: Newton's second law on the whole
body gives `GRF = m(a_com + g)`, and every segment centre of mass is measured.
Segment inertias follow Winter Table 4.1.

Assumptions, and where the error lives: centre of pressure at the midfoot;
left-right symmetry (a visible lean breaks it); planar motion. Squats only — a
pull-up has no ground contact, so the derivation does not apply.

Signs are declared, not derived, and pinned by
`bioscout.tests.markerless.test_dynamics` against a hand-computed static pose. Note
one genuine result that looks like a bug: in a shallow squat the ground reaction
can pass in front of the knee, giving a small **flexor** moment that grows into
a large extensor moment with depth.

## The model-family selector matters

`knee_angle` sign is opposite between model families — Rajagopal has flexion
positive (0..+145), GPK/gait2392 negative (−145..+10). Pick the family you will
load the file into; the choice is stamped into the filename. OpenSim accepts
out-of-range values silently and renders a collapsed figure, so getting this
wrong looks like a mystery rather than an error.

`pelvis_ty` is written as an **absolute height above the floor**, measured as
hip-above-ankle plus the ankle joint height. A standing subject should come out
near 0.93 m; if not, the pixel scale (and so your height entry) is wrong.

The force model is always fed Rajagopal signs internally, whatever the export
convention, since that is what it was trained on.

## What it measures, and what it does not

**Measured, and trustworthy:** rep count, joint angles through the rep, range of
motion, squat depth and pull-up travel in metres.

**Approximate:** tempo. The browser delivers frames at a rate that varies with
lighting, thermal state and load, so durations are only as good as the achieved
frame rate — which the results panel reports.

**Muscle and joint contact forces: estimates, not measurements.** A surrogate
for OpenSim static optimisation, retrained 2026-09-02 on 570 solved trials from
26 subjects (running, sprinting, single-leg squats). On subjects it has never
seen it reaches a median R² of 0.46 for muscle force and 0.66 for joint contact
force. The ranking of muscles and the shape of the curve are more trustworthy
than the absolute newtons.

Two limits are structural rather than fixable by more data. It takes kinematics
only, so it **cannot know external load** — an empty bar and a loaded bar at the
same depth and tempo predict the same forces, which makes it valid for
bodyweight movement and wrong for loaded lifting. And every one of its 80
outputs is a lower-limb muscle, so **it does not apply to pull-ups at all**: the
lats, biceps and trapezius that do the work are not in the output vector. It is
shown for squats, where the muscle list is right and the inputs are recoverable.

The model it replaced predicted 113,250 N on a trial from its own training set;
`node tests/test_force_model.mjs` is the regression test that would have caught that,
and it now runs against the browser's own forward pass. See
`../android_app/models/MODEL_CARD.md`. Joint kinematics and joint moments never
pass through this model and are unaffected.

**Structural limits.** One camera cannot separate left from right, so `*_r` and
`*_l` carry identical values. Nor can it recover out-of-plane motion — this is a
sagittal measurement, and anything the subject does towards or away from the
camera is invisible to it.

## Verification

`src/kinematics.js` is a deliberate line-by-line port of `bioscout.movement_detector.markerless`,
including numpy's exact semantics for percentile interpolation, `convolve`
`'same'` offset and NaN handling. It is checked, not assumed.

`reference.json` is the fixture both sides are held to:

```bash
node tests/test_port.mjs       # JS     == data/reference.json
python tools/check_reference.py  # Python == data/reference.json
```

The second half is the one that is easy to leave out, and leaving it out is
what lets the two drift. Checking only the JavaScript proves it reproduces a
*recording* of the Python; if bioscout changes and nobody regenerates the
fixture, that test keeps passing against a stale answer forever. With both
sides pinned to the same file, `JS == reference == Python` — and any change to
either implementation has to update the fixture deliberately.

Neither step needs a video or a clip: every case in `reference.json` stores its
own input landmarks. That is what makes this runnable in CI
(`.github/workflows/port.yml`, on every push and weekly, since bioscout can
change without anything happening in this repo).

To regenerate the fixture after an intended change:

```bash
python tools/dump_reference.py                      # squats; carries the pull-up case over
python tools/dump_reference.py --pullup-poses ../sessions/session1/poses.json
```

Current status: every rep boundary, timestamp and exported coordinate agrees
exactly on a real pull-up clip (2 reps) and a synthetic squat (3 reps, both
model families), across 121 checks.

## Layout

```
index.html                 the app: UI, camera, dashboard, export
sw.js                      service worker, for offline use

src/                       ES modules, loaded directly by index.html
  kinematics.js            analysis core - shared with the Python package
  dynamics.js forces.js    inverse dynamics and joint loads
  detect.js ensemble.js    movement detection and rep segmentation
  overlay.js               skeleton overlay (three.js)
  profiles.js              athletes, sessions, meals, diary, weight, cycle
  dashboard.js             the dashboard and its forms
  diary.js weight.js       per-domain logic, each with its own test
  cycle.js foods.js
  media.js share.js        photos in IndexedDB, the shareable month card
  fetcher.js               the optional local clip helper
  i18n.js zip.js           translations, and the session archive

tests/                     node tests/test_*.mjs, or npm test for all of them
data/                      fixtures and tables the app fetches at runtime
  review/                  MSK-modelling literature review + studies.json
  reference.json           the fixture both implementations are pinned to
  norms.json               reference ranges
  force_model.json         the trained force model
assets/                    large, vendored, and not to be edited by hand
  vendor/                  MediaPipe tasks-vision (not a CDN)
  pose_landmarker_full.task
  meshes/                  character geometry for the overlay
  icons/                   the BioScout mark: page header, favicon, PWA,
                           home screen. Generated by tools/make_icons.py;
                           referenced from index.html, the manifest and sw.js
tools/                     scripts you run, not code the app loads
  bioscout_fetch.py        the optional local clip helper
  check_reference.py       asserts the Python matches the fixture
  dump_reference.py        regenerates the fixture after an intended change
  run_tests.mjs            runs every test in tests/
push.py                    apply a patch and ship it, from a phone
```

Everything the browser loads is a plain ES module — no build step, no bundler,
no `node_modules`. `npm test` needs nothing installed.

`data/reference.json` is 1.1 MB and only used by the test and demo mode. Delete it
from a deployment if you want a smaller repo; `?demo` stops working if you do.
