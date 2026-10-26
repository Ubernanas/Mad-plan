import assert from "node:assert/strict";
import { test } from "node:test";
import { loadIngredientRules } from "../config.ts";
import type { GomaProduct } from "../fetch/goma.ts";
import type { Protein, Recipe } from "../recipes.ts";
import { chooseQueries, coverage, offerWeights, queriesOf, ruleFor, selectCandidates } from "./candidates.ts";

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
    ["cornstarch", "majsstivelse"],
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
  const recipe = { ingredients: ["spaghetti", "heavy cream", "soy sauce", "salt"] } as Recipe;
  assert.deepEqual(queriesOf(recipe, rules, glutenAndLactoseFree), ["glutenfri-pasta", "laktosefri-fløde", "tamari"]);
  assert.deepEqual(queriesOf(recipe, rules, noDiet), ["pasta", "fløde", "soja"]);
});

let nextId = 1;
function recipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: nextId++, name: `Ret ${nextId}`, category: "One Dish Meal", minutes: 30, servings: 4, rating: 5, reviews: 50,
    ingredients: ["chicken breasts", "onion", "garlic", "rice", "salt"], amounts: ["2", "1", "2", "1", ""],
    steps: ["Cook.", "Serve."], proteins: ["chicken"], gluten: [], dairy: [], ...over,
  };
}

test("coverage is the share of ingredients the table knows", () => {
  assert.equal(coverage(recipe({ ingredients: ["chicken", "tahini", "salt", "za'atar"] }), rules), 0.5);
});

test("the proteins on offer at the chosen store weigh by their saving", () => {
  const product = (store: string, price: number, normalPrice: number | null, onOffer = true) =>
    ({ store, price, normalPrice, onOffer }) as GomaProduct;
  const weights = offerWeights([
    { query: "kylling", product: product("Netto", 40, 60) },
    { query: "kylling", product: product("Netto", 30, 30) },
    { query: "kylling", product: product("Føtex", 10, 90) },
    { query: "laks", product: product("Netto", 50, 65) },
    { query: "svinekød", product: product("Netto", 20, null) },
  ], "Netto");
  assert.deepEqual(weights, { chicken: 20, beef: 0, pork: 0, fish: 15, veg: 0 });
});

const options = (over = {}) => ({
  weights: { chicken: 0, beef: 0, pork: 0, fish: 0, veg: 0 } as Record<Protein, number>,
  diet: noDiet, recent: new Set<number>(), count: 10, seed: "2026-W45", ...over,
});

test("candidates leave out recent dishes, too many diet swaps and unknown ingredients", () => {
  const recent = recipe();
  const glutenHeavy = recipe({ gluten: ["flour", "breadcrumbs", "soy sauce"] });
  const strange = recipe({ ingredients: ["chicken", "tahini", "za'atar", "sumac", "salt"] });
  const fine = recipe();
  const chosen = selectCandidates([recent, glutenHeavy, strange, fine], rules, options({
    recent: new Set([recent.id]), diet: glutenAndLactoseFree,
  }));
  assert.deepEqual(chosen.map((r) => r.id), [fine.id]);
  // Without the diet, gluten is no reason to leave a dish out.
  assert.ok(selectCandidates([glutenHeavy], rules, options()).length === 1);
});

test("the protein on offer gets most of the candidates, but every protein gets some", () => {
  const pool = (["chicken", "beef", "pork", "fish", "veg"] as Protein[]).flatMap((p) =>
    Array.from({ length: 20 }, () => recipe({ proteins: [p] })));
  const chosen = selectCandidates(pool, rules, options({ count: 20, weights: { chicken: 0, beef: 0, pork: 100, fish: 0, veg: 0 } }));
  const count = (p: Protein) => chosen.filter((r) => r.proteins[0] === p).length;
  assert.equal(chosen.length, 20);
  assert.ok(count("pork") >= 8, `pork ${count("pork")}`);
  for (const p of ["chicken", "beef", "fish", "veg"] as Protein[]) assert.ok(count(p) >= 1, p);
});

test("the same week gives the same candidates; another week mixes them differently", () => {
  const pool = Array.from({ length: 60 }, () => recipe());
  const ids = (seed: string) => selectCandidates(pool, rules, options({ seed })).map((r) => r.id).join();
  assert.equal(ids("2026-W45"), ids("2026-W45"));
  assert.notEqual(ids("2026-W45"), ids("2026-W46"));
});

test("search words: unpriced first, then the most needed, within the budget, never failed ones", () => {
  const candidates = [
    recipe({ ingredients: ["chicken", "carrots", "ginger", "soy sauce"] }),
    recipe({ ingredients: ["chicken", "carrots", "lime"] }),
    recipe({ ingredients: ["pork", "carrots", "lime", "honey"] }),
  ];
  const result = chooseQueries(candidates, rules, {
    diet: noDiet, fixed: ["kylling", "svinekød"], budget: 3, fresh: new Set(["gulerødder"]), failed: new Set(["honning"]),
  });
  // Carrots are needed most but priced from last week, so lime, ginger and soy go first.
  assert.deepEqual(result, { queries: ["lime", "ingefær", "soja"], unfetched: ["gulerødder"] });
  assert.deepEqual(chooseQueries(candidates, rules, {
    diet: noDiet, fixed: [], budget: -2, fresh: new Set(), failed: new Set(),
  }).queries, []);
});
