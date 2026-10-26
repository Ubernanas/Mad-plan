// Sunday, between the protein searches and the rest of the fetch: which recipes
// from the dataset suit this week's offers at the chosen store, and which Goma
// search words their ingredients need. Claude later picks the dishes among them.

import type { Household, IngredientRule } from "../config.ts";
import type { GomaProduct } from "../fetch/goma.ts";
import { proteinsOf, type Protein, type Recipe } from "../recipes.ts";

type Diet = Household["diet"];
export type Weights = Record<Protein, number>;

/** The Goma search whose offers say how cheap each protein is this week. */
export const PROTEIN_QUERIES: Record<Exclude<Protein, "veg">, string> = {
  chicken: "kylling",
  beef: "hakket-oksekød",
  pork: "svinekød",
  fish: "laks",
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

/** The search word for a rule, the gluten- or lactose-free variant when the diet asks for it. */
export function queryFor(rule: IngredientRule, diet: Diet): string | null {
  if (rule.basis) return null;
  if (diet.glutenFree && rule.glutenFree) return rule.glutenFree;
  if (diet.lactoseFree && rule.lactoseFree) return rule.lactoseFree;
  return rule.query ?? null;
}

/** The search words a recipe needs. Basis items and unknown ingredients need none. */
export function queriesOf(recipe: Recipe, rules: IngredientRule[], diet: Diet): string[] {
  const queries = new Set<string>();
  for (const ingredient of recipe.ingredients) {
    const rule = ruleFor(ingredient, rules);
    const query = rule && queryFor(rule, diet);
    if (query) queries.add(query);
  }
  return [...queries];
}

/**
 * Whether Claude can make the recipe as people rated it: at most one ingredient
 * without a price, and never its meat, fish or beans, which would make it another dish.
 */
export function makeable(recipe: Recipe, rules: IngredientRule[], diet: Diet, priced: Set<string>): boolean {
  let missing = 0;
  for (const ingredient of recipe.ingredients) {
    const rule = ruleFor(ingredient, rules);
    const query = rule && queryFor(rule, diet);
    if (!query || priced.has(query)) continue;
    if (proteinsOf([ingredient]).length) return false;
    missing++;
  }
  return missing <= 1;
}

/** The search words whose products count as each protein, so a dish keeps its recipe's protein. */
export const PROTEIN_PRODUCTS: Record<Exclude<Protein, "veg">, string[]> = {
  chicken: ["kylling"],
  beef: ["hakket-oksekød", "oksekød"],
  pork: ["svinekød", "hakket-svinekød", "bacon", "skinke", "pølser"],
  fish: ["laks", "torsk", "rejer", "tun"],
};

/** Share of the ingredients the table knows how to buy. */
export function coverage(recipe: Recipe, rules: IngredientRule[]): number {
  return recipe.ingredients.filter((i) => ruleFor(i, rules)).length / recipe.ingredients.length;
}

// ---------- Choosing the candidates ----------

/** Total saving (normal price minus offer price) on each protein's search at the chosen store. */
export function offerWeights(found: { query: string; product: GomaProduct }[], store: string): Weights {
  const weights: Weights = { chicken: 0, beef: 0, pork: 0, fish: 0, veg: 0 };
  for (const [protein, query] of Object.entries(PROTEIN_QUERIES) as [Protein, string][]) {
    for (const { query: q, product: p } of found) {
      if (q !== query || p.store !== store || !p.onOffer || p.normalPrice === null) continue;
      weights[protein] += Math.max(0, p.normalPrice - p.price);
    }
  }
  return weights;
}

/** A number in [0, 1) that is the same for a recipe all week, so reruns pick the same candidates. */
function jitter(seed: string, id: number): number {
  let hash = 2166136261;
  for (const ch of `${seed}:${id}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return (hash >>> 0) / 2 ** 32;
}

type CandidateOptions = {
  weights: Weights;
  diet: Diet;
  /** Recipes in the last weeks' plans, so the same dishes don't come back every week. */
  recent: Set<number>;
  count: number;
  /** The plan week: a new mix every week, the same one on a rerun. */
  seed: string;
};

/**
 * The best-rated recipes the household can make, more of them for the proteins on
 * offer, and some of every kind so the week still varies.
 */
export function selectCandidates(recipes: Recipe[], rules: IngredientRule[], options: CandidateOptions): Recipe[] {
  const { weights, diet, recent, count, seed } = options;
  // Many swaps (gluten-free pasta, lactose-free cream …) and the dish is no longer the one people rated.
  const eligible = recipes.filter((r) =>
    !recent.has(r.id) &&
    (!diet.glutenFree || r.gluten.length <= 2) &&
    (!diet.lactoseFree || r.dairy.length <= 3) &&
    coverage(r, rules) >= 0.8);

  const swaps = (r: Recipe) => (diet.glutenFree ? r.gluten.length : 0) + (diet.lactoseFree ? r.dairy.length : 0);
  const score = (r: Recipe) =>
    Math.log10(r.reviews) + (r.rating - 4.5) * 2 + (r.minutes <= 40 ? 0.3 : 0) - 0.2 * swaps(r) + jitter(seed, r.id);
  // A dish counts under its cheapest protein this week.
  const groupOf = (r: Recipe): Protein => r.proteins.reduce((best, p) => (weights[p] > weights[best] ? p : best));

  const max = Math.max(...Object.values(weights));
  const share = (p: Protein) => (p === "veg" ? 1 : 1 + (max > 0 ? (4 * weights[p]) / max : 0));
  const proteins = Object.keys(weights) as Protein[];
  const total = proteins.reduce((sum, p) => sum + share(p), 0);

  const ranked = eligible.map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s);
  const chosen = new Set<Recipe>();
  for (const p of proteins) {
    const quota = Math.max(1, Math.round((count * share(p)) / total));
    for (const { r } of ranked.filter(({ r }) => groupOf(r) === p).slice(0, quota)) chosen.add(r);
  }
  // Rounding or a thin group can leave room; the best of the rest fill it.
  for (const { r } of ranked) {
    if (chosen.size >= count) break;
    chosen.add(r);
  }
  return ranked.map(({ r }) => r).filter((r) => chosen.has(r)).slice(0, count);
}

type QueryOptions = {
  diet: Diet;
  /** Fetched every week anyway. */
  fixed: string[];
  /** Pages left for Goma in this run. */
  budget: number;
  /** Words with prices from the last few weeks; they can wait, and are priced as estimates. */
  fresh: Set<string>;
  /** Words Goma recently found nothing for; fetching them again would waste a page. */
  failed: Set<string>;
};

/**
 * The search words to fetch after the fixed list, as many as the page budget allows.
 * Words without a recent price go first, so over the weeks every word gets fetched;
 * then the words most candidates need. The rest are priced from earlier weeks.
 */
export function chooseQueries(
  candidates: Recipe[],
  rules: IngredientRule[],
  { diet, fixed, budget, fresh, failed }: QueryOptions,
): { queries: string[]; unfetched: string[] } {
  const need = new Map<string, number>();
  for (const recipe of candidates) {
    for (const query of queriesOf(recipe, rules, diet)) {
      if (!fixed.includes(query) && !failed.has(query)) need.set(query, (need.get(query) ?? 0) + 1);
    }
  }
  const stale = (q: string) => (fresh.has(q) ? 1 : 0);
  const ranked = [...need]
    .sort((a, b) => stale(a[0]) - stale(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([q]) => q);
  const room = Math.max(0, budget);
  return { queries: ranked.slice(0, room), unfetched: ranked.slice(room) };
}
