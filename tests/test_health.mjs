/**
 * health.js -- a rating that has to stay honest as metrics are added.
 *
 * Two failures matter. A metric whose inputs are missing must not score zero,
 * because a dial reading "bad" when the app simply does not know is a lie
 * rendered in red. And the overall score must stay comparable as metrics are
 * added, or a rating from one number will look like a rating from five.
 *
 *   node tests/test_health.mjs
 */
import { rate, scoreColour, METRICS, clamp01 } from "../src/health.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!bad && !cond) bad++;
  else if (!cond) bad++;
};

/* ---- BMI --------------------------------------------------------------- */
{
  // 1.81 m, 83 kg -> 25.3, which is just outside the plateau.
  const r = rate({ heightM: 1.81, weightKg: 83 });
  ok(r.contributions.length === 1, "one metric today");
  ok(r.contributions[0].value === 25.3, "BMI to one decimal", String(r.contributions[0].value));
  ok(r.score < 1 && r.score > 0.9, "just over the band scores just under 1", r.score.toFixed(3));

  const mid = rate({ heightM: 1.81, weightKg: 72 });      // 22.0
  ok(mid.score === 1, "the middle of the range is a full score", String(mid.score));

  const low = rate({ heightM: 1.81, weightKg: 49 });      // 15.0
  ok(low.score === 0, "the floor scores zero rather than going negative", String(low.score));

  const high = rate({ heightM: 1.81, weightKg: 120 });    // 36.6
  ok(high.score === 0, "and so does the ceiling", String(high.score));
}

/* ---- missing inputs ---------------------------------------------------- */
{
  const r = rate({ heightM: 1.81 });
  ok(r.score === null, "no weight, no rating -- not a zero", String(r.score));
  ok(r.contributions.length === 0 && r.missing.length === 1, "the metric is listed as missing");
  ok(r.missing[0].needs.includes("weightKg"), "and says what it wanted",
     r.missing[0].needs.join(","));

  ok(rate({}).score === null, "nothing at all is null");
  ok(rate({ heightM: 0, weightKg: 83 }).score === null, "a nonsense height is missing, not bad");
  ok(rate({ heightM: 1.81, weightKg: -5 }).score === null, "and so is a nonsense weight");
}

/* ---- the registry stays addable ---------------------------------------- */
{
  const before = rate({ heightM: 1.81, weightKg: 72 });
  METRICS.push({
    key: "test", label: "x", needs: ["fake"],
    compute: ({ fake }) => ({ value: fake, text: String(fake), score: 0 }),
  });
  try {
    const withNew = rate({ heightM: 1.81, weightKg: 72, fake: 1 });
    ok(withNew.contributions.length === 2, "a metric is added by pushing an object");
    ok(withNew.score === 0.5, "and the rating is the mean of what scored",
       String(withNew.score));

    // The one that keeps it honest: a metric whose inputs are absent must not
    // drag the mean down, or every new metric would make everyone look worse.
    const stillOne = rate({ heightM: 1.81, weightKg: 72 });
    ok(stillOne.score === before.score,
       "a missing metric leaves the others' rating unchanged",
       `${stillOne.score} vs ${before.score}`);
    ok(stillOne.missing.some((m) => m.key === "test"), "and is reported as missing");
  } finally {
    METRICS.pop();
  }
}

/* ---- colour ------------------------------------------------------------ */
{
  const hue = (c) => +(/hsl\((\d+)/.exec(c) || [])[1];
  ok(hue(scoreColour(1)) > hue(scoreColour(0.5)), "better scores are greener");
  ok(hue(scoreColour(0.5)) > hue(scoreColour(0)), "and worse ones redder");
  ok(hue(scoreColour(0)) === 0, "zero is red", scoreColour(0));
  // Grey, not red: an unknown rating must not read as a bad one.
  ok(!/hsl/.test(scoreColour(null)), "an unknown score is grey, not red", scoreColour(null));
  ok(clamp01(2) === 1 && clamp01(-1) === 0 && clamp01("x") === null, "clamping");
}

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
