"""Tabulate muscle moment arms from an OpenSim model.

The web app predicts muscle FORCES. A muscle's share of a joint moment is
force x moment arm, and the moment arm is a property of the musculoskeletal
model, not of the movement -- so it can be computed once, offline, and shipped
as a small lookup table. That is what this writes.

Run it against the same model family the force surrogate was trained on
(Rajagopal 2015 muscle names: recfem_r, glmax2_r, gasmed_r, ...), because the
app looks arms up by muscle name.

    python tools/moment_arms.py path/to/Rajagopal2015.osim -o moment_arms.json

Output shape:

    {"model": "...", "generated": "...",
     "joints": {"knee": {"coord": "knee_angle_r",
                         "grid": [-10, -5, ... 140],       # degrees
                         "muscles": {"recfem_r": [0.041, ...]}}}}   # metres

Sign is OpenSim's own for that coordinate, i.e. positive arm = the muscle acts
in the coordinate's positive direction (flexion for the Rajagopal knee and hip,
dorsiflexion for the ankle). The app flips this to its extension-positive
plotting convention; do not pre-flip here.
"""
import argparse
import datetime
import json
import os
import sys

# Coordinates to tabulate, and the range each is swept over. The ranges are
# deliberately wider than a squat needs: the app clamps at the ends, and a
# table that stops at the edge of the training data would silently flatten a
# deep rep.
JOINTS = {
    "hip":   dict(coord="hip_flexion_r", lo=-30.0, hi=130.0, step=5.0),
    "knee":  dict(coord="knee_angle_r",  lo=-10.0, hi=150.0, step=5.0),
    "ankle": dict(coord="ankle_angle_r", lo=-40.0, hi=40.0,  step=2.5),
    # The hip is a ball joint and the surrogate predicts all three of its
    # moments, so a sagittal-only table could only ever explain one of them.
    # A single camera does not measure these two angles, so the app reads them
    # at neutral; tabulating them anyway keeps that an explicit assumption
    # rather than a missing column.
    "hip_adduction": dict(coord="hip_adduction_r", lo=-30.0, hi=30.0, step=2.5),
    "hip_rotation":  dict(coord="hip_rotation_r",  lo=-40.0, hi=40.0, step=2.5),
}

# A muscle whose arm never exceeds this at any angle does not cross the joint
# in any useful sense, and carrying it would just make the file bigger.
MIN_ARM_M = 0.002


def frange(lo, hi, step):
    out, v = [], lo
    while v <= hi + 1e-9:
        out.append(round(v, 4))
        v += step
    return out


# A moment arm is a smooth function of joint angle: over one grid step it
# cannot move by this much. A bigger jump is a wrap object switching on or off
# between the two perturbed poses, which makes the central difference
# meaningless -- the quadriceps came out at +19 mm (a FLEXOR) at 145 deg of
# knee flexion, having been -30 mm one step earlier. Hold the last good value
# rather than ship a sign flip; the app clamps at the ends anyway.
MAX_STEP_M = 0.020


def _despike(arms):
    out, fixed = list(arms), 0
    for i in range(1, len(out)):
        if abs(out[i] - out[i - 1]) > MAX_STEP_M:
            out[i] = out[i - 1]
            fixed += 1
    return out, fixed


def via_pyosim(args, keep):
    """The same table, from py/pyosim's Paths.moment_arms, with no OpenSim."""
    import types
    import numpy as np
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, os.path.join(here, "py"))
    # pyosim/__init__ pulls in ik.py, which wants scipy for IK we do not do here.
    if "scipy" not in sys.modules:
        sys.modules["scipy"] = types.ModuleType("scipy")
        opt = types.ModuleType("scipy.optimize"); opt.least_squares = None
        sys.modules["scipy.optimize"] = opt
    from pyosim.model import Model
    from pyosim.muscles import Paths

    model = Model(args.model)
    paths = Paths(model, model.path)
    names = [m["name"] for m in paths.mus]
    out = {"model": os.path.basename(args.model),
           "generated": datetime.datetime.now().isoformat(timespec="seconds"),
           "units": {"grid": "deg", "arm": "m"},
           "source": "py/pyosim (central differences on path length)",
           "joints": {}}

    for jkey, spec in JOINTS.items():
        name = spec["coord"]
        if name not in model.coord_order:
            print(f"  skip {jkey}: no coordinate {name} in this model", file=sys.stderr)
            continue
        grid = frange(spec["lo"], spec["hi"], spec["step"])
        # Every other coordinate stays at the default pose -- the same
        # assumption the app's single-angle lookup makes.
        Q = np.zeros((len(grid), len(model.coord_order)))
        Q[:, model.coord_order.index(name)] = np.deg2rad(grid)
        # Coupled coordinates must follow. Rajagopal's patella rides on
        # knee_angle through a coupler constraint; sweeping the knee with the
        # patella left at zero tears the quadriceps path off its wrap surface
        # and the central difference then reports moment arms in METRES.
        Q = paths.kin.couple(Q)
        _, R = paths.moment_arms(Q, [name])
        table, repaired = {}, 0
        for mi, mname in enumerate(names):
            # hip_adduction / hip_rotation are the same joint as "hip" in
            # muscle_joints.json, which is keyed by joint, not by coordinate.
            if keep is not None and mname not in keep.get(jkey.split("_")[0], set()):
                continue
            arms = [round(float(v), 5) for v in R[:, 0, mi]]
            arms, fixed = _despike(arms)
            repaired += fixed
            if max(abs(a) for a in arms) >= MIN_ARM_M:
                table[mname] = arms
        out["joints"][jkey] = {"coord": name, "grid": grid, "muscles": table}
        print(f"  {jkey}: {len(table)} muscles over {len(grid)} angles"
              + (f" ({repaired} wrap-flip samples held)" if repaired else ""))

    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {args.out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", help="path to the .osim file")
    ap.add_argument("-o", "--out", default="moment_arms.json")
    ap.add_argument("--muscles", help="optional muscle_joints.json; restricts "
                                      "the output to the muscles the app knows")
    args = ap.parse_args()

    try:
        import opensim as osim
    except ImportError:
        osim = None

    keep = None
    if args.muscles:
        with open(args.muscles) as fh:
            mj = json.load(fh)
        by_joint = mj.get("byJoint") or {}
        keep = {j: set(v) for j, v in by_joint.items()}

    if osim is None:
        # No OpenSim bindings: use the repo's own path engine (py/pyosim), which
        # parses the .osim and differentiates path length the same way. Checked
        # against OpenSim's MuscleAnalysis to about 1 mm median (py/pyosim/ma.py).
        print("OpenSim not importable -- using py/pyosim instead", file=sys.stderr)
        return via_pyosim(args, keep)

    model = osim.Model(args.model)
    state = model.initSystem()
    coords = model.getCoordinateSet()
    muscles = model.getMuscles()

    have = {coords.get(i).getName() for i in range(coords.getSize())}
    out = {"model": model.getName() or args.model,
           "generated": datetime.datetime.now().isoformat(timespec="seconds"),
           "units": {"grid": "deg", "arm": "m"},
           "joints": {}}

    for jkey, spec in JOINTS.items():
        name = spec["coord"]
        if name not in have:
            print(f"  skip {jkey}: no coordinate {name} in this model", file=sys.stderr)
            continue
        coord = coords.get(name)
        grid = frange(spec["lo"], spec["hi"], spec["step"])
        table = {}

        for mi in range(muscles.getSize()):
            m = muscles.get(mi)
            mname = m.getName()
            # hip_adduction / hip_rotation are the same joint as "hip" in
            # muscle_joints.json, which is keyed by joint, not by coordinate.
            if keep is not None and mname not in keep.get(jkey.split("_")[0], set()):
                continue
            arms = []
            for deg in grid:
                # Lock nothing else: the arm is evaluated with every other
                # coordinate at its default pose, which is the same assumption
                # the app's single-angle lookup makes.
                coord.setValue(state, osim.SimTK_PI * deg / 180.0, False)
                model.assemble(state)
                model.realizePosition(state)
                arms.append(round(m.computeMomentArm(state, coord), 5))
            if max(abs(a) for a in arms) >= MIN_ARM_M:
                table[mname] = arms

        # Leave the coordinate where we found it before moving on.
        coord.setValue(state, coord.getDefaultValue(), False)
        model.assemble(state)

        out["joints"][jkey] = {"coord": name, "grid": grid, "muscles": table}
        print(f"  {jkey}: {len(table)} muscles over {len(grid)} angles")

    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
