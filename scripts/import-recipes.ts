// Filters the Food.com dataset once into recipes/foodcom.json.gz:
//   npm run import-recipes [-- path/to/recipes.csv]
// Download recipes.csv from Kaggle ("Food.com - Recipes and Reviews", irkaal) into datasets/.

import { parse } from "csv-parse";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { RECIPES_FILE, toRecipe, type Recipe } from "../src/recipes.ts";

const input = process.argv[2] ?? "datasets/recipes.csv";
const rows = createReadStream(input).pipe(parse({ columns: true, relax_quotes: true }));

// Food.com has many near-copies of popular dishes; keep the one most people reviewed.
const byName = new Map<string, Recipe>();
let read = 0;
for await (const row of rows) {
  read++;
  const recipe = toRecipe(row as Record<string, string>);
  if (!recipe) continue;
  const key = recipe.name.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const seen = byName.get(key);
  if (!seen || recipe.reviews > seen.reviews) byName.set(key, recipe);
}

const recipes = [...byName.values()].sort((a, b) => b.reviews - a.reviews);
mkdirSync(dirname(RECIPES_FILE), { recursive: true });
const gz = gzipSync(JSON.stringify(recipes), { level: 9 });
writeFileSync(RECIPES_FILE, gz);

const count = (p: string) => recipes.filter((r) => r.proteins.includes(p as Recipe["proteins"][number])).length;
console.log(`Læst: ${read} opskrifter. Gemt: ${recipes.length} (${(gz.length / 1e6).toFixed(1)} MB).`);
console.log(`Kylling ${count("chicken")}, okse ${count("beef")}, svin ${count("pork")}, fisk ${count("fish")}, vegetar ${count("veg")}.`);
console.log(`Uden gluten-ingredienser: ${recipes.filter((r) => !r.gluten.length).length}. Uden mælk: ${recipes.filter((r) => !r.dairy.length).length}. Uden begge: ${recipes.filter((r) => !r.gluten.length && !r.dairy.length).length}.`);
