/**
 * water.js -- glasses of water and cups of coffee, one count per day each.
 *
 * Counted in glasses/cups rather than typed in litres because that is how
 * anyone actually keeps track: nobody measures, they notice they have had
 * another one. A glass of water is 0.5 L and a cup of coffee is 100 mL (an
 * espresso-to-small-mug average); each row shows ten, which covers any
 * ordinary day -- the row is a tally, not a target.
 *
 * Coffee used to be a diary tag ("caffeine", level 1-10). It moved here
 * because a count of cups says what a mood-style level never could: how much.
 *
 * Like sleep and vitals nothing carries forward: yesterday's six glasses say
 * nothing about today.
 */
import { dayKey } from "./vitals.js";

/* `field` is the name the count is stored under. Water rows were written as
 * {glasses} before coffee existed, so that stays; coffee rows are {cups}. */
export const DRINKS = {
  water:  { cupL: 0.5, max: 10, field: "glasses" },
  coffee: { cupL: 0.1, max: 10, field: "cups" },
};
export const DRINK_KINDS = Object.keys(DRINKS);

export const GLASS_L = DRINKS.water.cupL;
export const GLASSES = DRINKS.water.max;

/** A count as it may be stored: a whole number from 0 to max, or null for
 *  anything that is not one. */
export function clampCups(n, max = GLASSES) {
  if (n === null || n === undefined || n === "") return null;
  const v = Math.round(+n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(max, v));
}
export const clampGlasses = (n) => clampCups(n, GLASSES);

/** One athlete's days for one drink. A later entry for the same day wins --
 *  the count is overwritten on every tap, so the last write is the count.
 *  Zero days are dropped. Each day carries `n` and, for water, `glasses`. */
export function collectCups(entries, kind = "water", profile = null) {
  const d = DRINKS[kind];
  const days = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    const key = dayKey(e.at);
    if (!key) continue;
    const n = clampCups(e[d.field], d.max);
    if (n === null) continue;
    if (n === 0) { days.delete(key); continue; }
    days.set(key, { key, n, [d.field]: n, litres: Math.round(n * d.cupL * 10) / 10 });
  }
  return days;
}
export const collectWater = (entries, profile = null) => collectCups(entries, "water", profile);
export const collectCoffee = (entries, profile = null) => collectCups(entries, "coffee", profile);

/** "1.5 L" for water, "300 mL" for coffee, in the page's locale. */
export function fmtVolume(n, kind = "water") {
  const litres = n * DRINKS[kind].cupL;
  if (kind === "coffee") return `${Math.round(litres * 1000)} mL`;
  return litres.toLocaleString([], { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " L";
}
export const fmtLitres = (glasses) => fmtVolume(glasses, "water");
