import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Household = {
  persons: number;
  weeklyBudgetDkk: number;
  dinnersPerWeek: number;
  /** How many dishes Claude suggests to choose from. */
  dishOptions: number;
  diet: { glutenFree: boolean; lactoseFree: boolean; other: string };
  stores: string[];
  storeMode: "cheapest" | "fixed";
  fixedStore: string | null;
  fetchCron: string;
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

/** Goma search words priced every week, grouped by the section their products go in. */
export function loadItemSections(): Record<string, Section> {
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

export function loadItems(): string[] {
  return Object.keys(loadItemSections());
}

export function loadPreferences(): string {
  return readFileSync(join(CONFIG_DIR, "preferences.md"), "utf8");
}
