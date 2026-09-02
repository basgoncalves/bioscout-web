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
    }
    this.renderer.render(this.scene, this.camera);
  }

  clear() { this.renderer.clear(); }
}
