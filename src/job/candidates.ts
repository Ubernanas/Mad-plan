// Sunday, after REMA's prices are fetched: which recipes Claude gets to choose among.
// All of them are well rated (4.5 stars, 10 reviews); among those, the cheapest per
// portion come first (cost.ts), with some of every protein so the week still varies.
// An ingredient without a price never rules a recipe out; it just counts as a guess.

import type { Household, IngredientRule } from "../config.ts";
import { addDays } from "../kitchen.ts";
import type { Protein, Recipe } from "../recipes.ts";

type Diet = Household["diet"];

/** The search words whose products count as each protein, so a dish keeps its recipe's protein. */
export const PROTEIN_PRODUCTS: Record<Exclude<Protein, "veg">, string[]> = {
  chicken: ["kylling"],
  beef: ["hakket-oksekød", "oksekød"],
  pork: ["svinekød", "hakket-svinekød", "bacon", "skinke", "pølser"],
  fish: ["laks", "torsk", "rejer", "tun"],
};

// ---------- Ingredients → search words ----------

const patterns = new WeakMap<IngredientRule, RegExp>();
function patternOf(rule: IngredientRule): RegExp {
  let re = patterns.get(rule);
  if (!re) {
    const words = rule.words.map((w) => w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    re = new RegExp(`\\b(?:${words.join("|")})(?:s|es)?\\b`);
    patterns.set(rule, re);
  }
  return re;
}

/** The first rule whose words occur in the ingredient, or null if it is unknown. */
export function ruleFor(ingredient: string, rules: IngredientRule[]): IngredientRule | null {
  const name = ingredient.toLowerCase();
  return rules.find((rule) => patternOf(rule).test(name)) ?? null;
}

/** How the household buys: its diet, its own swaps, and the variant pages Goma lacks. */
export type Buying = { diet: Diet; substitutes?: Record<string, string>; failed?: Set<string> };

/**
 * The search word for a rule. The household's own swap comes first ("fløde" → "kokosmælk").
 * Then the gluten- or lactose-free variant when the diet asks for it, unless Goma has no
 * page for the variant; then the plain word, whose page usually lists the variants too.
 */
export function queryFor(rule: IngredientRule, { diet, substitutes = {}, failed = new Set() }: Buying): string | null {
  if (rule.basis) return null;
  if (rule.query && substitutes[rule.query]) return substitutes[rule.query]!;
  const variant = (diet.glutenFree && rule.glutenFree) || (diet.lactoseFree && rule.lactoseFree) || null;
  if (variant && !failed.has(variant)) return variant;
  return rule.query ?? null;
}

/** The search words a recipe needs. Basis items and unknown ingredients need none. */
export function queriesOf(recipe: Recipe, rules: IngredientRule[], buying: Buying): string[] {
  const queries = new Set<string>();
  for (const ingredient of recipe.ingredients) {
    const rule = ruleFor(ingredient, rules);
    const query = rule && queryFor(rule, buying);
    if (query) queries.add(query);
  }
  return [...queries];
}

// ---------- Choosing the candidates ----------

/** A number in [0, 1) that is the same for a recipe all week, so reruns pick the same candidates. */
function jitter(seed: string, id: number): number {
  let hash = 2166136261;
  for (const ch of `${seed}:${id}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return (hash >>> 0) / 2 ** 32;
}

/** What is in the kitchen, as search words; true when it is fresh and about to expire. */
export type KitchenStock = Map<string, boolean>;

/**
 * The search words the kitchen has. Ticked items know their Goma product; items from
 * the Køkken text are matched by name ("basmatiris" is ris, "hakket oksekød" is hakket-oksekød).
 */
export function kitchenStock(
  items: { name: string; query: string | null; location: string; expires: string | null }[],
  text: string,
  known: string[],
  today: string,
): KitchenStock {
  const soon = (expires: string | null) => expires !== null && expires <= addDays(today, 3);
  const stock: KitchenStock = new Map();
  const add = (query: string, fresh: boolean) => stock.set(query, (stock.get(query) ?? false) || fresh);
  for (const item of items) {
    const fresh = item.location === "køl" && soon(item.expires);
    if (item.query) add(item.query, fresh);
    else for (const query of known) if (mentions(item.name, query)) add(query, fresh);
  }
  for (const query of known) if (mentions(text, query)) add(query, false);
  return stock;
}

/** Whether a Danish text names a search word: as a phrase, or as the end of a compound word. */
function mentions(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const words = query.split("-");
  if (words.length > 1) return lower.includes(words.join(" "));
  return lower.split(/[^a-zæøåé]+/).some((w) => w === words[0] || (words[0]!.length >= 3 && w.endsWith(words[0]!)));
}

type CandidateOptions = {
  diet: Diet;
  /** Recipes in the last weeks' plans, so the same dishes don't come back every week. */
  recent: Set<number>;
  count: number;
  /** The plan week: a slightly new mix every week, the same one on a rerun. */
  seed: string;
  /** Estimated kr. per portion (cost.ts), with the kitchen's items free. */
  cost: (recipe: Recipe) => number;
};

/** Many swaps (gluten-free pasta, lactose-free cream …) and the dish is no longer the one people rated. */
export function suitsDiet(r: Recipe, diet: Diet): boolean {
  return (!diet.glutenFree || r.gluten.length <= 2) && (!diet.lactoseFree || r.dairy.length <= 3);
}

/** Not dinner, though the dataset files some of these as mains: cheapest-first would find them all. */
const NOT_DINNER = /\b(cakes?|cookies?|dough|batter|puddings?|mustard|muffins?|frosting|icing|crusts?|brownies?|pancakes?)\b/i;
/** What makes a vegetarian main a dinner rather than fried eggs. */
const VEG_PROTEIN = /\b(beans?|lentils?|chickpeas?|garbanzos?|tofu|tempeh)\b/i;

/** A whole dinner's main or side: not a cake or a dough, and a vegetarian main has beans, lentils or tofu. */
export function isDinner(r: Recipe): boolean {
  if (NOT_DINNER.test(r.name)) return false;
  if (r.kind === "main" && r.proteins.every((p) => p === "veg")) return r.ingredients.some((i) => VEG_PROTEIN.test(i));
  return true;
}

/** Up to this many kr. per portion of chance, so dishes of about the same price take turns from week to week. */
const JITTER_KR = 3;

/** Recipes the household can eat, cheapest per portion first. */
function ranked(recipes: Recipe[], { diet, recent, seed, cost }: CandidateOptions): Recipe[] {
  const eligible = recipes.filter((r) => !recent.has(r.id) && suitsDiet(r, diet) && isDinner(r) && Number.isFinite(cost(r)));
  const swaps = (r: Recipe) => (diet.glutenFree ? r.gluten.length : 0) + (diet.lactoseFree ? r.dairy.length : 0);
  const score = (r: Recipe) => cost(r) + swaps(r) + JITTER_KR * jitter(seed, r.id);
  return eligible.map((r) => ({ r, s: score(r) })).sort((a, b) => a.s - b.s).map(({ r }) => r);
}

/** Every protein gets at least this many of the mains, if there are that many, so it isn't pork all week. */
const MIN_PER_PROTEIN = 3;

/** The cheapest mains, with a few of every protein. */
export function selectMains(recipes: Recipe[], options: CandidateOptions): Recipe[] {
  const cheapest = ranked(recipes.filter((r) => r.kind === "main"), options);
  const chosen = new Set<Recipe>();
  for (const p of ["chicken", "beef", "pork", "fish", "veg"] as Protein[]) {
    for (const r of cheapest.filter((r) => (r.proteins[0] ?? "veg") === p).slice(0, MIN_PER_PROTEIN)) chosen.add(r);
  }
  for (const r of cheapest) {
    if (chosen.size >= options.count) break;
    chosen.add(r);
  }
  return cheapest.filter((r) => chosen.has(r)).slice(0, options.count);
}

/** The cheapest sides, at most a few of each kind, so there are potatoes, rice, salads and vegetables to pair. */
export function selectSides(recipes: Recipe[], options: CandidateOptions): Recipe[] {
  const perCategory = new Map<string, number>();
  const chosen: Recipe[] = [];
  for (const r of ranked(recipes.filter((r) => r.kind === "side"), options)) {
    if (chosen.length >= options.count) break;
    const n = perCategory.get(r.category) ?? 0;
    if (n >= 4) continue;
    perCategory.set(r.category, n + 1);
    chosen.push(r);
  }
  return chosen;
}
