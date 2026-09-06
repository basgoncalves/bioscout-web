/**
 * foods.js -- the arithmetic between grams and calories.
 *
 * The failure that matters here is a total that looks whole but is not. A meal
 * of four items where one has no known density must not report the other three
 * as "the meal", because the number lands next to a training log and gets
 * compared across days.
 *
 *   node test_foods.mjs
 */
import { DEFAULT_FOODS, itemKcal, mealKcal, densityFor, foodNames, describe }
  from "./foods.js";

let bad = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  [${cond ? "OK  " : "FAIL"}] ${label}${detail ? "  " + detail : ""}`);
  if (!cond) bad++;
};

/* ---- one item ---------------------------------------------------------- */

ok(itemKcal({ grams: 100, kcal100: 379 }) === 379, "100 g is the density itself");
ok(itemKcal({ grams: 80, kcal100: 379 }) === 303, "80 g of oats", String(itemKcal({ grams: 80, kcal100: 379 })));
ok(itemKcal({ grams: 250, kcal100: 50 }) === 125, "250 g of milk");
ok(itemKcal({ grams: 0, kcal100: 379 }) === null, "zero grams is not zero calories, it is no answer");
ok(itemKcal({ grams: 80 }) === null, "no density, no number");
// The one that bit: stored items carry kcal100: null explicitly, and
// Number(null) is 0, which turned an unknown food into a free one.
ok(itemKcal({ grams: 300, kcal100: null }) === null,
   "an explicitly null density is unknown, not zero", String(itemKcal({ grams: 300, kcal100: null })));
ok(itemKcal({ grams: 300, kcal100: "" }) === null, "and so is an empty box");
ok(itemKcal({ grams: null, kcal100: 379 }) === null, "a null weight is unknown, not zero");
ok(itemKcal({ grams: "abc", kcal100: 100 }) === null, "a typo is not an amount");
ok(itemKcal({ grams: 100, kcal100: 0 }) === 0, "a genuinely zero-energy food is 0, not null");

/* ---- a meal ------------------------------------------------------------ */
{
  const full = mealKcal([
    { name: "Oats", grams: 80, kcal100: 379 },
    { name: "Milk, semi-skimmed", grams: 200, kcal100: 50 },
  ]);
  ok(full.kcal === 403 && full.complete, "a complete meal totals its items", String(full.kcal));

  // The one that matters: one item nobody has a density for.
  const partial = mealKcal([
    { name: "Oats", grams: 80, kcal100: 379 },
    { name: "Grandma's stew", grams: 300, kcal100: null },
  ]);
  ok(partial.kcal === 303, "a partial meal still totals what it can", String(partial.kcal));
  ok(partial.complete === false, "but it does not claim to be the whole meal");
  ok(partial.counted === 1 && partial.items === 2,
     "and it says how many items it covered", `${partial.counted}/${partial.items}`);

  const none = mealKcal([{ name: "Something", grams: 100 }]);
  ok(none.kcal === null, "nothing known at all is null, not zero");
  ok(mealKcal([]).kcal === null && mealKcal([]).complete === false, "an empty meal is empty");
  ok(mealKcal(null).kcal === null, "no items is not a throw");
}

/* ---- densities --------------------------------------------------------- */

ok(densityFor("Oats") === DEFAULT_FOODS["Oats"], "a built-in food is found");
ok(densityFor("oats") === DEFAULT_FOODS["Oats"], "and case does not matter");
ok(densityFor("  Oats  ") === DEFAULT_FOODS["Oats"], "nor does stray whitespace");
ok(densityFor("Nothing at all") === null, "an unknown food has no density, rather than a default");
ok(densityFor("", {}) === null, "an empty name is not a food");

{
  // A personal figure off a packet beats a generic one, which is the whole
  // reason for letting people add foods.
  const custom = { "Oats": 362, "My cereal": 410 };
  ok(densityFor("Oats", custom) === 362, "the athlete's own value wins");
  ok(densityFor("My cereal", custom) === 410, "and their own foods are found");
  ok(densityFor("oats", custom) === 362, "case-insensitively too");

  const names = foodNames(custom);
  ok(names.includes("My cereal") && names.includes("Oats"), "the picker offers both");
  ok(names.length === new Set(names).size, "with no duplicates where they overlap");
}

/* ---- description ------------------------------------------------------- */

ok(describe([{ name: "Oats", grams: 80 }, { name: "Milk", grams: 200 }]) === "Oats 80 g · Milk 200 g",
   "a meal reads as what was eaten and how much",
   describe([{ name: "Oats", grams: 80 }, { name: "Milk", grams: 200 }]));
ok(describe([{ name: "Coffee" }]) === "Coffee", "an item with no weight still names itself");
ok(describe([]) === "", "nothing is nothing");

console.log(bad ? `\nFAIL  ${bad} check(s)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
