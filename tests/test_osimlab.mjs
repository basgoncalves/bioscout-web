/**
 * The OpenSim trial card's own logic: which engine addresses are allowed,
 * and what is read out of each step's result.
 *
 *   node tests/test_osimlab.mjs
 */
import { cleanEngineUrl, engineFromSearch, fileKind, makeEngineClient, pickAngles, pickMoments,
         markerErrors, topMuscles, worstReserve, reactionJoints, defaultReactionJoint,
         reactionForce, scaleRows, lineChartSVG } from "../src/osimlab.js";

let bad = 0;
const ok = (c, m, extra = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`); if (!c) bad++; };
const res = (data, extra = {}) => ({ columns: Object.keys(data), time: data[Object.keys(data)[0]].map((_, i) => i / 10), data, ...extra });

console.log("Engine addresses");
ok(cleanEngineUrl("https://abc-def.trycloudflare.com/x?y") === "https://abc-def.trycloudflare.com", "an https address, trimmed to its origin");
ok(cleanEngineUrl("http://127.0.0.1:8771") === "http://127.0.0.1:8771" && cleanEngineUrl("http://localhost:8771/"), "plain http on this computer");
ok(cleanEngineUrl("http://192.168.1.20:8771") === null, "plain http to another machine is refused");
ok(cleanEngineUrl("javascript:alert(1)") === null && cleanEngineUrl("") === null && cleanEngineUrl("https://u:p@x.com") === null,
   "so are scripts, blanks and addresses carrying a password");
const link = engineFromSearch("?lab=1&engine=http%3A%2F%2F127.0.0.1%3A8771&code=123456");
ok(link && link.url === "http://127.0.0.1:8771" && link.code === "123456", "the engine's printed link is read");
ok(engineFromSearch("?lab=1") === null && engineFromSearch("?engine=https://x.com&code=a b") === null, "no engine, or a malformed code: nothing");

console.log("Files");
ok(fileKind("Static.C3D", "static") === "static_c3d" && fileKind("walk.trc", "motion") === "motion_trc"
   && fileKind("grf.mot", "motion") === "motion_grf", "kind from the name and the slot");
ok(fileKind("grf.mot", "static") === null && fileKind("notes.txt", "motion") === null, "what a step cannot take is refused here");

console.log("Client");
{
  const seen = [];
  const fetchFn = async (url, opt) => { seen.push([url, opt]); return url.includes("/bad")
    ? { ok: false, status: 400, json: async () => ({ error: "bad_request", message: "run export first" }) }
    : { ok: true, json: async () => ({ id: "L1", steps: {} }) }; };
  const c = makeEngineClient({ url: "http://127.0.0.1:8771", code: "42", fetchFn });
  await c.run("L1", "scale");
  ok(seen[0][0] === "http://127.0.0.1:8771/api/job/L1/run" && seen[0][1].headers["X-Lab-Code"] === "42"
     && seen[0][1].body === '{"step":"scale"}', "requests carry the session code");
  ok(c.bundleUrl("L1").endsWith("/api/job/L1/bundle?code=42"), "the download link carries it too");
  let err = null;
  try { await makeEngineClient({ url: "http://127.0.0.1:8771/bad", code: "1", fetchFn }).newJob(); } catch (e) { err = e; }
  ok(err && err.code === "bad_request" && /export/.test(err.message), "an engine refusal keeps its code and message");
  try { await makeEngineClient({ url: "x", code: "1", fetchFn: async () => { throw new Error("net"); } }).health(); } catch (e) { err = e; }
  ok(err.code === "offline", "no answer is 'offline', not a stack trace");
}

console.log("Angles and moments");
{
  const gpk = res({ hip_flexion_r: [10, 30, 20], knee_angle_r: [-5, -60, -10], knee_angle_l: [-8, -40, -12], ankle_angle_r: [0, 10, -5] },
                  { inDegrees: true });
  const a = pickAngles(gpk);
  ok(a.series.length === 4 && a.flipped, "hip, both knees and an ankle found; the negative-flexion knee is flagged");
  ok(Math.max(...a.series.find((s) => s.joint === "knee" && s.side === "r").y) === 60, "and drawn flexion-positive");
  const raj = pickAngles(res({ knee_angle_r: [5, 60, 10] }, { inDegrees: true }));
  ok(!raj.flipped && raj.series[0].y[1] === 60, "a flexion-positive model is left alone");
  const rad = pickAngles(res({ hip_flexion_r: [0, Math.PI / 2] }, { inDegrees: false }));
  ok(Math.abs(rad.series[0].y[1] - 90) < 1e-9, "radians become degrees");
  const m = pickMoments(res({ hip_flexion_r_moment: [80, -40], knee_angle_l_moment: [20, 10], pelvis_ty_force: [800, 800] }), 80);
  ok(m.series.length === 2 && m.series[0].y[0] === 1 && m.series[1].dash && m.perKg, "moments per kg; the left side is dashed; forces are not moments");
  ok(pickAngles(res({ elbow_flex_r: [1, 2] })).series.length === 0, "a model with other names gives nothing rather than a guess");
}

console.log("Marker error, muscles, reserves");
{
  const e = markerErrors(res({ total_squared_error: [1, 1], marker_error_RMS: [0.01, 0.02], marker_error_max: [0.03, 0.05] }));
  ok(e.rms_cm === 1.5 && e.max_cm === 5, "RMS averaged, the worst marker kept, both in cm", JSON.stringify(e));
  const so = res({ soleus_r: [0, 900], vas_lat_r: [100, 400], tib_ant_r: [50, 60], reserve_hip_flexion_r: [5, -42], FX: [1000, 2000], MZ: [3, 4],
    calcn_l_grf_l_1_Fy: [800, 950] });
  const top = topMuscles(so, 2);
  ok(top.map((x) => x.column).join() === "soleus_r,vas_lat_r", "the largest muscles, with reserves and residuals left out");
  ok(worstReserve(so).peak === 42 && worstReserve(res({ soleus_r: [1, 2] })) === null, "the largest reserve, or none");
}

console.log("Joint reactions");
{
  const bw = 80 * 9.80665;
  const jr = res({ ground_pelvis_on_pelvis_in_pelvis_fx: [1, 1], ground_pelvis_on_pelvis_in_pelvis_fy: [1, 1], ground_pelvis_on_pelvis_in_pelvis_fz: [1, 1],
    hip_l_on_femur_l_in_femur_l_fx: [0, 0], hip_l_on_femur_l_in_femur_l_fy: [0, -bw], hip_l_on_femur_l_in_femur_l_fz: [0, 0],
    hip_r_on_femur_r_in_femur_r_fx: [0, 3 * bw], hip_r_on_femur_r_in_femur_r_fy: [0, -4 * bw], hip_r_on_femur_r_in_femur_r_fz: [0, 0],
    ankle_r_on_talus_r_in_talus_r_fx: [0, 1], ankle_r_on_talus_r_in_talus_r_fy: [0, 1] });
  const joints = reactionJoints(jr);
  ok(joints.map((j) => j.joint).join() === "hip_l,hip_r", "joints with all three force parts; the pelvis residual is not a joint");
  ok(defaultReactionJoint(joints) === "hip_r_on_femur_r_in_femur_r", "the right hip is shown first");
  const f = reactionForce(jr, "hip_r_on_femur_r_in_femur_r", 80);
  ok(Math.abs(f.peak - 5) < 1e-6 && f.inBW, "resultant in body weights: 3 and 4 make 5");
  ok(reactionForce(jr, "nope", 80) === null, "an unknown joint is null");
}

console.log("Scale factors and the chart");
{
  const rows = scaleRows([{ segment: "pelvis", scales: [1, 1.1, 1] }, { segment: "femur_r", scales: [1.05, 1.05, 1.05] },
    { segment: "femur_l", scales: [1.05, 1.05, 1.05] }, { segment: "tibia_r", scales: [1, 1, 1] }, { segment: "tibia_l", scales: [1.2, 1, 1] }]);
  ok(rows.map((r) => r.segment).join() === "pelvis,femur,tibia_r,tibia_l", "matching sides fold into one row; differing sides stay apart",
     rows.map((r) => r.segment).join());
  const svg = lineChartSVG({ time: [0, 1, 2], series: [{ label: "a<b", y: [0, NaN, 2], color: "#123456" }], yUnit: "N" });
  ok(svg.startsWith("<svg") && svg.includes("a&lt;b") && (svg.match(/M/g) || []).length === 2, "a gap in the data is a gap in the line; labels are escaped");
  ok(lineChartSVG({ time: [0], series: [] }) === "", "nothing to draw draws nothing");
}

console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
