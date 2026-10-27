// Canonical items: what a recipe asks for ("agurk", "laktosefri fløde"), whatever product
// it is bought as. Built from config/ingredients.json, which stays the source; Claude's
// names for new things are added as unconfirmed items, so the next plan names them the same.

import type { IngredientRule, Section } from "./config.ts";
import type { DB } from "./db.ts";
import type { Unit } from "./fetch/size.ts";

export type CanonicalItem = {
  name: string;
  section: Section;
  unit: Unit;
  /** Oil, salt, spices: never bought. */
  staple: boolean;
  /** The Goma search word it is fetched with. */
  query: string | null;
  /** For a diet variant: the word its products' names contain ("laktosefri"). */
  filter: string | null;
  /** For a diet variant: the plain items' search words, whose pages list the variant too. */
  baseQueries: string[];
  /** The recipes' English words for it. */
  words: string[];
};

/** "hakket-oksekød" → "hakket oksekød". */
export const nameOfQuery = (query: string) => query.replace(/-/g, " ");

/** One item per rule, one per diet variant. Rules with the same name are one item. */
export function itemsFromRules(rules: IngredientRule[]): CanonicalItem[] {
  const items = new Map<string, CanonicalItem>();
  const add = (item: CanonicalItem) => {
    const known = items.get(item.name);
    if (!known) return void items.set(item.name, item);
    known.words.push(...item.words);
    for (const q of item.baseQueries) if (!known.baseQueries.includes(q)) known.baseQueries.push(q);
  };
  for (const rule of rules) {
    const unit = rule.unit ?? "g";
    if (rule.basis) {
      add({ name: rule.name ?? rule.words[0]!, section: "kolonial", unit, staple: true, query: null, filter: null, baseQueries: [], words: [...rule.words] });
      continue;
    }
    const query = rule.query!;
    add({ name: rule.name ?? nameOfQuery(query), section: rule.section!, unit, staple: false, query, filter: null, baseQueries: [], words: [...rule.words] });
    for (const variant of [rule.glutenFree, rule.lactoseFree]) {
      if (!variant) continue;
      const prefix = /^(glutenfri|laktosefri)-/.exec(variant);
      add({
        name: nameOfQuery(variant), section: rule.section!, unit, staple: false, query: variant,
        filter: prefix ? prefix[1]! : nameOfQuery(variant), baseQueries: [query], words: [],
      });
    }
  }
  return [...items.values()];
}

/**
 * The item a fetched product is. A diet variant on the plain item's page is the variant
 * ("Laktosefri piskefløde" found by "fløde" is "laktosefri fløde"); the rest is the search word's item.
 */
export function itemFor(query: string, productName: string, items: CanonicalItem[]): CanonicalItem | undefined {
  const name = productName.toLowerCase();
  return items.find((i) => i.filter && i.baseQueries.includes(query) && name.includes(i.filter))
    ?? items.find((i) => i.query === query);
}

/** Writes the word table's items and words to the database. Safe to run at every start. */
export function syncItems(db: DB, items: CanonicalItem[]): void {
  const upsert = db.prepare(`
    INSERT INTO canonical_item (name_da, section, base_unit, is_staple, goma_query, name_filter) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (name_da) DO UPDATE SET section = excluded.section, base_unit = excluded.base_unit,
      is_staple = excluded.is_staple, goma_query = excluded.goma_query, name_filter = excluded.name_filter
    RETURNING id`);
  // Words from the word table follow it; a word the household or Claude gave is left alone.
  const alias = db.prepare(`
    INSERT INTO item_alias (alias, canonical_item_id, source, confirmed) VALUES (?, ?, 'rule', 1)
    ON CONFLICT (alias) DO UPDATE SET canonical_item_id = excluded.canonical_item_id WHERE item_alias.source = 'rule'`);
  db.transaction(() => {
    const seen = new Set<string>(); // the first rule with a word wins, as when matching
    for (const item of items) {
      const { id } = upsert.get(item.name, item.section, item.unit, item.staple ? 1 : 0, item.query, item.filter) as { id: number };
      for (const word of item.words.map((w) => w.toLowerCase())) {
        if (seen.has(word)) continue;
        seen.add(word);
        alias.run(word, id);
      }
    }
  })();
}

/** The item for a name, by its own name or an alias. */
export function itemId(db: DB, name: string): number | null {
  const n = name.trim().toLowerCase();
  const row = (db.prepare("SELECT id FROM canonical_item WHERE name_da = ?").get(n)
    ?? db.prepare("SELECT canonical_item_id AS id FROM item_alias WHERE alias = ?").get(n)) as { id: number } | undefined;
  return row?.id ?? null;
}

export type ItemInfo = { name: string; section: Section; unit: Unit };

/** The items Claude may name: the word table's and Claude's own from earlier plans. Staples are left out. */
export function listItems(db: DB): ItemInfo[] {
  return db.prepare("SELECT name_da AS name, section, base_unit AS unit FROM canonical_item WHERE is_staple = 0 ORDER BY id").all() as ItemInfo[];
}

/** Things Claude had to buy that no item covers become unconfirmed items, so the next plan names them the same. */
export function rememberNewItems(db: DB, bought: { name: string; unit: Unit; section?: Section }[]): void {
  const insert = db.prepare("INSERT INTO canonical_item (name_da, section, base_unit) VALUES (?, ?, ?) ON CONFLICT (name_da) DO NOTHING RETURNING id");
  const alias = db.prepare("INSERT INTO item_alias (alias, canonical_item_id, source, confirmed) VALUES (?, ?, 'claude', 0) ON CONFLICT (alias) DO NOTHING");
  db.transaction(() => {
    for (const thing of bought) {
      const name = thing.name.trim().toLowerCase();
      if (!name || itemId(db, name) !== null) continue;
      const row = insert.get(name, thing.section ?? "kolonial", thing.unit) as { id: number } | undefined;
      if (row) alias.run(name, row.id);
    }
  })();
}
