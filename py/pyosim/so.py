"""Static optimisation in pure Python, as OpenSim's StaticOptimization with
use_muscle_physiology: per frame, the muscle activations a (0..1) and actuator
controls u that minimise sum(a^2) + sum(u^2) while the muscles and actuators
reproduce the inverse-dynamics generalised forces.

    muscle force = F0 * (a * fl(lm) * fv(vm) + fp(lm)) * cos(pennation)
    rigid tendon: fibre length from the musculotendon length, pennation at constant thickness

Moment arms come from muscles.Paths (via points + cylinder/sphere wrapping);
the inverse dynamics from id.py; actuators (reserves, lumbar, residuals) from
the model's CoordinateActuators and/or an actuators .xml."""
import os
import xml.etree.ElementTree as ET
import numpy as np
from scipy.optimize import lsq_linear
from .model import Model
from .muscles import Paths
from .io import read_sto, write_mot
from . import id as idtool
from . import millard


def read_actuators(*paths):
    out = {}
    for p in paths:
        if not p or not os.path.isfile(p):
            continue
        for a in ET.parse(p).getroot().iter("CoordinateActuator"):
            c = (a.findtext("coordinate") or "").strip()
            if not c or c == "Unassigned" or (a.findtext("appliesForce") or "true").strip() == "false":
                continue
            out[a.get("name")] = (c, float(a.findtext("optimal_force") or 1),
                                  float(a.findtext("min_control") or -np.inf), float(a.findtext("max_control") or np.inf))
    return out


# curves (Thelen 2003 shapes; close to Millard's defaults over the physiological range)
def f_active(l):  return np.exp(-((l - 1.0) ** 2) / 0.45)
def f_passive(l):
    # capped at 1.4 x optimal length: with a rigid tendon the fibre stretch is overestimated in deep flexion
    # (deep squats), and the exponential would otherwise give kN of passive force from a silent muscle
    l = np.minimum(l, 1.4)
    return np.where(l > 1, (np.exp(4 * (l - 1) / 0.6) - 1) / (np.exp(4) - 1), 0.0)
def f_velocity(v):                     # v: fibre velocity / (vmax * lopt), shortening < 0
    v = np.clip(v, -0.999, 1.0)
    return np.where(v <= 0, (1 + v) / (1 - v / 0.25), 1.8 - 0.8 * (1 + 0.0) / (1 + v * 7.56))


def _solve_frame(A, b, lb, ub, wa, ref=None, w_ref=0.0, w_eq=100.0):
    """min |w_eq (A z - b)|^2 + |wa z|^2 within lb <= z <= ub: one bounded linear least squares.
    The moment equations are weighted so heavily (1 N*m off costs as much as 100 fully active muscles)
    that they hold whenever muscles + reserves can meet them, and the frame still has a best answer
    when they cannot -- an equality-constrained solver returns something arbitrary there."""
    n = A.shape[1]
    ub = np.maximum(ub, lb + 1e-9)                               # the solver wants lb < ub strictly
    M = np.vstack([w_eq * A, np.diag(wa)])
    r = np.concatenate([w_eq * b, np.zeros(n)])
    if ref is not None and w_ref > 0:                            # stay close to the neighbouring frames' activations
        k = len(ref); S = np.zeros((k, n)); S[np.arange(k), np.arange(k)] = w_ref
        M = np.vstack([M, S]); r = np.concatenate([r, w_ref * ref])
    res = lsq_linear(M, r, bounds=(lb, ub), method="bvls", max_iter=4 * n)
    if not res.success and res.status <= 0:                      # bvls gave up (rare): the iterative method instead
        res = lsq_linear(M, r, bounds=(lb, ub), method="trf", lsmr_tol="auto")
    return np.clip(res.x, lb, ub)


def run(model_path, coords_mot, id_sto, out_dir, actuators=None, t_range=None, cutoff=6.0, log=print, prefix="SO",
        passive=False, strength=1.0, t_smooth=0.020, smooth=True, tendon=True, tendon_iters=4, _dbg=None):
    """passive=False (default) matches OpenSim's StaticOptimization, which applies only the active
    fibre force a * F0 * fl * fv * cos(pennation); True adds the passive fibre force on top.

    Differences from a plain frame-by-frame static optimisation (they are what makes it usable on fast
    movements such as running):
      * reserves are never capped: a reserve on a coordinate that muscles span costs (moment / 1 N*m)^2,
        so it is used only for what the muscles cannot do, and how much that was is reported;
      * every frame has a solution (bounded least squares, see _solve_frame), also where the muscles
        cannot produce the inverse-dynamics moment;
      * smooth=True: the frames are solved together rather than one by one -- each frame's cost also has
        (t_smooth / dt)^2 |a - a_neighbours|^2, so an activation changes over about t_smooth (20 ms, the
        order of activation dynamics) instead of jumping between 0 and 1 from frame to frame, in both
        directions of time (no lag); a few sweeps over the frames reach that joint solution;
      * tendon=True: the tendon stretches with its force, so the fibres of long-tendon muscles (triceps
        surae) are not made to shorten at impossible speeds (see the comment at step 2 below);
      * strength: factor on every muscle's maximum isometric force (generic models are sized for
        walking: 1.5-2 is common for running and jumping)."""
    model = model_path if isinstance(model_path, Model) else Model(model_path)
    osim = model_path if isinstance(model_path, str) else getattr(model, "path", None)
    paths = Paths(model, osim)
    t, Q = idtool.read_coords(model, coords_mot)
    Q = idtool._lowpass(Q, t, cutoff)                             # on all the frames there are, then cropped
    from scipy.interpolate import make_interp_spline
    Qd_all = make_interp_spline(t, Q, k=5, axis=0).derivative()(t) if len(t) > 6 else np.gradient(Q, t, axis=0)
    ic, idd, _ = read_sto(id_sto)
    tid = idd[:, ic.index("time")]
    # only where there are inverse-dynamics moments (the coordinates may carry a margin either side)
    lo, hi = max(t[0], tid[0]), min(t[-1], tid[-1])
    if t_range:
        lo, hi = max(lo, t_range[0]), min(hi, t_range[1])
    m = (t >= lo - 1e-9) & (t <= hi + 1e-9); t, Q, Qd_all = t[m], Q[m], Qd_all[m]
    act = read_actuators(osim, actuators)
    # coordinates to satisfy: every non-locked coordinate a muscle or an actuator can move
    acts_on = {c for c, *_ in act.values()}
    names_c = [c for c in model.free if not model.coords[c].locked]
    L, R = paths.moment_arms(Q, names_c)                         # (n, M), (n, C, M)
    R_all = R
    spans = np.abs(R).max(axis=(0, 2)) > 1e-4
    moves = spans | np.array([c in acts_on for c in names_c])
    if acts_on:
        # With an actuator set, its coordinates are the ones to balance (hip x3, knee flexion, ankle, lumbar in the
        # template). Muscles also have small moment arms about coordinates the joint itself carries -- knee
        # adduction and the condyle / patella coordinates, subtalar, toes: asking muscles alone to produce those
        # inverse-dynamics moments forces heavy co-contraction that the flexion reserves then have to undo.
        left = [c for k, c in enumerate(names_c) if spans[k] and c not in acts_on]
        moves = np.array([c in acts_on for c in names_c])
        if left:
            log(f"[so] not balanced by muscles (no actuator named for them; carried by the joint): {' '.join(left)}")
    cidx = [k for k, c in enumerate(names_c) if moves[k]]
    coords = [names_c[k] for k in cidx]; R = R[:, cidx]
    tau = np.stack([np.interp(t, tid, idd[:, ic.index(c + ("_force" if model.coords[c].translational else "_moment"))])
                    if (c + "_moment") in ic or (c + "_force") in ic else np.zeros(len(t)) for c in coords], 1)
    mus = paths.mus
    F0 = strength * np.array([m["F0"] for m in mus]); lopt = np.array([m["lopt"] for m in mus]); lts = np.array([m["lts"] for m in mus])
    a0 = np.array([m["alpha"] for m in mus]); vmax = np.array([m["vmax"] for m in mus])
    h = lopt * np.sin(a0)
    # fibre velocity as OpenSim: musculotendon speed = -sum(moment arm x coordinate speed), coordinate
    # speeds from a quintic spline of the filtered coordinates. Differentiating the length itself rings
    # wherever a path jumps onto or off a wrap surface (a kink in the length), e.g. -9 l0/s for one frame.
    Qd = Qd_all
    ci_all = [model.coord_order.index(c) for c in names_c]
    v_mt = -np.einsum("ncm,nc->nm", R_all, Qd[:, ci_all])                     # musculotendon lengthening speed
    curves = millard.curves_from_osim(osim) if osim else {}

    def state(lt):
        """Fibre state for tendon lengths lt (n, M): force per unit activation, passive force, l/l0, v/vmax.
        Rigid tendon: lt = slack length, the fibre takes all of the musculotendon length change."""
        lmt = np.maximum(L - lt, 1e-4)
        lm = np.sqrt(lmt ** 2 + h ** 2); cosa = lmt / lm
        dlt = np.gradient(lt, t, axis=0) if len(t) > 2 else 0.0
        vm = (v_mt - dlt) * cosa
        nl, nv = lm / lopt, vm / (vmax * lopt)
        fl, fv = f_active(nl), f_velocity(nv)                                 # Thelen-type, for non-Millard muscles
        for k, m in enumerate(mus):
            if m["name"] in curves:                                           # the model's own Millard curves
                cfl, cfv = curves[m["name"]]
                fl[:, k] = cfl(nl[:, k]); fv[:, k] = cfv(nv[:, k])
        Fa = F0 * fl * fv * cosa                                              # per unit activation
        Fp = F0 * f_passive(nl) * cosa if passive else np.zeros_like(Fa)
        return Fa, Fp, nl, nv, fl, fv

    Fa, Fp, nl, nv, fl, fv = state(np.broadcast_to(lts, L.shape).copy())
    log(f"[so] {sum(m['name'] in curves for m in mus)}/{len(mus)} muscles on Millard curves; passive fibre force "
        + ("included" if passive else "left out (as OpenSim)"))
    an = list(act); A_c = np.zeros((len(coords), len(an))); opt = np.array([act[a][1] for a in an])
    spanned = np.abs(R).max(axis=(0, 2)) > 1e-4                               # coordinates a muscle can move
    wa = np.ones(len(mus) + len(an))
    lb = np.concatenate([np.full(len(mus), 0.01), np.full(len(an), -np.inf)])
    ub = np.concatenate([np.ones(len(mus)), np.full(len(an), np.inf)])
    for j, a in enumerate(an):
        c = act[a][0]
        if c not in coords:
            lb[len(mus) + j] = ub[len(mus) + j] = 0.0; continue
        k = coords.index(c); A_c[k, j] = opt[j]
        # control u = moment / optimal force. A reserve next to muscles is priced per N*m (as an OpenSim
        # reserve of optimal force 1), whatever optimal force the file gives it; an actuator on a coordinate
        # no muscle spans (lumbar, residuals) does the whole job there and keeps the file's price.
        if spanned[k]:
            wa[len(mus) + j] = opt[j]
    log(f"[so] {len(t)} frames, {len(mus)} muscles, {len(an)} actuators, {len(coords)} coordinates"
        + (f", strength x{strength:g}" if strength != 1 else ""))
    n = len(t); nm = len(mus); X = np.zeros((n, nm + len(an)))

    def frames(Fa, Fp, say=False):
        AB = [(np.hstack([R[i] * Fa[i][None], A_c]), tau[i] - R[i] @ Fp[i]) for i in range(n)]
        Y = np.zeros((n, nm + len(an)))
        for i in range(n):
            Y[i] = _solve_frame(*AB[i], lb, ub, wa)
            if say and i % 50 == 0:
                log(f"[so] frame {i + 1}/{n}")
        return AB, Y

    AB, X = frames(Fa, Fp, say=True)                                          # 1. every frame on its own, rigid tendon
    if tendon and n > 4:
        # 2. tendon stretch. With a rigid tendon the fibres of a long-tendon muscle (soleus, gastrocnemii: tendon
        #    6-8 fibre lengths) take the whole length change of the musculotendon unit -- in the push-off of a run
        #    that is shortening near vmax, the force-velocity curve gives them ~0 force, and the ankle moment is
        #    left to the reserves. The tendon stretches with its force (4.9 % at F0; De Groote et al. 2016:
        #    f = 0.2 exp(35 (l/ls - 0.995)) - 0.25), so the fibre length and speed are recomputed with the tendon
        #    length that belongs to the forces just found, and the frames solved again (fixed point, damped).
        lt_n = np.ones_like(L)                                                # tendon length / slack length
        ker = np.ones(5) / 5
        for it in range(tendon_iters):
            F = X[:, :nm] * Fa + Fp
            fT = np.clip(F / F0, 0.0, 1.6)
            pad = np.pad(fT, ((2, 2), (0, 0)), mode="edge")                   # the tendon does not follow frame-to-frame jitter
            fT = np.apply_along_axis(lambda v: np.convolve(v, ker, mode="valid"), 0, pad)
            new = 0.995 + np.log((fT + 0.25) / 0.2) / 35.0
            lt_n = 0.5 * lt_n + 0.5 * new
            Fa, Fp, nl, nv, fl, fv = state(lts * lt_n)
            AB, X = frames(Fa, Fp)
        log(f"[so] tendon stretch included ({tendon_iters} passes); largest strain {100 * (lt_n.max() - 1):.1f} %")
    if _dbg is not None:
        _dbg.update(names=[m["name"] for m in mus], nl=nl, nv=nv, fl=fl, fv=fv, t=t, lts=lts, lopt=lopt)
    if smooth and n > 2:
        # 2. coupled in time: block Gauss-Seidel sweeps (forward, backward, ...) on
        #    sum_i |a_i|^2 + lam sum_i |a_i+1 - a_i|^2 with the moment equations of every frame
        dt = float(np.median(np.diff(t))); lam = (t_smooth / dt) ** 2
        for sweep in range(4):
            order = range(n) if sweep % 2 == 0 else range(n - 1, -1, -1)
            for i in order:
                nb = [X[j, :nm] for j in (i - 1, i + 1) if 0 <= j < n]
                X[i] = _solve_frame(*AB[i], lb, ub, wa, ref=np.mean(nb, axis=0), w_ref=np.sqrt(lam * len(nb)))
        log(f"[so] frames coupled in time (activations change over ~{t_smooth * 1000:.0f} ms)")
    viol = np.array([np.abs(AB[i][0] @ X[i] - AB[i][1]).max() for i in range(n)])
    forces = X[:, :len(mus)] * Fa + Fp
    acts = X[:, :len(mus)]
    os.makedirs(out_dir, exist_ok=True)
    cols = ["time"] + [m["name"] for m in mus] + an
    write_mot(os.path.join(out_dir, f"{prefix}_StaticOptimization_force.sto"), cols,
              np.column_stack([t, forces, X[:, len(mus):] * opt]), name="Static Optimization", degrees=False)
    write_mot(os.path.join(out_dir, f"{prefix}_StaticOptimization_activation.sto"), cols,
              np.column_stack([t, acts, X[:, len(mus):]]), name="Static Optimization", degrees=False)
    # each muscle's (and the reserves') moment about the main leg coordinates, with SO's own moment arms:
    # they add up to the inverse-dynamics moment it was solved against (to within the reported mismatch).
    # A moment arm from a separate muscle analysis is computed on other (unfiltered) kinematics and does not.
    import re as _re
    mcols, mdata = ["time"], [t]
    for k, c in enumerate(coords):
        if not _re.match(r"(hip_flexion|hip_adduction|hip_rotation|knee_angle|ankle_angle)_[rl]$", c):
            continue
        for j, m in enumerate(mus):
            if np.abs(R[:, k, j]).max() > 1e-4:
                mcols.append(f"{c}|{m['name']}"); mdata.append(R[:, k, j] * forces[:, j])
        mcols.append(f"{c}|reserve"); mdata.append((X[:, len(mus):] * opt) @ (A_c[k] / np.where(opt == 0, 1, opt)))
        mcols.append(f"{c}|ID"); mdata.append(tau[:, k])
    if len(mcols) > 1:
        write_mot(os.path.join(out_dir, f"{prefix}_StaticOptimization_moments_contrib.sto"), mcols, np.column_stack(mdata),
                  name="Static Optimization moment contributions (N*m; per coordinate: muscles, reserve, ID)", degrees=False)
    bad = int((viol > 1.0).sum())
    log(f"[so] done; moments matched to {np.median(viol):.3f} N·m median" + (f", {bad} frames off by > 1 N·m" if bad else ""))
    # how much of each coordinate's moment the reserves had to carry: the honest measure of the solution
    rs = X[:, nm:] * opt
    worst = []
    for j, a in enumerate(an):
        c = act[a][0]
        if c in coords and spanned[coords.index(c)]:
            pk = np.abs(tau[:, coords.index(c)]).max(); r = np.abs(rs[:, j]).max()
            if pk > 1 and r > 0.05 * pk and r > 2:
                worst.append((r / pk, f"{c} {r:.0f} of {pk:.0f} N·m"))
    if worst:
        worst.sort(reverse=True)
        log("[so] reserves carried more than 5 % of the peak moment at: " + "; ".join(w for _, w in worst[:6])
            + " -- the muscles could not produce it (raise 'strength', or check scaling / kinematics)")
    sat = float((X[:, :nm] > 0.99).mean()) * 100
    if sat > 2:
        log(f"[so] {sat:.0f} % of the muscle-frames are fully activated")
    return t, [m["name"] for m in mus], forces, acts
