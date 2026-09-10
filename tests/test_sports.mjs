/**
 * Sports: every movement a sport offers is one the app can analyse and one
 * the recorder's Movement list has; "auto" is always allowed; a session with
 * no sport (from before sports existed) allows everything.
 *
 *   node tests/test_sports.mjs
 */
import { readFileSync } from "node:fs";
import { SPORTS, SPORT_IDS, allowedIn, sportActivities } from "../src/sports.js";
import { ACTIVITIES } from "../src/kinematics.js";
import { REGION_EXERCISES, REGIONS, regionsFor, bodyMapHTML } from "../src/bodymap.js";

let fails = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${msg}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const html = readFileSync("index.html", "utf8");
const options = new Set([...html.matchAll(/<option value="([a-z]+)" data-i18n=/g)].map((m) => m[1]));

ok(SPORT_IDS.join() === "strength,basketball", "two sports for now: strength, basketball");
for (const [sport, acts] of Object.entries(SPORTS)) {
  const unknown = acts.filter((a) => !ACTIVITIES[a]);
  ok(!unknown.length, `${sport}: every movement is analysable`, unknown.join(","));
  const missing = acts.filter((a) => !options.has(a));
  ok(!missing.length, `${sport}: every movement is in the Movement list`, missing.join(","));
}
ok(allowedIn("basketball", "jumpshot") && !allowedIn("basketball", "pullup"), "basketball: shot yes, pull-up no");
ok(allowedIn("strength", "kickback") && !allowedIn("strength", "jumpshot"), "strength: kick back yes, shot no");
ok(allowedIn("basketball", "auto") && allowedIn("strength", "auto"), "detect automatically stays in both");
ok(allowedIn(null, "pullup") && sportActivities(null) === null, "no sport: everything allowed");

/* Body map: offers only strength movements, and every strength movement is
 * reachable from some body part. */
const offered = new Set(Object.values(REGION_EXERCISES).flat());
ok([...offered].every((a) => SPORTS.strength.includes(a)), "the body map offers strength movements only");
ok(SPORTS.strength.every((a) => offered.has(a)), "every strength movement is under some body part",
   SPORTS.strength.filter((a) => !offered.has(a)).join(","));
ok(regionsFor("kickback").includes("glutes") && regionsFor("pullup").includes("back"),
   "kick back -> glutes, pull-up -> back");
const svg = bodyMapHTML((k) => k, { selected: "glutes", trained: ["back"], current: "squat" });
ok(REGIONS.filter((r) => r !== "core").every((r) => svg.includes(`data-region="${r}"`)),
   "every group is drawn and tappable");
ok(/bm-part sel" data-region="glutes"/.test(svg) && /bm-part done" data-region="back"/.test(svg),
   "the tapped group is selected, trained groups are tinted");
ok((svg.match(/class="ghost bmEx/g) || []).length === 3 && /bmEx on" data-activity="squat"/.test(svg),
   "the glutes list three exercises, the current one marked");
ok(bodyMapHTML((k) => k, { selected: "core" }).includes("bmNone"), "a group with nothing trackable says so");

{
  const regionsOf = (h) => [...h.matchAll(/data-region="([a-z]+)"/g)].map((m) => m[1]).sort().join();
  const him = bodyMapHTML((k) => k, {}), her = bodyMapHTML((k) => k, { female: true });
  ok(her.includes("bm-hair") && !him.includes("bm-hair") && her.includes('class="bodymap female"'),
     "a female athlete gets the female figure; others do not");
  ok(regionsOf(her) === regionsOf(him), "and both figures offer exactly the same groups to tap");
}

console.log(fails ? `\n${fails} FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
