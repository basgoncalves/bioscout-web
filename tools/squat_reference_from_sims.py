"""Build a squat reference from the powerlifting project's OpenSim/CEINMS runs.

The gait literature already in bioscout (Bergmann, Richards, Giarmatzis, Pandy)
cannot be laid over a squat: a gait cycle is not a rep, and only the axis looks
alike. What CAN be laid over a squat is a squat, so this turns the project's own
simulations into reference curves in exactly the schema
`literature_curves.csv` already uses, so the output drops into
bioscout/muscle_inspect/validation/ beside the gait sources.

    python squat_reference_from_sims.py <simulations/Athlete_03_GPK/25_03_31> \
        --mass 78 --source Athlete03_GPK --out squat_curves.csv

What it emits, per variable, as mean / lower / upper across the trials given
(lower and upper are mean -+ 1 SD, matching how Hoang and Richards are stored):

    joint_angle           deg, the model's own sign convention
    joint_moment          N.m, likewise, NOT yet flipped to extension-positive
    joint_contact_force   xBW, resultant of the JRA force components
    muscle_force          N, per muscle, from CEINMS

Signs are deliberately left in the model's convention and the convention is
recorded in the output. Flipping here would bake one plotting choice into the
data file; flipping at the point of display is reversible.

HONESTY. Read the header this writes. A handful of trials from ONE athlete is
a reference, not a norm: it says what this pipeline produces for this person,
which is useful for spotting a prediction that is wrong by an order of
magnitude, and is not a population range.
"""
import argparse
import csv
import glob
import math
import os
import sys

GRID = 101


def read_storage(path):
    """OpenSim .sto/.mot -> (columns, rows). Both are the same format: a free
    text header, a line 'endheader', then a tab-separated table."""
    with open(path, errors="ignore") as fh:
        in_degrees = None
        for line in fh:
            s = line.strip()
            low = s.lower()
            if low.startswith("indegrees"):
                in_degrees = low.split("=")[-1].strip() == "yes"
            if low == "endheader":
                break
        else:
            raise ValueError(f"{path}: no endheader")
        header = fh.readline().rstrip("\n").split("\t")
        rows = []
        for line in fh:
            if not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) != len(header):
                continue
            try:
                rows.append([float(x) for x in parts])
            except ValueError:
                continue
    return header, rows, in_degrees


def column(header, rows, name):
    try:
        i = header.index(name)
    except ValueError:
        return None
    return [r[i] for r in rows]


def resample(x, y, n=GRID):
    """Linear resample onto n points spanning x's range."""
    out = []
    x0, x1 = x[0], x[-1]
    span = (x1 - x0) or 1.0
    j = 0
    for k in range(n):
        xt = x0 + span * k / (n - 1)
        while j < len(x) - 2 and x[j + 1] < xt:
            j += 1
        xa, xb = x[j], x[j + 1]
        ya, yb = y[j], y[j + 1]
        f = 0.0 if xb == xa else (xt - xa) / (xb - xa)
        out.append(ya + (yb - ya) * f)
    return out


def mean_sd(curves):
    n = len(curves[0])
    m, s = [], []
    for k in range(n):
        v = [c[k] for c in curves]
        mu = sum(v) / len(v)
        m.append(mu)
        s.append(math.sqrt(sum((a - mu) ** 2 for a in v) / (len(v) - 1))
                 if len(v) > 1 else 0.0)
    return m, s


ANGLES = {"hip": "hip_flexion_r", "knee": "knee_angle_r", "ankle": "ankle_angle_r"}
MOMENTS = {"hip": "hip_flexion_r_moment", "knee": "knee_angle_r_moment",
           "ankle": "ankle_angle_r_moment"}


def jcf_resultant(header, rows, joint):
    """Resultant of a JRA force triple, in newtons. Column names differ between
    joints (the knee goes through a Lerner articulation frame), so match on a
    prefix and the fx/fy/fz suffix rather than hard-coding all three names."""
    pref = [c for c in header
            if c.lower().startswith(joint) and c.endswith("_fx")]
    if not pref:
        # the knee is named for the articulation frame, not the joint
        pref = [c for c in header if joint in c.lower() and c.endswith("_fx")]
    if not pref:
        return None, None
    base = pref[0][:-3]
    fx = column(header, rows, base + "_fx")
    fy = column(header, rows, base + "_fy")
    fz = column(header, rows, base + "_fz")
    if fx is None or fy is None or fz is None:
        return None, None
    return [math.sqrt(a * a + b * b + c * c) for a, b, c in zip(fx, fy, fz)], base


def collect(trial_dir, mass_kg, want_muscles):
    """Every curve one trial can offer, each already on the 0-100% grid."""
    out = {}
    ik = os.path.join(trial_dir, "joint_angles.mot")
    if os.path.isfile(ik):
        h, r, deg = read_storage(ik)
        t = column(h, r, "time")
        if t:
            k = 1.0 if deg else 180.0 / math.pi
            for ent, col in ANGLES.items():
                y = column(h, r, col)
                if y:
                    out[("joint_angle", ent, "deg")] = resample(t, [v * k for v in y])
    idf = os.path.join(trial_dir, "inverse_dynamics.sto")
    if os.path.isfile(idf):
        h, r, _ = read_storage(idf)
        t = column(h, r, "time")
        if t:
            for ent, col in MOMENTS.items():
                y = column(h, r, col)
                if y:
                    out[("joint_moment", ent, "N.m")] = resample(t, y)
    jra = os.path.join(trial_dir, "Analyse_JRA_ReactionLoads_CEINMS.sto")
    if os.path.isfile(jra):
        h, r, _ = read_storage(jra)
        t = column(h, r, "time")
        bw = mass_kg * 9.80665
        for ent, key in [("hip", "hip_r"), ("knee", "knee_r"), ("ankle", "ankle_r")]:
            y, base = jcf_resultant(h, r, key)
            if y:
                out[("joint_contact_force", ent, "xBW")] = resample(t, [v / bw for v in y])
    if want_muscles:
        mf = sorted(glob.glob(os.path.join(trial_dir, "Execution_*", "MuscleForces.sto")))
        if mf:
            h, r, _ = read_storage(mf[0])
            t = column(h, r, "time")
            for c in h:
                if c == "time" or c.endswith("_reserve"):
                    continue
                y = column(h, r, c)
                if y:
                    out[("muscle_force", c, "N")] = resample(t, y)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session", help="a session folder holding the Squat_* trials")
    ap.add_argument("--mass", type=float, required=True, help="athlete body mass, kg")
    ap.add_argument("--source", default="SquatReference", help="source id in the CSV")
    ap.add_argument("--pattern", default="Squat*")
    ap.add_argument("--muscles", action="store_true", help="also export muscle forces")
    ap.add_argument("--out", default="squat_curves.csv")
    a = ap.parse_args()

    trials = sorted(d for d in glob.glob(os.path.join(a.session, a.pattern))
                    if os.path.isdir(d))
    if not trials:
        print(f"no trials matching {a.pattern} in {a.session}", file=sys.stderr)
        return 2

    # Group by condition, because a bodyweight squat and a 35 kg squat are not
    # the same movement and averaging them together would hide the difference
    # the reference exists to show.
    by_condition = {}
    for d in trials:
        name = os.path.basename(d)
        cond = "bodyweight" if "bw" in name.lower() else name.split("_")[1].lower()
        by_condition.setdefault(cond, []).append(d)

    rows = []
    report = []
    for cond, dirs in sorted(by_condition.items()):
        pooled = {}
        for d in dirs:
            for key, curve in collect(d, a.mass, a.muscles).items():
                pooled.setdefault(key, []).append(curve)
        for (var, ent, unit), curves in sorted(pooled.items()):
            m, s = mean_sd(curves)
            series = {"mean": m}
            if len(curves) > 1:
                series["lower"] = [x - y for x, y in zip(m, s)]
                series["upper"] = [x + y for x, y in zip(m, s)]
            for sname, vals in series.items():
                for i, v in enumerate(vals):
                    rows.append([a.source, var, ent, cond, sname, i,
                                 round(v, 6), "%squat_cycle", unit])
            report.append((cond, var, ent, len(curves), unit,
                           min(m), max(m)))

    with open(a.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["source", "variable", "entity", "condition", "series",
                    "x", "y", "x_unit", "y_unit"])
        w.writerows(rows)

    print(f"wrote {a.out}: {len(rows)} rows")
    for cond, var, ent, n, unit, lo, hi in report:
        if var == "muscle_force":
            continue
        print(f"  {cond:12s} {var:20s} {ent:6s} n={n}  "
              f"{lo:9.2f} .. {hi:9.2f} {unit}")
    print("\nNOTE: this is one athlete. It is a reference for this pipeline, "
          "not a population norm, and the CSV should say so in the manifest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
