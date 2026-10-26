// Sunday 14:00: choose the store, fetch the item list from it, and save the
// products for the plan week. Nothing is saved if the source looks broken, so
// the plan job then finds no new products and the previous plan stays.

import type { Household, IngredientRule } from "../config.ts";
import { getMeta, setMeta, type DB } from "../db.ts";
import { fetchSearch, type GomaProduct } from "../fetch/goma.ts";
import type { HttpClient } from "../fetch/http.ts";
import { fetchLeaflet, type LeafletInfo } from "../fetch/validity.ts";
import type { Recipe } from "../recipes.ts";
import { mondayOf, planWeek, weekKey } from "../week.ts";
import { chooseQueries, offerWeights, selectCandidates, unpriced } from "./candidates.ts";
import { chooseStore, SourceChangedError, type StoreChoice } from "./store.ts";

/** Goma pages per run, robots.txt and the store choice included (CLAUDE.md: about 25). */
const GOMA_PAGES = 24;
/** Recipes Claude gets to choose among. */
const CANDIDATES = 40;

export type FetchSummary = {
  week: string;
  choice: StoreChoice;
  /** Products found per search word. */
  counts: Record<string, number>;
  /** Search words with no products this week; they become estimates. */
  missing: string[];
  saved: number;
  /** When the store's weekly leaflet ends, if eTilbudsavis could tell. */
  leaflet: LeafletInfo | null;
  pagesFetched: number;
  /** The recipes saved for Claude to choose among. */
  candidates: Recipe[];
};

type Options = {
  db: DB;
  http: HttpClient;
  household: Household;
  /** The fixed list (config/varer.json), fetched before the words the recipes ask for. */
  items: string[];
  /** The recipe dataset and how its ingredients are bought. Without them only the fixed list is fetched. */
  recipes?: Recipe[];
  rules?: IngredientRule[];
  now?: () => Date;
  log?: (message: string) => void;
};

export async function fetchWeek({
  db, http, household, items, recipes = [], rules = [], now = () => new Date(), log = console.log,
}: Options): Promise<FetchSummary> {
  const week = planWeek(now());
  const choice = await chooseStore(http, household, log);
  log(`Butik for ${week}: ${choice.store}${choice.mode === "fixed" ? " (fast valgt)" : ""}.`);

  const found: { query: string; product: GomaProduct }[] = [];
  const counts: Record<string, number> = {};
  const fetchAll = async (queries: string[]) => {
    const empty: string[] = [];
    for (const query of queries) {
      const page = await fetchSearch(http, query, choice.slug);
      counts[query] = page?.products.length ?? 0;
      if (!page || page.products.length === 0) {
        empty.push(query);
        continue;
      }
      if (page.skipped > 0) log(`${query}: ${page.skipped} varer kunne ikke læses.`);
      for (const product of page.products) found.push({ query, product });
    }
    return empty;
  };

  // The fixed list decides whether Goma still works; the recipes' words may simply not exist there.
  const missing = await fetchAll(items);
  if (missing.length > items.length / 2) {
    throw new SourceChangedError(`${missing.length} af ${items.length} varer gav 0 rækker (${missing.join(", ")}).`);
  }

  // The protein offers just fetched decide which recipes are worth cooking this week,
  // and their ingredients decide what else to fetch. Twice as many as needed, because
  // some will lack prices for their ingredients.
  const diet = household.diet;
  const pool = selectCandidates(recipes, rules, {
    weights: offerWeights(found, choice.store), diet, recent: recentRecipes(db, week), count: CANDIDATES * 2, seed: week,
  });
  const failed = failedQueries(db, week);
  const fresh = freshQueries(db, week);
  const { queries, unfetched } = chooseQueries(pool, rules, {
    diet, fixed: items, budget: GOMA_PAGES - http.pagesFetched(), fresh, failed: new Set(failed.keys()),
  });
  const empty = await fetchAll(queries);
  if (!http.isBlocked("https://goma.gg/")) for (const query of empty) failed.set(query, week);
  setMeta(db, "emptyQueries", JSON.stringify(Object.fromEntries(failed)));
  if (empty.length) log(`Ingen varer for: ${empty.join(", ")}.`);

  // Claude can only use what has a price, so keep the recipes missing at most one priced ingredient.
  const priced = new Set([...items, ...queries, ...fresh].filter((q) => !missing.includes(q) && !empty.includes(q)));
  const candidates = pool.filter((r) => unpriced(r, rules, diet, priced).length <= 1).slice(0, CANDIDATES);
  if (recipes.length) log(`${candidates.length} opskrifter at vælge imellem. Søgeord fra dem: ${queries.join(", ") || "ingen"}.`);
  setMeta(db, `candidates:${week}`, JSON.stringify(candidates.map((r) => r.id)));

  // Words not fetched this week are priced from earlier weeks, like a failed search.
  const estimated = [...missing, ...empty, ...unfetched];
  const saved = save(db, week, choice, found, estimated, now().toISOString());

  // Only dates for "køb senest". Without them the plan is still made, just without the notes.
  let leaflet: LeafletInfo | null = null;
  try {
    leaflet = await fetchLeaflet(http, choice.store, mondayOf(week));
  } catch (error) {
    log(`Avisens gyldighed kunne ikke hentes: ${(error as Error).message}`);
  }
  if (!leaflet) log(`Ingen gyldighedsdato for ${choice.store}s avis. Planen får ingen "køb senest"-noter.`);
  setMeta(db, `leaflet:${week}`, JSON.stringify(leaflet));

  return { week, choice, counts, missing: estimated, saved, leaflet, pagesFetched: http.pagesFetched(), candidates };
}

/** The week key some weeks before the given one. */
function weeksBefore(week: string, weeks: number): string {
  return weekKey(new Date(mondayOf(week).getTime() - weeks * 7 * 86_400_000));
}

/** Search words with products from the last 4 weeks. */
function freshQueries(db: DB, week: string): Set<string> {
  const rows = db.prepare("SELECT DISTINCT query FROM products WHERE week >= ? AND week < ?").all(weeksBefore(week, 4), week) as { query: string }[];
  return new Set(rows.map((r) => r.query));
}

/** Search words that gave no products in the last 8 weeks, with the week it happened. */
function failedQueries(db: DB, week: string): Map<string, string> {
  const saved = JSON.parse(getMeta(db, "emptyQueries") ?? "{}") as Record<string, string>;
  const since = weeksBefore(week, 8);
  return new Map(Object.entries(saved).filter(([, when]) => when >= since));
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
  found: { query: string; product: GomaProduct }[],
  missing: string[],
  fetchedAt: string,
): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO products
      (week, store, goma_id, query, name, package_amount, unit, price, normal_price, per_kg, on_offer, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return db.transaction(() => {
    db.prepare("DELETE FROM products WHERE week = ?").run(week);
    let saved = 0;
    for (const { query, product: p } of found) {
      // The store page can list products from other chains; keep only the chosen store.
      if (p.store !== choice.store) continue;
      saved += insert.run(
        week, choice.store, p.gomaId, query, p.name, p.packageAmount, p.unit,
        p.price, p.normalPrice, p.perKg, p.onOffer ? 1 : 0, fetchedAt,
      ).changes;
    }
    db.prepare(`
      INSERT OR REPLACE INTO fetches (week, store, store_mode, savings_json, missing_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(week, choice.store, choice.mode, JSON.stringify(choice.savings), JSON.stringify(missing), fetchedAt);
    return saved;
  })();
}
