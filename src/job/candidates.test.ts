import assert from "node:assert/strict";
import { test } from "node:test";
import { loadIngredientRules } from "../config.ts";
import type { Protein, Recipe } from "../recipes.ts";
import { isDinner, kitchenStock, queriesOf, ruleFor, selectMains, selectSides } from "./candidates.ts";
import { portionCost, priceIndex } from "./cost.ts";

const rules = loadIngredientRules();
const glutenAndLactoseFree = { glutenFree: true, lactoseFree: true, other: "" };
const noDiet = { glutenFree: false, lactoseFree: false, other: "" };

const buys = (ingredient: string) => {
  const rule = ruleFor(ingredient, rules);
  return rule?.basis ? "basis" : (rule?.query ?? null);
};

test("the word table buys the right thing, also where words overlap", () => {
  const cases: [string, string | null][] = [
    ["boneless skinless chicken breasts", "kylling"],
    ["chicken broth", "bouillon"],
    ["cream of mushroom soup", "fløde"],
    ["egg noodles", "nudler"],
    ["eggs", "æg"],
    ["corn tortillas", "majstortillas"],
    ["cornstarch", "maizena"],
    ["thai red curry paste", "rød-karry"],
    ["green curry paste", "karry"],
    ["curry powder", "basis"],
    ["leeks", "porrer"],
    ["black beans", "bønner"],
    ["soy sauce", "soyasauce"],
    ["frozen corn", "majs"],
    ["red pepper flakes", "basis"],
    ["red bell pepper", "peberfrugt"],
    ["fresh ground black pepper", "basis"],
    ["garlic powder", "basis"],
    ["garlic cloves", "hvidløg"],
    ["olive oil", "basis"],
    ["black olives", "oliven"],
    ["rice vinegar", "basis"],
    ["coconut milk", "kokosmælk"],
    ["milk", "mælk"],
    ["peanut butter", "peanutbutter"],
    ["butter", "smør"],
    ["sour cream", "creme-fraiche"],
    ["green onions", "forårsløg"],
    ["onions", "løg"],
    ["tomato paste", "tomatpure"],
    ["diced tomatoes", "hakkede-tomater"],
    ["tomatoes", "tomater"],
    ["ground beef", "hakket-oksekød"],
    ["sirloin steak", "oksekød"],
    ["hamburger", "hakket-oksekød"],
    ["hamburger buns", "burgerboller"],
    ["french bread", "brød"],
    ["bread crumbs", "rasp"],
    ["tahini", null],
  ];
  for (const [ingredient, expected] of cases) assert.equal(buys(ingredient), expected, ingredient);
});

test("the diet picks the gluten- or lactose-free variant", () => {
  const recipe = { ingredients: ["spaghetti", "heavy cream", "flour", "salt"] } as Recipe;
  assert.deepEqual(queriesOf(recipe, rules, { diet: glutenAndLactoseFree }), ["glutenfri-pasta", "laktosefri-fløde", "glutenfri-mel"]);
  assert.deepEqual(queriesOf(recipe, rules, { diet: noDiet }), ["pasta", "fløde", "hvedemel"]);
  // Goma has no page for the variant: the plain word's page lists it too.
  assert.deepEqual(queriesOf(recipe, rules, { diet: glutenAndLactoseFree, failed: new Set(["glutenfri-pasta", "laktosefri-fløde"]) }), ["pasta", "fløde", "glutenfri-mel"]);
});

test("the household's own swap comes before the diet variant: coconut milk for cream", () => {
  const recipe = { ingredients: ["heavy cream", "half-and-half", "chicken"] } as Recipe;
  assert.deepEqual(queriesOf(recipe, rules, { diet: glutenAndLactoseFree, substitutes: { fløde: "kokosmælk" } }), ["kokosmælk", "kylling"]);
});

test("the kitchen as search words: ticked products by their search word, text and names by name", () => {
  const known = ["ris", "løg", "hakket-oksekød", "kylling", "fløde", "kokosmælk"];
  const stock = kitchenStock([
    { name: "(dp) netto hk. okse 8-12%", query: "hakket-oksekød", location: "køl", expires: "2026-11-01" },
    { name: "Basmatiris", query: null, location: "skab", expires: null },
    { name: "Kyllingebryst", query: "kylling", location: "køl", expires: "2026-11-20" },
  ], "", known, "2026-10-30");
  assert.deepEqual([...stock], [["hakket-oksekød", true], ["ris", false], ["kylling", false]]);
  assert.deepEqual([...kitchenStock([], "2 løg, en halv pose ris og en dåse kokosmælk", known, "2026-10-30").keys()], ["ris", "løg", "kokosmælk"]);
});

let nextId = 1;
function recipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: nextId++, kind: "main", name: `Ret ${nextId}`, category: "One Dish Meal", minutes: 30, servings: 4, rating: 5, reviews: 50,
    ingredients: ["chicken breasts", "onion", "garlic", "rice", "salt"], amounts: ["2", "1", "2", "1", ""],
    steps: ["Cook.", "Serve."], proteins: ["chicken"], gluten: [], dairy: [], ...over,
  };
}

const flat = () => 0;
const options = (over = {}) => ({ diet: noDiet, recent: new Set<number>(), count: 10, seed: "2026-W45", cost: flat, ...over });

test("mains leave out recent dishes and too many diet swaps, but never unpriced or unknown ingredients", () => {
  const recent = recipe();
  const glutenHeavy = recipe({ gluten: ["flour", "breadcrumbs", "soy sauce"] });
  const strange = recipe({ ingredients: ["chicken", "tahini", "za'atar", "sumac", "salt"] });
  const side = recipe({ kind: "side" });
  const chosen = selectMains([recent, glutenHeavy, strange, side], options({
    recent: new Set([recent.id]), diet: glutenAndLactoseFree,
  }));
  assert.deepEqual(chosen.map((r) => r.id), [strange.id]);
  // Without the diet, gluten is no reason to leave a dish out.
  assert.ok(selectMains([glutenHeavy], options()).length === 1);
});

test("sides: the best of each kind, at most 4 per category, so the pairings vary", () => {
  const potatoes = Array.from({ length: 10 }, () => recipe({ kind: "side", category: "Potato", reviews: 500 }));
  const salads = Array.from({ length: 3 }, () => recipe({ kind: "side", category: "Greens", reviews: 20 }));
  const chosen = selectSides([...potatoes, ...salads, recipe()], options({ count: 10 }));
  assert.equal(chosen.filter((r) => r.category === "Potato").length, 4);
  assert.equal(chosen.filter((r) => r.category === "Greens").length, 3);
  assert.ok(chosen.every((r) => r.kind === "side"));
});

test("the cheapest mains come first, but every protein gets a few", () => {
  const pool = (["chicken", "beef", "pork", "fish", "veg"] as Protein[]).flatMap((p) =>
    Array.from({ length: 20 }, () => recipe({ proteins: [p], ...(p === "veg" ? { ingredients: ["black beans", "rice"] } : {}) })));
  const price: Record<Protein, number> = { pork: 10, chicken: 20, veg: 25, beef: 40, fish: 50 };
  const chosen = selectMains(pool, options({ count: 20, cost: (r: Recipe) => price[r.proteins[0]!] }));
  const count = (p: Protein) => chosen.filter((r) => r.proteins[0] === p).length;
  assert.equal(chosen.length, 20);
  assert.ok(count("pork") >= 8, `pork ${count("pork")}`);
  for (const p of ["chicken", "beef", "fish", "veg"] as Protein[]) assert.ok(count(p) >= 3, p);
  // Cheapest first.
  assert.equal(chosen[0]!.proteins[0], "pork");
});

test("the same week gives the same candidates; another week mixes them differently", () => {
  const pool = Array.from({ length: 60 }, () => recipe());
  const ids = (seed: string) => selectMains(pool, options({ seed })).map((r) => r.id).join();
  assert.equal(ids("2026-W45"), ids("2026-W45"));
  assert.notEqual(ids("2026-W45"), ids("2026-W46"));
});

const product = (price: number, packageAmount: number, unit: "g" | "ml" | "stk" = "g") => ({ price, packageAmount, unit });

test("the price index keeps the cheapest price per unit for each search word", () => {
  const index = priceIndex([
    { query: "kylling", product: product(49, 650) },
    { query: "kylling", product: product(25, 400) },
    { query: "agurk", product: product(10, 1, "stk") },
    { query: "løg", product: { price: 7, packageAmount: null, unit: null } },
  ]);
  assert.equal(index.get("kylling")!.perUnit, 25 / 400);
  assert.deepEqual(index.get("agurk"), { perUnit: 10, unit: "stk" });
  assert.equal(index.has("løg"), false);
});

test("a portion costs a typical amount of each ingredient: meat matters most, basis items nothing", () => {
  const prices = priceIndex([
    { query: "kylling", product: product(60, 1000) },
    { query: "hakket-oksekød", product: product(100, 1000) },
    { query: "ris", product: product(10, 1000) },
    { query: "løg", product: product(5, 1000) },
  ]);
  const cost = (ingredients: string[], over: Partial<Recipe> = {}, stock?: Map<string, boolean>) =>
    portionCost(recipe({ ingredients, ...over }), { rules, buying: { diet: noDiet }, prices, stock });
  // 500 g chicken (30 kr), 150 g rice (1.50), 250 g onion (1.25), salt free: 32.75 kr / 4.
  assert.equal(cost(["chicken breasts", "rice", "onion", "salt"]), 8.19);
  assert.ok(cost(["ground beef", "rice", "onion", "salt"]) > cost(["chicken breasts", "rice", "onion", "salt"]));
  // Without a price this week it is a guess, not a reason to leave the dish out.
  assert.equal(cost(["chicken breasts", "lime"]), (30 + 10) / 4);
  // Two lines for the same item count once; servings divide.
  assert.equal(cost(["chicken thighs", "chicken breasts"], { servings: 2 }), 15);
  // The kitchen's items are free, and those about to expire pull the price down.
  assert.equal(cost(["chicken breasts", "rice"], {}, new Map([["kylling", false]])), 0.38);
  assert.equal(cost(["chicken breasts", "rice"], {}, new Map([["kylling", true]])), 0);
  // A recipe that lists only the seasoning still needs its meat bought.
  assert.equal(cost(["salt", "dried thyme", "olive oil"], { proteins: ["chicken"] }), 7.5);
  // Nothing to buy and no meat: not food.
  assert.equal(cost(["salt", "white vinegar"], { proteins: [] }), Infinity);
});

test("only dinners: no cakes or doughs, and a vegetarian main needs beans, lentils or tofu", () => {
  const lentils = recipe({ name: "Turkish Red Lentil Soup", proteins: ["veg"], ingredients: ["red lentils", "onion"] });
  const eggs = recipe({ name: "Fried Eggs With Dill", proteins: ["veg"], ingredients: ["eggs", "dill"] });
  const cake = recipe({ name: "Death by Chocolate Cake", proteins: ["veg"], ingredients: ["eggs", "kidney beans"] });
  const chicken = recipe({ name: "Chicken Souvlaki" });
  const fries = recipe({ kind: "side", name: "Pub Fries", proteins: [], ingredients: ["potatoes", "oil"] });
  assert.deepEqual([lentils, eggs, cake, chicken, fries].filter(isDinner), [lentils, chicken, fries]);
  assert.deepEqual(selectMains([eggs, lentils, cake], options()), [lentils]);
});
