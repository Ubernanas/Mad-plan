import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Unit } from "./fetch/size.ts";

export type Household = {
  persons: number;
  weeklyBudgetDkk: number;
  dinnersPerWeek: number;
  /** How many dishes Claude suggests to choose from. */
  dishOptions: number;
  diet: { glutenFree: boolean; lactoseFree: boolean; other: string };
  /**
   * The household's own swaps, by Goma search word: { "fløde": "kokosmælk" } means
   * coconut milk is bought and cooked with wherever a recipe says cream.
   */
  substitutes?: Record<string, string>;
  stores: string[];
  storeMode: "cheapest" | "fixed";
  fixedStore: string | null;
  planCron: string;
  timezone: string;
  oauthTokenExpires: string;
};

const CONFIG_DIR = join(import.meta.dirname, "..", "config");

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(CONFIG_DIR, file), "utf8")) as T;
}

export function loadHousehold(): Household {
  return readJson<Household>("household.json");
}

/** Shopping list sections in the order you walk through a typical store. */
export const SECTIONS = ["frugt og grønt", "kød og fisk", "køl", "kolonial", "frost"] as const;
export type Section = (typeof SECTIONS)[number];

/** Goma search words fetched every week, grouped by the section their products go in. */
function loadFixedItems(): Record<string, Section> {
  const grouped = readJson<Record<string, string[]>>("varer.json");
  const sections: Record<string, Section> = {};
  for (const [section, queries] of Object.entries(grouped)) {
    if (!SECTIONS.includes(section as Section)) {
      throw new Error(`Ukendt afdeling "${section}" i varer.json. Brug: ${SECTIONS.join(", ")}.`);
    }
    for (const query of queries) sections[query] = section as Section;
  }
  return sections;
}

/**
 * The section for every search word the job can fetch: the fixed list, plus the words
 * the week's recipes ask for (config/ingredients.json, with diet variants).
 */
export function loadItemSections(): Record<string, Section> {
  const sections: Record<string, Section> = {};
  for (const rule of loadIngredientRules()) {
    if (!rule.query) continue;
    for (const query of [rule.query, rule.glutenFree, rule.lactoseFree]) if (query) sections[query] = rule.section!;
  }
  return { ...sections, ...loadFixedItems() };
}

/** The search words fetched every week, before the ones the recipes ask for. */
export function loadItems(): string[] {
  return Object.keys(loadFixedItems());
}

/**
 * How an English recipe ingredient is bought: a Goma search word (with a gluten- or
 * lactose-free variant), or a basis item the household always has. First match wins.
 */
export type IngredientRule = {
  words: string[];
  /** The item's Danish name, where the search word doesn't say it well ("soyasauce" → "sojasauce"). */
  name?: string;
  /** The unit the item is usually counted in; g if not given. */
  unit?: Unit;
  basis?: true;
  query?: string;
  section?: Section;
  glutenFree?: string;
  lactoseFree?: string;
};

export function loadIngredientRules(): IngredientRule[] {
  const rules = readJson<IngredientRule[]>("ingredients.json");
  for (const rule of rules) {
    if (!rule.basis && !(rule.query && SECTIONS.includes(rule.section!))) {
      throw new Error(`ingredients.json: "${rule.words[0]}" skal have basis eller query med en afdeling (${SECTIONS.join(", ")}).`);
    }
  }
  return rules;
}

export function loadPreferences(): string {
  return readFileSync(join(CONFIG_DIR, "preferences.md"), "utf8");
}
