"""
Assert reference.json still matches what the Python pipeline produces today.

    python tools/check_reference.py

reference.json is the fixture test_port.mjs checks the JavaScript against. That
alone proves the JS matches *a recording of* the Python, not the Python. If
bioscout changes and nobody regenerates the fixture, the port test keeps passing
against a stale answer and the two implementations drift apart in silence. This
closes that gap:

    test_port.mjs        JS      == reference.json
    check_reference.py   Python  == reference.json
    therefore            JS      == Python

Every case stores its own input landmarks, so this needs no video, no clip and
no data outside the repository -- which is what makes it runnable in CI.
"""
import json
import os
import sys

import numpy as np

from bioscout.movement_detector.markerless.dynamics import inverse_dynamics
from bioscout.movement_detector.markerless.kinematics import compute_px_per_m
from bioscout.movement_detector.markerless.session import ACTIVITIES, analyse
from bioscout.movement_detector.markerless.squat import (
    build_squat_features, joint_positions_m)

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE = os.path.join(os.path.dirname(HERE), "reference.json")

# The JS port agrees with Python to ~5e-12; anything looser would let a real
# change hide inside the tolerance.
TOL = 1e-9

FAILURES = []


def check(label, got, want, tol=TOL):
    got, want = np.asarray(got, float), np.asarray(want, float)
    if got.shape != want.shape:
        FAILURES.append("%s: shape %s != %s" % (label, got.shape, want.shape))
        return
    if got.size == 0:
        print("  [OK  ] %-34s empty" % label)
        return
    d = float(np.nanmax(np.abs(got - want)))
    if not np.isfinite(d) or d > tol:
        FAILURES.append("%s: max|diff| = %.3e" % (label, d))
        print("  [FAIL] %-34s max|diff| = %.3e" % (label, d))
    else:
        print("  [OK  ] %-34s max|diff| = %.3e" % (label, d))


def poses_from(stored):
    """Rebuild the pose dict the pipeline takes from its JSON form."""
    return {int(k): {n: tuple(v) for n, v in lm.items()}
            for k, lm in stored.items()}


def run_case(name, c):
    print("\n%s (%s, %s)" % (name, c["activity"], c["osim_model"]))
    poses = poses_from(c["poses"])
    res = analyse(poses, c["fps"], height_m=c["height_m"],
                  activity=c["activity"], osim_model=c["osim_model"])

    check("px_per_m", [res.px_per_m], [c["px_per_m"]])
    if res.view != c["view"]:
        FAILURES.append("%s view: %r != %r" % (name, res.view, c["view"]))

    if len(res.reps) != len(c["reps"]):
        FAILURES.append("%s: %d reps, reference has %d"
                        % (name, len(res.reps), len(c["reps"])))
        return

    for i, (got, want) in enumerate(zip(res.reps, c["reps"]), start=1):
        check("rep%d bounds" % i, [got.b0, got.top, got.b1], want["bounds"])
        check("rep%d time" % i, got.times, want["times"])
        for col in c["columns"]:
            if col in want["coords"]:
                check("rep%d %s" % (i, col), got.coords[col], want["coords"][col])

    if c.get("dynamics"):
        F = build_squat_features(poses)
        px, _ = compute_px_per_m(poses, c["height_m"])
        r = res.reps[0]
        d = inverse_dynamics(
            joint_positions_m(F, (r.b0, r.top, r.b1), px, F["_floor_y"]),
            75.0, c["fps"])
        for k, want in c["dynamics"].items():
            check("dyn %s" % k, np.atleast_1d(d[k]), np.atleast_1d(want))


def main():
    if not os.path.exists(REFERENCE):
        print("reference.json not found at %s" % REFERENCE)
        return 1
    with open(REFERENCE) as f:
        cases = json.load(f)["cases"]

    for name, c in cases.items():
        if c["activity"] not in ACTIVITIES:
            FAILURES.append("%s: unknown activity %r" % (name, c["activity"]))
            continue
        run_case(name, c)

    print()
    if FAILURES:
        print("%d MISMATCH(ES) -- reference.json no longer matches the Python "
              "pipeline.\nEither the change was unintended, or the fixture and "
              "pullupkit.js both need updating:" % len(FAILURES))
        for f in FAILURES:
            print("  " + f)
        return 1
    print("reference.json matches the current Python pipeline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
