import assert from "node:assert/strict";
import { test } from "node:test";
import { dairyIn, decodeHtml, glutenIn, minutesOf, parseRVector, proteinsOf, toRecipe } from "./recipes.ts";

test("R vectors from the dataset become lists", () => {
  assert.deepEqual(parseRVector('c("1/4", "2", "NA")'), ["1/4", "2", "NA"]);
  assert.deepEqual(parseRVector('c("Say \\"cheese\\"", "Bake")'), ['Say "cheese"', "Bake"]);
  assert.deepEqual(parseRVector('"Stir well."'), ["Stir well."]);
  assert.deepEqual(parseRVector("NA"), []);
  assert.deepEqual(parseRVector("character(0)"), []);
  assert.deepEqual(parseRVector(undefined), []);
  assert.deepEqual(parseRVector('c("Chicken &amp; rice")'), ["Chicken & rice"]);
});

test("HTML entities are decoded", () => {
  assert.equal(decodeHtml("Mac &amp; Cheese &quot;Deluxe&quot; &#39;n&#39; more"), `Mac & Cheese "Deluxe" 'n' more`);
  assert.equal(decodeHtml("&unknown;"), "&unknown;");
});

test("durations in ISO form become minutes", () => {
  assert.equal(minutesOf("PT1H30M"), 90);
  assert.equal(minutesOf("PT45M"), 45);
  assert.equal(minutesOf("PT2H"), 120);
  assert.equal(minutesOf("PT"), null);
  assert.equal(minutesOf("NA"), null);
});

test("the protein comes from the ingredients, not from broth", () => {
  assert.deepEqual(proteinsOf(["chicken breasts", "rice"]), ["chicken"]);
  assert.deepEqual(proteinsOf(["chicken broth", "lentils"]), ["veg"]);
  assert.deepEqual(proteinsOf(["lean ground beef", "eggs"]), ["beef"]);
  assert.deepEqual(proteinsOf(["ground turkey", "kidney beans"]), ["chicken"]);
  assert.deepEqual(proteinsOf(["salmon fillets", "bacon"]).sort(), ["fish", "pork"]);
  assert.deepEqual(proteinsOf(["potatoes", "onion"]), []);
});

test("gluten and dairy are flagged, without false alarms for coconut milk or peanut butter", () => {
  assert.deepEqual(glutenIn(["soy sauce", "flour", "rice"]), ["soy sauce", "flour"]);
  assert.deepEqual(dairyIn(["coconut milk", "peanut butter", "butter", "heavy cream", "cheddar cheese"]), ["butter", "heavy cream", "cheddar cheese"]);
});

const row = (over: Record<string, string> = {}): Record<string, string> => ({
  RecipeId: "68955",
  Name: "Japanese Mum&#39;s Chicken",
  RecipeCategory: "Chicken Thigh & Leg",
  Keywords: 'c("Chicken", "Asian")',
  TotalTime: "PT45M",
  RecipeServings: "4",
  AggregatedRating: "5",
  ReviewCount: "973",
  RecipeIngredientQuantities: 'c("8", "1", "1/2", "1/3")',
  RecipeIngredientParts: 'c("chicken drumsticks", "water", "soy sauce", "sugar")',
  RecipeInstructions: 'c("Simmer everything for 20 minutes.", "Reduce to a sticky glaze.")',
  ...over,
});

test("a well-rated dinner is kept, with what Claude needs", () => {
  assert.deepEqual(toRecipe(row()), {
    id: 68955,
    kind: "main",
    name: "Japanese Mum's Chicken",
    category: "Chicken Thigh & Leg",
    minutes: 45,
    servings: 4,
    rating: 5,
    reviews: 973,
    ingredients: ["chicken drumsticks", "water", "soy sauce", "sugar"],
    amounts: ["8", "1", "1/2", "1/3"],
    steps: ["Simmer everything for 20 minutes.", "Reduce to a sticky glaze."],
    proteins: ["chicken"],
    gluten: ["soy sauce"],
    dairy: [],
  });
});

test("amounts that don't pair with the ingredients, and missing servings, are kept as they are", () => {
  const recipe = toRecipe(row({ RecipeIngredientQuantities: 'c("8", "1/2")', RecipeServings: "NA" }));
  assert.deepEqual(recipe?.amounts, ["8", "1/2"]);
  assert.equal(recipe?.servings, null);
});

test("the meat in the name counts when the ingredients only show eggs, unless the name says vegetarian", () => {
  const recipe = toRecipe(row({ Name: "Chicken-Fried Steak", RecipeIngredientParts: 'c("eggs", "flour", "milk", "salt")' }));
  assert.deepEqual(recipe?.proteins.sort(), ["beef", "chicken"]);
  const chickpeas = toRecipe(row({ Name: "Very Quick Butter Chickpeas (Vegetarian Butter Chicken!)", RecipeIngredientParts: 'c("chickpeas", "onion", "curry powder", "potatoes")' }));
  assert.deepEqual(chickpeas?.proteins, ["veg"]);
});

test("recipes that are neither a dinner nor a side, too slow, or with too few reviews are left out", () => {
  const rejects: Record<string, string>[] = [
    row({ AggregatedRating: "4" }),
    row({ ReviewCount: "9" }),
    row({ RecipeCategory: "Dessert" }),
    row({ Keywords: 'c("Breakfast")' }),
    row({ TotalTime: "PT4H" }),
    row({ TotalTime: "NA" }),
    row({ RecipeServings: "24" }),
    row({ RecipeIngredientParts: 'c("chicken", "salt")' }),
    row({ RecipeInstructions: 'c("Mix it all.")' }),
    row({ Name: "Garlic Bread", RecipeIngredientParts: 'c("bread", "garlic", "salt", "butter")' }),
    row({ Name: "Amazing Chicken Marinade" }),
    row({ Name: "Deviled Eggs" }),
    row({ Name: "Creamy Potato Soup", RecipeCategory: "Potato", RecipeIngredientParts: 'c("potatoes", "milk", "onion")' }),
    row({ Name: "Easy Bourbon BBQ Sauce" }),
  ];
  for (const r of rejects) assert.equal(toRecipe(r), null, JSON.stringify(r));
});

test("Potato as a keyword does not hide a main course", () => {
  assert.ok(toRecipe(row({ Keywords: 'c("Potato", "Meat")' })));
});

test("a dish with a sauce in the middle of its name is still a dinner, and crab is fish", () => {
  assert.ok(toRecipe(row({ Name: "Chicken in Garlic Sauce with Rice" })));
  assert.deepEqual(proteinsOf(["lump crabmeat", "eggs"]), ["fish"]);
});

test("sides are kept: potatoes, rice and salads without meat, bacon in a potato salad allowed", () => {
  const side = (over: Record<string, string>) => toRecipe(row({ RecipeCategory: "Potato", RecipeInstructions: 'c("Boil and toss.")', ...over }));
  assert.equal(side({ Name: "Greek Lemon Potatoes", RecipeIngredientParts: 'c("potatoes", "lemon", "olive oil", "oregano")' })?.kind, "side");
  assert.equal(side({ Name: "Plain Rice", RecipeCategory: "White Rice", RecipeIngredientParts: 'c("rice", "water")' })?.kind, "side");
  assert.equal(side({ Name: "Authentic German Potato Salad", RecipeIngredientParts: 'c("potatoes", "bacon", "vinegar", "onion")' })?.kind, "side");
  // Sausage and potatoes is a dinner, and a one-step main is too thin to follow.
  assert.equal(side({ Name: "Sausage, Peppers, and Potatoes", RecipeIngredientParts: 'c("smoked sausage", "potatoes", "peppers", "onion")', RecipeInstructions: 'c("Fry.", "Serve.")' })?.kind, "main");
  assert.equal(side({ Name: "Sausage and Potatoes", RecipeIngredientParts: 'c("smoked sausage", "potatoes", "peppers", "onion")' }), null);
});
