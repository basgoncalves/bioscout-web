/**
 * water.js -- glasses of water, one count per day.
 *
 * Counted in glasses rather than typed in litres because that is how anyone
 * actually keeps track: nobody measures, they notice they have had another
 * glass. A glass is 0.5 L, and the day shows ten of them (5 L), which covers
 * any ordinary day with room to spare -- the row is a tally, not a target.
 *
 * Like sleep and vitals it does not carry forward: yesterday's six glasses
 * say nothing about today.
 */
import { dayKey } from "./vitals.js";

export const GLASS_L = 0.5;
export const GLASSES = 10;

/** A glass count as it may be stored: a whole number from 0 to GLASSES, or
 *  null for anything that is not one. */
export function clampGlasses(n) {
  if (n === null || n === undefined || n === "") return null;
  const v = Math.round(+n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(GLASSES, v));
}

/** One athlete's days. A later entry for the same day wins -- the count is
 *  overwritten on every tap, so the last write is the count. Zero-glass days
 *  are dropped: a day someone tapped + then - again drank nothing we know of. */
export function collectWater(entries, profile = null) {
  const days = new Map();
  for (const e of entries || []) {
    if (profile && e.profile !== profile) continue;
    const key = dayKey(e.at);
    if (!key) continue;
    const glasses = clampGlasses(e.glasses);
    if (glasses === null) continue;
    if (glasses === 0) { days.delete(key); continue; }
    days.set(key, { key, glasses, litres: glasses * GLASS_L });
  }
  return days;
}

/** "1.5 L" in the page's locale ("1,5 L" in German and Portuguese). */
export function fmtLitres(glasses) {
  return (glasses * GLASS_L).toLocaleString([], { minimumFractionDigits: 1,
                                                  maximumFractionDigits: 1 }) + " L";
}
