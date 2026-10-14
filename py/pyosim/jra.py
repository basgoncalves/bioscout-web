"""Joint reaction analysis in pure Python -- what OpenSim's JointReaction
analysis writes (Analyse_JRA_ReactionLoads.sto): for every joint, the force
and moment the joint applies to its CHILD body, expressed in the child body,
about the joint centre.

For the subtree S below a joint (its child body and everything further out):

    F_joint = sum_S m (a - g)              - F_external(S) - F_muscles(S)
    M_joint = sum_S (I alpha + w x I w + (c - P) x m (a - g))
              - sum (r - P) x F_external/muscles - T_external

with the muscle forces from static optimisation applied at the path points
along the straight segments of each path (wrapping changes the line of action
a little near the wrap surface; it is not modelled here). Coordinate
actuators (reserves) act along the joint's own axes, not as reactions, so they
are left out, as OpenSim's reactions do.
"""
import os
import numpy as np
from .model import Model, Kinematics
from .muscles import read_muscles
from .io import read_sto, write_mot
from . import id as idtool


def run(model_path, coords_mot, forces_sto, loads_xml, out_sto, loads_mot=None, cutoff=6.0, log=print):
    model = model_path if isinstance(model_path, Model) else Model(model_path)
    osim = model_path if isinstance(model_path, str) else model.path
    fc, fd, _ = read_sto(forces_sto)
    tf = fd[:, fc.index("time")]
    t, Q = idtool.read_coords(model, coords_mot)
    Q = idtool._lowpass(Q, t, cutoff)
    m = (t >= tf[0] - 1e-9) & (t <= tf[-1] + 1e-9)
    t, Q = t[m], Q[m]
    n = len(t)
    if n < 3:
        raise ValueError("the muscle forces and the joint angles do not overlap in time")
    mus = [mu for mu in read_muscles(osim) if mu["name"] in fc]
    log(f"[jra] {n} frames, {len(mus)} muscles with forces, {len(model.joints)} joints")

    kin = Kinematics(model, [])
    names, C, R = idtool._body_state(model, Q, t, kin)
    bidx = {b: k for k, b in enumerate(names)}
    nb = len(names)
    mass = np.array([model.bodies[b]["mass"] for b in names])
    Iloc = np.zeros((nb, 3, 3))
    for k, b in enumerate(names):
        xx, yy, zz, xy, xz, yz = model.bodies[b]["inertia"]
        Iloc[k] = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]
    g = np.asarray(model.gravity)
    V = np.gradient(C, t, axis=0); A = np.gradient(V, t, axis=0)
    Rd = np.gradient(R, t, axis=0)
    S = np.einsum("nbij,nbkj->nbik", Rd, R)
    W = np.stack([S[..., 2, 1] - S[..., 1, 2], S[..., 0, 2] - S[..., 2, 0], S[..., 1, 0] - S[..., 0, 1]], -1) / 2
    AL = np.gradient(W, t, axis=0)
    Ig = np.einsum("nbij,bjk,nblk->nbil", R, Iloc, R)

    # every body's own wrench, about the ground origin: inertial - gravity - applied
    Fm = mass[None, :, None] * (A - g)                                      # (n, nb, 3)
    Mm = np.einsum("nbij,nbj->nbi", Ig, AL) + np.cross(W, np.einsum("nbij,nbj->nbi", Ig, W)) + np.cross(C, Fm)

    def apply(b, F, P, T=None):                                             # an applied force at P (ground)
        Fm[:, b] -= F; Mm[:, b] -= np.cross(P, F) + (0 if T is None else T)

    if loads_xml:
        datafile, forces = idtool.read_external_loads(loads_xml, loads_mot)
        if not os.path.isabs(datafile) and not os.path.isfile(datafile):
            datafile = os.path.join(os.path.dirname(loads_xml), datafile)
        cols, data, _ = read_sto(datafile)
        ts = data[:, cols.index("time")]
        for f in forces:
            if f["body"] not in bidx:
                continue
            F = idtool._xyz(cols, data, f["fid"], ts, t); P = idtool._xyz(cols, data, f["pid"], ts, t); T = idtool._xyz(cols, data, f["tid"], ts, t)
            if f["force_in"] != "ground":
                Rb = R[:, bidx[f["force_in"]]]; F = np.einsum("nij,nj->ni", Rb, F); T = np.einsum("nij,nj->ni", Rb, T)
            if f["point_in"] != "ground":
                k = bidx[f["point_in"]]; org = C[:, k] - R[:, k] @ model.bodies[f["point_in"]]["com"]
                P = org + np.einsum("nij,nj->ni", R[:, k], P)
            apply(bidx[f["body"]], F, P, T)

    TB = kin.bodies(Q)
    gpt = lambda b, loc: TB[b][1] + (TB[b][0] @ loc)
    for mu in mus:
        Fmag = np.interp(t, tf, fd[:, fc.index(mu["name"])])
        X = [gpt(b, loc) for b, loc in mu["pts"]]
        U = [X[i + 1] - X[i] for i in range(len(X) - 1)]
        U = [u / np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-9) for u in U]
        for i, (b, _) in enumerate(mu["pts"]):
            if b not in bidx:
                continue
            d = (U[i] if i < len(U) else 0) - (U[i - 1] if i > 0 else 0)       # tension pulls toward both neighbours
            apply(bidx[b], Fmag[:, None] * d, X[i])

    # subtree sums, leaves first
    Fs, Ms = Fm.copy(), Mm.copy()
    for j in reversed(model.joints):
        c, p = bidx.get(model._body_of(j.child)), bidx.get(model._body_of(j.parent))
        if c is not None and p is not None:
            Fs[:, p] += Fs[:, c]; Ms[:, p] += Ms[:, c]

    cols, out = ["time"], [t]
    for j in model.joints:
        cb = model._body_of(j.child); c = bidx[cb]
        Rc, oc = TB[cb]
        Rc = np.broadcast_to(Rc, (n, 3, 3))
        loc = (j.child.p if j.child.name != cb else np.zeros(3))
        P = oc + np.einsum("nij,j->ni", Rc, loc)
        F = Fs[:, c]; M = Ms[:, c] - np.cross(P, F)
        Fc = np.einsum("nji,nj->ni", Rc, F); Mc = np.einsum("nji,nj->ni", Rc, M)
        base = f"{j.name}_on_{cb}_in_{cb}"
        for lab, v in (("f", Fc), ("m", Mc)):
            for a, ax in enumerate("xyz"):
                cols.append(f"{base}_{lab}{ax}"); out.append(v[:, a])
        for a, ax in enumerate("xyz"):
            cols.append(f"{base}_p{ax}"); out.append(np.full(n, loc[a]))
    write_mot(out_sto, cols, np.column_stack(out), name="Joint Reaction Loads", degrees=False)
    log(f"[jra] wrote {os.path.basename(out_sto)}")
    return t, cols
