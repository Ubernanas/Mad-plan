// The settings page's values, saved in SQLite. They override household.json,
// which then only holds the defaults. Changes apply from the next fetch and plan.

import { loadHousehold, type Household } from "./config.ts";
import { getMeta, setMeta, type DB } from "./db.ts";

export type Settings = Pick<Household, "persons" | "weeklyBudgetDkk" | "dinnersPerWeek" | "diet" | "storeMode" | "fixedStore">;

const KEY = "settings";

/** household.json with the settings page's changes on top. Use this, not loadHousehold, in jobs. */
export function effectiveHousehold(db: DB, defaults: Household = loadHousehold()): Household {
  const saved = JSON.parse(getMeta(db, KEY) ?? "{}") as Partial<Settings>;
  return { ...defaults, ...saved, diet: { ...defaults.diet, ...saved.diet } };
}

export function settingsOf(household: Household): Settings {
  const { persons, weeklyBudgetDkk, dinnersPerWeek, diet, storeMode, fixedStore } = household;
  return { persons, weeklyBudgetDkk, dinnersPerWeek, diet, storeMode, fixedStore };
}

/** Merges a change into the saved settings. Returns an error in Danish, or the new settings. */
export function saveSettings(db: DB, change: unknown, defaults: Household = loadHousehold()): { error: string } | { settings: Settings } {
  const next = settingsOf(effectiveHousehold(db, defaults));
  const c = (change ?? {}) as Record<string, unknown>;
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

  if ("persons" in c) {
    if (!int(c.persons, 1, 12)) return { error: "Antal personer skal være mellem 1 og 12." };
    next.persons = c.persons as number;
  }
  if ("weeklyBudgetDkk" in c) {
    if (!int(c.weeklyBudgetDkk, 50, 5000)) return { error: "Budgettet skal være mellem 50 og 5.000 kr." };
    next.weeklyBudgetDkk = c.weeklyBudgetDkk as number;
  }
  if ("dinnersPerWeek" in c) {
    const max = Math.min(7, defaults.dishOptions);
    if (!int(c.dinnersPerWeek, 1, max)) return { error: `Antal retter skal være mellem 1 og ${max}.` };
    next.dinnersPerWeek = c.dinnersPerWeek as number;
  }
  if ("diet" in c) {
    const diet = (c.diet ?? {}) as Record<string, unknown>;
    if ("glutenFree" in diet) {
      if (typeof diet.glutenFree !== "boolean") return { error: "Ugyldigt valg." };
      next.diet = { ...next.diet, glutenFree: diet.glutenFree };
    }
    if ("lactoseFree" in diet) {
      if (typeof diet.lactoseFree !== "boolean") return { error: "Ugyldigt valg." };
      next.diet = { ...next.diet, lactoseFree: diet.lactoseFree };
    }
    if ("other" in diet) {
      if (typeof diet.other !== "string" || diet.other.length > 300) return { error: "Andre hensyn må højst være 300 tegn." };
      next.diet = { ...next.diet, other: diet.other.trim() };
    }
  }
  if ("storeMode" in c) {
    if (c.storeMode === "cheapest") {
      next.storeMode = "cheapest";
      next.fixedStore = null;
    } else if (c.storeMode === "fixed" && typeof c.fixedStore === "string" && defaults.stores.includes(c.fixedStore)) {
      next.storeMode = "fixed";
      next.fixedStore = c.fixedStore;
    } else {
      return { error: `Vælg billigste eller en af butikkerne: ${defaults.stores.join(", ")}.` };
    }
  }

  // Save only what differs from household.json, so it stays the default for everything else.
  const base = settingsOf(defaults);
  const overrides: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (key === "diet") continue;
    if (next[key] !== base[key]) overrides[key] = next[key];
  }
  const diet = Object.fromEntries(Object.entries(next.diet).filter(([k, v]) => v !== base.diet[k as keyof Settings["diet"]]));
  if (Object.keys(diet).length) overrides.diet = diet;
  // A fixed store needs its mode next to it, and the other way round.
  if (overrides.storeMode !== undefined || overrides.fixedStore !== undefined) {
    overrides.storeMode = next.storeMode;
    overrides.fixedStore = next.fixedStore;
  }

  setMeta(db, KEY, JSON.stringify(overrides));
  return { settings: next };
}
