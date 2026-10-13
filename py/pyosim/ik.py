"""Inverse kinematics: weighted least squares on marker positions, frame by frame,
like OpenSim's InverseKinematicsTool (same task set and setup files)."""
import os
import xml.etree.ElementTree as ET
import numpy as np
from scipy.optimize import least_squares
from .io import read_trc, write_mot
from .model import Model, Kinematics


def read_tasks(path):
    """IK task set -> {marker: weight}, {coordinate: (weight, value_or_None)}."""
    root = ET.parse(path).getroot()
    mk, co = {}, {}
    for t in root.iter("IKMarkerTask"):
        if (t.findtext("apply") or "true").strip() == "true":
            mk[t.get("name")] = float(t.findtext("weight") or 1)
    for t in root.iter("IKCoordinateTask"):
        if (t.findtext("apply") or "true").strip() == "true":
            vt = (t.findtext("value_type") or "default_value").strip()
            co[t.get("name")] = (float(t.findtext("weight") or 1), vt, float(t.findtext("value") or 0))
    return mk, co


def solve(model, times, markers, marker_w, coord_tasks=None, t_range=None, log=print):
    coord_tasks = coord_tasks or {}
    names = [n for n in marker_w if n in markers and n in model.markers]
    if len(names) < 6:
        common = [n for n in model.markers if n in markers and not np.isnan(markers[n]).all()]
        log(f"[ik] task set matches only {len(names)} markers; using all {len(common)} markers "
            f"shared by model and .trc with weight 1")
        marker_w = {n: 1.0 for n in common}
        names = common
    missing = [n for n in marker_w if n not in markers or n not in model.markers]
    if len(names) < 6:
        raise ValueError(f"only {len(names)} task markers are both in the model and the .trc "
                         f"({', '.join(names) or 'none'}); check marker names / task set")
    if missing:
        log(f"[ik] {len(missing)} task markers not found, ignored: {', '.join(missing[:10])}")
    free = model.free
    lo = np.array([model.coords[n].range[0] if model.coords[n].clamped else -np.inf for n in free])
    hi = np.array([model.coords[n].range[1] if model.coords[n].clamped else np.inf for n in free])
    w = np.sqrt(np.array([marker_w[n] for n in names]))
    ct = [(n, np.sqrt(wt), val) for n, (wt, vt, val) in coord_tasks.items() if n in free]
    sel = np.ones(len(times), bool)
    if t_range is not None:
        half = 0.5 * np.median(np.diff(times))
        sel = (times >= t_range[0] - 1e-9) & (times <= t_range[1] + half)
    x = np.array([model.coords[n].default for n in free])
    x = np.clip(x, lo, hi)
    kin = Kinematics(model, names)
    nf = len(free)
    ct_i = [(free.index(n), s, val) for n, s, val in ct]
    H = 1e-6

    def resid_jac(v, obs, ok):
        V = np.vstack([v, v + H * np.eye(nf)])                 # pose + forward differences
        P = kin.markers(V)                                      # (nf+1, m, 3)
        R = ((P - obs[None]) * w[None, :, None])[:, ok].reshape(nf + 1, -1)
        if ct_i:
            C = np.array([[s * (Vb[i] - val) for i, s, val in ct_i] for Vb in V])
            R = np.hstack([R, C])
        return R[0], ((R[1:] - R[0]) / H).T

    out, errs = [], []
    first = True
    for k in np.where(sel)[0]:
        obs = np.array([markers[n][k] for n in names])
        ok = ~np.isnan(obs).any(axis=1)
        obs = np.nan_to_num(obs)
        cache = {}

        def fun(v):
            r, J = resid_jac(v, obs, ok); cache["J"] = J; cache["v"] = v.copy(); return r

        def jac(v):
            if "v" not in cache or not np.array_equal(cache["v"], v):
                fun(v)
            return cache["J"]

        sol = least_squares(fun, x, jac=jac, bounds=(lo, hi), method="trf", x_scale="jac",
                            xtol=1e-10, ftol=1e-10, gtol=1e-10, max_nfev=500 if first else 100)
        x = sol.x; first = False
        P = kin.markers(x[None])[0]
        e = np.linalg.norm(P - obs, axis=1)[ok]
        errs.append((np.sqrt(np.mean(e ** 2)), e.max()))
        out.append(model.full_q(dict(zip(free, x))))
    t = times[sel]
    return t, out, np.array(errs), names


def run(model_path, trc_path, task_path, out_mot, t_range=None, log=print, markerset=None):
    model = model_path if isinstance(model_path, Model) else Model(model_path)
    if markerset:
        model.load_markerset(markerset)
        log(f"[ik] markers from {os.path.basename(markerset)} ({len(model.markers)})")
    times, markers, rate = read_trc(trc_path)
    mw, ct = read_tasks(task_path) if task_path else ({}, {})
    t, qs, errs, used = solve(model, times, markers, mw, ct, t_range, log)
    cols = ["time"] + model.coord_order
    # as OpenSim: degrees for rotational coordinates, but coupled (dependent) ones stay in radians
    rot = {n for n, c in model.coords.items() if not c.translational and c.coupled is None}
    data = np.array([[ti] + [np.degrees(q[n]) if n in rot else q[n] for n in model.coord_order]
                     for ti, q in zip(t, qs)])
    write_mot(out_mot, cols, data)
    log(f"[ik] {len(t)} frames, {len(used)} markers; RMS error mean {errs[:,0].mean()*1000:.1f} mm, "
        f"max {errs[:,1].max()*1000:.1f} mm")
    return out_mot, errs
