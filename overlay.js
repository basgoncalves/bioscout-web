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
  nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};

/** body -> [local anchor pair], [world landmark pair].
 *  localTo names the child joint whose translation the build step stored. */
const RIG = [
  { body: "pelvis",    localFrom: "hipMid",  localTo: "torso",   from: "hipMid",    to: "shoulderMid" },
  { body: "torso",     localFrom: "origin",  localTo: "cerv7",   from: "backJoint", to: "shoulderMid" },
  { body: "skull",     localFrom: "origin",  localTo: null,      from: "shoulderMid", to: "nose", fallbackLen: 0.16 },
  { trueSpan: true, body: "femur_r",   localFrom: "origin",  localTo: "femoral_cond_r", from: "rHip", to: "rKnee" },
  { trueSpan: true, body: "femur_l",   localFrom: "origin",  localTo: "femoral_cond_l", from: "lHip", to: "lKnee" },
  { trueSpan: true, body: "tibia_r",   localFrom: "origin",  localTo: "talus_r", from: "rKnee",  to: "rAnkle" },
  { trueSpan: true, body: "tibia_l",   localFrom: "origin",  localTo: "talus_l", from: "lKnee",  to: "lAnkle" },
  { body: "calcn_r",   localFrom: "origin",  localTo: "toes_r",  from: "rAnkle", to: "rToe" },
  { body: "calcn_l",   localFrom: "origin",  localTo: "toes_l",  from: "lAnkle", to: "lToe" },
  { body: "toes_r",    localFrom: "origin",  localTo: null,      from: "rToe",   to: "rToe", fallbackLen: 0.05 },
  { body: "toes_l",    localFrom: "origin",  localTo: null,      from: "lToe",   to: "lToe", fallbackLen: 0.05 },
  { trueSpan: true, body: "humerus_r", localFrom: "origin",  localTo: "ulna_r",  from: "rShoulder", to: "rElbow" },
  { trueSpan: true, body: "humerus_l", localFrom: "origin",  localTo: "ulna_l",  from: "lShoulder", to: "lElbow" },
  { trueSpan: true, body: "ulna_r",    localFrom: "origin",  localTo: "hand_r",  from: "rElbow", to: "rWrist" },
  { trueSpan: true, body: "ulna_l",    localFrom: "origin",  localTo: "hand_l",  from: "lElbow", to: "lWrist" },
  { body: "hand_r",    localFrom: "origin",  localTo: null,      from: "rWrist", to: "rIndex", fallbackLen: 0.09 },
  { body: "hand_l",    localFrom: "origin",  localTo: null,      from: "lWrist", to: "lIndex", fallbackLen: 0.09 },
];

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
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
    this.setName = null;
  }

  dispose() {
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
      color: 0xdcdce4, transparent: true, opacity: 0.92, side: THREE.DoubleSide,
    });
    let done = 0;
    for (const [body, info] of Object.entries(idx.bodies)) {
      const floats = info.triangles * 9;
      const pos = new Float32Array(buf, info.byteOffset, floats);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat.clone());
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

    const P = (i) => {
      const p = p2(i);
      p.z = (mirror ? -world[i].z : world[i].z) * pxPerM;
      return p;
    };
    const mid = (a, b) => P(a).add(P(b)).multiplyScalar(0.5);

    const pts = {
      nose: P(L.nose), rHip: P(L.rHip), lHip: P(L.lHip),
      rKnee: P(L.rKnee), lKnee: P(L.lKnee),
      rAnkle: P(L.rAnkle), lAnkle: P(L.lAnkle),
      rToe: P(L.rToe), lToe: P(L.lToe),
      rShoulder: P(L.rShoulder), lShoulder: P(L.lShoulder),
      rElbow: P(L.rElbow), lElbow: P(L.lElbow),
      rWrist: P(L.rWrist), lWrist: P(L.lWrist),
      rIndex: P(L.rIndex), lIndex: P(L.lIndex),
      hipMid: mid(L.lHip, L.rHip), shoulderMid: mid(L.lShoulder, L.rShoulder),
    };
    pts.backJoint = pts.hipMid.clone().lerp(pts.shoulderMid, 0.12);

    // The subject's right, in scene space. OpenSim's local +z is the same.
    const worldRight = pts.rHip.clone().sub(pts.lHip).normalize();

    // ONE global scale, from the bodies whose local and world anchor pairs are
    // the same physical span (limb segments, joint centre to joint centre).
    // The pelvis, torso and skull have no such correspondence -- their stored
    // anchors span a different distance than any landmark pair -- so deriving a
    // per-body scale there inflates them enormously. Orientation is still taken
    // per body; only the size is shared.
    const scales = [];
    for (const r of RIG) {
      if (!r.trueSpan) continue;
      const anch = this.anchors[r.body] || {};
      const la = r.localTo && anch[r.localTo] ? v3(anch[r.localTo]).length() : 0;
      const w0 = pts[r.from], w1 = pts[r.to];
      if (la > 1e-4 && w0 && w1) scales.push(w0.distanceTo(w1) / la);
    }
    scales.sort((a, b) => a - b);
    const gScale = scales.length ? scales[scales.length >> 1] : pxPerM;

    for (const r of RIG) {
      const mesh = this.meshes[r.body];
      if (!mesh) continue;
      const w0 = pts[r.from], w1 = pts[r.to];
      if (!w0 || !w1) { mesh.visible = false; continue; }

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

      const s = gScale;                          // pixels per model metre
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
    }
    this.renderer.render(this.scene, this.camera);
  }

  clear() { this.renderer.clear(); }
}
