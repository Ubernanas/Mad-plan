import assert from "node:assert/strict";
import { test } from "node:test";
import type { Household } from "./config.ts";
import { openDb } from "./db.ts";
import { effectiveHousehold, saveSettings } from "./settings.ts";

const defaults: Household = {
  persons: 2, weeklyBudgetDkk: 460, dinnersPerWeek: 7, dishOptions: 12,
  diet: { glutenFree: true, lactoseFree: true, other: "" },
  stores: ["Netto", "Føtex", "Bilka", "REMA 1000"], storeMode: "cheapest", fixedStore: null,
  fetchCron: "0 14 * * 0", planCron: "0 18 * * 0", timezone: "Europe/Copenhagen", oauthTokenExpires: "2027-10-23",
};

test("without saved settings, household.json decides", () => {
  assert.deepEqual(effectiveHousehold(openDb(":memory:"), defaults), defaults);
});

test("saved settings override household.json, one field at a time", () => {
  const db = openDb(":memory:");
  saveSettings(db, { weeklyBudgetDkk: 500 }, defaults);
  saveSettings(db, { diet: { lactoseFree: false } }, defaults);
  const household = effectiveHousehold(db, defaults);
  assert.equal(household.weeklyBudgetDkk, 500);
  assert.deepEqual(household.diet, { glutenFree: true, lactoseFree: false, other: "" });
  assert.equal(household.fetchCron, "0 14 * * 0"); // not a setting
});

test("store mode: a fixed store must be one of the configured stores", () => {
  const db = openDb(":memory:");
  assert.ok("error" in saveSettings(db, { storeMode: "fixed", fixedStore: "Irma" }, defaults));
  assert.ok("settings" in saveSettings(db, { storeMode: "fixed", fixedStore: "REMA 1000" }, defaults));
  assert.equal(effectiveHousehold(db, defaults).fixedStore, "REMA 1000");
  saveSettings(db, { storeMode: "cheapest" }, defaults);
  assert.deepEqual([effectiveHousehold(db, defaults).storeMode, effectiveHousehold(db, defaults).fixedStore], ["cheapest", null]);
});

test("only changes are stored, so household.json still decides the rest", () => {
  const db = openDb(":memory:");
  saveSettings(db, { weeklyBudgetDkk: 500 }, defaults);
  const laterDefaults = { ...defaults, persons: 3, diet: { ...defaults.diet, lactoseFree: false } };
  const household = effectiveHousehold(db, laterDefaults);
  assert.equal(household.persons, 3); // edited in household.json after the settings page was used
  assert.equal(household.diet.lactoseFree, false);
  assert.equal(household.weeklyBudgetDkk, 500);

  saveSettings(db, { weeklyBudgetDkk: 460 }, defaults); // back to the default value
  assert.equal(effectiveHousehold(db, { ...defaults, weeklyBudgetDkk: 400 }).weeklyBudgetDkk, 400);
});

test("out-of-range values are refused and nothing is saved", () => {
  const db = openDb(":memory:");
  for (const change of [{ persons: 0 }, { persons: 2.5 }, { weeklyBudgetDkk: 10 }, { dinnersPerWeek: 8 }, { diet: { glutenFree: "ja" } }]) {
    assert.ok("error" in saveSettings(db, change, defaults), JSON.stringify(change));
  }
  assert.deepEqual(effectiveHousehold(db, defaults), defaults);
});
