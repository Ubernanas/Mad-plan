// Sunday 14:00: choose the store, fetch the item list from it, and save the
// products for the plan week. Nothing is saved if the source looks broken, so
// the plan job then finds no new products and the previous plan stays.

import type { Household } from "../config.ts";
import { setMeta, type DB } from "../db.ts";
import { fetchSearch, type GomaProduct } from "../fetch/goma.ts";
import type { HttpClient } from "../fetch/http.ts";
import { fetchLeaflet, type LeafletInfo } from "../fetch/validity.ts";
import { mondayOf, planWeek } from "../week.ts";
import { chooseStore, SourceChangedError, type StoreChoice } from "./store.ts";

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
};

type Options = {
  db: DB;
  http: HttpClient;
  household: Household;
  items: string[];
  now?: () => Date;
  log?: (message: string) => void;
};

export async function fetchWeek({ db, http, household, items, now = () => new Date(), log = console.log }: Options): Promise<FetchSummary> {
  const week = planWeek(now());
  const choice = await chooseStore(http, household, log);
  log(`Butik for ${week}: ${choice.store}${choice.mode === "fixed" ? " (fast valgt)" : ""}.`);

  const found: { query: string; product: GomaProduct }[] = [];
  const counts: Record<string, number> = {};
  const missing: string[] = [];
  for (const query of items) {
    const page = await fetchSearch(http, query, choice.slug);
    counts[query] = page?.products.length ?? 0;
    if (!page || page.products.length === 0) {
      missing.push(query);
      continue;
    }
    if (page.skipped > 0) log(`${query}: ${page.skipped} varer kunne ikke læses.`);
    for (const product of page.products) found.push({ query, product });
  }

  if (missing.length > items.length / 2) {
    throw new SourceChangedError(`${missing.length} af ${items.length} varer gav 0 rækker (${missing.join(", ")}).`);
  }

  const saved = save(db, week, choice, found, missing, now().toISOString());

  // Only dates for "køb senest". Without them the plan is still made, just without the notes.
  let leaflet: LeafletInfo | null = null;
  try {
    leaflet = await fetchLeaflet(http, choice.store, mondayOf(week));
  } catch (error) {
    log(`Avisens gyldighed kunne ikke hentes: ${(error as Error).message}`);
  }
  if (!leaflet) log(`Ingen gyldighedsdato for ${choice.store}s avis. Planen får ingen "køb senest"-noter.`);
  setMeta(db, `leaflet:${week}`, JSON.stringify(leaflet));

  return { week, choice, counts, missing, saved, leaflet, pagesFetched: http.pagesFetched() };
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
