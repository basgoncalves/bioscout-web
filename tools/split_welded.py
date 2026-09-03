"""
split_welded.py -- carve rigid bodies out of a welded mesh bundle.

Some characters arrive as a model whose head and arms are WELDED to the torso:
one mesh, one body, one rigid transform. The overlay can only articulate what
is its own body, so on those characters the head follows the ribcage and the
arms swing with the chest -- which is what a viewer notices first.

The honest fix is a model that has the bodies. Where the source .osim is not
available, this tool does the next best thing: it splits the welded geometry
GEOMETRICALLY and re-expresses each piece in a frame of its own.

Why that is not the reassignment build_meshes.py warns about. Moving a welded
mesh FILE to another body is wrong because the whole file is authored in the
torso's frame and the other body's frame is somewhere else entirely. Here the
new frame is constructed from the geometry itself -- its origin is the joint
centre we cut at, its axes are the torso's -- so the piece is expressed in the
frame it is placed by, which is the whole of the requirement. Orientation is
resolved by the overlay from the stored child-joint anchor, so a limb whose
sculpted pose is not the model's neutral pose still lands correctly.

    python tools/split_welded.py --name gohan_ss_v6 --arms
    python tools/split_welded.py --name gpk_bones --head 0.468

Rewrites meshes/<name>.bin and meshes/<name>.json in place (a .bak is kept).
"""
import argparse
import json
import os
import shutil

import numpy as np


def read_bundle(path_json, path_bin):
    idx = json.load(open(path_json))
    raw = open(path_bin, "rb").read()
    out = {}
    for body, info in idx["bodies"].items():
        n = info["triangles"] * 9
        pos = np.frombuffer(raw, "<f4", count=n, offset=info["byteOffset"]).reshape(-1, 3, 3)
        col = np.frombuffer(raw, "<f4", count=n, offset=info["colorOffset"]).reshape(-1, 3, 3)
        out[body] = {"pos": pos.copy(), "col": col.copy(),
                     "anchors": dict(info.get("anchors") or {})}
    return idx["name"], out


def write_bundle(name, bodies, out_dir="meshes"):
    """Bodies are written in RIG-ish order; the overlay reads them by name."""
    blobs, index, off = [], {}, 0
    for body, b in bodies.items():
        if len(b["pos"]) == 0:
            continue
        pbuf = b["pos"].reshape(-1).astype("<f4").tobytes()
        cbuf = b["col"].reshape(-1).astype("<f4").tobytes()
        blobs.append(pbuf); blobs.append(cbuf)
        index[body] = {"byteOffset": off, "triangles": int(len(b["pos"])),
                       "colorOffset": off + len(pbuf), "anchors": b["anchors"]}
        off += len(pbuf) + len(cbuf)
    with open(os.path.join(out_dir, name + ".bin"), "wb") as f:
        for x in blobs:
            f.write(x)
    json.dump({"name": name, "bodies": index},
              open(os.path.join(out_dir, name + ".json"), "w"))
    for body, info in index.items():
        print("   %-11s %6d tri" % (body, info["triangles"]))
    print("   -> %.2f MB" % (off / 1e6))


def arm_axis(cen, sgn, seed_z=0.19):
    """Principal axis of one welded arm, pointing away from the midline.

    The seed is the geometry clearly outside the ribcage; everything nearer the
    midline is ambiguous between shoulder and chest, and including it tilts the
    axis into the torso."""
    seed = cen[(cen[:, 2] * sgn) > seed_z]
    if len(seed) < 50:
        raise SystemExit("no arm geometry beyond |z| = %.2f" % seed_z)
    c0 = seed.mean(0)
    _, _, vt = np.linalg.svd(seed - c0, full_matrices=False)
    ax = vt[0] * np.sign(vt[0][2] * sgn)
    return c0, ax, float(((seed - c0) @ ax).min())


def split_arms(torso, radius=0.10, upper_frac=0.55):
    """torso -> (torso, {humerus,ulna,hand}_{r,l}) by cutting each sleeve.

    The wrist is found from the sleeve's own radius profile: a sleeve tapers to
    its narrowest at the wrist and swells again over the hand, so the minimum
    in the distal third is the cut. The elbow has no such signature on a baggy
    sculpt, so it is placed at `upper_frac` of shoulder->wrist, which is the
    segment ratio (upper arm 0.186 of stature, forearm 0.146)."""
    pos, col = torso["pos"], torso["col"]
    cen = pos.mean(1)
    keep = np.ones(len(pos), bool)
    parts = {}
    for side, sgn in (("r", 1), ("l", -1)):
        c0, ax, u0 = arm_axis(cen, sgn)
        d = cen - c0
        u = d @ ax
        r = np.linalg.norm(d - np.outer(u, ax), axis=1)
        arm = (r < radius) & (u > u0) & ((cen[:, 2] * sgn) > 0.05)
        u_max = float(u[arm].max())

        # wrist: narrowest slab in the distal third
        best, u_wrist = 1e9, u_max - 0.09
        lo = u_max - 0.20
        while lo < u_max - 0.04:
            s = arm & (u >= lo) & (u < lo + 0.02)
            if s.sum() >= 8:
                r90 = float(np.percentile(r[s], 90))
                if r90 < best:
                    best, u_wrist = r90, lo + 0.01
            lo += 0.01

        S = c0 + ax * u0                      # shoulder: centre of the cut face
        W = c0 + ax * u_wrist
        E = S + (W - S) * upper_frac
        seg = W - S
        t = ((cen - S) @ seg) / float(seg @ seg)

        for body, sel in (
                ("humerus_" + side, arm & (t < upper_frac)),
                ("ulna_" + side,    arm & (t >= upper_frac) & (t < 1.0)),
                ("hand_" + side,    arm & (t >= 1.0))):
            if sel.sum() == 0:
                continue
            origin = {"humerus_": S, "ulna_": E, "hand_": W}[body.rsplit("_", 1)[0] + "_"]
            parts[body] = {"pos": pos[sel] - origin, "col": col[sel], "anchors": {}}
        keep &= ~arm

        parts["humerus_" + side]["anchors"] = {"__origin_offset__": [0.0, 0.0, 0.0],
                                               "ulna_" + side: (E - S).tolist()}
        parts["ulna_" + side]["anchors"] = {"__origin_offset__": [0.0, 0.0, 0.0],
                                            "hand_" + side: (W - E).tolist()}
        # The hand has no child joint, so the overlay orients it by the model's
        # own -y axis over a nominal length. A sculpted hand does not point
        # along -y, so rotate it until it does -- keeping +z (the subject's
        # right) as the roll reference, which is the convention the overlay
        # resolves roll against.
        h = parts.get("hand_" + side)
        if h is not None and len(h["pos"]):
            tip = c0 + ax * u_max
            a = tip - W
            a /= np.linalg.norm(a)
            z = np.array([0.0, 0.0, 1.0])
            z = z - a * (z @ a)
            z = z / np.linalg.norm(z) if np.linalg.norm(z) > 1e-6 else np.array([0.0, 0.0, 1.0])
            y = -a
            x = np.cross(y, z)
            R = np.stack([x, y, z])            # rows: world -> local
            h["pos"] = h["pos"] @ R.T
        print("  %s  shoulder %s  elbow %s  wrist %s" %
              (side, np.round(S, 3), np.round(E, 3), np.round(W, 3)))
    torso["pos"], torso["col"] = pos[keep], col[keep]
    return parts


def split_head(torso, y_cut):
    """torso -> skull, cutting the neck at a height in the torso's own frame."""
    pos, col = torso["pos"], torso["col"]
    cen = pos.mean(1)
    head = cen[:, 1] >= y_cut
    skull = {"pos": pos[head], "col": col[head],
             "anchors": {"__origin_offset__": [0.0, 0.0, 0.0]}}
    torso["pos"], torso["col"] = pos[~head], col[~head]
    bb = skull["pos"].reshape(-1, 3)
    print("  skull %d tri, bbox %s .. %s" %
          (len(skull["pos"]), np.round(bb.min(0), 3), np.round(bb.max(0), 3)))
    return {"skull": skull}


ORDER = ["pelvis", "torso", "skull",
         "femur_r", "femur_l", "tibia_r", "tibia_l",
         "calcn_r", "calcn_l", "toes_r", "toes_l",
         "humerus_r", "humerus_l", "ulna_r", "ulna_l", "hand_r", "hand_l"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--dir", default="meshes")
    ap.add_argument("--arms", action="store_true", help="carve arms out of the torso")
    ap.add_argument("--head", type=float, default=None,
                    help="carve a skull out of the torso above this local y")
    ap.add_argument("--anchor", action="append", default=[],
                    metavar="BODY:CHILD:X,Y,Z",
                    help="add a child-joint anchor the source model did not "
                         "carry. A body with no anchor to its child has no "
                         "axis, and the overlay falls back to the model's own "
                         "-y over a nominal length -- which places the torso "
                         "upside down, since the neck is at +y.")
    args = ap.parse_args()

    pj = os.path.join(args.dir, args.name + ".json")
    pb = os.path.join(args.dir, args.name + ".bin")
    for p in (pj, pb):
        if not os.path.exists(p + ".bak"):
            shutil.copy(p, p + ".bak")
    name, bodies = read_bundle(pj + ".bak", pb + ".bak")

    for spec in args.anchor:
        body, child, xyz = spec.split(":")
        bodies[body]["anchors"][child] = [float(v) for v in xyz.split(",")]
        print("  anchor %s -> %s %s" % (body, child, bodies[body]["anchors"][child]))

    new = {}
    if args.head is not None:
        new.update(split_head(bodies["torso"], args.head))
    if args.arms:
        new.update(split_arms(bodies["torso"]))
    bodies.update(new)

    ordered = {b: bodies[b] for b in ORDER if b in bodies}
    ordered.update({b: v for b, v in bodies.items() if b not in ordered})
    write_bundle(name, ordered, args.dir)


if __name__ == "__main__":
    main()
