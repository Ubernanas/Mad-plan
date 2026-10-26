import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, type DB } from "./db.ts";
import {
  addDays, categoryOf, consume, convert, freeze, freezeAlerts, isExpired, kitchenText, listKitchen, locationOf, replaceKitchen, restore, syncPurchase, unfreeze,
} from "./kitchen.ts";

const line = (productId: string, item: string, section: "kød og fisk" | "frugt og grønt" | "kolonial" | "køl" | "frost", packageAmount: number, unit: "g" | "ml" | "stk" = "g", packages = 1) =>
  ({ productId, item, section, packageAmount, unit, packages });

function stocked(): DB {
  const db = openDb(":memory:");
  syncPurchase(db, 1, line("laks", "Laksefilet", "kød og fisk", 250), true, "2026-10-26");
  syncPurchase(db, 1, line("okse", "Hakket oksekød 8-12%", "kød og fisk", 400, "g", 2), true, "2026-10-26");
  syncPurchase(db, 1, line("løg", "Løg", "frugt og grønt", 1000), true, "2026-10-26");
  syncPurchase(db, 1, line("ris", "Basmatiris", "kolonial", 1000), true, "2026-10-26");
  return db;
}

test("categories and places follow the spec's shelf lives", () => {
  assert.equal(categoryOf("Lerøy laksestykke", "kød og fisk"), "fisk");
  assert.equal(categoryOf("(dp) netto hk. okse 8-12%", "kød og fisk"), "hakket");
  assert.equal(categoryOf("Flæskesteg", "kød og fisk"), "kød");
  assert.equal(categoryOf("Broccoli", "frugt og grønt"), "grønt");
  assert.equal(categoryOf("Ærter, frost", "kolonial"), "frost");
  assert.equal(categoryOf("Basmatiris", "kolonial"), "holdbart");
  assert.equal(locationOf("grønt", "Kartofler"), "skab");
  assert.equal(locationOf("grønt", "Broccoli"), "køl");
});

test("a tick puts the bought amount in the kitchen with a shelf life from the day of the tick", () => {
  const items = Object.fromEntries(listKitchen(stocked()).map((i) => [i.productId, i]));
  assert.deepEqual([items.laks!.qty, items.laks!.location, items.laks!.expires], [250, "køl", "2026-10-28"]); // fish: 2 days
  assert.deepEqual([items.okse!.qty, items.okse!.expires], [800, "2026-10-28"]); // 2 packs, minced: 2 days
  assert.deepEqual([items.løg!.location, items.løg!.expires], ["skab", "2026-10-31"]); // vegetables: 5 days
  assert.equal(items.ris!.expires, addDays("2026-10-26", 180));
});

test("ticking twice adds once, and unticking takes exactly that row out", () => {
  const db = stocked();
  syncPurchase(db, 1, line("laks", "Laksefilet", "kød og fisk", 250), true, "2026-10-27");
  assert.equal(listKitchen(db).filter((i) => i.productId === "laks").length, 1);
  syncPurchase(db, 1, line("laks", "Laksefilet", "kød og fisk", 250), false, "2026-10-27");
  assert.equal(listKitchen(db).some((i) => i.productId === "laks"), false);
});

test("'Lavet' takes the ingredients out, never below 0, and undo puts back exactly that", () => {
  const db = stocked();
  const moves = consume(db, [
    { name: "hakket oksekød", qty: 500, unit: "g", productId: "okse" },
    { name: "laks", qty: 400, unit: "g", productId: "laks" }, // more than there is
    { name: "salt", qty: 5, unit: "g", basis: true },
  ]);
  const after = Object.fromEntries(listKitchen(db).map((i) => [i.productId, i.qty]));
  assert.equal(after.okse, 300);
  assert.equal(after.laks, undefined); // 0 left: no longer listed
  restore(db, moves);
  const back = Object.fromEntries(listKitchen(db).map((i) => [i.productId, i.qty]));
  assert.deepEqual([back.okse, back.laks], [800, 250]);
});

test("pieces and grams convert with units.json", () => {
  assert.equal(convert(2, "stk", "g", "løg"), 300);
  assert.equal(convert(300, "g", "stk", "Rødløg"), 2.5);
  assert.equal(convert(100, "ml", "g", "kokosmælk"), 100);
  assert.equal(convert(1, "stk", "g", "flæskesteg"), null);
  const db = openDb(":memory:");
  replaceKitchen(db, [{ id: "k1", name: "løg", qty: 3, unit: "stk", location: "skab", category: "grønt" }], "2026-10-25");
  consume(db, [{ name: "løg", qty: 150, unit: "g", kitchenItem: `k${listKitchen(db)[0]!.id}` }]);
  assert.equal(listKitchen(db)[0]!.qty, 2);
});

test("freezing moves to the freezer for 3 months, and can be undone", () => {
  const db = stocked();
  const laks = listKitchen(db).find((i) => i.productId === "laks")!;
  const before = freeze(db, laks.id, "2026-10-27")!;
  const frozen = listKitchen(db).find((i) => i.id === laks.id)!;
  assert.deepEqual([frozen.location, frozen.expires], ["frost", addDays("2026-10-27", 90)]);
  unfreeze(db, laks.id, before);
  assert.deepEqual([listKitchen(db).find((i) => i.id === laks.id)!.location], ["køl"]);
});

test("only fresh items expire", () => {
  const [laks] = listKitchen(stocked()).filter((i) => i.productId === "laks");
  assert.equal(isExpired(laks!, "2026-10-28"), false);
  assert.equal(isExpired(laks!, "2026-10-29"), true);
  assert.equal(isExpired({ ...laks!, location: "frost" }, "2026-12-01"), false);
});

test("'Frys i dag' warns about fresh items that expire before the dish that uses them", () => {
  const db = stocked(); // bought Monday 26 Oct: laks good until Wed 28, okse until Wed 28
  const kitchen = listKitchen(db);
  const monday = new Date("2026-10-26T00:00:00Z");
  const meals = [
    { day: "onsdag", title: "Chili", status: "planned", ingredients: [{ name: "okse", qty: 400, unit: "g" as const, productId: "okse" }] },
    { day: "torsdag", title: "Laks i ovn", status: "planned", ingredients: [{ name: "laks", qty: 250, unit: "g" as const, productId: "laks" }] },
    { day: "fredag", title: "Risret", status: "planned", ingredients: [{ name: "ris", qty: 200, unit: "g" as const, productId: "ris" }] },
  ];
  const alerts = freezeAlerts(meals, monday, kitchen, "2026-10-27");
  assert.deepEqual(alerts.map((a) => `${a.name} til ${a.mealTitle} (${a.day})`), ["Laksefilet til Laks i ovn (torsdag)"]);

  // Once frozen, or once the dish is made, no more warning.
  freeze(db, kitchen.find((k) => k.productId === "laks")!.id, "2026-10-27");
  assert.deepEqual(freezeAlerts(meals, monday, listKitchen(db), "2026-10-27"), []);
  assert.deepEqual(freezeAlerts(meals.map((m) => ({ ...m, status: "done" })), monday, kitchen, "2026-10-27"), []);
  // Too late to freeze once it has expired.
  assert.deepEqual(freezeAlerts(meals, monday, kitchen, "2026-10-29").filter((a) => a.name === "Laksefilet"), []);
});

test("the Køkken text reads like you would say it", () => {
  const db = openDb(":memory:");
  replaceKitchen(db, [
    { id: "a", name: "Løg", qty: 2, unit: "stk", location: "skab", category: "grønt" },
    { id: "b", name: "Hakket oksekød", qty: 300, unit: "g", location: "frost", category: "frost" },
    { id: "c", name: "Ris", qty: 1500, unit: "g", location: "skab", category: "holdbart" },
  ], "2026-10-25");
  assert.equal(kitchenText(listKitchen(db)), "300 g hakket oksekød i fryseren\n2 løg\n1,5 kg ris");
});

test("replacing from text keeps a known item's expiry and gives new ones the category's", () => {
  const db = stocked();
  const ids = replaceKitchen(db, [
    { id: "k1", name: "Laksefilet", qty: 250, unit: "g", location: "køl", category: "fisk" },
    { id: "k2", name: "Æg", qty: 6, unit: "stk", location: "køl", category: "køl" },
  ], "2026-10-27");
  const items = listKitchen(db);
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.name === "Laksefilet")!.expires, "2026-10-28"); // kept from the tick
  assert.equal(items.find((i) => i.name === "Laksefilet")!.productId, "laks");
  assert.equal(items.find((i) => i.name === "Æg")!.expires, "2026-11-10"); // 14 days
  assert.equal(ids.size, 2);
});

test("anything in the freezer keeps like frozen food, even if Claude calls it minced meat", () => {
  const db = openDb(":memory:");
  replaceKitchen(db, [{ id: "k1", name: "Hakket oksekød", qty: 300, unit: "g", location: "frost", category: "hakket" }], "2026-10-24");
  assert.equal(listKitchen(db)[0]!.expires, addDays("2026-10-24", 90));
});
