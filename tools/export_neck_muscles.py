"""
export_neck_muscles.py -- the HYOID cervical model reduced to what an isometric
neck hold needs in the browser: per-muscle moment arms and maximum forces at
the neutral posture, the Jacobian of the head's load point, and the head and
neck weights, all about the model's six independent cervical coordinates.

    python tools/export_neck_muscles.py <Neck_model.osim> data/neck_muscles.json

Source model: Mortensen, Vasavada & Merryweather (2018), "The inclusion of
hyoid muscles improve moment generating capacity and dynamic simulations in
musculoskeletal models of the head and neck", PLOS ONE 13(6):e0199912
(HYOID 1.2, 72 muscles, open on SimTK). The copy read here is the one in
C:\\Git\\bioscout\\bioscout\\models\\Neck_model.osim.

How the numbers are made, so they can be checked without OpenSim:
  * Forward kinematics of the joint tree, with the CoordinateCouplerConstraints
    that spread pitch2/roll2/yaw2 over C7..C3 (and pitch1/roll1/yaw1 over C1),
    evaluated at the default (neutral) coordinates.
  * Moment arm r_ik = -dL_i/dq_k by central difference (+-1e-4 rad), L the
    straight-line path length through the muscle's PathPoints. The model has
    no wrap objects, so no wrapping is lost.
  * Load-point Jacobian J_k = dp/dq_k for the skull's centre of mass (where a
    head-harness strap pulls), and the same for every body's centre of mass
    above T1, for gravity.
  * Fmax is max_isometric_force. Force-length-velocity is not modelled: the
    hold is isometric and at (near) neutral, where it matters least.

Ground frame: x anterior, y up, z to the model's right.
"""
import json, math, sys
import xml.etree.ElementTree as ET
import numpy as np

def vec(s): return np.array([float(x) for x in s.split()])

def rot_xyz(e):
    """OpenSim body-fixed XYZ orientation."""
    cx, cy, cz = (math.cos(a) for a in e); sx, sy, sz = (math.sin(a) for a in e)
    Rx = np.array([[1,0,0],[0,cx,-sx],[0,sx,cx]])
    Ry = np.array([[cy,0,sy],[0,1,0],[-sy,0,cy]])
    Rz = np.array([[cz,-sz,0],[sz,cz,0],[0,0,1]])
    return Rx @ Ry @ Rz

def axis_rot(axis, a):
    k = axis / np.linalg.norm(axis); K = np.array([[0,-k[2],k[1]],[k[2],0,-k[0]],[-k[1],k[0],0]])
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K

class Fn:
    """The OpenSim functions this model uses."""
    def __init__(self, el):
        self.tag = el.tag; self.el = el
        if el.tag == "Constant": self.v = float(el.findtext("value"))
        elif el.tag == "LinearFunction": self.c = vec(el.findtext("coefficients"))
        elif el.tag in ("SimmSpline", "NaturalCubicSpline", "PiecewiseLinearFunction"):
            self.x = vec(el.findtext("x")); self.y = vec(el.findtext("y"))
        elif el.tag == "MultiplierFunction":
            self.inner = Fn(el.find("function")[0] if el.find("function") is not None and len(el.find("function")) else
                            [c for c in el if c.tag not in ("scale",)][0]); self.s = float(el.findtext("scale"))
        else: raise ValueError("unsupported function " + el.tag)
    def __call__(self, q):
        if self.tag == "Constant": return self.v
        if self.tag == "LinearFunction": return self.c[0] * q + self.c[1]
        if self.tag == "MultiplierFunction": return self.s * self.inner(q)
        # Splines: a cubic through the knots. Only values within a few 1e-4
        # rad of neutral are ever asked for, where any C1 interpolant of these
        # knots agrees to well below the differencing error.
        from scipy.interpolate import CubicSpline
        if not hasattr(self, "_cs"): self._cs = CubicSpline(self.x, self.y, bc_type="natural")
        return float(self._cs(q))

def first_fn(el):
    for c in el:
        if c.tag not in ("coordinates", "axis"): return Fn(c)
    return None

def main(src, dst):
    m = ET.parse(src).getroot().find("Model")
    bodies = {b.get("name"): b for b in m.find("BodySet/objects")}
    joints = list(m.find("JointSet/objects"))
    # coordinates
    q0, coord_joint = {}, {}
    for j in joints:
        for c in j.findall("coordinates/Coordinate"):
            q0[c.get("name")] = float(c.findtext("default_value") or 0)
    couplers = []
    for c in m.find("ConstraintSet/objects"):
        if c.tag != "CoordinateCouplerConstraint": continue
        ind = c.findtext("independent_coordinate_names").split()
        dep = c.findtext("dependent_coordinate_name").strip()
        f = c.find("coupled_coordinates_function")
        couplers.append((ind[0], dep, Fn(f[0])))
    INDEP = ["pitch2", "roll2", "yaw2", "pitch1", "roll1", "yaw1"]

    def resolve(q):
        q = dict(q)
        for ind, dep, f in couplers: q[dep] = f(q[ind])
        return q

    # offset frames: name -> (parent body, R, p)
    # Offset-frame names repeat across joints ("spine_offset" belongs to six of
    # them, each with its own translation), so a frame is keyed by its joint.
    frames = {}
    for j in joints:
        for fr in j.find("frames"):
            parent = fr.findtext("socket_parent").strip().split("/")[-1]
            frames[(j.get("name"), fr.get("name"))] = (
                parent, rot_xyz(vec(fr.findtext("orientation"))), vec(fr.findtext("translation")))
    def frame_of(joint, name):
        if (joint, name) in frames: return frames[(joint, name)]
        return (name, np.eye(3), np.zeros(3))

    def fk(qind):
        q = resolve({**q0, **qind})
        X = {"ground": (np.eye(3), np.zeros(3))}
        pending = list(joints)
        while pending:
            for j in list(pending):
                pf = j.findtext("socket_parent_frame").strip(); cf = j.findtext("socket_child_frame").strip()
                pb, pR, pp = frame_of(j.get("name"), pf)
                cb, cR, cp = frame_of(j.get("name"), cf)
                if pb not in X: continue
                R_GP, p_GP = X[pb]
                R_GF, p_GF = R_GP @ pR, p_GP + R_GP @ pp
                R_FM, p_FM = np.eye(3), np.zeros(3)
                if j.tag == "CustomJoint":
                    tas = {ta.get("name"): ta for ta in j.find("SpatialTransform")}
                    for nm in ("rotation1", "rotation2", "rotation3"):
                        ta = tas[nm]; cn = (ta.findtext("coordinates") or "").split()
                        v = first_fn(ta)(q[cn[0]]) if cn else first_fn(ta)(0.0)
                        R_FM = R_FM @ axis_rot(vec(ta.findtext("axis")), v)
                    for nm in ("translation1", "translation2", "translation3"):
                        ta = tas[nm]; cn = (ta.findtext("coordinates") or "").split()
                        v = first_fn(ta)(q[cn[0]]) if cn else first_fn(ta)(0.0)
                        p_FM = p_FM + vec(ta.findtext("axis")) * v
                elif j.tag != "WeldJoint": raise ValueError(j.tag)
                R_GM, p_GM = R_GF @ R_FM, p_GF + R_GF @ p_FM
                # child body = M frame with the child offset removed
                R_GB = R_GM @ cR.T
                X[cb] = (R_GB, p_GM - R_GB @ cp)
                pending.remove(j)
        return X

    def point(X, frame, loc):
        """frame: a body name, or a (joint, offset-frame) pair."""
        b, R, p = frames[frame] if isinstance(frame, tuple) else (frame, np.eye(3), np.zeros(3))
        RG, pG = X[b]
        return pG + RG @ (p + R @ loc)

    muscles = []
    for f in m.find("ForceSet/objects"):
        if not f.tag.endswith("Muscle"): continue
        pts = []
        for p in f.find("GeometryPath/PathPointSet/objects"):
            ref = p.findtext("socket_parent_frame").strip().split("/")
            fr = (ref[-2], ref[-1]) if "jointset" in ref else ref[-1]
            pts.append((fr, vec(p.findtext("location"))))
        muscles.append((f.get("name"), float(f.findtext("max_isometric_force")), pts))

    def lengths(X):
        out = []
        for _, _, pts in muscles:
            P = [point(X, fr, loc) for fr, loc in pts]
            out.append(sum(np.linalg.norm(P[i + 1] - P[i]) for i in range(len(P) - 1)))
        return np.array(out)

    above = ["cerv7", "cerv6", "cerv5", "cerv4", "cerv3", "cerv2", "cerv1", "skull", "jaw"]
    # The load is taken at the head's centre of mass: a harness strap round the
    # head pulls there, near enough, and it is the point the "N g" equivalence
    # on the results page assumes. (The model's own Skull_Impact actuator sits
    # at the vertex, 0.2 m up the skull frame -- a crash load, not a strap.)
    load_pt = vec(bodies["skull"].findtext("mass_center"))
    def probes(X):
        P = {"load": point(X, "skull", load_pt)}
        for b in above:
            P[b] = point(X, b, vec(bodies[b].findtext("mass_center")))
        return P

    h = 1e-4
    X0 = fk({}); L0 = lengths(X0); P0 = probes(X0)
    R = np.zeros((len(muscles), len(INDEP)))
    J = {k: np.zeros((3, len(INDEP))) for k in P0}
    for k, c in enumerate(INDEP):
        Xp, Xm = fk({c: q0[c] + h}), fk({c: q0[c] - h})
        R[:, k] = -(lengths(Xp) - lengths(Xm)) / (2 * h)
        Pp, Pm = probes(Xp), probes(Xm)
        for nm in P0: J[nm][:, k] = (Pp[nm] - Pm[nm]) / (2 * h)

    g = np.array([0.0, -9.80665, 0.0])
    Qg = np.zeros(len(INDEP))
    for b in above: Qg += float(bodies[b].findtext("mass")) * (J[b].T @ g)
    head_kg = sum(float(bodies[b].findtext("mass")) for b in ("skull", "jaw"))

    # Where the load point sits above the lower-cervical joint (T1/C7), for a
    # plain-language lever arm.
    t1 = point(X0, ("auxt1jnt", "cerv7_offset"), np.zeros(3))
    out = {
        "format": "bioscout-neckmuscles/1",
        "source": "HYOID 1.2 (Mortensen, Vasavada & Merryweather 2018, PLOS ONE 13:e0199912), neutral posture",
        "frame": "x anterior, y up, z right (model)",
        "dofs": INDEP,
        "loadPoint": {"body": "skull", "location": load_pt.tolist(),
                      "ground": P0["load"].round(5).tolist(),
                      "aboveT1_m": round(float(P0["load"][1] - t1[1]), 4),
                      "fromT1": (P0["load"] - t1).round(5).tolist()},
        "J": J["load"].round(6).tolist(),
        "Qgravity": Qg.round(5).tolist(),
        "headKg": round(head_kg, 3),
        "muscles": [{"name": n, "fmax": fm, "r": R[i].round(6).tolist()}
                    for i, (n, fm, _) in enumerate(muscles)],
    }
    with open(dst, "w") as fh: json.dump(out, fh, separators=(",", ":"))
    print(f"{len(muscles)} muscles, load point {out['loadPoint']['aboveT1_m']} m above T1, "
          f"head {head_kg:.2f} kg, Qg {Qg.round(2)} -> {dst}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
