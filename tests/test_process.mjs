/**
 * The Process page's engine (src/process.js, proc_dsp.js, proc_io.js).
 *
 * Reference numbers come from the BD2II 2026W course helpers
 * (analysis_toolkit/bd2ii_tools.py: numpy/scipy/pandas) run on the same
 * synthetic jump, so the page and the students' notebooks give one answer.
 *
 *   node tests/test_process.mjs
 */
import { makeProcessor, tokenize, chartSVG, channelTree, markerTriplets } from "../src/process.js";
import { readDelimited, readOpenSim, readTrc, fromTable } from "../src/proc_io.js";
import * as D from "../src/proc_dsp.js";

let fails = 0;
const ok = (c, msg) => { if (c) console.log("ok   ", msg); else { fails++; console.error("FAIL ", msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} (${a} vs ${b})`);

// synthetic squat jump, as in the Python reference
const fs = 1000, n = 3000;
const fz = new Float64Array(n).fill(700);
for (let i = 0; i < 300; i++) fz[1000 + i] = 700 + 600 * Math.sin((Math.PI * i) / 300);
for (let i = 1300; i < 1800; i++) fz[i] = 0;
for (let i = 0; i < 100; i++) fz[1800 + i] = 700 + 1500 * Math.sin((Math.PI * i) / 100);
for (let i = 0; i < n; i++) fz[i] += 5 * Math.sin(2 * Math.PI * 37 * (i / fs));

// python: bd2ii_tools on the same signal
const REF = { h: 0.3065625, hi: 0.13144985341319132, bw: 700.0, lp: [699.990744653114, 1112.26004410747, 699.9638129316221], pk: [1144, 1849], c: [[0, 1300], [1800, 3000]] };

near(D.jumpHeightFlight(fz, fs).height, REF.h, 1e-9, "jump height from flight time");
near(D.jumpHeightImpulse(fz, fs).height, REF.hi, 1e-9, "jump height from impulse");
const lp = D.lowpass(fz, fs, 10);
near(lp[0], REF.lp[0], 1e-9, "low-pass first sample (filtfilt padding)");
near(lp[1234], REF.lp[1], 1e-9, "low-pass middle");
near(lp[2999], REF.lp[2], 1e-9, "low-pass last sample");
ok(JSON.stringify(D.simplePeaks(fz, 1.3 * 700, 50)) === JSON.stringify(REF.pk), "peaks (Excel template rule)");
ok(JSON.stringify(D.contacts(fz)) === JSON.stringify(REF.c), "contacts");

// pandas centred rolling mean, odd and even windows
const x = [1, 2, 3, 4, 5, 6];
ok(JSON.stringify(Array.from(D.movingAverage(x, 3))) === JSON.stringify([1.5, 2, 3, 4, 5, 5.5]), "moving average, odd window");
ok(JSON.stringify(Array.from(D.movingAverage(x, 4))) === JSON.stringify([1.5, 2, 2.5, 3.5, 4.5, 5]), "moving average, even window (pandas centring)");

// paired t: scipy ttest_rel([1,2,3,4.5],[2,2.5,4,6]).pvalue
const ps = D.pairedSummary([1, 2, 3, 4.5], [2, 2.5, 4, 6]);
near(ps.p_paired_t, 0.01627660345942856, 1e-9, "paired t-test p (scipy ttest_rel)");

// the engine, through commands
const P = makeProcessor();
const ds = fromTable("P01_cmj_1.csv", ["time", "Force Plate 1 - Force - Fz"], Array.from(fz, (v, i) => [i / fs, -v]));
P.add([ds]);
ok(P.run("fz").ok && P.current().cols.Fz[500] > 0, "fz flips a downward plate force");
let r = P.run("jump Fz");
ok(r.ok, "jump command: " + r.msg);
near(P.S.results.find((q) => q.measure === "height (flight time)").value, 30.66, 1e-3, "jump result in cm");
ok(P.S.results[0].participant === "P01" && P.S.results[0].condition === "cmj", "participant/condition from the file name");
ok(P.run("lowpass fz 10").ok && P.current().cols["Fz·lp10"], "lowpass by case-insensitive column name");
ok(!P.run("lowpass Fz 900").ok, "a cut-off above Nyquist is refused");
ok(!P.run("frobnicate").ok, "unknown command is an error, not a crash");
ok(P.run("window 0 0.9").ok && P.run("bw").ok && Math.abs(P.S.bw[ds.name] - 700) < 1, "body weight from the quiet window");
ok(P.run('peaks Fz 1.3bw 50').ok, "peaks with a threshold in body weights");
ok(P.run("window all").ok && P.run("contacts Fz").ok && P.S.contacts[ds.name].list.length === 2, "contacts");
ok(P.run("meansd Fz contacts").ok && P.S.plot.curves.mean.length === 101, "mean ± SD of contacts, 101 points");
ok(P.run("values fascicle 45.1 47.8 44.0").ok, "typed values");
near(P.S.results.find((q) => q.measure === "fascicle cv_pct").value, 4.285, 1e-3, "CV of typed values");
ok(tokenize('plot "KMP-4 - Force - Fz" Fz').length === 3, "quoted column names");

// batch: two participants x two conditions -> compare
const Q = makeProcessor();
const mk = (name, scale) => fromTable(name, ["time", "Fz"], Array.from(fz, (v, i) => [i / fs, i >= 1300 && i < 1800 ? 0 : v * scale]));
Q.add([mk("P01_pre_1.csv", 1), mk("P01_post_1.csv", 1.1), mk("P02_pre_1.csv", 1), mk("P02_post_1.csv", 1.05)]);
ok(Q.run("all jump Fz").ok, "all <command> runs on every file");
r = Q.run('compare "impulse" pre post');
ok(r.ok && Q.S.results.some((q) => q.measure === "mean_diff"), "compare two conditions: " + r.msg);

// readers
const vicon = readDelimited("Devices\n1000\n,,KMP-1 - Force,,\nFrame,Sub Frame,Fx,Fy,Fz\n,,N,N,N\n1,0,1,2,-3\n1,1,1,2,-4\n\nTrajectories\n100\n,,LASI,,\nFrame,Sub Frame,X,Y,Z\n,,mm,mm,mm\n1,,10,20,30\n", "t.csv");
ok(vicon.length === 2 && vicon[0].cols["KMP-1 - Force - Fz"][1] === -4 && vicon[0].fs === 1000 && vicon[1].cols["LASI - X"][0] === 10, "Vicon CSV: two sections, grouped column names");
const mot = readOpenSim("Coordinates\nversion=1\ninDegrees=yes\nendheader\ntime\tknee_angle_r\n0\t1\n0.01\t2\n", "ik.mot");
ok(mot[0].fs > 99 && mot[0].cols.knee_angle_r[1] === 2 && mot[0].meta.inDegrees, "OpenSim .mot");
const trc = readTrc("PathFileType\t4\t(X/Y/Z)\tx.trc\nDataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\n100\t100\t2\t1\tmm\nFrame#\tTime\tLASI\t\t\n\t\tX1\tY1\tZ1\n1\t0\t1\t2\t3\n2\t0.01\t4\t5\t6\n", "x.trc");
ok(trc[0].cols["LASI Y"][1] === 5, ".trc markers");
const nexus = readDelimited("Trial,x\nTime,EMG Channels.TA\ns,V\n0,0.1\n0.0005,0.2\n", "n.csv");
ok(nexus[0].cols.TA && Math.round(nexus[0].fs) === 2000, "Nexus ASCII export");

// raw vs processed: every processed column knows its raw channel, through chains
const V = makeProcessor();
V.add([fromTable("v.csv", ["time", "EMG1", "LASI X", "LASI Y", "LASI Z", "RASI - X", "RASI - Y", "RASI - Z"], Array.from({ length: 400 }, (_, i) => [i / 1000, Math.sin(i), 1, 2, 3, 4, 5, 6]))]);
V.run("envelope EMG1 50"); V.run("lowpass EMG1·env50 20"); V.run("all rectify EMG1");
const tree = channelTree(V.current());
ok(JSON.stringify(tree.derived.EMG1) === JSON.stringify(["EMG1·env50", "EMG1·env50·lp20", "EMG1·abs"]), "processed columns trace back to the raw channel");
ok(!tree.raw.includes("EMG1·env50"), "processed columns are not listed as raw");
ok(markerTriplets(V.current()).map((m) => m.name).join() === "LASI,RASI", "marker triplets from C3D and Vicon naming");

// L02 commands (values checked against the L02 notebook on the course example data)
const L2 = makeProcessor();
L2.add([fromTable("P01_sj_1.csv", ["time", "Fz"], Array.from(fz, (v, i) => [i / fs, v]))]);
ok(L2.run("impulse Fz 0.5 20").ok, "impulse command");
const g = (m) => L2.S.results.find((q) => q.measure === m).value;
near(g("net_impulse"), g("positive_impulse") + g("negative_impulse"), 1e-3, "net = positive + negative impulse");
near(g("height_flight"), 30.66, 1e-3, "impulse command reports the flight-time height too");
ok(L2.run("filters Fz 5 10 ma25 quiet 0 0.5").ok && L2.current().cols["Fz·lp10"] && L2.current().src["Fz·ma25"] === "Fz", "filters makes the columns and links them to the raw channel");
near(L2.S.results.find((q) => q.measure === "lp10 quiet mean").value, 700, 1e-2, "a low-pass keeps the quiet-standing mean");
const wk = fromTable("walk.csv", ["time", "Fz", "Fy"], Array.from({ length: 300 }, (_, i) => { const p = i / 299; return [i / 200, 600 * Math.sin(Math.PI * p) + 200 * Math.sin(3 * Math.PI * p), 100 * Math.sin(2 * Math.PI * p)]; }));
L2.add([wk]);
ok(L2.run("gait Fz Fy 60").ok && L2.S.results.some((q) => q.measure === "braking" && q.value < 0), "gait: braking reported negative whatever the walking direction");

ok(chartSVG({ series: [{ x: [0, 1, 2], y: [1, 3, 2], color: "#000" }] }).svg.startsWith("<svg"), "chart draws");

if (fails) { console.error(`${fails} failure(s)`); process.exit(1); }
console.log("all process tests passed");
