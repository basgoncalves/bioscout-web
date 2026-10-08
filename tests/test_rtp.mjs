/**
 * Return to play: the tables hold together.
 *
 *   node tests/test_rtp.mjs
 */
import { readFileSync } from "node:fs";
import { RTP_REGIONS, PHASE_IDS, INJURIES, injuriesFor, recentTest, rtpPanelHTML } from "../src/rtp.js";
import { ACTIVITIES } from "../src/kinematics.js";
import { bodyMapHTML } from "../src/bodymap.js";
import { EN_KEYS } from "../src/i18n.js";

let bad = 0;
const ok = (c, m, extra = "") => { console.log(`  [${c ? "OK  " : "FAIL"}] ${m}${extra ? "  " + extra : ""}`); if (!c) bad++; };
const html = readFileSync("index.html", "utf8");
const options = new Set([...html.matchAll(/<option value="([a-z]+)" data-i18n=/g)].map((m) => m[1]));
const known = (a) => a === "reaction" || (ACTIVITIES[a] && options.has(a));

ok(INJURIES.every((i) => i.tests.length && i.tests.every(known)), "every suggested test is something the app records",
   INJURIES.flatMap((i) => i.tests.filter((a) => !known(a))).join());
ok(INJURIES.every((i) => PHASE_IDS.every((p) => Array.isArray(i.exercises[p]) && i.exercises[p].every(known))),
   "every injury has every phase, with trackable exercises only");
ok(INJURIES.every((i) => i.regions.every((r) => RTP_REGIONS.includes(r))), "injuries sit on regions the figure offers");
ok(RTP_REGIONS.every((r) => INJURIES.some((i) => i.regions.includes(r) && i.common)), "every region has at least one injury button");
ok(injuriesFor("knee").map((i) => i.id).includes("acl") && !injuriesFor("knee").some((i) => i.id === "meniscus"),
   "a region shows its common injuries; the rest stay in the drop-down");
const svg = bodyMapHTML((k) => k, { regions: RTP_REGIONS, list: false });
ok(RTP_REGIONS.every((r) => svg.includes(`data-region="${r}"`)) && !svg.includes('data-region="chest"'),
   "the figure offers the joints and leaves the other muscle groups untappable");
const strength = bodyMapHTML((k) => k, {});
ok(!strength.includes('data-region="knee"'), "strength training still offers muscle groups only");

const now = Date.parse("2026-10-08T12:00:00Z");
const sessions = [{ started: "2026-10-01T10:00:00Z", sets: [{ activity: "heelraise", at: "2026-10-01T10:05:00Z" }] },
                  { started: "2026-09-01T10:00:00Z", sets: [{ activity: "cmj", at: "2026-09-01T10:05:00Z" }] }];
ok(recentTest(["heelraise", "cmj"], { sessions, now }).activity === "heelraise", "a test in the last two weeks is found");
ok(recentTest(["cmj"], { sessions, now }) === null, "an old one is not");
ok(recentTest(["reaction"], { reactions: [{ at: "2026-10-07T09:00:00Z" }], now }).activity === "reaction", "reaction tests count for concussion");

const tr = (k) => k;
const p = rtpPanelHTML(tr, { region: "knee", injury: "acl", phase: "strength", showEx: true }, { recent: null });
ok(p.includes('data-rtp-injury="acl"') && p.includes('data-rtp-phase="power"') && p.includes("rtpTestSuggest")
   && p.includes('data-rtp-ex="slsquat"'), "region -> injury -> phase -> test suggestion and exercises");
ok(rtpPanelHTML(tr, { injury: "acl", phase: "strength" }, { recent: { activity: "cmj", at: now } }).includes("rtpTestRecent"),
   "a recent test is shown instead of the suggestion");
const keys = new Set(Object.keys(EN_KEYS));
const need = [...INJURIES.map((i) => "inj_" + i.id), ...PHASE_IDS.map((x) => "rtpPhase_" + x), ...RTP_REGIONS.map((r) => "bm_" + r)];
ok(need.every((k) => keys.has(k)), "every injury, phase and region has a translation", need.filter((k) => !keys.has(k)).join());
console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed");
process.exit(bad ? 1 : 0);
