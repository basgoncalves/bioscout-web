/**
 * health.js -- a health rating that can grow.
 *
 * The shape matters more than what is in it today. A metric is an object with
 * a key, a label, the inputs it needs, and a compute() that returns a value
 * and a score from 0 to 1, worst to best. Adding one means pushing an object
 * onto METRICS; nothing else in the app changes. A metric backed by a model
 * later is the same object with a different compute().
 *
 * The overall rating is the mean of the metrics that could be computed, and it
 * reports how many those were. It is NOT scaled by how many are missing: a
 * rating from one metric and a rating from five would otherwise look identical
 * on a dial, and the first is a single number wearing the clothes of a
 * summary.
 *
 * On BMI specifically, since it is the only metric here today: it is height
 * and mass and nothing else, and it systematically misreads muscular people as
 * overweight. In an app whose users are lifting and jumping, that is not an
 * edge case, it is the median user. The metric carries that caveat and the UI
 * shows it. Treating BMI as a health verdict would be the same error as
 * reporting a joint moment from a body mass nobody checked.
 */

/** 0 is bad, 1 is good. Everything scores on this scale so colour is uniform. */
export const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : null);

/** Piecewise: 1 inside [good, goodTo], falling to 0 at [floor] and [ceil]. */
function plateau(v, floor, good, goodTo, ceil) {
  if (!Number.isFinite(v)) return null;
  if (v >= good && v <= goodTo) return 1;
  if (v < good) return clamp01((v - floor) / (good - floor));
  return clamp01((ceil - v) / (ceil - goodTo));
}

export const METRICS = [
  {
    key: "bmi",
    label: "metricBmi",
    needs: ["heightM", "weightKg"],
    caveat: "bmiCaveat",
    compute({ heightM, weightKg }) {
      const h = Number(heightM), m = Number(weightKg);
      if (!(h > 0.5 && h < 2.6) || !(m > 20 && m < 400)) return null;
      const bmi = m / (h * h);
      return {
        value: Math.round(bmi * 10) / 10,
        text: `${(Math.round(bmi * 10) / 10).toFixed(1)}`,
        // WHO bands, softened at the edges: 18.5-25 is the plateau, and the
        // score falls to zero at 15 and 35 rather than stepping at a boundary
        // that nobody's body knows about.
        score: plateau(bmi, 15, 18.5, 25, 35),
      };
    },
  },
];

/**
 * Rate what can be rated.
 *
 * `ctx` carries whatever the metrics might need; a metric that cannot find its
 * inputs is listed as missing rather than scored as zero, because "we do not
 * know" and "bad" are different answers and only one of them is honest.
 */
export function rate(ctx = {}) {
  const contributions = [];
  const missing = [];
  for (const m of METRICS) {
    const lacks = (m.needs || []).filter((k) => ctx[k] === undefined || ctx[k] === null || ctx[k] === "");
    if (lacks.length) { missing.push({ key: m.key, label: m.label, needs: lacks }); continue; }
    const out = m.compute(ctx);
    if (!out || out.score === null) { missing.push({ key: m.key, label: m.label, needs: m.needs }); continue; }
    contributions.push({ key: m.key, label: m.label, caveat: m.caveat, ...out });
  }
  if (!contributions.length) return { score: null, contributions: [], missing };
  const score = contributions.reduce((a, c) => a + c.score, 0) / contributions.length;
  return { score, contributions, missing };
}

/**
 * Score to colour, red through amber to green.
 *
 * Hue only, with saturation and lightness fixed, so the steps between scores
 * read as one scale rather than as separate colours. Null is grey: an unknown
 * rating must not look like a bad one.
 */
export function scoreColour(score) {
  if (score === null || score === undefined) return "#5b6671";
  return `hsl(${Math.round(clamp01(score) * 122)} 52% 46%)`;
}
