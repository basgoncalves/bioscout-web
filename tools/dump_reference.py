"""
Regenerate reference.json, the fixture the JavaScript port is tested against.

    python tools/dump_reference.py [--pullup-poses PATH]

The squat cases are synthetic and always regenerate. The pull-up case needs a
real clip's poses.json, which is not in this repository -- pass it explicitly,
or the existing pull-up case is carried over from the current reference.json so
that regenerating the squats never silently drops it.

This rewrites the fixture, so it is NOT what CI runs. CI runs
tools/check_reference.py, which re-derives every case from the poses already
stored in the fixture and asserts nothing moved.
"""
import argparse
import json
import os

import numpy as np

from bioscout.movement_detector.markerless.dynamics import inverse_dynamics
from bioscout.movement_detector.markerless.kinematics import compute_px_per_m
from bioscout.movement_detector.markerless.pose import load_poses
from bioscout.movement_detector.markerless.session import ACTIVITIES, analyse
from bioscout.movement_detector.markerless.squat import joint_positions_m
from bioscout.tests.markerless.test_squat import synth_squats

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE = os.path.join(os.path.dirname(HERE), "reference.json")


def case(poses, fps, activity, height_m=1.75, osim_model="gpk"):
    res = analyse(poses, fps, height_m=height_m, activity=activity,
                  osim_model=osim_model)
    cols = ACTIVITIES[activity]["columns"]
    return {
        "activity": activity,
        "fps": fps,
        "height_m": height_m,
        "px_per_m": res.px_per_m,
        "osim_model": osim_model,
        "view": res.view,
        "columns": cols,
        "poses": {str(k): {n: list(v) for n, v in lm.items()}
                  for k, lm in poses.items()},
        "dynamics": _dyn(poses, res, activity, fps, height_m),
        "reps": [{
            "bounds": [int(r.b0), int(r.top), int(r.b1)],
            "times": [float(t) for t in r.times],
            "coords": {c: [float(v) for v in np.asarray(r.coords[c])]
                       for c in cols if c in r.coords},
        } for r in res.reps],
    }


def _dyn(poses, res, activity, fps, height_m, mass_kg=75.0):
    """Inverse-dynamics reference for the first rep, squats only."""
    if activity != "squat" or not res.reps:
        return None
    from bioscout.movement_detector.markerless.squat import build_squat_features
    F = build_squat_features(poses)
    px, _ = compute_px_per_m(poses, height_m)
    r = res.reps[0]
    d = inverse_dynamics(joint_positions_m(F, (r.b0, r.top, r.b1), px,
                                           F["_floor_y"]), mass_kg, fps)
    return {k: [float(x) for x in np.asarray(v)] if hasattr(v, "__len__")
            else float(v) for k, v in d.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pullup-poses",
                    help="poses.json for the real pull-up clip. Omitted: the "
                         "existing pull-up case is carried over unchanged.")
    args = ap.parse_args()

    existing = {}
    if os.path.exists(REFERENCE):
        with open(REFERENCE) as f:
            existing = json.load(f).get("cases", {})

    cases = {}
    if args.pullup_poses:
        poses, fps = load_poses(args.pullup_poses)
        cases["pullup_P01"] = case(poses, fps, "pullup")
    elif "pullup_P01" in existing:
        cases["pullup_P01"] = existing["pullup_P01"]
        print("carried over pullup_P01 (no --pullup-poses given)")

    cases["squat_synthetic"] = case(synth_squats(), 30.0, "squat")
    cases["squat_rajagopal"] = case(synth_squats(), 30.0, "squat",
                                    osim_model="rajagopal")

    with open(REFERENCE, "w") as f:
        json.dump({"cases": cases}, f)
    for name, c in cases.items():
        print("%-18s %s, %d reps, %d frames"
              % (name, c["activity"], len(c["reps"]), len(c["poses"])))
    print("-> %s (%.1f MB)" % (REFERENCE, os.path.getsize(REFERENCE) / 1e6))


if __name__ == "__main__":
    main()
