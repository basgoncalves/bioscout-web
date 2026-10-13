/**
 * c3dexport.js -- a C3D becomes the files a bioscout trial starts from, as
 * bioscout/session/exportC3D.py writes them into 2_experimental/<trial>/:
 *
 *   marker_experimental.trc   markers, mm, rotated -90 deg about X (lab Z-up -> OpenSim Y-up), time from 0
 *   grf.mot                   per plate ground_force_<n>_v{x,y,z} (N), _p{x,y,z} (m, CoP) and
 *                             ground_moment_<n>_m{x,y,z} (N m, free moment), OpenSim axes, time from 0
 *   emg.mot                   the analog channels that look like EMG (optional)
 *
 * The plate maths follows OpenSim's C3DFileAdapter (forces at the centre of
 * pressure): plate axes from CORNERS, the plate origin offset from ORIGIN, the
 * stored force taken as the reaction on the subject, CoP from the moments about
 * the plate origin. Checked on runA1.c3d: the CoP lands under the foot markers.
 */
import { readC3d } from "./proc_io.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => { const n = Math.hypot(...a) || 1; return a.map((v) => v / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mul = (R, v) => [0, 1, 2].map((r) => R[0][r] * v[0] + R[1][r] * v[1] + R[2][r] * v[2]);   // R = [ex, ey, ez] columns

// lab (Z-up) -> OpenSim (Y-up): x -> x, y -> z, z -> -y  (exportC3D._remap_grf_axes default; markers rotate -90 about X)
const toOsim = (v) => [v[0], v[2], -v[1]];

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(8) : "nan");

export function c3dToOpenSim(buf, fileName, { emgPattern = /emg|voltage/i, forceThreshold = 10 } = {}) {
  const ds = readC3d(buf, fileName);
  const mk = ds.find((d) => d.meta.markers), an = ds.find((d) => d.meta.platesRaw);
  const out = {};
  // ---- markers -> .trc
  if (mk) {
    const names = mk.meta.markers, n = mk.time.length, rate = mk.fs;
    const head = [`PathFileType\t4\t(X/Y/Z)\tmarker_experimental.trc`,
      `DataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\tOrigDataRate\tOrigDataStartFrame\tOrigNumFrames`,
      `${rate.toFixed(6)}\t${rate.toFixed(6)}\t${n}\t${names.length}\tmm\t${rate.toFixed(6)}\t${mk.meta.first || 0}\t${n}`,
      `Frame#\tTime\t` + names.map((m) => `${m}\t\t`).join("\t"),
      `\t\t` + names.map((_, i) => `X${i + 1}\tY${i + 1}\tZ${i + 1}`).join("\t"), ""];
    const rows = [];
    for (let i = 0; i < n; i++) {
      const r = [String(i + 1), (i / rate).toFixed(5)];
      for (const m of names) {
        const v = toOsim([mk.cols[`${m} X`][i], mk.cols[`${m} Y`][i], mk.cols[`${m} Z`][i]]);
        r.push(...v.map((x) => (Number.isFinite(x) ? x.toFixed(5) : "")));
      }
      rows.push(r.join("\t"));
    }
    out["marker_experimental.trc"] = head.join("\n") + rows.join("\n") + "\n";
  }
  // ---- force plates -> grf.mot
  if (an && an.meta.platesRaw.length) {
    const n = an.time.length, fs = an.fs, cols = ["time"], data = [an.time.map((_, i) => i / fs)];
    const plates = [];
    an.meta.platesRaw.forEach((pl, k) => {
      const c = [0, 1, 2, 3].map((i) => pl.corners.slice(3 * i, 3 * i + 3));
      if (c.some((v) => v.length < 3)) return;
      // C3D corners: 1 (+x,+y), 2 (-x,+y), 3 (-x,-y), 4 (+x,-y) in plate axes, listed looking down on the plate
      const ex = norm(sub(c[0], c[1])), eyRaw = norm(sub(c[0], c[3])), ez = norm(cross(ex, eyRaw)), ey = cross(ez, ex);
      const centre = [0, 1, 2].map((a) => (c[0][a] + c[1][a] + c[2][a] + c[3][a]) / 4);
      const R = [ex, ey, ez];
      const [ox, oy, oz] = pl.origin.length === 3 ? pl.origin : [0, 0, 0];   // plate origin relative to the surface centre, plate axes (mm)
      const [Fx, Fy, Fz, Mx, My, Mz] = pl.channels;
      const F = [new Float64Array(n), new Float64Array(n), new Float64Array(n)], P = [new Float64Array(n), new Float64Array(n), new Float64Array(n)], T = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
      for (let i = 0; i < n; i++) {
        const f = [Fx[i], Fy[i], Fz[i]], m = [Mx[i], My[i], Mz[i]];               // what the plate measured, about its origin
        const on = Math.abs(f[2]) > forceThreshold;
        // CoP on the surface (plate axes, relative to the plate origin): z_s = -oz
        const zs = -oz;
        // moment about the surface point (cx, cy, zs): M' = M - r x F ; choose cx, cy so M'x = M'y = 0
        //   M'x = Mx - (cy*Fz - zs*Fy) = 0  -> cy = (Mx + zs*Fy)/Fz
        //   M'y = My - (zs*Fx - cx*Fz) = 0  -> cx = -(My - zs*Fx)/Fz
        const CX = on ? -(m[1] - zs * f[0]) / f[2] : 0, CY = on ? (m[0] + zs * f[1]) / f[2] : 0;
        const Tz = on ? m[2] - (CX * f[1] - CY * f[0]) : 0;
        // type-2/4 plates store the force the plate applies to the subject (the reaction) in plate axes
        const Flab = mul(R, f);
        const Plab = on ? [0, 1, 2].map((a) => centre[a] + mul(R, [CX + ox, CY + oy, 0])[a]) : [NaN, NaN, NaN];
        const Tlab = mul(R, [0, 0, -Tz]);
        const fo = toOsim(Flab), po = on ? toOsim(Plab).map((v) => v / 1000) : [0, 0, 0], to = toOsim(Tlab).map((v) => v / 1000);
        for (let a = 0; a < 3; a++) { F[a][i] = fo[a]; P[a][i] = po[a]; T[a][i] = on ? to[a] : 0; }
      }
      const id = k + 1;
      for (const [a, ax] of ["x", "y", "z"].entries()) { cols.push(`ground_force_${id}_v${ax}`); data.push(F[a]); }
      for (const [a, ax] of ["x", "y", "z"].entries()) { cols.push(`ground_force_${id}_p${ax}`); data.push(P[a]); }
      for (const [a, ax] of ["x", "y", "z"].entries()) { cols.push(`ground_moment_${id}_m${ax}`); data.push(T[a]); }
      plates.push(id);
    });
    if (plates.length) {
      let txt = `grf\nversion=1\nnRows=${n}\nnColumns=${cols.length}\ninDegrees=no\nendheader\n${cols.join("\t")}\n`;
      for (let i = 0; i < n; i++) txt += data.map((d) => fmt(d[i])).join("\t") + "\n";
      out["grf.mot"] = txt;
    }
    // ---- EMG -> emg.mot
    const emg = Object.keys(an.cols).filter((c) => emgPattern.test(c) && !/^FP\d/.test(c));
    if (emg.length) {
      let txt = `emg\nversion=1\nnRows=${n}\nnColumns=${emg.length + 1}\ninDegrees=no\nendheader\ntime\t${emg.join("\t")}\n`;
      for (let i = 0; i < n; i++) txt += (i / fs).toFixed(8) + "\t" + emg.map((c) => fmt(an.cols[c][i])).join("\t") + "\n";
      out["emg.mot"] = txt;
    }
  }
  return out;
}
