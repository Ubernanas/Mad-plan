import assert from "node:assert/strict";
import { test } from "node:test";
import { loadIngredientRules, type IngredientRule } from "./config.ts";
import { openDb } from "./db.ts";
import { itemFor, itemId, itemsFromRules, listItems, rememberNewItems, syncItems } from "./items.ts";

const rules: IngredientRule[] = [
  { words: ["salt"], basis: true, name: "salt" },
  { words: ["cream of mushroom soup"], query: "fløde", lactoseFree: "laktosefri-fløde", section: "køl", unit: "ml" },
  { words: ["heavy cream", "cream"], query: "fløde", lactoseFree: "laktosefri-fløde", section: "køl", unit: "ml" },
  { words: ["soy sauce"], query: "soyasauce", name: "sojasauce", section: "kolonial" },
  { words: ["mozzarella"], query: "mozzarella", lactoseFree: "laktosefri-ost", section: "køl" },
  { words: ["feta"], query: "feta", lactoseFree: "laktosefri-ost", section: "køl" },
];

test("one item per rule and per diet variant; rules with the same search word are one item", () => {
  const items = itemsFromRules(rules);
  assert.deepEqual(items.map((i) => i.name), ["salt", "fløde", "laktosefri fløde", "sojasauce", "mozzarella", "laktosefri ost", "feta"]);
  const cream = items.find((i) => i.name === "fløde")!;
  assert.deepEqual([cream.unit, cream.words], ["ml", ["cream of mushroom soup", "heavy cream", "cream"]]);
  assert.deepEqual(items.find((i) => i.name === "laktosefri ost")!.baseQueries, ["mozzarella", "feta"]);
  assert.equal(items.find((i) => i.name === "salt")!.staple, true);
});

test("a diet variant on the plain item's page is the variant", () => {
  const items = itemsFromRules(rules);
  assert.equal(itemFor("fløde", "Arla piskefløde 38%", items)?.name, "fløde");
  assert.equal(itemFor("fløde", "Arla Laktosefri Piskefløde", items)?.name, "laktosefri fløde");
  assert.equal(itemFor("laktosefri-fløde", "Piskefløde", items)?.name, "laktosefri fløde");
  assert.equal(itemFor("feta", "Laktosefri feta", items)?.name, "laktosefri ost");
  assert.equal(itemFor("ukendt", "Noget", items), undefined);
});

test("syncing is safe to repeat, and leaves Claude's own words alone", () => {
  const db = openDb(":memory:");
  syncItems(db, itemsFromRules(rules));
  rememberNewItems(db, [{ name: "Tahin", unit: "g", section: "kolonial" }, { name: "fløde", unit: "ml" }]);
  syncItems(db, itemsFromRules(rules));
  assert.equal(itemId(db, "heavy cream"), itemId(db, "fløde"));
  assert.equal(itemId(db, " Tahin "), itemId(db, "tahin"));
  assert.notEqual(itemId(db, "tahin"), null);
  assert.equal(itemId(db, "rosenkål"), null);
  // Staples are not named by Claude; fløde was known, so it was not added again.
  assert.deepEqual(listItems(db).map((i) => i.name), ["fløde", "laktosefri fløde", "sojasauce", "mozzarella", "laktosefri ost", "feta", "tahin"]);
});

test("the real word table builds without clashes", () => {
  const db = openDb(":memory:");
  const items = itemsFromRules(loadIngredientRules());
  syncItems(db, items);
  assert.equal(listItems(db).length, items.filter((i) => !i.staple).length);
  assert.equal(itemId(db, "snow peas") ?? itemId(db, "peas"), itemId(db, "ærter"));
});
