// Sunday: fetch REMA 1000's food categories, choose the week's recipes (the cheapest
// per portion among the well-rated ones), and save the products for the plan week.
// Nothing is saved if the source looks broken, so the plan job then finds no new
// products and the previous plan stays. Prices are REMA's; the household may shop anywhere.

import type { Household, IngredientRule } from "../config.ts";
import { setMeta, type DB } from "../db.ts";
import type { HttpClient } from "../fetch/http.ts";
import { categoryUrl, fetchRema, REMA_CATEGORIES, REMA_CORE, REMA_STORE, type RemaProduct } from "../fetch/rema.ts";
import { compileRules, loadRemaRules, queryOfProduct, type RemaRule } from "../fetch/rema-match.ts";
import type { LeafletInfo } from "../fetch/validity.ts";
import { itemFor, itemId, itemsFromRules, syncItems, type CanonicalItem } from "../items.ts";
import type { Recipe } from "../recipes.ts";
import { mondayOf, planWeek, weekKey } from "../week.ts";
import { getKitchenDraft, isExpired, listKitchen, todayIso } from "../kitchen.ts";
import { kitchenStock, selectMains, selectSides, suitsDiet, type KitchenStock } from "./candidates.ts";
import { portionCost, priceIndex } from "./cost.ts";
import { SourceBlockedError, SourceChangedError, type StoreChoice } from "./store.ts";

/** Mains and sides Claude gets to pair into dinners. */
const MAINS = 40;
const SIDES = 30;

export type FetchSummary = {
  week: string;
  choice: StoreChoice;
  /** Products found per category page. */
  counts: Record<string, number>;
  /** Category pages that couldn't be fetched; their items are priced from earlier weeks. */
  missing: string[];
  saved: number;
  /** When REMA's weekly offers end, from the products themselves. */
  leaflet: LeafletInfo | null;
  pagesFetched: number;
  /** The recipes saved for Claude to choose among. */
  candidates: Recipe[];
};

type Options = {
  db: DB;
  http: HttpClient;
  household: Household;
  /** The recipe dataset and how its ingredients are bought. Without them only the products are saved. */
  recipes?: Recipe[];
  rules?: IngredientRule[];
  /** Which REMA products each search word is (config/rema.json). */
  remaRules?: RemaRule[];
  now?: () => Date;
  log?: (message: string) => void;
};

export async function fetchWeek({
  db, http, household, recipes = [], rules = [], remaRules = loadRemaRules(), now = () => new Date(), log = console.log,
}: Options): Promise<FetchSummary> {
  const week = planWeek(now());
  const choice: StoreChoice = { store: REMA_STORE, slug: "rema1000", mode: "fixed", savings: {} };
  const { products, counts, failed } = await fetchRema(http, mondayOf(week));

  // The meat counters are there every week; without them the page has changed or REMA said no.
  const emptyCore = REMA_CORE.filter((c) => !counts[c]);
  if (emptyCore.length > REMA_CORE.length / 2 || failed.length > REMA_CATEGORIES.length / 2) {
    const blocked = http.blockReason(categoryUrl(""));
    if (blocked) throw new SourceBlockedError(blocked, "REMA 1000");
    throw new SourceChangedError(`${emptyCore.length} af ${REMA_CORE.length} kød- og fiskesider og ${failed.length} af ${REMA_CATEGORIES.length} sider gav 0 varer.`);
  }
  if (failed.length) log(`Kunne ikke hente: ${failed.join(", ")}. Deres varer bliver skøn.`);

  const compiled = compileRules(remaRules);
  const found: { query: string; product: RemaProduct }[] = [];
  for (const product of products) {
    const query = queryOfProduct(product, compiled);
    if (query) found.push({ query, product });
  }

  // Cheap dinners first, among the well-rated ones the household can eat. The kitchen's
  // items cost nothing, so recipes that use them come earlier.
  const diet = household.diet;
  const buying = { diet, substitutes: household.substitutes };
  const prices = priceIndex(found);
  const stock = stockOf(db, rules, now());
  const cost = (r: Recipe) => portionCost(r, { rules, buying, prices, stock });
  // Dishes last week's plan didn't get to come back first, whatever their price.
  const unmade = new Set(unmadeDishes(db, week).flatMap((d) => [d.recipeId, d.sideRecipeId]));
  const back = recipes.filter((r) => unmade.has(r.id) && suitsDiet(r, diet));
  if (back.length) log(`Fra sidste plan, ikke lavet: ${back.map((r) => r.name).join(", ")}.`);
  const options = { diet, recent: new Set([...recentRecipes(db, week), ...back.map((r) => r.id)]), seed: week, cost };
  const countOf = (kind: Recipe["kind"]) => back.filter((r) => r.kind === kind).length;
  const candidates = [
    ...back,
    ...selectMains(recipes, { ...options, count: MAINS - countOf("main") }),
    ...selectSides(recipes, { ...options, count: SIDES - countOf("side") }),
  ];
  if (recipes.length) log(`${candidates.length} opskrifter at vælge imellem, de billigste pr. portion først.`);
  setMeta(db, `candidates:${week}`, JSON.stringify(candidates.map((r) => r.id)));
  setMeta(db, `candidateCosts:${week}`, JSON.stringify(Object.fromEntries(candidates.map((r) => [r.id, cost(r)]))));

  // Search words with no product this week are priced from earlier weeks, if they were found then.
  const foundQueries = new Set(found.map((f) => f.query));
  const estimated = [...new Set(rules.flatMap((r) => [r.query, r.glutenFree, r.lactoseFree].filter((q): q is string => !!q)))].filter((q) => !foundQueries.has(q));
  const catalog = itemsFromRules(rules);
  syncItems(db, catalog);
  const saved = save(db, week, choice, found, estimated, catalog, now().toISOString());

  // "Køb senest": the day most of the week's offers end.
  const leaflet = offerEnd(found.map((f) => f.product));
  if (!leaflet) log(`Ingen slutdato for REMA's tilbud. Planen får ingen "køb senest"-noter.`);
  setMeta(db, `leaflet:${week}`, JSON.stringify(leaflet));

  return { week, choice, counts, missing: failed, saved, leaflet, pagesFetched: http.pagesFetched(), candidates };
}

/** The last day of the week's offers: the end date most offers share. */
export function offerEnd(products: RemaProduct[]): LeafletInfo | null {
  const days = new Map<string, number>();
  for (const p of products) if (p.onOffer && p.offerLastDay) days.set(p.offerLastDay, (days.get(p.offerLastDay) ?? 0) + 1);
  const [lastDay] = [...days].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return lastDay ? { store: REMA_STORE, label: "REMA 1000 avisvarer", lastDay } : null;
}

/** The week key some weeks before the given one. */
function weeksBefore(week: string, weeks: number): string {
  return weekKey(new Date(mondayOf(week).getTime() - weeks * 7 * 86_400_000));
}

/**
 * What the kitchen holds, as search words. The Køkken page's draft replaces the kitchen
 * when the plan uses it, so then only the draft counts.
 */
function stockOf(db: DB, rules: IngredientRule[], now: Date): KitchenStock {
  const today = todayIso(now);
  const known = [...new Set(rules.flatMap((r) => [r.query, r.glutenFree, r.lactoseFree].filter((q): q is string => !!q)))];
  const draft = getKitchenDraft(db);
  if (draft) return kitchenStock([], draft, known, today);
  const queryOf = db.prepare("SELECT query FROM products WHERE goma_id = ? ORDER BY week DESC LIMIT 1");
  const items = listKitchen(db).filter((item) => !isExpired(item, today)).map((item) => ({
    ...item,
    // Ticked items know their Goma product; items without a price ("buy:…") are matched by name.
    query: item.productId && !item.productId.startsWith("buy:") ? ((queryOf.get(item.productId) as { query: string } | undefined)?.query ?? null) : null,
  }));
  return kitchenStock(items, "", known, today);
}

/** A dish chosen in the last plan but never marked "Lavet". Dishes Claude wrote itself have no recipe to bring back. */
export type UnmadeDish = { title: string; recipeId: number; sideRecipeId?: number | undefined };

/** The unmade dishes of the newest plan before this week, in the order they were to be cooked. */
export function unmadeDishes(db: DB, week: string): UnmadeDish[] {
  const row = db.prepare("SELECT plan_json FROM plans WHERE week < ? AND week >= ? ORDER BY week DESC, id DESC LIMIT 1")
    .get(week, weeksBefore(week, 4)) as { plan_json: string } | undefined;
  if (!row) return [];
  // Plans from before dishes could be chosen have no selected.
  const plan = JSON.parse(row.plan_json) as {
    options?: { title: string; recipeId?: number; sideRecipeId?: number }[];
    selected?: number[];
    done?: number[];
  };
  const done = new Set(plan.done ?? []);
  return (plan.selected ?? []).flatMap((id) => {
    const dish = plan.options?.[id];
    if (dish?.recipeId === undefined || done.has(id)) return [];
    return [{ title: dish.title, recipeId: dish.recipeId, sideRecipeId: dish.sideRecipeId }];
  });
}

/** Recipes used in the plans of the last 4 weeks, so they don't come back too soon. */
function recentRecipes(db: DB, week: string): Set<number> {
  const rows = db.prepare("SELECT plan_json FROM plans WHERE week >= ?").all(weeksBefore(week, 4)) as { plan_json: string }[];
  const ids = new Set<number>();
  for (const row of rows) {
    const plan = JSON.parse(row.plan_json) as { options?: { recipeId?: number }[] };
    for (const option of plan.options ?? []) if (option.recipeId) ids.add(option.recipeId);
  }
  return ids;
}

function save(
  db: DB,
  week: string,
  choice: StoreChoice,
  found: { query: string; product: RemaProduct }[],
  missing: string[],
  items: CanonicalItem[],
  fetchedAt: string,
): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO products
      (week, store, goma_id, query, name, package_amount, unit, price, normal_price, per_kg, on_offer, fetched_at, canonical_item_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const itemIdOf = (query: string, name: string) => {
    const item = itemFor(query, name, items);
    return item ? itemId(db, item.name) : null;
  };

  return db.transaction(() => {
    db.prepare("DELETE FROM products WHERE week = ?").run(week);
    let saved = 0;
    for (const { query, product: p } of found) {
      saved += insert.run(
        week, choice.store, p.id, query, p.name, p.packageAmount, p.unit,
        p.price, p.normalPrice, p.perKg, p.onOffer ? 1 : 0, fetchedAt, itemIdOf(query, p.name),
      ).changes;
    }
    db.prepare(`
      INSERT OR REPLACE INTO fetches (week, store, store_mode, savings_json, missing_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(week, choice.store, choice.mode, JSON.stringify(choice.savings), JSON.stringify(missing), fetchedAt);
    return saved;
  })();
}
