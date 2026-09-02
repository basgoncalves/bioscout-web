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
import sys

# Coordinates to tabulate, and the range each is swept over. The ranges are
# deliberately wider than a squat needs: the app clamps at the ends, and a
# table that stops at the edge of the training data would silently flatten a
# deep rep.
JOINTS = {
    "hip":   dict(coord="hip_flexion_r", lo=-30.0, hi=130.0, step=5.0),
    "knee":  dict(coord="knee_angle_r",  lo=-10.0, hi=150.0, step=5.0),
    "ankle": dict(coord="ankle_angle_r", lo=-40.0, hi=40.0,  step=2.5),
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
        print("OpenSim's Python bindings are not importable in this environment.\n"
              "In the conda env that has OpenSim:\n"
              "    conda activate opensim\n"
              "    python tools/moment_arms.py <model.osim>", file=sys.stderr)
        return 2

    keep = None
    if args.muscles:
        with open(args.muscles) as fh:
            mj = json.load(fh)
        by_joint = mj.get("byJoint") or {}
        keep = {j: set(v) for j, v in by_joint.items()}

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
            if keep is not None and mname not in keep.get(jkey, set()):
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
