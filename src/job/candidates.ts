// Sunday, between the protein searches and the rest of the fetch: which recipes
// Claude gets to choose among, and which Goma search words their ingredients need.
// Good dinners come first; the offers only tilt the mix towards cheap proteins.
// An ingredient without a price never rules a recipe out.

import type { Household, IngredientRule } from "../config.ts";
import type { GomaProduct } from "../fetch/goma.ts";
import type { Protein, Recipe } from "../recipes.ts";

type Diet = Household["diet"];
export type Weights = Record<Protein, number>;

/** The Goma search whose offers say how cheap each protein is this week. */
export const PROTEIN_QUERIES: Record<Exclude<Protein, "veg">, string> = {
  chicken: "kylling",
  beef: "hakket-oksekød",
  pork: "svinekød",
  fish: "laks",
};

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

/**
 * The search word for a rule: the gluten- or lactose-free variant when the diet asks for
 * it, unless Goma has no page for the variant. Then the plain word, whose page usually
 * lists the variants too ("fløde" has the lactose-free cream).
 */
export function queryFor(rule: IngredientRule, diet: Diet, failed: Set<string> = new Set()): string | null {
  if (rule.basis) return null;
  const variant = (diet.glutenFree && rule.glutenFree) || (diet.lactoseFree && rule.lactoseFree) || null;
  if (variant && !failed.has(variant)) return variant;
  return rule.query ?? null;
}

/** The search words a recipe needs. Basis items and unknown ingredients need none. */
export function queriesOf(recipe: Recipe, rules: IngredientRule[], diet: Diet, failed?: Set<string>): string[] {
  const queries = new Set<string>();
  for (const ingredient of recipe.ingredients) {
    const rule = ruleFor(ingredient, rules);
    const query = rule && queryFor(rule, diet, failed);
    if (query) queries.add(query);
  }
  return [...queries];
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
  diet: Diet;
  /** Recipes in the last weeks' plans, so the same dishes don't come back every week. */
  recent: Set<number>;
  count: number;
  /** The plan week: a new mix every week, the same one on a rerun. */
  seed: string;
};

/** Recipes the household can eat, ranked by what people thought of them, with a new mix every week. */
function ranked(recipes: Recipe[], { diet, recent, seed }: CandidateOptions): Recipe[] {
  // Many swaps (gluten-free pasta, lactose-free cream …) and the dish is no longer the one people rated.
  const eligible = recipes.filter((r) =>
    !recent.has(r.id) && (!diet.glutenFree || r.gluten.length <= 2) && (!diet.lactoseFree || r.dairy.length <= 3));
  const swaps = (r: Recipe) => (diet.glutenFree ? r.gluten.length : 0) + (diet.lactoseFree ? r.dairy.length : 0);
  const score = (r: Recipe) =>
    Math.log10(r.reviews) + (r.rating - 4.5) * 2 + (r.minutes <= 40 ? 0.3 : 0) - 0.2 * swaps(r) + jitter(seed, r.id);
  return eligible.map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s).map(({ r }) => r);
}

/**
 * The best-rated mains, more of them for the proteins on offer, and some of every
 * kind so the week still varies.
 */
export function selectMains(recipes: Recipe[], weights: Weights, options: CandidateOptions): Recipe[] {
  const best = ranked(recipes.filter((r) => r.kind === "main"), options);
  // A dish counts under its cheapest protein this week.
  const groupOf = (r: Recipe): Protein => r.proteins.reduce((a, p) => (weights[p] > weights[a] ? p : a));
  const max = Math.max(...Object.values(weights));
  const share = (p: Protein) => (p === "veg" ? 1 : 1 + (max > 0 ? (4 * weights[p]) / max : 0));
  const proteins = Object.keys(weights) as Protein[];
  const total = proteins.reduce((sum, p) => sum + share(p), 0);

  const chosen = new Set<Recipe>();
  for (const p of proteins) {
    const quota = Math.max(1, Math.round((options.count * share(p)) / total));
    for (const r of best.filter((r) => groupOf(r) === p).slice(0, quota)) chosen.add(r);
  }
  // Rounding or a thin group can leave room; the best of the rest fill it.
  for (const r of best) {
    if (chosen.size >= options.count) break;
    chosen.add(r);
  }
  return best.filter((r) => chosen.has(r)).slice(0, options.count);
}

/** The best-rated sides, at most a few of each kind, so there are potatoes, rice, salads and vegetables to pair. */
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
 * then the words most candidates need. The rest are priced from earlier weeks, or not at all.
 */
export function chooseQueries(
  candidates: Recipe[],
  rules: IngredientRule[],
  { diet, fixed, budget, fresh, failed }: QueryOptions,
): { queries: string[]; unfetched: string[] } {
  const need = new Map<string, number>();
  for (const recipe of candidates) {
    for (const query of queriesOf(recipe, rules, diet, failed)) {
      if (!fixed.includes(query) && !failed.has(query)) need.set(query, (need.get(query) ?? 0) + 1);
    }
  }
  const stale = (q: string) => (fresh.has(q) ? 1 : 0);
  const order = [...need]
    .sort((a, b) => stale(a[0]) - stale(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([q]) => q);
  const room = Math.max(0, budget);
  return { queries: order.slice(0, room), unfetched: order.slice(room) };
}
