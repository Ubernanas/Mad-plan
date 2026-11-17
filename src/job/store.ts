// Chooses the week's store. "cheapest": the chain with the largest total saving
// (normal price minus offer price) on the four protein searches. "fixed": the configured store.

import type { Household } from "../config.ts";
import { fetchSearch, type GomaProduct } from "../fetch/goma.ts";
import type { HttpClient } from "../fetch/http.ts";

export const PROTEINS = ["kylling", "hakket-oksekød", "svinekød", "laks"];

/** Goma's display name → the slug used in ?store=. */
export const STORE_SLUGS: Record<string, string> = {
  Netto: "netto",
  Føtex: "fotex",
  Bilka: "bilka",
  Lidl: "lidl",
  "REMA 1000": "rema1000",
  "365discount": "365discount",
  SuperBrugsen: "superbrugsen",
  MENY: "meny",
  Kvickly: "kvickly",
};

export type StoreChoice = {
  store: string;
  slug: string;
  mode: Household["storeMode"];
  /** Total saving per store in kr. Empty in fixed mode. */
  savings: Record<string, number>;
};

export class SourceChangedError extends Error {
  constructor(detail: string) {
    super(`Kilden har ændret sig: ${detail}`);
  }
}

/** Goma answered 403 or 429. Its pages may be fine; it just won't serve them to us. */
export class SourceBlockedError extends Error {
  constructor(reason: string, source = "Goma") {
    super(`${source} afviser hentningen: ${reason}.`);
  }
}

export function slugFor(store: string): string {
  const slug = STORE_SLUGS[store];
  if (!slug) throw new Error(`Ukendt butik "${store}". Kendte butikker: ${Object.keys(STORE_SLUGS).join(", ")}.`);
  return slug;
}

/** Sum of normal price minus offer price per store. Offers without a real saving count for nothing. */
export function storeSavings(products: GomaProduct[], stores: string[]): Record<string, number> {
  const savings: Record<string, number> = Object.fromEntries(stores.map((s) => [s, 0]));
  for (const p of products) {
    if (!(p.store in savings) || !p.onOffer || p.normalPrice === null) continue;
    const saving = p.normalPrice - p.price;
    if (saving > 0) savings[p.store]! += saving;
  }
  for (const store of stores) savings[store] = Math.round(savings[store]! * 100) / 100;
  return savings;
}

/** The store with the largest saving. On a tie, the one listed first in the config wins. */
export function bestStore(savings: Record<string, number>, stores: string[]): string {
  return stores.reduce((best, store) => (savings[store]! > savings[best]! ? store : best));
}

export async function chooseStore(
  http: HttpClient,
  household: Household,
  log: (message: string) => void = console.log,
): Promise<StoreChoice> {
  for (const store of household.stores) slugFor(store);

  if (household.storeMode === "fixed") {
    if (!household.fixedStore) throw new Error('storeMode er "fixed", men fixedStore er ikke sat.');
    return { store: household.fixedStore, slug: slugFor(household.fixedStore), mode: "fixed", savings: {} };
  }

  const products: GomaProduct[] = [];
  let fetched = 0;
  for (const protein of PROTEINS) {
    const page = await fetchSearch(http, protein);
    if (!page) {
      const blocked = http.blockReason("https://goma.gg/");
      if (blocked) throw new SourceBlockedError(blocked);
      log(`Kunne ikke hente tilbud på ${protein}. Butiksvalget bruger de andre proteiner.`);
      continue;
    }
    if (page.products.length === 0) throw new SourceChangedError(`søgningen på ${protein} gav 0 varer.`);
    fetched++;
    products.push(...page.products);
  }
  if (fetched === 0) throw new SourceChangedError("ingen af proteinsøgningerne kunne hentes.");

  const savings = storeSavings(products, household.stores);
  const store = bestStore(savings, household.stores);
  return { store, slug: slugFor(store), mode: "cheapest", savings };
}
