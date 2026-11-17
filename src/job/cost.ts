// A rough price per portion for a recipe, so the cheapest dinners can be chosen before
// Claude sees them. The dataset has no units ("1 1/2", not "1 1/2 lb"), so each ingredient
// counts a typical amount for its kind: about 500 g of meat, a vegetable or two, a little
// of the rest. It only ranks recipes; the real prices come from compute.ts after Claude.

import type { IngredientRule, Section } from "../config.ts";
import type { Unit } from "../fetch/size.ts";
import type { Recipe } from "../recipes.ts";
import { PROTEIN_PRODUCTS, queryFor, ruleFor, type Buying } from "./candidates.ts";

/** The cheapest price per g, ml or stk for each search word this week. */
export type PriceIndex = Map<string, { perUnit: number; unit: Unit }>;

export function priceIndex(found: { query: string; product: { price: number; packageAmount: number | null; unit: Unit | null } }[]): PriceIndex {
  const index: PriceIndex = new Map();
  for (const { query, product: p } of found) {
    if (!p.packageAmount || !p.unit || p.packageAmount <= 0) continue;
    const perUnit = p.price / p.packageAmount;
    const known = index.get(query);
    // Mixing units would compare per gram with per piece; the first unit seen sets it.
    if (!known || (known.unit === p.unit && perUnit < known.perUnit)) index.set(query, { perUnit, unit: p.unit });
  }
  return index;
}

/** How much of an ingredient a recipe for about 4 uses, in the product's unit. */
const TYPICAL: Record<Section, number> = { "kød og fisk": 500, "frugt og grønt": 250, køl: 200, kolonial: 150, frost: 300 };
/** An ingredient to buy without a price this week, and one the word table doesn't know. */
const UNPRICED_KR = 10;
const UNKNOWN_KR = 5;

export type CostOptions = {
  rules: IngredientRule[];
  buying: Buying;
  prices: PriceIndex;
  /** Search words the kitchen has; true when fresh and about to expire. They cost nothing, and expiring ones pull the price down. */
  stock?: Map<string, boolean>;
};

/**
 * Estimated kr. per portion. Infinity for a "recipe" with nothing to buy at all (only salt,
 * oil and spices, and no meat in its name), which in this dataset is not food, like a weed killer.
 */
export function portionCost(recipe: Recipe, { rules, buying, prices, stock }: CostOptions): number {
  let total = 0;
  let toBuy = 0;
  const seen = new Set<string>();
  for (const ingredient of recipe.ingredients) {
    const rule = ruleFor(ingredient, rules);
    if (!rule) {
      toBuy++;
      total += UNKNOWN_KR;
      continue;
    }
    if (!rule.basis) toBuy++;
    const query = queryFor(rule, buying);
    if (!query || seen.has(query)) continue; // a basis item, or already counted
    seen.add(query);
    if (stock?.has(query)) {
      if (stock.get(query)) total -= 5;
      continue;
    }
    const price = prices.get(query);
    if (!price) {
      total += UNPRICED_KR;
      continue;
    }
    const amount = price.unit === "stk" ? 1 : TYPICAL[rule.section ?? "kolonial"];
    total += price.perUnit * amount;
  }
  if (toBuy === 0 && recipe.proteins.every((p) => p === "veg")) return Infinity;
  // Some recipes list only the seasoning, not the pork chops; the meat is still bought.
  for (const protein of recipe.proteins) {
    if (protein === "veg") continue;
    const queries = PROTEIN_PRODUCTS[protein];
    if (queries.some((q) => seen.has(q))) continue;
    const perGram = queries.flatMap((q) => (prices.get(q)?.unit === "g" ? [prices.get(q)!.perUnit] : []));
    total += perGram.length ? Math.min(...perGram) * TYPICAL["kød og fisk"] : UNPRICED_KR;
  }
  const servings = Math.min(8, Math.max(2, recipe.servings ?? 4));
  return Math.max(0, Math.round((total / servings) * 100) / 100);
}
