/**
 * The ball, carried from the video into the OpenSim export.
 *
 * Each ball sport has a default ball (mass, radius). The ball's centre is a
 * BALL marker in marker_experimental.trc, and the exported model gets a ball
 * body on a 3-translation joint to ground with a BALL marker at its centre, so
 * IK puts the model's ball where the video's ball was. Mass and radius sit in
 * the .osim (Body mass/inertia, Sphere radius) for the user to change and
 * re-run on a PC.
 *
 * Where the ball comes from:
 *   - jump shot: between the hands until release (the hands carry it), then a
 *     ballistic flight from the hands' position and velocity at release;
 *   - kick / racket strokes: the ball tracker's detections (balltrack.js).
 *
 * The ball is NOT tied to the hand in the model: its joint goes to ground. Its
 * inverse dynamics (ball_t* residuals) is then the force that had to act on
 * it -- while it is held, the push of the hands.
 */
export const BALLS = {
  jumpshot: { sport: "basketball (size 7)", massKg: 0.62,  radiusM: 0.12 },
  kick:   { sport: "football (size 5)",   massKg: 0.43,  radiusM: 0.11 },
  stroke: { sport: "tennis / padel",      massKg: 0.058, radiusM: 0.0335 },
};
export const ballFor = (activity) => BALLS[activity] || null;

const G = 9.80665;

/** -> Map(frame array index -> [x, y] image px) for the take, or null. */
export function ballPath(res, frames, fps) {
  const spec = ballFor(res.activity);
  if (!spec || !frames || !frames.length) return null;
  const out = new Map();
  const ppm = res.pxPerM > 0 ? res.pxPerM : 0;
  if (res.activity === "jumpshot") {
    if (!ppm) return null;
    const mid = (lm) => {
      const a = lm && lm.left_wrist, b = lm && lm.right_wrist;
      if (a && b) return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5 * ppm ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - spec.radiusM * ppm] : null;
      return null;
    };
    const byI = new Map(frames.map((f, k) => [f.i ?? k, k]));
    const rels = (res.reps || []).filter((r) => !r.removed && Number.isFinite(r.release_i)).map((r) => byI.get(r.release_i)).filter((k) => k != null).sort((a, b) => a - b);
    let flight = null;
    for (let k = 0; k < frames.length; k++) {
      if (rels.includes(k)) {
        // the hands' velocity over the last few frames before release
        const k0 = Math.max(0, k - 3), p1 = mid(frames[k].lm) || null, p0 = mid(frames[k0].lm) || null;
        if (p1 && p0 && k > k0) {
          const dt = (frames[k].t - frames[k0].t) / 1000;
          flight = { k, t0: frames[k].t, p: p1, v: [(p1[0] - p0[0]) / dt, (p1[1] - p0[1]) / dt] };
        }
      }
      if (flight && k > flight.k) {
        const t = (frames[k].t - flight.t0) / 1000;
        const x = flight.p[0] + flight.v[0] * t, y = flight.p[1] + flight.v[1] * t + 0.5 * G * ppm * t * t;
        if (t > 1.5 || y > (frames[k].lm && Math.max(...Object.values(frames[k].lm).map((p) => p[1]))) + ppm) { flight = null; continue; }
        out.set(k, [x, y]);
        continue;
      }
      const m = mid(frames[k].lm);
      if (m) out.set(k, m);
    }
  } else if (Array.isArray(res.ballTrack) && res.ballTrack.length) {
    const half = 500 / (fps || 30);
    let j = 0;
    const tr = res.ballTrack;
    for (let k = 0; k < frames.length; k++) {
      const t = frames[k].t;
      while (j < tr.length - 1 && Math.abs(tr[j + 1].t - t) <= Math.abs(tr[j].t - t)) j++;
      if (Math.abs(tr[j].t - t) <= half) out.set(k, [tr[j].x, tr[j].y]);
    }
  }
  return out.size ? out : null;
}

/** Frames with a BALL "landmark" added where the ball is known (depth 0). */
export function framesWithBall(frames, path) {
  if (!path) return frames;
  return frames.map((f, k) => (path.has(k) ? { ...f, lm: { ...f.lm, BALL: [...path.get(k), 0] } } : f));
}

const f6 = (x) => String(+Number(x).toPrecision(6));
const linear = '<LinearFunction><coefficients> 1 0</coefficients></LinearFunction>';
const zero = '<Constant><value>0</value></Constant>';

/** A generic model's .osim text with the ball added (body, joint, marker). */
export function addBallToOsim(osimText, spec) {
  if (!osimText || !spec || /<Body name="ball"/.test(osimText)) return osimText;
  const m = spec.massKg, r = spec.radiusM, I = (2 / 3) * m * r * r;   // a hollow sphere
  const body = `
				<!-- BioScout Web: the ${spec.sport} ball. Change <mass>, <inertia> (hollow sphere: 2/3 m r^2)
				     and the Sphere <radius> to re-run with another ball. -->
				<Body name="ball">
					<mass>${f6(m)}</mass>
					<mass_center>0 0 0</mass_center>
					<inertia>${f6(I)} ${f6(I)} ${f6(I)} 0 0 0</inertia>
					<attached_geometry>
						<Sphere name="ball_geom">
							<socket_frame>..</socket_frame>
							<Appearance><opacity>1</opacity><color>0.5 0.5 0.5</color></Appearance>
							<radius>${f6(r)}</radius>
						</Sphere>
					</attached_geometry>
				</Body>`;
  const ax = (name, axis, coord) => `<TransformAxis name="${name}"><coordinates>${coord}</coordinates><axis>${axis}</axis>${coord ? linear : zero}</TransformAxis>`;
  const coord = (n) => `<Coordinate name="${n}"><default_value>0</default_value><range>-50 50</range><clamped>false</clamped><locked>false</locked></Coordinate>`;
  const joint = `
				<!-- BioScout Web: the ball moves freely (3 translations) relative to the ground; its
				     inverse-dynamics residuals are the force that acted on it (the hands, while held). -->
				<CustomJoint name="ball_free">
					<socket_parent_frame>ground_offset</socket_parent_frame>
					<socket_child_frame>ball_offset</socket_child_frame>
					<coordinates>${coord("ball_tx")}${coord("ball_ty")}${coord("ball_tz")}</coordinates>
					<frames>
						<PhysicalOffsetFrame name="ground_offset"><socket_parent>/ground</socket_parent><translation>0 0 0</translation><orientation>0 0 0</orientation></PhysicalOffsetFrame>
						<PhysicalOffsetFrame name="ball_offset"><socket_parent>/bodyset/ball</socket_parent><translation>0 0 0</translation><orientation>0 0 0</orientation></PhysicalOffsetFrame>
					</frames>
					<SpatialTransform>
						${ax("rotation1", "1 0 0", "")}${ax("rotation2", "0 1 0", "")}${ax("rotation3", "0 0 1", "")}
						${ax("translation1", "1 0 0", "ball_tx")}${ax("translation2", "0 1 0", "ball_ty")}${ax("translation3", "0 0 1", "ball_tz")}
					</SpatialTransform>
				</CustomJoint>`;
  const marker = `
				<Marker name="BALL"><socket_parent_frame>/bodyset/ball</socket_parent_frame><location>0 0 0</location><fixed>false</fixed></Marker>`;
  let s = osimText;
  s = s.replace(/(<BodySet[^>]*>\s*<objects>)/, `$1${body}`);
  s = s.replace(/(<JointSet[^>]*>\s*<objects>)/, `$1${joint}`);
  if (/<MarkerSet[^>]*>\s*<objects>/.test(s)) s = s.replace(/(<MarkerSet[^>]*>\s*<objects>)/, `$1${marker}`);
  else s = s.replace(/(<\/JointSet>)/, `$1\n\t\t<MarkerSet name="markerset"><objects>${marker}</objects><groups /></MarkerSet>`);
  return s;
}
