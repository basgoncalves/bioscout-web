"""Muscle-tendon paths of an OpenSim model in pure Python: path points plus
wrapping over cylinders and spheres (tangent lines and the arc between them,
the side chosen by the wrap object's quadrant, else the shorter way), lengths
for many poses at once, and moment arms as -dL/dq. Tori are not wrapped (their
muscles follow their via points)."""
import re
import xml.etree.ElementTree as ET
import numpy as np
from .model import _vec, rot_xyz, _path_name, Kinematics

MUSCLE_TAGS = ("Millard2012EquilibriumMuscle", "Thelen2003Muscle", "DeGrooteFregly2016Muscle", "Millard2012AccelerationMuscle", "RigidTendonMuscle")


def _wrap_objects(root):
    out = {}
    for body in root.iter("Body"):
        ws = body.find("WrapObjectSet/objects")
        if ws is None:
            continue
        for w in ws:
            if (w.findtext("active") or "true").strip() == "false":
                continue
            q = (w.findtext("quadrant") or "all").strip().lower()
            qv = None
            m = re.fullmatch(r"([+-]?)([xyz])", q)
            if m:
                qv = np.zeros(3); qv["xyz".index(m.group(2))] = -1.0 if m.group(1) == "-" else 1.0
            out[w.get("name")] = dict(kind=w.tag, body=body.get("name"), R=rot_xyz(_vec(w.findtext("xyz_body_rotation"))),
                                      t=_vec(w.findtext("translation")), r=float(w.findtext("radius") or 0),
                                      length=float(w.findtext("length") or 0), q=qv)
    return out


def read_muscles(path):
    root = ET.parse(path).getroot()
    wraps = _wrap_objects(root)
    out = []
    for tag in MUSCLE_TAGS:
        for m in root.iter(tag):
            if (m.findtext("appliesForce") or "true").strip() == "false":
                continue
            pts = [(_path_name(p.findtext("socket_parent_frame") or p.findtext("body")), _vec(p.findtext("location")))
                   for p in m.find("GeometryPath/PathPointSet/objects") if p.tag.endswith("PathPoint")]
            wr = []
            for w in m.iterfind("GeometryPath/PathWrapSet/objects/PathWrap"):
                o = wraps.get((w.findtext("wrap_object") or "").strip())
                if o is None or o["kind"] not in ("WrapCylinder", "WrapSphere"):
                    continue
                rg = [int(float(x)) for x in (w.findtext("range") or "-1 -1").split()]
                wr.append(dict(o, range=None if rg[0] < 1 else (rg[0] - 1, rg[1] - 1)))   # path-point indices, 0-based
            if len(pts) < 2:                       # the <defaults> template, not a muscle
                continue
            g = lambda k, d: float(m.findtext(k) or d)
            out.append(dict(name=m.get("name"), pts=pts, wraps=wr, F0=g("max_isometric_force", 1000), lopt=g("optimal_fiber_length", 0.1),
                            lts=g("tendon_slack_length", 0.2), alpha=g("pennation_angle_at_optimal", 0), vmax=g("max_contraction_velocity", 10)))
    return out


def _circle(P, S, r, Q3, to3, force_ok=None):
    """Shortest admissible path P -> circle(r, origin) -> S in a plane, for many cases at once.
    P,S: (B,2). Returns wrapped length (B,) and a mask of where wrapping applies. Q3: quadrant
    direction (3,) or None; to3(angle) -> (B,3) the arc point in the wrap frame, for the quadrant test."""
    dP, dS = np.linalg.norm(P, axis=1), np.linalg.norm(S, axis=1)
    D = S - P; L2 = np.maximum((D * D).sum(1), 1e-18)
    t = np.clip(-(P * D).sum(1) / L2, 0, 1)
    C = P + t[:, None] * D
    near = np.linalg.norm(C, axis=1)
    ok = (dP > r * 1.0001) & (dS > r * 1.0001) & (near < r)
    if Q3 is not None:
        # with a quadrant the path may not pass the object on the other side: a line that misses
        # the object on the forbidden side wraps round the allowed side anyway (as OpenSim)
        cang = np.arctan2(C[:, 1], C[:, 0])
        forced = (dP > r * 1.0001) & (dS > r * 1.0001) & (to3(cang) @ Q3 < 0)
        ok |= forced if force_ok is None else forced & force_ok(t)
    if not ok.any():
        return None, ok
    aP, aS = np.arccos(np.clip(r / np.maximum(dP, r), -1, 1)), np.arccos(np.clip(r / np.maximum(dS, r), -1, 1))
    thP, thS = np.arctan2(P[:, 1], P[:, 0]), np.arctan2(S[:, 1], S[:, 0])
    tP, tS = np.sqrt(np.maximum(dP ** 2 - r ** 2, 0)), np.sqrt(np.maximum(dS ** 2 - r ** 2, 0))
    best, bestmid = None, None
    cands = []
    for d in (1, -1):
        t1, t2 = thP + d * aP, thS - d * aS
        arc = np.mod(d * (t2 - t1), 2 * np.pi)
        cands.append((tP + tS + r * arc, t1 + d * arc / 2))
    (l1, m1), (l2, m2) = cands
    if Q3 is None:
        L = np.minimum(l1, l2)
    else:
        good1 = to3(m1) @ Q3 >= 0
        good2 = to3(m2) @ Q3 >= 0
        L = np.where(good1 & ~good2, l1, np.where(good2 & ~good1, l2, np.minimum(l1, l2)))
    return L, ok


def _wrap_segment(Pl, Sl, w):
    """Wrapped length of the straight segments Pl->Sl (wrap-frame coordinates), NaN where it does not wrap."""
    B = len(Pl); out = np.full(B, np.nan); r = w["r"]
    if w["kind"] == "WrapCylinder":
        half = w["length"] / 2 if w["length"] > 0 else np.inf
        L2, ok = _circle(Pl[:, :2], Sl[:, :2], r, w["q"], lambda a: np.stack([r * np.cos(a), r * np.sin(a), np.zeros_like(a)], 1),
                         force_ok=lambda t: np.abs(Pl[:, 2] + t * (Sl[:, 2] - Pl[:, 2])) <= half)
        if L2 is None:
            return out
        dz = Sl[:, 2] - Pl[:, 2]
        out[ok] = np.sqrt(L2[ok] ** 2 + dz[ok] ** 2)
        return out
    # sphere: the great circle in the plane of P, S and the centre
    e1 = Pl / np.maximum(np.linalg.norm(Pl, axis=1, keepdims=True), 1e-12)
    n = np.cross(Pl, Sl); n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    e2 = np.cross(n, e1)
    P2 = np.stack([(Pl * e1).sum(1), (Pl * e2).sum(1)], 1); S2 = np.stack([(Sl * e1).sum(1), (Sl * e2).sum(1)], 1)
    L2, ok = _circle(P2, S2, r, w["q"], lambda a: r * (np.cos(a)[:, None] * e1 + np.sin(a)[:, None] * e2))
    if L2 is not None:
        out[ok] = L2[ok]
    return out


class Paths:
    def __init__(self, model, osim_path):
        self.m = model
        self.mus = read_muscles(osim_path)
        self.kin = Kinematics(model, [])
        self.names = [x["name"] for x in self.mus]

    def lengths(self, Q):
        """Q: (B, n_coords) full coordinates -> (B, n_muscles) musculotendon lengths."""
        T = self.kin.bodies(Q); B = len(Q)
        g = lambda b, loc: T[b][1] + (T[b][0] @ loc if np.ndim(T[b][0]) == 3 else T[b][0] @ loc)
        out = np.zeros((B, len(self.mus)))
        for k, mu in enumerate(self.mus):
            X = [g(b, loc) for b, loc in mu["pts"]]
            nseg = len(X) - 1
            seg = np.stack([np.linalg.norm(X[i + 1] - X[i], axis=1) for i in range(nseg)], 1)   # (B, nseg)
            for w in mu["wraps"]:
                # a wrap object acts on ONE segment of the path (as OpenSim): of the segments in its
                # range that wrap, the one it lengthens least
                Rb, pb = T[w["body"]]
                Rb = np.broadcast_to(Rb, (B, 3, 3))
                to = lambda x: np.einsum("ji,bj->bi", w["R"], np.einsum("bji,bj->bi", Rb, x - pb) - w["t"])
                add = np.full((B, nseg), np.inf)
                for i in range(nseg):
                    if w["range"] is not None and not (w["range"][0] <= i and i + 1 <= w["range"][1]):
                        continue
                    wl = _wrap_segment(to(X[i]), to(X[i + 1]), w)
                    good = ~np.isnan(wl) & (wl >= seg[:, i] - 1e-9)
                    add[good, i] = wl[good] - seg[good, i]
                j = np.argmin(add, 1); best = add[np.arange(B), j]
                hit = np.isfinite(best)
                seg[hit, j[hit]] += best[hit]
            out[:, k] = seg.sum(1)
        return out

    def moment_arms(self, Q, coords, h=1e-4):
        """Q: (n, n_coords). -> lengths (n, M), moment arms (n, len(coords), M) = -dL/dq (central differences)."""
        n, nc = Q.shape; idx = [self.m.coord_order.index(c) for c in coords]
        Qs = [Q]
        for ci in idx:
            for s in (h, -h):
                P = Q.copy(); P[:, ci] += s; Qs.append(self.kin.couple(P))
        L = self.lengths(np.concatenate(Qs))
        L0 = L[:n]; R = np.zeros((n, len(idx), L.shape[1]))
        for k in range(len(idx)):
            Lp = L[n * (1 + 2 * k): n * (2 + 2 * k)]; Lm = L[n * (2 + 2 * k): n * (3 + 2 * k)]
            R[:, k] = -(Lp - Lm) / (2 * h)
        return L0, R
