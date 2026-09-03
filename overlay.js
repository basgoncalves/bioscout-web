/**
 * overlay.js -- draw an OpenSim character's STL geometry over the live video.
 *
 * How it lines up with the video. MediaPipe gives two things per frame: 2-D
 * landmarks in image coordinates, and worldLandmarks in metres. Neither alone
 * is enough -- the metric ones are not registered to the image, and the image
 * ones have no depth. So the scene is built in a PIXEL space: x and y come from
 * the 2-D landmarks (so the overlay is aligned with the video by construction)
 * and z comes from worldLandmarks scaled by the same pixels-per-metre. An
 * orthographic camera then looks straight down -z.
 *
 * How each body is placed. Every mesh is already in its OpenSim body frame, and
 * child joint frames sit at the body origin, so a body is pinned by two anchor
 * points: its own origin (a joint centre) and the joint to its child, both read
 * out of the .osim at build time. Match those two local points to two landmark
 * positions and the body is fixed up to a roll about the line joining them --
 * which is resolved from the subject's left-right axis, since OpenSim's +z is
 * the subject's right.
 *
 * What it will not do. The subject's real segment proportions are not the
 * model's, so each body is scaled independently and joints can pull apart
 * slightly under large scale mismatches. MediaPipe's landmarks are surface
 * points, not joint centres -- its "hip" sits near the ASIS rather than the
 * femoral head -- so expect a couple of centimetres of offset at the pelvis.
 * This is an overlay, not a registration.
 */
import * as THREE from "./vendor/three.module.min.js";

// MediaPipe pose landmark indices.
const L = {
  nose: 0, lEar: 7, rEar: 8, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};

/** body -> [local anchor pair], [world landmark pair].
 *  localTo names the child joint whose translation the build step stored. */
const RIG = [
  // modelLen: the model's own distance corresponding to the from->to landmark
  // pair, in metres, read off the .osim joint table. Each body is scaled by its
  // OWN measured segment rather than one shared factor -- that is what makes
  // the figure match the subject's height and keeps limb joints closed, since
  // every segment then spans exactly its two landmarks.
  { body: "pelvis",    localTo: "torso",          from: "hipMid",    to: "shoulderMid", modelLen: 0.493, localFrom: "hipMid" },
  { body: "torso",     localTo: "cerv7",          from: "backJoint", to: "shoulderMid", modelLen: 0.412 },
  { body: "skull",     localTo: null,             from: "shoulderMid", to: "nose",      modelLen: 0.24, fallbackLen: 0.16 },
  { body: "femur_r",   localTo: "femoral_cond_r", from: "rHip",   to: "rKnee" },
  { body: "femur_l",   localTo: "femoral_cond_l", from: "lHip",   to: "lKnee" },
  { body: "tibia_r",   localTo: "talus_r",        from: "rKnee",  to: "rAnkle" },
  { body: "tibia_l",   localTo: "talus_l",        from: "lKnee",  to: "lAnkle" },
  { body: "calcn_r",   localTo: "toes_r",         from: "rAnkle", to: "rToe" },
  { body: "calcn_l",   localTo: "toes_l",         from: "lAnkle", to: "lToe" },
  { body: "toes_r",    localTo: null,             from: "rToe",   to: "rToe", modelLen: 0.05, fallbackLen: 0.05 },
  { body: "toes_l",    localTo: null,             from: "lToe",   to: "lToe", modelLen: 0.05, fallbackLen: 0.05 },
  { body: "humerus_r", localTo: "ulna_r",         from: "rShoulder", to: "rElbow" },
  { body: "humerus_l", localTo: "ulna_l",         from: "lShoulder", to: "lElbow" },
  { body: "ulna_r",    localTo: "hand_r",         from: "rElbow", to: "rWrist" },
  { body: "ulna_l",    localTo: "hand_l",         from: "lElbow", to: "lWrist" },
  { body: "hand_r",    localTo: null,             from: "rWrist", to: "rIndex", modelLen: 0.09, fallbackLen: 0.09 },
  { body: "hand_l",    localTo: null,             from: "lWrist", to: "lIndex", modelLen: 0.09, fallbackLen: 0.09 },
];

/* Head fit, per character set.
 *
 * The head cannot be sized like the other segments. Every other body is scaled
 * from pxPerM, which is derived from the shoulder-hip and hip-knee segments --
 * and in a close-up of the face those landmarks are not measured, they are
 * MediaPipe's guesses, so pxPerM is meaningless there. The ear landmarks are
 * measured in exactly the shot where the body's are not.
 *
 * So the head is sized from the ear span alone: scale = ear span in pixels
 * divided by the model's own ear span in model metres. Both numbers below are
 * in the mesh's local units:
 *
 *   earSpan   distance between the ears of the actual head. NOT the mesh
 *             width -- a Super Saiyan's bounding box is mostly hair, and
 *             sizing off it shrinks the face to nothing.
 *   centre    where the middle of the head sits in the mesh, again ignoring
 *             hair. The ear midpoint is placed here.
 *
 * A character whose set is not listed falls back to its bounding box, which is
 * right for a bare skull and too big for anything with hair -- hence the head
 * size control in the app, which multiplies whatever this table says.
 */
const HEAD_FIT = {
  gohan_ss_v6: { earSpan: 0.17, centre: [0.05, 0.14, 0.00] },
  gohan_ss_v4: { earSpan: 0.17, centre: [0.05, 0.14, 0.00] },
  gwen_v3:     { earSpan: 0.16, centre: [0.00, 0.10, 0.00] },
  bas_v3:      { earSpan: 0.15, centre: [0.00, 0.10, 0.00] },
};

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    // Some mobile browsers refuse a second WebGL context, or fail under memory
    // pressure. Surface that instead of rendering nothing.
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true,
                                                powerPreference: "high-performance" });
    } catch (err) {
      throw new Error("WebGL unavailable on this device: " + err.message);
    }
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(0.4, 0.8, 1);
    this.scene.add(key);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.meshes = {};
    this.anchors = {};
    this._lastScale = {};
    this.setName = null;
    this.headScale = 1;     // user correction, 1 = the table's own fit
  }

  /** Multiplier on the automatic head fit. */
  setHeadScale(k) {
    this.headScale = Number.isFinite(k) && k > 0 ? k : 1;
  }

  dispose() {
    this._lastScale = {};
    for (const m of Object.values(this.meshes)) {
      m.geometry.dispose(); m.material.dispose(); this.group.remove(m);
    }
    this.meshes = {};
  }

  /** Load a packed character set built by tools/build_meshes.py. */
  async load(name, onProgress) {
    if (this.setName === name) return;
    this.dispose();
    const idx = await (await fetch(`meshes/${name}.json`)).json();
    const buf = await (await fetch(`meshes/${name}.bin`)).arrayBuffer();
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true, transparent: true, opacity: 0.92,
      side: THREE.DoubleSide,
    });
    let done = 0;
    for (const [body, info] of Object.entries(idx.bodies)) {
      const floats = info.triangles * 9;
      const pos = new Float32Array(buf, info.byteOffset, floats);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      if (info.colorOffset !== undefined) {
        // Per-vertex colour, carried from each source mesh's <Appearance>.
        const col = new Float32Array(buf, info.colorOffset, floats);
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      }
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.userData.bbox = geo.boundingBox.clone();
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.meshes[body] = mesh;
      this.anchors[body] = info.anchors || {};
      if (onProgress) onProgress(++done, Object.keys(idx.bodies).length);
    }
    this.setName = name;
  }

  resize(w, h) {
    // Guard on the size WE last configured, not on canvas.width: the canvas can
    // already carry the right pixel dimensions (set in markup, or by another
    // writer) while the camera frustum is still the default 2x2 box, which
    // renders a correctly-placed scene entirely off screen.
    if (this._w === w && this._h === h) return;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    // Pixel space, y DOWN to match image coordinates: flip the camera instead
    // of negating every landmark.
    this.camera.left = 0; this.camera.right = w;
    this.camera.top = 0; this.camera.bottom = h;
    this.camera.updateProjectionMatrix();
  }

  /** landmarks: 2-D normalised; world: metric. Both from one detect call. */
  update(landmarks, world, w, h, mirror) {
    if (this.contextLost) return;
    this.resize(w, h);
    if (!landmarks || !world || !Object.keys(this.meshes).length) {
      this.renderer.clear();
      return;
    }

    // Pixels per metre, from the segment whose 2-D and metric lengths we have.
    const p2 = (i) => new THREE.Vector3(
      (mirror ? 1 - landmarks[i].x : landmarks[i].x) * w, landmarks[i].y * h, 0);
    const wl = (i) => new THREE.Vector3(world[i].x, world[i].y, world[i].z);
    let scale = 0, n = 0;
    for (const [a, b] of [[L.lShoulder, L.lHip], [L.rShoulder, L.rHip],
                          [L.lHip, L.lKnee], [L.rHip, L.rKnee]]) {
      const d2 = p2(a).distanceTo(p2(b)), d3 = wl(a).distanceTo(wl(b));
      if (d3 > 1e-4) { scale += d2 / d3; n++; }
    }
    const pxPerM = n ? scale / n : 500;

    // MediaPipe estimates every landmark whether or not it is in frame. Close
    // to the face the hips and knees are pure guesses, and a body driven by
    // them flails. Gate on the reported visibility instead of trusting them.
    const VIS = 0.5;
    const seen = (i) => (landmarks[i].visibility ?? 1) >= VIS;

    const P = (i) => {
      const p = p2(i);
      p.z = (mirror ? -world[i].z : world[i].z) * pxPerM;
      return p;
    };
    const mid = (a, b) => P(a).add(P(b)).multiplyScalar(0.5);

    const OK = {
      nose: seen(L.nose), lEar: seen(L.lEar), rEar: seen(L.rEar),
      rHip: seen(L.rHip), lHip: seen(L.lHip),
      rKnee: seen(L.rKnee), lKnee: seen(L.lKnee),
      rAnkle: seen(L.rAnkle), lAnkle: seen(L.lAnkle),
      rToe: seen(L.rToe), lToe: seen(L.lToe),
      rShoulder: seen(L.rShoulder), lShoulder: seen(L.lShoulder),
      rElbow: seen(L.rElbow), lElbow: seen(L.lElbow),
      rWrist: seen(L.rWrist), lWrist: seen(L.lWrist),
      rIndex: seen(L.rIndex), lIndex: seen(L.lIndex),
    };
    OK.hipMid = OK.lHip && OK.rHip;
    OK.shoulderMid = OK.lShoulder && OK.rShoulder;
    OK.backJoint = OK.hipMid && OK.shoulderMid;
    OK.headCentre = OK.lEar && OK.rEar;

    const pts = {
      nose: P(L.nose), rHip: P(L.rHip), lHip: P(L.lHip),
      rKnee: P(L.rKnee), lKnee: P(L.lKnee),
      rAnkle: P(L.rAnkle), lAnkle: P(L.lAnkle),
      rToe: P(L.rToe), lToe: P(L.lToe),
      rShoulder: P(L.rShoulder), lShoulder: P(L.lShoulder),
      rElbow: P(L.rElbow), lElbow: P(L.lElbow),
      rWrist: P(L.rWrist), lWrist: P(L.lWrist),
      rIndex: P(L.rIndex), lIndex: P(L.lIndex),
      lEar: P(L.lEar), rEar: P(L.rEar),
      hipMid: mid(L.lHip, L.rHip), shoulderMid: mid(L.lShoulder, L.rShoulder),
    };
    pts.headCentre = pts.lEar.clone().add(pts.rEar).multiplyScalar(0.5);
    pts.backJoint = pts.hipMid.clone().lerp(pts.shoulderMid, 0.12);

    // The subject's right, in scene space. OpenSim's local +z is the same.
    const worldRight = pts.rHip.clone().sub(pts.lHip).normalize();

    // Fallback scale for a body whose own segment is not measurable this
    // frame (a landmark dropped out): the median of everything that is.
    const measured = [];
    for (const r of RIG) {
      const w0 = pts[r.from], w1 = pts[r.to];
      const anch = this.anchors[r.body] || {};
      const ml = r.modelLen || (r.localTo && anch[r.localTo] ? v3(anch[r.localTo]).length() : 0);
      if (w0 && w1 && ml > 1e-4) {
        const d = w0.distanceTo(w1);
        if (d > 1e-3) measured.push(d / ml);
      }
    }
    measured.sort((a, b) => a - b);
    const fallbackScale = measured.length ? measured[measured.length >> 1] : pxPerM;

    for (const r of RIG) {
      if (r.body === "skull") continue;          // handled above
      const mesh = this.meshes[r.body];
      if (!mesh) continue;
      const w0 = pts[r.from], w1 = pts[r.to];
      if (!w0 || !w1 || OK[r.from] === false || OK[r.to] === false) {
        mesh.visible = false; continue;
      }

      const anch = this.anchors[r.body] || {};
      const a0 = r.localFrom === "hipMid"
        ? v3(anch.femur_r || [0, 0, 0]).lerp(v3(anch.femur_l || [0, 0, 0]), 0.5)
        : new THREE.Vector3(0, 0, 0);
      // Bodies with no child joint (skull, toes, hands) have no stored axis;
      // fall back to the model's own y-axis over a nominal length.
      const a1 = r.localTo && anch[r.localTo]
        ? v3(anch[r.localTo])
        : new THREE.Vector3(0, -(r.fallbackLen || 0.1), 0).add(a0);

      const la = a1.clone().sub(a0), wa = w1.clone().sub(w0);
      const lLen = la.length(), wLen = wa.length();
      if (lLen < 1e-6 || wLen < 1e-3) { mesh.visible = false; continue; }

      // Scale this body by its own segment: world span / model span.
      const modelLen = r.modelLen || lLen;
      const s = wLen > 1e-3 && modelLen > 1e-4 ? wLen / modelLen : fallbackScale;
      const b1 = wa.clone().normalize();
      const a1n = la.clone().normalize();
      const lRef = new THREE.Vector3(0, 0, 1);
      const a3 = lRef.clone().sub(a1n.clone().multiplyScalar(lRef.dot(a1n)));
      const b3 = worldRight.clone().sub(b1.clone().multiplyScalar(worldRight.dot(b1)));
      if (a3.lengthSq() < 1e-8 || b3.lengthSq() < 1e-8) { mesh.visible = false; continue; }
      a3.normalize(); b3.normalize();
      const a2 = a3.clone().cross(a1n), b2 = b3.clone().cross(b1);

      const A = new THREE.Matrix4().makeBasis(a1n, a2, a3);
      const B = new THREE.Matrix4().makeBasis(b1, b2, b3);
      const R = B.multiply(A.transpose());

      const S = new THREE.Matrix4().makeScale(s, s, s);
      const M = new THREE.Matrix4().multiplyMatrices(R, S);
      // translate so the local anchor a0 lands exactly on w0
      const shifted = a0.clone().applyMatrix4(M);
      M.setPosition(w0.x - shifted.x, w0.y - shifted.y, w0.z - shifted.z);

      mesh.matrix.copy(M);
      // matrixAutoUpdate is off, so writing .matrix does NOT mark the world
      // matrix stale. Without this the meshes are positioned and invisible.
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
      this._lastScale[r.body] = s;
    }

    // The skull is placed last, and differently. It has no child joint in the
    // model (the cervical chain is dropped from the rig), so the two-anchor
    // scheme had nothing to span and stretched it along shoulder->nose -- the
    // spike over the face. Instead: sit it on the torso's own neck anchor so
    // the two actually meet, size it from the measured ear span, and orient it
    // from the head. Ears drive size and roll; the torso decides where it sits.
    const skull = this.meshes.skull;
    if (skull && skull.userData.bbox) {
      const bb = skull.userData.bbox;
      const size = new THREE.Vector3(); bb.getSize(size);
      const bbCentre = new THREE.Vector3(); bb.getCenter(bbCentre);
      const fit = HEAD_FIT[this.setName] || null;

      // Model ear span. Without a table entry, guess from the mesh width --
      // correct for a bare skull, generous for anything with hair.
      const modelEarSpan = fit ? fit.earSpan : Math.max(1e-3, size.z * 0.62);
      const headCentreLocal = fit ? v3(fit.centre) : bbCentre.clone();

      const earSpanPx = OK.headCentre ? pts.rEar.distanceTo(pts.lEar) : 0;
      // Fall back to the body scale only when the ears are not visible; that
      // is the case the ear measurement cannot cover.
      const auto = earSpanPx > 1
        ? earSpanPx / modelEarSpan
        : (this._lastScale.torso || fallbackScale);
      const sk = auto * (this.headScale || 1);

      const up = pts.headCentre.clone().sub(pts.shoulderMid);
      const haveUp = up.lengthSq() > 1e-6 && OK.shoulderMid;
      if (OK.headCentre || haveUp) {
        // Orientation: up the neck when the shoulders are visible, otherwise
        // straight up the image, which is right for a head-and-shoulders shot.
        const b1 = haveUp ? up.normalize() : new THREE.Vector3(0, -1, 0);
        const lat = pts.rEar.clone().sub(pts.lEar);
        const b3 = lat.lengthSq() > 1e-6
          ? lat.normalize().sub(b1.clone().multiplyScalar(lat.dot(b1))).normalize()
          : worldRight.clone();
        const b2 = b3.clone().cross(b1);
        const a1 = new THREE.Vector3(0, 1, 0), a3 = new THREE.Vector3(0, 0, 1);
        const a2 = a3.clone().cross(a1);
        const A = new THREE.Matrix4().makeBasis(a1, a2, a3);
        const B = new THREE.Matrix4().makeBasis(b1, b2, b3);
        const R = B.multiply(A.transpose());
        const M = new THREE.Matrix4().multiplyMatrices(
          R, new THREE.Matrix4().makeScale(sk, sk, sk));

        // Put the model's head centre on the measured ear midpoint. Nothing
        // else: the ear midpoint is the one point on a head that both the
        // landmarks and the mesh agree about, so anchoring there is what keeps
        // the face on the face.
        const shift = headCentreLocal.clone().applyMatrix4(M);
        const target = OK.headCentre ? pts.headCentre : pts.nose;
        M.setPosition(target.x - shift.x, target.y - shift.y, target.z - shift.z);
        skull.matrix.copy(M);
        skull.matrixWorldNeedsUpdate = true;
        skull.visible = true;
      } else {
        skull.visible = false;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  clear() { this.renderer.clear(); }
}
