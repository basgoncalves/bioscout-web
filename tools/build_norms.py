"""Build norms.json for the web app from bioscout's validation data.

bioscout is the source of truth. It holds the curated curves with their
citations in bioscout/muscle_inspect/validation/; this reads them and writes
the small JSON the browser can fetch, the same way build_meshes.py turns .osim
geometry into meshes/ and moment_arms.py turns a model into moment_arms.json.
Nothing is curated here -- if a number is wrong, it is wrong in bioscout.

    python tools/build_norms.py --bioscout C:/Git/bioscout -o norms.json

Two different things come out, because the corpus holds two different things:

  squat      Curves to lay over a mean rep, from the project's own OpenSim and
             CEINMS squat runs. Same movement, same model family, so the
             comparison is real.

  levels     Single reference VALUES from the gait literature -- peak hip and
             knee contact force in walking and running. A gait cycle is not a
             squat rep, so these are drawn as labelled horizontal lines, never
             as waveforms over a rep. They exist to make an implausible
             magnitude obvious at a glance.

SIGNS. The app plots joint moments extension-positive (see dynamics.js). The
stored curves are in the GPK model's own convention, where a squat comes out
with a positive knee moment but negative hip and ankle moments. They are
flipped here, once, on the way out, rather than at every plotting site.
"""
import argparse
import csv
import datetime
import json
import os
import sys

GRID = 101

# Extension-positive, to match dynamics.js. The knee already agrees.
MOMENT_SIGN = {"hip": -1.0, "knee": 1.0, "ankle": -1.0}

# Curves that exist in the source but are not fit to be a reference.
#
# ankle joint contact force: in the source runs it sits at 5.2 xBW while the
# athlete is STANDING STILL at the start of the trial, and moves only to
# 5.9 xBW at the bottom of a full-depth squat. A contact force that barely
# responds to the movement, and that is five times body weight before the
# movement begins, is a constant offset -- most likely a reserve or residual
# actuator at the ankle, or a weld constraint load riding along in the talus
# JRA -- and not something to draw on a plot as the right answer. Excluded
# until the ankle JRA is checked at source, rather than quietly shipped.
EXCLUDE = {("joint_contact_force", "ankle")}

# Peak levels worth drawing as a line, and where they come from. Keyed by the
# variable and entity the app plots.
LEVEL_SPECS = [
    ("knee", "joint_contact_force", "Richards2018", "knee", "walk_normal",
     "peak in normal walking"),
    ("hip", "joint_contact_force", "Bergmann2001", "hip", "walk_4kmh",
     "peak in walking, 4 km/h"),
    ("hip", "joint_contact_force", "Giarmatzis2015", "hip", "6kmh",
     "peak in running, 6 km/h"),
    ("hip", "joint_contact_force", "Giarmatzis2015", "hip", "12kmh",
     "peak in running, 12 km/h"),
]


def load_curves(path):
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def series_map(rows, source=None):
    """(variable, entity, condition, series) -> list of y, ordered by x."""
    out = {}
    for r in rows:
        if source and r["source"] != source:
            continue
        key = (r["variable"], r["entity"], r["condition"], r["series"])
        out.setdefault(key, []).append((float(r["x"]), float(r["y"]), r["y_unit"]))
    return {k: ([y for _, y, _ in sorted(v)], sorted(v)[0][2])
            for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bioscout", required=True,
                    help="path to the bioscout repo or installed package")
    ap.add_argument("--squat-source", default="Athlete03_GPK_squat")
    ap.add_argument("-o", "--out", default="norms.json")
    a = ap.parse_args()

    base = a.bioscout
    for cand in (os.path.join(base, "bioscout", "muscle_inspect", "validation"),
                 os.path.join(base, "muscle_inspect", "validation"),
                 base):
        if os.path.isfile(os.path.join(cand, "literature_manifest.json")):
            val = cand
            break
    else:
        print(f"no validation folder with a manifest under {base}", file=sys.stderr)
        return 2

    manifest = json.load(open(os.path.join(val, "literature_manifest.json")))
    lit = load_curves(os.path.join(val, "literature_curves.csv"))

    squat_path = os.path.join(val, "squat_curves.csv")
    squat_rows = load_curves(squat_path) if os.path.isfile(squat_path) else []
    if not squat_rows:
        print("warning: no squat_curves.csv -- the app will show levels only",
              file=sys.stderr)

    out = {
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "grid": GRID,
        "x_unit": "%rep",
        "squat": {},
        "levels": [],
        "sources": {},
    }

    # ---- squat curves ------------------------------------------------------
    sm = series_map(squat_rows)
    used = set()
    for (var, ent, cond, ser), (vals, unit) in sm.items():
        if var == "muscle_force":
            continue                      # the app compares muscle SHAPE, not level
        if (var, ent) in EXCLUDE:
            continue
        if len(vals) != GRID:
            continue
        sign = MOMENT_SIGN.get(ent, 1.0) if var == "joint_moment" else 1.0
        node = out["squat"].setdefault(cond, {}).setdefault(var, {}).setdefault(
            ent, {"unit": unit})
        node[ser] = [round(v * sign, 4) for v in vals]
        used.add(squat_rows[0]["source"])
    for cond in out["squat"]:
        for var in out["squat"][cond]:
            for ent, node in out["squat"][cond][var].items():
                node["source"] = a.squat_source

    # ---- gait levels -------------------------------------------------------
    lm = series_map(lit)
    for app_ent, var, src, ent, cond, label in LEVEL_SPECS:
        best = None
        for ser in ("mean", "curve"):
            hit = lm.get((var if var != "joint_contact_force"
                          else f"{ent.split('_')[0]}_contact_force", ent, cond, ser))
            if hit:
                best = hit
                break
        if not best:
            continue
        vals, unit = best
        peak = max(vals)
        if unit == "%BW":
            peak, unit = peak / 100.0, "xBW"
        out["levels"].append({
            "entity": app_ent, "variable": var, "value": round(peak, 3),
            "unit": unit, "label": label, "source": src,
        })
        used.add(src)

    for s in sorted(used):
        info = manifest.get("sources", {}).get(s, {})
        out["sources"][s] = {
            "citation": info.get("citation", s),
            "notes": info.get("notes", ""),
        }

    with open(a.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    size = os.path.getsize(a.out)
    print(f"wrote {a.out} ({size/1024:.1f} kB)")
    if EXCLUDE:
        print("  excluded: " + ", ".join(f"{v}/{e}" for v, e in sorted(EXCLUDE))
              + "  (see EXCLUDE in this script for why)")
    for cond, d in sorted(out["squat"].items()):
        bits = [f"{v}/{e}" for v in sorted(d) for e in sorted(d[v])]
        print(f"  squat {cond}: {len(bits)} curves")
    for L in out["levels"]:
        print(f"  level {L['entity']:6s} {L['value']:5.2f} {L['unit']:4s} "
              f"{L['label']} ({L['source']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
