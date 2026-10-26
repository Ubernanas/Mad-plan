// Recipes from the Food.com dataset (Kaggle "Food.com - Recipes and Reviews", CC0).
// scripts/import-recipes.ts filters the raw CSV once into recipes/foodcom.json.gz;
// the Sunday job reads that file. Recipes are in English, and the amounts have no
// units (the dataset lost them), so Claude reads the units from the steps when it
// translates a recipe.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export type Protein = "chicken" | "beef" | "pork" | "fish" | "veg";

export type Recipe = {
  id: number;
  name: string;
  category: string;
  minutes: number;
  /** Missing for some recipes; Claude estimates it from the amounts. */
  servings: number | null;
  rating: number;
  reviews: number;
  ingredients: string[];
  /**
   * Amounts as written ("1 1/2", no unit). They pair with `ingredients` in order only
   * when both lists are equally long; the dataset drops amounts like "salt to taste".
   */
  amounts: string[];
  steps: string[];
  proteins: Protein[];
  /** Ingredients that usually contain gluten or lactose, so Claude knows what to swap. */
  gluten: string[];
  dairy: string[];
};

export const RECIPES_FILE = join(import.meta.dirname, "..", "recipes", "foodcom.json.gz");

export function loadRecipes(file = RECIPES_FILE): Recipe[] {
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Recipe[];
}

// ---------- Reading the raw CSV ----------

/** The dataset stores lists as R vectors: c("a", "b"), a lone "a", or NA. */
export function parseRVector(value: string | undefined): string[] {
  const text = (value ?? "").trim();
  if (!text || text === "NA" || text === "character(0)") return [];
  if (!text.startsWith("c(")) return [decodeHtml(text.replace(/^"|"$/g, ""))];
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => decodeHtml(m[1]!.replace(/\\"/g, '"').trim()));
}

/** Food.com text has HTML entities: "Chicken &amp; Rice". */
export function decodeHtml(text: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(#\d+|[a-z]+);/g, (whole, code: string) =>
    code.startsWith("#") ? String.fromCharCode(Number(code.slice(1))) : (named[code] ?? whole));
}

/** "PT1H30M" → 90. */
export function minutesOf(iso: string | undefined): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/** Broth, sauces and soup bases mention a meat or fish without being the dish's protein. */
const NOT_PROTEIN = /broth|stock|bouillon|soup|base|gravy|seasoning|flavor|fat|drippings|sauce|paste/;
const PROTEIN_WORDS: [Protein, RegExp][] = [
  ["chicken", /\bchicken\b|\bturkey\b/],
  ["beef", /\bbeef\b|\bsteak|\bsirloin|\bchuck\b|\bhamburger\b|\bground (?:round|meat)\b|\bmeatloaf mix\b/],
  ["pork", /\bpork\b|\bbacon\b|\bham\b|\bsausage|\bchorizo\b|\bpancetta\b/],
  ["fish", /\bsalmon\b|\bcod\b|\btilapia\b|\bfish\b|\btuna\b|\bshrimp|\bprawn|\bhaddock\b|\bpollock\b|\bcrab|\blobster|\bscallop|\bmussel|\bclam/],
  ["veg", /\bbeans?\b|\blentils?\b|\bchickpeas?\b|\bgarbanzo|\btofu\b|\beggs?\b/],
];

export function proteinsOf(names: string[]): Protein[] {
  const found = new Set<Protein>();
  for (const raw of names) {
    const name = raw.toLowerCase();
    if (NOT_PROTEIN.test(name)) continue;
    for (const [protein, re] of PROTEIN_WORDS) if (re.test(name)) found.add(protein);
  }
  // Eggs or beans next to meat or fish are a side, not the protein.
  if (found.size > 1) found.delete("veg");
  return [...found];
}

const GLUTEN = /flour|bread|crumb|panko|pasta|spaghetti|noodle|macaroni|lasagna|penne|tortilla|pita|\bbuns?\b|\brolls?\b|cracker|soy sauce|teriyaki|\bbeer\b|couscous|barley|bisquick|biscuit|stuffing|pie crust|pastry|cream of/;
const DAIRY = /(?<!coconut |almond |soy )milk|cream(?! of tartar)|(?<!peanut |apple )butter(?!nut)|cheese|parmesan|mozzarella|cheddar|feta|ricotta|yogurt|yoghurt|ghee/;

export const glutenIn = (names: string[]) => names.filter((n) => GLUTEN.test(n.toLowerCase()));
export const dairyIn = (names: string[]) => names.filter((n) => DAIRY.test(n.toLowerCase()));

/** Recipes in these categories are mostly sides. As keywords they also tag mains, so only the category counts. */
const SIDES = new Set(["Vegetable", "Potato", "Corn", "Greens", "Onions", "Spinach", "Yam/Sweet Potato", "Cauliflower", "Black Beans"]);

/** Food.com categories and keywords that are never a dinner. */
const NOT_DINNER = new Set([
  "Dessert", "Breads", "Quick Breads", "Yeast Breads", "Beverages", "Breakfast", "Drop Cookies", "Bar Cookie",
  "Pie", "Candy", "Smoothies", "Cheesecake", "Frozen Desserts", "Scones", "Punch Beverage", "Sauces",
  "Salad Dressings", "Spreads", "Lunch/Snacks", "Fruit", "Apple", "Shakes", "Gelatin", "Jellies", "Lemon Cake",
  "Chocolate Chip Cookies", "Coconut Cream Pie", "Tarts", "Sourdough Breads", "Bread Machine", "Brunch",
]);

/** Names of things that come with a dinner rather than being one: marinades, dips, sides, sauces. */
const NOT_A_MEAL = /marinade|\brub\b|\bdips?\b|dressing|hummus|deviled|guacamole|spread|seasoning|refried|potato salad|broccoli salad|pasta salad|coleslaw|\bslaw\b|appetizer|pickled|jerky|\bbrine\b|\bsauce$|\bglaze$|\bgravy$|stuffing/i;

export const LIMITS = { minRating: 4.5, minReviews: 10, maxMinutes: 75, minIngredients: 4, maxIngredients: 16, maxSteps: 14 };

/** One raw CSV row → a recipe worth suggesting for dinner, or null. */
export function toRecipe(row: Record<string, string>, limits = LIMITS): Recipe | null {
  const rating = Number(row.AggregatedRating);
  const reviews = Number(row.ReviewCount);
  if (!(rating >= limits.minRating) || !(reviews >= limits.minReviews)) return null;

  const keywords = parseRVector(row.Keywords);
  const category = row.RecipeCategory ?? "";
  if (SIDES.has(category) || NOT_DINNER.has(category) || keywords.some((k) => NOT_DINNER.has(k))) return null;

  const minutes = minutesOf(row.TotalTime);
  if (minutes === null || minutes <= 0 || minutes > limits.maxMinutes) return null;

  // Big batches (party food, freezer cooking) are not a dinner for a household.
  const servings = row.RecipeServings === "NA" ? null : Number(row.RecipeServings);
  if (servings !== null && (!Number.isInteger(servings) || servings < 1 || servings > 12)) return null;

  const names = parseRVector(row.RecipeIngredientParts);
  if (names.length < limits.minIngredients || names.length > limits.maxIngredients) return null;

  const steps = parseRVector(row.RecipeInstructions);
  if (steps.length < 2 || steps.length > limits.maxSteps || steps.some((s) => s.length > 700)) return null;

  // The ingredient list sometimes lacks the meat that the name promises ("Chicken-Fried Steak").
  const name = decodeHtml(row.Name!.trim());
  if (NOT_A_MEAL.test(name)) return null;
  let proteins = proteinsOf(names);
  if (!proteins.length || (proteins.length === 1 && proteins[0] === "veg")) proteins = proteinsOf([...names, name]);
  if (!proteins.length) return null;

  return {
    id: Number(row.RecipeId),
    name,
    category,
    minutes,
    servings,
    rating,
    reviews,
    ingredients: names,
    amounts: parseRVector(row.RecipeIngredientQuantities).map((q) => (q === "NA" ? "" : q)),
    steps,
    proteins,
    gluten: glutenIn(names),
    dairy: dairyIn(names),
  };
}
