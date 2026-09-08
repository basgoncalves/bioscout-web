/**
 * foods.js -- grams in, calories out.
 *
 * A meal is a list of items, each a name, a weight in grams, and an energy
 * density in kcal per 100 g. The calorie figure is then arithmetic rather than
 * a guess typed into a box, which is the point: people are poor at estimating
 * the energy in a plate of food and good at reading a number off a packet.
 *
 * What this is NOT is a food database. A real one is tens of thousands of
 * branded entries, updated constantly, and served from somewhere -- none of
 * which fits an app that ships as static files and talks to no server. The
 * table below is a few dozen generic staples at approximate values, meant as a
 * starting point you correct. Anything you add is saved with your profile,
 * with the density you gave it, and takes precedence over the built-in figure.
 *
 * So every number here is approximate by construction, and the UI says so.
 * Presenting "2,140 kcal" from generic densities as though it were measured
 * would be the same class of error as the app reporting a joint moment from a
 * body mass nobody checked.
 */

/** kcal per 100 g. Generic, uncooked unless noted, rounded. */
export const DEFAULT_FOODS = {
  "Oats": 379, "Rice, cooked": 130, "Pasta, cooked": 158, "Bread, white": 265,
  "Bread, wholemeal": 247, "Potato, boiled": 87, "Sweet potato": 86,
  "Banana": 89, "Apple": 52, "Orange": 47, "Berries": 50,
  "Milk, semi-skimmed": 50, "Milk, whole": 61, "Yoghurt, plain": 61,
  "Yoghurt, Greek": 97, "Cheese, cheddar": 402, "Egg": 143,
  "Chicken breast": 165, "Beef mince": 254, "Pork": 242, "Salmon": 208,
  "Tuna, canned": 116, "Tofu": 76, "Lentils, cooked": 116,
  "Chickpeas, cooked": 164, "Beans, cooked": 132, "Almonds": 579,
  "Peanut butter": 588, "Olive oil": 884, "Butter": 717, "Sugar": 387,
  "Honey": 304, "Chocolate, dark": 546, "Pancakes": 227, "Protein powder": 375,
};

/**
 * A meal item's amount is entered in whichever unit is convenient -- grams or
 * millilitres for most things, kilograms or litres for a bag or a bottle,
 * "units" for something counted rather than weighed (an egg, a protein bar).
 * Every density above is kcal per 100 g, so the amount has to become grams
 * before itemKcal can use it.
 *
 * "units" has no fixed weight -- an egg and a protein bar are not the same
 * mass -- so it does not convert. An item logged in units stays uncounted for
 * calories, exactly like a food itemKcal has never heard of: honest, not a
 * guess dressed up as a gram figure.
 */
export const UNITS = ["g", "mL", "Kg", "L", "units"];
const UNIT_TO_GRAMS = { g: 1, mL: 1, Kg: 1000, L: 1000, units: null };

/** The amount, converted to grams -- or null when the unit does not convert. */
export function toGrams(amount, unit = "g") {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const f = UNIT_TO_GRAMS[unit] ?? 1;
  return f == null ? null : n * f;
}

/** How far the +/- buttons move the on-screen amount, sized to the unit --
 *  Kg and L are already a x1000 scale on g/mL, so a step of 10 there would
 *  jump 10 kg at a tap; "units" moves one at a time. */
export function unitStep(unit = "g") {
  return unit === "Kg" || unit === "L" ? 0.1 : unit === "units" ? 1 : 10;
}

/** Energy of one item, rounded to whole kcal. Nulls anywhere give null. */
export function itemKcal(item) {
  // null and "" both become 0 through Number(), which would turn "we do not
  // know what this food is" into "this food has no calories" -- a wrong total
  // that looks complete. Missing has to be checked before converting.
  if (item?.grams == null || item.grams === "") return null;
  if (item?.kcal100 == null || item.kcal100 === "") return null;
  const g = Number(item.grams);
  const d = Number(item.kcal100);
  if (!Number.isFinite(g) || g <= 0) return null;
  if (!Number.isFinite(d) || d < 0) return null;
  return Math.round((g * d) / 100);
}

/**
 * A meal's total, and whether every item contributed.
 *
 * `complete` is false when an item has no density -- something typed by hand
 * that is not in any table. The total is still returned, because a partial
 * total is useful, but the caller must be able to mark it as partial rather
 * than present it as the whole meal.
 */
export function mealKcal(items) {
  let total = 0, counted = 0;
  for (const it of items || []) {
    const k = itemKcal(it);
    if (k === null) continue;
    total += k; counted++;
  }
  const n = (items || []).length;
  return { kcal: counted ? total : null, counted, items: n, complete: n > 0 && counted === n };
}

/** The density to use for a name: the athlete's own first, then the table. */
export function densityFor(name, custom = {}) {
  const key = String(name || "").trim();
  if (!key) return null;
  if (Number.isFinite(custom[key])) return custom[key];
  if (Number.isFinite(DEFAULT_FOODS[key])) return DEFAULT_FOODS[key];
  // Case-insensitive second pass, so "oats" finds "Oats" rather than silently
  // becoming an unknown food with no energy.
  const lower = key.toLowerCase();
  for (const src of [custom, DEFAULT_FOODS]) {
    for (const k of Object.keys(src)) {
      if (k.toLowerCase() === lower) return src[k];
    }
  }
  return null;
}

/** Every name the picker should offer, the athlete's own first. */
export function foodNames(custom = {}) {
  return [...new Set([...Object.keys(custom), ...Object.keys(DEFAULT_FOODS)])].sort();
}

/**
 * A one-line description of a meal, for the list.
 *
 * Items rather than a free-text name: "Oats 80 g · Milk 200 g" says what was
 * eaten and how much, which is the thing worth keeping.
 */
export function describe(items) {
  return (items || [])
    .map((i) => {
      // Display amount is whatever was typed, in whatever unit was chosen --
      // grams is only the arithmetic's unit, not the label's.
      const amt = i.qty ?? i.grams;
      if (!(Number(amt) > 0)) return i.name;
      const unit = i.unit || "g";
      const n = unit === "Kg" || unit === "L" ? Math.round(amt * 100) / 100 : Math.round(amt);
      return `${i.name} ${n} ${unit}`;
    })
    .join(" · ");
}
