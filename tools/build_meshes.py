"""
build_meshes.py -- turn an OpenSim model's STL geometry into a compact bundle
the browser overlay can load.

    python tools/build_meshes.py \
        --osim  C:/Users/Basilio/Desktop/test_project/human_stl/gwen_v3.osim \
        --stl   C:/Users/Basilio/Desktop/test_project/human_stl \
        --name  gwen_v3 --target-triangles 60000

For each rigid body it merges that body's meshes, decimates them, and writes:

    meshes/<name>.bin    Float32 vertex positions, bodies concatenated
    meshes/<name>.json   per-body byte ranges, plus the joint anchors that let
                         the overlay place each body from pose landmarks

Decimation is vertex clustering: snap vertices to a grid, merge each cell to
its centroid, drop degenerate triangles. It is not quadric-error decimation and
will round off fine detail, but at the size these render on a phone that is
invisible, and it needs no third-party dependency.

Normals are NOT stored -- three.js recomputes them, which halves the download.
"""
import argparse
import json
import os
import re
import struct

import numpy as np

# Bodies the overlay can actually place from pose landmarks. Cervical vertebrae
# and the jaw are skipped: they are interior bones with no landmark to drive
# them, and they cost triangles for nothing at overlay size.
RIGGED_BODIES = [
    "pelvis", "torso", "skull",
    "femur_r", "femur_l", "tibia_r", "tibia_l",
    "calcn_r", "calcn_l", "toes_r", "toes_l",
    "humerus_r", "humerus_l", "ulna_r", "ulna_l", "hand_r", "hand_l",
]


def read_stl(path):
    """Binary or ASCII STL -> (n, 3, 3) triangle vertex array."""
    with open(path, "rb") as f:
        head = f.read(84)
        if len(head) < 84:
            return np.zeros((0, 3, 3), np.float32)
        n = struct.unpack("<I", head[80:84])[0]
        body = f.read(n * 50)
    if len(body) == n * 50 and n > 0:
        arr = np.frombuffer(body, dtype=np.uint8).reshape(n, 50)
        verts = np.frombuffer(arr[:, 12:48].tobytes(), dtype="<f4").reshape(n, 3, 3)
        return verts.astype(np.float32)
    # ASCII fallback
    txt = open(path, "r", errors="ignore").read()
    vals = re.findall(r"vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)", txt)
    v = np.array(vals, np.float32)
    return v[: len(v) // 3 * 3].reshape(-1, 3, 3)


def decimate(tris, cell, want_index=False):
    """Vertex clustering to a grid of the given cell size.

    With want_index, also returns the surviving source-triangle indices so
    per-triangle attributes (colour) can be carried through."""
    if len(tris) == 0 or cell <= 0:
        return (tris, np.arange(len(tris))) if want_index else tris
    v = tris.reshape(-1, 3)
    keys = np.floor(v / cell).astype(np.int64)
    uniq, inv = np.unique(keys, axis=0, return_inverse=True)
    # representative vertex = centroid of the cell's members
    reps = np.zeros((len(uniq), 3), np.float64)
    counts = np.zeros(len(uniq), np.int64)
    np.add.at(reps, inv, v)
    np.add.at(counts, inv, 1)
    reps /= counts[:, None]
    idx = inv.reshape(-1, 3)
    keep = (idx[:, 0] != idx[:, 1]) & (idx[:, 1] != idx[:, 2]) & (idx[:, 0] != idx[:, 2])
    out = reps[idx[keep]].astype(np.float32)
    return (out, np.nonzero(keep)[0]) if want_index else out


def mesh_bodies(osim_path):
    """{body: [(filename, (r, g, b)), ...]}.

    Colour comes from each Mesh's own <Appearance><color>, so a character keeps
    its skin, hair and clothing instead of rendering as uniform grey.
    """
    s = open(osim_path).read()
    out = {}
    for bm in re.finditer(r'<Body name="([^"]+)">(.*?)</Body>', s, re.S):
        body, blk = bm.group(1), bm.group(2)
        meshes = []
        for mm in re.finditer(r'<Mesh name="[^"]*">(.*?)</Mesh>', blk, re.S):
            mblk = mm.group(1)
            fm = re.search(r"<mesh_file>([^<]+)</mesh_file>", mblk)
            if not fm:
                continue
            fn = os.path.basename(fm.group(1).strip())
            if not fn.lower().endswith(".stl"):
                continue
            # Decorative VFX geometry (energy aura, bolts) is not body geometry:
            # it is huge, detached from the skeleton, and stretches into spikes
            # when a body is scaled. Keep it out of the rig.
            if any(k in fn.lower() for k in ("aura", "bolt")):
                continue
            cm = re.search(r"<color>([^<]+)</color>", mblk)
            col = tuple(float(v) for v in cm.group(1).split()) if cm else (0.8, 0.8, 0.85)
            meshes.append((fn, col[:3]))
        if meshes:
            out[body] = meshes
    return out


def joint_anchors(osim_path):
    """{body: {child_body: [x,y,z] in the body's own frame}} from the joints."""
    s = open(osim_path).read()
    anchors = {}
    for jm in re.finditer(
            r'<(CustomJoint|PinJoint|WeldJoint|BallJoint|FreeJoint) name="([^"]+)">(.*?)</\1>',
            s, re.S):
        blk = jm.group(3)
        pf = re.search(r"<socket_parent_frame>([^<]*)", blk)
        cf = re.search(r"<socket_child_frame>([^<]*)", blk)
        pofs = {}
        for pof in re.finditer(
                r'<PhysicalOffsetFrame name="([^"]+)">(.*?)</PhysicalOffsetFrame>',
                blk, re.S):
            n, b = pof.group(1), pof.group(2)
            t = re.search(r"<translation>([^<]*)</translation>", b)
            par = re.search(r"<socket_parent>([^<]*)</socket_parent>", b)
            pofs[n] = ([float(x) for x in t.group(1).split()] if t else [0, 0, 0],
                       par.group(1).split("/")[-1] if par else "?")
        if not (pf and cf and pf.group(1) in pofs and cf.group(1) in pofs):
            continue
        (tp, pbody) = pofs[pf.group(1)]
        (tc, cbody) = pofs[cf.group(1)]
        anchors.setdefault(pbody, {})[cbody] = tp
        anchors.setdefault(cbody, {})["__origin_offset__"] = tc
    return anchors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osim", required=True)
    ap.add_argument("--stl", required=True, help="root the mesh_file paths resolve under")
    ap.add_argument("--name", required=True)
    ap.add_argument("--target-triangles", type=int, default=60000)
    ap.add_argument("--out", default="meshes")
    args = ap.parse_args()

    mb = mesh_bodies(args.osim)
    anchors = joint_anchors(args.osim)
    os.makedirs(args.out, exist_ok=True)

    raw, raw_col = {}, {}
    for body in RIGGED_BODIES:
        files = mb.get(body)
        if not files:
            continue
        parts, cols = [], []
        for fn, col in files:
            tris = None
            for cand in (os.path.join(args.stl, fn),
                         os.path.join(args.stl, "stl_" + args.name, fn)):
                if os.path.exists(cand):
                    tris = read_stl(cand)
                    break
            if tris is None:
                hits = [os.path.join(dp, fn) for dp, _, fs in os.walk(args.stl) if fn in fs]
                if hits:
                    tris = read_stl(hits[0])
            if tris is not None and len(tris):
                parts.append(tris)
                cols.append(np.tile(np.array(col, np.float32), (len(tris), 1)))
        if parts:
            raw[body] = np.concatenate(parts, axis=0)
            raw_col[body] = np.concatenate(cols, axis=0)

    total = sum(len(t) for t in raw.values())
    if not total:
        raise SystemExit("no meshes found under %s" % args.stl)
    ratio = args.target_triangles / total
    print("%s: %d triangles across %d bodies -> target %d (%.1f%%)"
          % (args.name, total, len(raw), args.target_triangles, ratio * 100))

    blobs, index, offset = [], {}, 0
    for body, tris in raw.items():
        span = float(np.linalg.norm(np.ptp(tris.reshape(-1, 3), axis=0)))
        # Cell size chosen so each body keeps roughly its share of the budget.
        cell = span / max(4.0, (len(tris) * ratio) ** (1 / 2.2))
        dec, keep = decimate(tris, cell, want_index=True)
        for _ in range(6):                        # converge on the budget
            got = len(dec) / max(1, len(tris))
            if got <= ratio * 1.35 or len(dec) < 200:
                break
            cell *= 1.25
            dec, keep = decimate(tris, cell, want_index=True)
        # One colour per surviving triangle, expanded to its three vertices.
        tri_col = raw_col[body][keep]
        vcol = np.repeat(tri_col, 3, axis=0)
        buf = dec.reshape(-1).astype("<f4").tobytes()
        cbuf = vcol.reshape(-1).astype("<f4").tobytes()
        blobs.append(buf); blobs.append(cbuf)
        index[body] = {"byteOffset": offset, "triangles": int(len(dec)),
                       "colorOffset": offset + len(buf),
                       "anchors": anchors.get(body, {})}
        offset += len(buf) + len(cbuf)
        print("   %-11s %7d -> %6d tri  (%.1f%%)"
              % (body, len(tris), len(dec), 100 * len(dec) / max(1, len(tris))))

    bin_path = os.path.join(args.out, args.name + ".bin")
    with open(bin_path, "wb") as f:
        for b in blobs:
            f.write(b)
    json.dump({"name": args.name, "bodies": index},
              open(os.path.join(args.out, args.name + ".json"), "w"))
    kept = sum(v["triangles"] for v in index.values())
    print("   -> %s  %d triangles, %.2f MB" % (bin_path, kept, offset / 1e6))


if __name__ == "__main__":
    main()
