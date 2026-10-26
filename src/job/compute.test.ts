import assert from "node:assert/strict";
import { test } from "node:test";
import type { Section } from "../config.ts";
import { computePlan, formatSize, sectionFor, selectDishes, setDayStatus, weekStarted, type ClaudeResponse, type Dish, type Product } from "./compute.ts";

const SECTIONS: Record<string, Section> = { ris: "kolonial", "hakket-oksekød": "kød og fisk", løg: "frugt og grønt" };
const META = { week: "2026-W44", store: "Netto", createdAt: "2026-10-25T17:00:00.000Z", weeklyBudgetDkk: 460, dinnersPerWeek: 2, wishes: "", leafletLastDay: null };

function product(id: string, extra: Partial<Product>): Product {
  return { id, name: id, query: "ris", packageAmount: 1000, unit: "g", price: 10, onOffer: false, perKg: null, estimate: false, ...extra };
}

const PRODUCTS = new Map<string, Product>([
  ["ris", product("ris", { name: "Basmatiris", packageAmount: 1000, price: 20 })],
  ["okse", product("okse", { name: "Hakket oksekød 8-12%", query: "hakket-oksekød", packageAmount: 400, price: 35, onOffer: true })],
  ["løg", product("løg", { name: "Løg", query: "løg", packageAmount: 1000, price: 12, estimate: true })],
  ["bouillon", product("bouillon", { name: "Hønsebouillon", query: "ris", packageAmount: 10, unit: "stk", price: 15 })],
]);

function dish(title: string, suggested: boolean, ingredients: Dish["ingredients"], servings = 2): Dish {
  return { title, description: `${title}.`, suggested, servings, timeMinutes: 30, steps: ["Lav maden."], ingredients };
}

function response(): ClaudeResponse {
  return {
    storeReason: "Netto har flest tilbud på kød.",
    dietRespected: ["glutenfri"],
    notes: [],
    dishes: [
      dish("Chili", true, [
        { name: "hakket oksekød", qty: 400, unit: "g", productId: "okse", checkLabel: false },
        { name: "løg", qty: 150, unit: "g", productId: "løg", checkLabel: false },
        { name: "ris", qty: 300, unit: "g", productId: "ris", checkLabel: false },
        { name: "salt", qty: 5, unit: "g", basis: true, checkLabel: false },
      ], 4),
      dish("Løgsuppe", false, [
        { name: "løg", qty: 800, unit: "g", productId: "løg", checkLabel: false },
        { name: "bouillon", qty: 2, unit: "stk", productId: "bouillon", checkLabel: true },
      ]),
      dish("Risret", true, [
        { name: "hakket oksekød", qty: 200, unit: "g", productId: "okse", checkLabel: false },
        { name: "ris", qty: 300, unit: "g", productId: "ris", checkLabel: false },
        { name: "bouillon", qty: 1, unit: "stk", productId: "bouillon", checkLabel: true },
      ]),
    ],
  };
}

const plan = () => computePlan(response(), PRODUCTS, SECTIONS, META);

test("Claude's suggested dishes are chosen from the start, on days in list order", () => {
  const p = plan();
  assert.deepEqual(p.selected, [0, 2]);
  assert.deepEqual(p.meals.map((m) => [m.day, m.title]), [["mandag", "Chili"], ["tirsdag", "Risret"]]);
  assert.equal(p.options.length, 3);
});

test("one line per product for the chosen dishes, rounded up to whole packages", () => {
  const p = plan();
  const okse = p.shoppingList.find((l) => l.productId === "okse")!;
  assert.equal(okse.usedAmount, 600);
  assert.equal(okse.packages, 2); // 600 g from 400 g packs
  assert.equal(okse.price, 70);
  const ris = p.shoppingList.find((l) => l.productId === "ris")!;
  assert.equal(ris.packages, 1); // 600 g from a 1 kg pack
  assert.equal(p.shoppingList.length, 4); // salt is a basis item
  assert.equal(p.totalPurchaseCost, 70 + 20 + 12 + 15);
});

test("leftovers are bought minus used, valued at the price paid", () => {
  const p = plan();
  const byId = Object.fromEntries(p.leftovers.map((l) => [l.productId, l]));
  assert.deepEqual(byId.okse, { productId: "okse", item: "Hakket oksekød 8-12%", amount: 200, unit: "g", value: 17.5 }); // 800 bought, 600 used
  assert.equal(byId.ris!.value, 8); // 400 g of a 20 kr. kilo
  assert.equal(byId.løg!.value, 10.2); // 850 g of a 12 kr. kilo
  assert.equal(byId.bouillon!.value, 13.5); // 9 of 10 cubes
  assert.equal(p.leftoverValue, 49.2);
  assert.deepEqual(p.leftovers.map((l) => l.productId), ["okse", "bouillon", "løg", "ris"]); // largest first
});

test("a product used up exactly leaves no leftover line", () => {
  const p = selectDishes(plan(), [1]); // the soup: 800 g onions of 1 kg, 2 of 10 cubes
  assert.deepEqual(p.leftovers.map((l) => l.productId).sort(), ["bouillon", "løg"]);
  const exact = selectDishes({ ...plan(), options: [{ ...plan().options[1]!, ingredients: [{ name: "løg", qty: 1000, unit: "g", productId: "løg", checkLabel: false }] }] }, [0]);
  assert.deepEqual(exact.leftovers, []);
  assert.equal(exact.leftoverValue, 0);
});

test("every option has its own cost, chosen or not", () => {
  const [chili, suppe, risret] = plan().options;
  // 400/400*35 + 150/1000*12 + 300/1000*20 = 35 + 1.8 + 6
  assert.equal(chili!.mealCost, 42.8);
  assert.equal(chili!.pricePerPortion, 10.7);
  // 800/1000*12 + 2/10*15 = 9.6 + 3
  assert.equal(suppe!.mealCost, 12.6);
  // 200/400*35 + 300/1000*20 + 1/10*15 = 17.5 + 6 + 1.5
  assert.equal(risret!.mealCost, 25);
});

test("choosing other dishes recomputes days, list and price without Claude", () => {
  const p = selectDishes(plan(), [2, 1]);
  assert.deepEqual(p.selected, [1, 2]);
  assert.deepEqual(p.meals.map((m) => [m.day, m.title]), [["mandag", "Løgsuppe"], ["tirsdag", "Risret"]]);
  const lines = Object.fromEntries(p.shoppingList.map((l) => [l.productId, l]));
  assert.equal(lines.okse!.packages, 1);
  assert.equal(lines.bouillon!.usedAmount, 3);
  assert.equal(lines.løg!.packages, 1);
  assert.equal(p.totalPurchaseCost, 35 + 20 + 12 + 15);
});

test("choosing ignores unknown ids and duplicates, and refuses more than 7", () => {
  assert.deepEqual(selectDishes(plan(), [0, 0, 99]).selected, [0]);
  assert.throws(() => selectDishes({ ...plan(), options: Array.from({ length: 8 }, (_, i) => ({ ...plan().options[0]!, id: i })) }, [0, 1, 2, 3, 4, 5, 6, 7]));
});

/** A plan with five chosen dishes, to move around the week. */
function weekPlan() {
  const options = Array.from({ length: 6 }, (_, id) => ({ ...plan().options[0]!, id, title: `Ret ${id}` }));
  return selectDishes({ ...plan(), options }, [0, 1, 2, 3, 4]);
}
const week = (p: ReturnType<typeof weekPlan>) => p.days.map((d) => `${d.day.slice(0, 3)}:${d.status === "skipped" ? "-" : d.mealId ?? "·"}${d.status === "done" ? "✓" : ""}`).join(" ");

test("the chosen dishes fill the days from Monday", () => {
  assert.equal(week(weekPlan()), "man:0 tir:1 ons:2 tor:3 fre:4 lør:· søn:·");
});

test("'Lavet' marks the day's dish done", () => {
  const p = setDayStatus(weekPlan(), "mandag", "done");
  assert.equal(week(p), "man:0✓ tir:1 ons:2 tor:3 fre:4 lør:· søn:·");
  assert.equal(p.meals[0]!.status, "done");
});

test("skipping a day moves its dish and the rest one day on; the last drops out", () => {
  const full = selectDishes({ ...weekPlan(), options: Array.from({ length: 7 }, (_, id) => ({ ...plan().options[0]!, id, title: `Ret ${id}` })) }, [0, 1, 2, 3, 4, 5, 6]);
  const p = setDayStatus(setDayStatus(full, "mandag", "done"), "tirsdag", "skipped");
  assert.equal(week(p), "man:0✓ tir:- ons:1 tor:2 fre:3 lør:4 søn:5");
  assert.deepEqual(p.dropped, [6]);
  assert.equal(p.meals.find((m) => m.day === "onsdag")!.title, "Ret 1");
});

test("undo puts a skipped day or a done dish back to planned", () => {
  const skipped = setDayStatus(weekPlan(), "tirsdag", "skipped");
  assert.equal(week(setDayStatus(skipped, "tirsdag", "planned")), week(weekPlan()));
  const done = setDayStatus(weekPlan(), "mandag", "done");
  assert.equal(week(setDayStatus(done, "mandag", "planned")), week(weekPlan()));
});

test("a day without a dish, or one already done, cannot be skipped", () => {
  assert.throws(() => setDayStatus(weekPlan(), "lørdag", "skipped"));
  assert.throws(() => setDayStatus(setDayStatus(weekPlan(), "mandag", "done"), "mandag", "skipped"));
  assert.throws(() => setDayStatus(weekPlan(), "lørdag", "done"));
});

test("day status leaves the shopping list and prices as planned, and marks the week as started", () => {
  const before = weekPlan();
  const after = setDayStatus(before, "mandag", "skipped");
  assert.deepEqual(after.shoppingList, before.shoppingList);
  assert.equal(after.totalPurchaseCost, before.totalPurchaseCost);
  assert.equal(weekStarted(before), false);
  assert.equal(weekStarted(after), true);
});

test("offers needed after the leaflet ends are marked, with a note on what to buy by when", () => {
  // Week 44: Monday 26 Oct. Netto's leaflet runs to Friday 30 Oct.
  const options = Array.from({ length: 7 }, (_, id) => ({
    ...plan().options[0]!, id, title: `Ret ${id}`,
    ingredients: id === 5 ? [{ name: "hakket oksekød", qty: 400, unit: "g" as const, productId: "okse", checkLabel: false }]
      : [{ name: "ris", qty: 100, unit: "g" as const, productId: "ris", checkLabel: false }],
  }));
  const p = selectDishes({ ...plan(), options, leafletLastDay: "2026-10-30" }, [0, 1, 2, 3, 4, 5, 6]);
  const okse = p.shoppingList.find((l) => l.productId === "okse")!; // on offer, used Saturday
  const ris = p.shoppingList.find((l) => l.productId === "ris")!; // regular price
  assert.equal(okse.buyBefore, "2026-10-30");
  assert.equal(okse.buyEarly, true);
  assert.equal(ris.buyBefore, null);
  assert.equal(ris.buyEarly, false);
  assert.equal(p.buyNote, "Køb hakket oksekød 8-12% til lørdag senest fredag, og frys det ned.");
});

test("things that keep are told the offer ends; only meat and fish are told to freeze", () => {
  const products = new Map(PRODUCTS);
  products.set("ris", { ...PRODUCTS.get("ris")!, onOffer: true });
  const r = response();
  const p = computePlan(r, products, SECTIONS, { ...META, leafletLastDay: "2026-10-25" }); // Sunday of the week before
  assert.equal(p.buyNote, "Køb hakket oksekød 8-12% til mandag og tirsdag senest søndag, og frys det ned. Tilbuddet på basmatiris slutter søndag.");
});

test("no note when the offers are used in time, or the leaflet's end is unknown", () => {
  assert.equal(selectDishes({ ...plan(), leafletLastDay: "2026-10-30" }, [0, 2]).buyNote, null); // Mon and Tue
  assert.equal(plan().buyNote, null);
  assert.equal(plan().shoppingList.find((l) => l.productId === "okse")!.buyBefore, null);
});

test("the plan keeps the products it uses, so choosing never needs the database", () => {
  const p = plan();
  assert.deepEqual(Object.keys(p.products).sort(), ["bouillon", "løg", "okse", "ris"]);
  assert.equal(p.products.okse!.section, "kød og fisk");
});

test("price source, check label and package size per line", () => {
  const lines = Object.fromEntries(plan().shoppingList.map((l) => [l.productId, l]));
  assert.equal(lines.okse!.priceSource, "offer");
  assert.equal(lines.ris!.priceSource, "regular");
  assert.equal(lines.løg!.priceSource, "estimate");
  assert.equal(lines.bouillon!.checkLabel, true);
  assert.equal(lines.ris!.packageSize, "1 kg");
  assert.equal(lines.bouillon!.packageSize, "10 stk");
});

test("the list is sorted by section in store order, then by name", () => {
  assert.deepEqual(plan().shoppingList.map((l) => l.item), ["Løg", "Hakket oksekød 8-12%", "Basmatiris", "Hønsebouillon"]);
});

test("an exact package fit does not round up through float noise", () => {
  const products = new Map([["x", product("x", { packageAmount: 0.3, unit: "stk" })]]);
  const r = response();
  r.dishes = [dish("X", true, [
    { name: "x", qty: 0.1, unit: "stk", productId: "x", checkLabel: false },
    { name: "x", qty: 0.2, unit: "stk", productId: "x", checkLabel: false },
  ])];
  assert.equal(computePlan(r, products, SECTIONS, META).shoppingList[0]!.packages, 1);
});

test("frozen products go in the frozen section whatever their search word", () => {
  assert.equal(sectionFor({ name: "Frosne ærter", query: "løg" }, SECTIONS), "frost");
  assert.equal(sectionFor({ name: "Laksefilet, frost", query: "laks" }, SECTIONS), "frost");
  assert.equal(sectionFor({ name: "Løg", query: "løg" }, SECTIONS), "frugt og grønt");
});

test("formatSize writes Danish sizes", () => {
  assert.equal(formatSize(1500, "g"), "1,5 kg");
  assert.equal(formatSize(400, "g"), "400 g");
  assert.equal(formatSize(1000, "ml"), "1 l");
  assert.equal(formatSize(6, "stk"), "6 stk");
});
