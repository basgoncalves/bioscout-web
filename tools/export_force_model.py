"""Export the FAIS surrogate pickle to the JSON the browser reads.

    python tools/export_force_model.py \
        C:/Git/FAIS_machine_learning/results/ml_training/kinematics_only_model.pkl

Writes ``data/force_model_v2.json`` and regenerates ``data/ref.json`` (the
Python-parity fixture of tests/test_force_model.mjs) from the SAME pickle, so
the two can never describe different networks.

Why a new file name rather than overwriting force_model.json: sw.js serves the
model cache-first from the heavy cache, which is deliberately almost never
bumped (it holds 44 MB of wasm). A changed file under the old name would never
reach a phone that already has it. A new name is a cache miss, which is the
cheapest correct invalidation.

Format ``fais-forcenet/2`` is /1 plus:
  target_blocks   group name -> target names (muscle forces, GRF, moments ...)
  target_units    group name -> unit
  frames          the reference frame of every force group, in words
/1 files still load; forces.js treats the additions as optional.

The exporter refuses to write unless a replay of the float32 JSON weights
reproduces the pickle's float64 forward pass to 1e-3 BW on random inputs --
the check whose absence let the BatchNorm export ship broken.
"""
import base64
import json
import pickle
import sys
from pathlib import Path

import numpy as np

G = 9.80665
HERE = Path(__file__).resolve().parent.parent

CAMERA_COORDS = ["pelvis_tilt", "pelvis_ty", "pelvis_tx", "hip_flexion_r",
                 "knee_angle_r", "ankle_angle_r", "hip_flexion_l", "knee_angle_l",
                 "ankle_angle_l", "lumbar_extension", "elbow_flex_r", "elbow_flex_l"]

UNITS = {"muscle forces": "BW", "JRF components": "BW", "JRF magnitude": "BW",
         "GRF": "BW", "joint moments": "N.m/kg", "activations": "0-1",
         "muscle power": "W/kg", "hip JCF in pelvis": "BW"}


def _ln(x, w, b, eps=1e-5):
    mu = x.mean(-1, keepdims=True)
    var = x.var(-1, keepdims=True)
    return (x - mu) / np.sqrt(var + eps) * w + b


def forward(w, X):
    X = np.asarray(X, np.float64)
    z = (X - w["x_mean"]) / np.where(np.abs(w["x_std"]) < 1e-12, 1.0, w["x_std"])
    h = np.maximum(0.0, z @ w["stem_W"] + w["stem_b"])
    for b in w["blocks"]:
        n = _ln(h, b["norm_w"], b["norm_b"])
        n = np.maximum(0.0, n @ b["fc1_W"] + b["fc1_b"])
        h = h + n @ b["fc2_W"] + b["fc2_b"]
    h = _ln(h, w["norm_w"], w["norm_b"])
    return (h @ w["head_W"] + w["head_b"]) * w["y_std"] + w["y_mean"]


def pack(a):
    a = np.ascontiguousarray(np.asarray(a, np.float32))
    return {"shape": list(a.shape), "b64": base64.b64encode(a.tobytes()).decode()}


def unpack(d):
    return np.frombuffer(base64.b64decode(d["b64"]), np.float32) \
             .reshape(d["shape"]).astype(np.float64)


def ddt(v, t):
    out = np.zeros_like(v)
    n = len(t)
    for i in range(n):
        i0, i1 = max(0, i - 1), min(n - 1, i + 1)
        dt = t[i1] - t[i0]
        out[i] = (v[i1] - v[i0]) / dt if dt > 0 else 0.0
    return out


def features(feat, x_mean, coords, times, mass, height):
    """The arithmetic of forces.js buildFeatures, line for line."""
    n = len(times)
    X = np.tile(np.asarray(x_mean, np.float64), (n, 1))
    ser = {}
    for j, f in enumerate(feat):
        if f == "mass_kg":
            X[:, j] = mass
            continue
        if f == "height_m":
            X[:, j] = height
            continue
        for pre, kind in (("qdd_", 2), ("qd_", 1), ("q_", 0)):
            if f.startswith(pre):
                base = f[len(pre):]
                if base in coords:
                    if base not in ser:
                        raw = np.asarray(coords[base], np.float64)
                        q = raw[np.minimum(np.arange(n), len(raw) - 1)]
                        qd = ddt(q, times)
                        ser[base] = (q, qd, ddt(qd, times))
                    X[:, j] = ser[base][kind]
                break
    return X


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    src = Path(argv[1])
    out = Path(argv[2]) if len(argv) > 2 else HERE / "data" / "force_model_v2.json"
    with open(src, "rb") as fh:
        b = pickle.load(fh)
    need = {"weights", "feature_names", "target_names", "inputs"}
    if need - set(b):
        sys.exit(f"{src.name}: not a FAIS surrogate bundle (missing {sorted(need - set(b))})")
    w = b["weights"]
    targ = [str(t) for t in b["target_names"]]
    feat = [str(f) for f in b["feature_names"]]
    blocks = {k: [str(x) for x in v] for k, v in (b.get("target_blocks") or {}).items()}
    muscles = blocks.get("muscle forces") or [
        t for t in targ if not t.startswith(("hip_", "knee_", "ankle_"))]
    rep = b.get("report") or {}
    groups = rep.get("groups", rep)

    doc = {
        "format": "fais-forcenet/2",
        "info": (f"Static-optimisation surrogate. Inputs: kinematics. Outputs: "
                 f"{len(targ)} targets -- {', '.join(f'{len(v)} {k}' for k, v in blocks.items())}."),
        "provenance": (f"FAIS cohort, {len(b.get('train_subjects', []))} training subjects, "
                       f"held out {','.join(str(s) for s in b.get('test_subjects', []))}. "
                       f"Trained from OpenSim StaticOptimization + JointReaction "
                       f"({b.get('iteration', '?')}; source {src.name})."),
        "inputs": b["inputs"], "arch": "linear-relu + layernorm residual blocks (no batchnorm)",
        "units": "bodyweight", "units_detail": str(b.get("units", "")),
        "frames": str(b.get("frames", "")),
        "gravity": G, "feat": feat, "targ": targ, "muscles": muscles,
        "jrf_components": blocks.get("JRF components", [t for t in targ if t[-3:] in ("_fx", "_fy", "_fz") and t.split("_")[0] in ("hip", "knee", "ankle") and "pelvis" not in t]),
        "jrf_magnitudes": blocks.get("JRF magnitude", [t for t in targ if t.endswith("_mag")]),
        "target_blocks": blocks, "target_units": {k: UNITS.get(k, "") for k in blocks},
        "camera_coords": CAMERA_COORDS,
        "report": {k: {kk: (vv if not isinstance(vv, (np.floating, np.integer)) else float(vv))
                       for kk, vv in v.items()} for k, v in groups.items()},
        "x_mean": pack(w["x_mean"]), "x_std": pack(w["x_std"]),
        "y_mean": pack(w["y_mean"]), "y_std": pack(w["y_std"]),
        "stem": {"W": pack(w["stem_W"]), "b": pack(w["stem_b"])},
        "blocks": [{"norm_w": pack(k["norm_w"]), "norm_b": pack(k["norm_b"]),
                    "fc1_W": pack(k["fc1_W"]), "fc1_b": pack(k["fc1_b"]),
                    "fc2_W": pack(k["fc2_W"]), "fc2_b": pack(k["fc2_b"])} for k in w["blocks"]],
        "norm_w": pack(w["norm_w"]), "norm_b": pack(w["norm_b"]),
        "head": {"W": pack(w["head_W"]), "b": pack(w["head_b"])},
    }

    # ---- replay: the file must BE the network ------------------------------
    w32 = {"x_mean": unpack(doc["x_mean"]), "x_std": unpack(doc["x_std"]),
           "y_mean": unpack(doc["y_mean"]), "y_std": unpack(doc["y_std"]),
           "stem_W": unpack(doc["stem"]["W"]), "stem_b": unpack(doc["stem"]["b"]),
           "norm_w": unpack(doc["norm_w"]), "norm_b": unpack(doc["norm_b"]),
           "head_W": unpack(doc["head"]["W"]), "head_b": unpack(doc["head"]["b"]),
           "blocks": [{k: unpack(v) for k, v in blk.items()} for blk in doc["blocks"]]}
    rng = np.random.default_rng(0)
    X = np.asarray(w["x_mean"]) + rng.normal(size=(256, len(feat))) * np.asarray(w["x_std"])
    err = float(np.abs(forward(w, X) - forward(w32, X)).max())
    if not err < 1e-3:
        sys.exit(f"REFUSED: float32 replay differs from the pickle by {err:.3g}")
    mi = [targ.index(m) for m in muscles]
    peak = float(np.abs(forward(w, np.asarray(w["x_mean"])[None])[:, mi]).max())
    if peak > 12:
        sys.exit(f"REFUSED: {peak:.1f} BW of muscle force at the training mean")

    out.write_text(json.dumps(doc), encoding="utf-8")
    print(f"wrote {out}  ({out.stat().st_size / 1e6:.2f} MB)  replay error {err:.2e}, "
          f"training-mean peak {peak:.2f} BW")

    # ---- parity fixture ------------------------------------------------------
    refp = HERE / "data" / "ref.json"
    if refp.exists():
        ref = json.loads(refp.read_text())
        t = np.asarray(ref["times"], np.float64)
        Xr = features(feat, w32["x_mean"], ref["coords"], t, ref["mass"], ref["height"])
        y = forward(w32, Xr)
        ref["expected_N"] = (y[:, mi] * ref["mass"] * G).tolist()
        ref["expected_all"] = y.tolist()          # every target, native units
        ref["model"] = out.name
        refp.write_text(json.dumps(ref), encoding="utf-8")
        print(f"rewrote {refp} against {out.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
