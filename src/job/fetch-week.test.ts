import assert from "node:assert/strict";
import { test } from "node:test";
import { loadIngredientRules, type Household } from "../config.ts";
import { openDb, type DB } from "../db.ts";
import type { HttpClient } from "../fetch/http.ts";
import { categoryUrl, REMA_CATEGORIES } from "../fetch/rema.ts";
import type { Recipe } from "../recipes.ts";
import { fetchWeek, unmadeDishes } from "./fetch-week.ts";
import { SourceBlockedError, SourceChangedError } from "./store.ts";

const FRIDAY = () => new Date("2026-10-23T12:00:00Z");

type Fake = { id: number; name: string; size: string; price: number; offer?: { price: number; lastDay: string } };

/** A category page as REMA serves it: products as Nuxt data, where values point at other entries. */
function remaPage(category: string, products: Fake[]): string {
  const data: unknown[] = [];
  const push = (value: unknown) => data.push(value) - 1;
  for (const p of products) {
    const prices = p.offer
      ? [
          push({ price: push(p.offer.price), is_campaign: push(true), is_advertised: push(true), ending_at: push(`${p.offer.lastDay}T00:00:00+00:00`) }),
          push({ price: push(p.price), is_campaign: push(false), is_advertised: push(false) }),
        ]
      : [push({ price: push(p.price), is_campaign: push(false), is_advertised: push(false) })];
    const [department, slug] = category.split("/");
    data.push({
      id: push(p.id), name: push(p.name), underline: push(`${p.size} / REMA 1000`), prices: push(prices),
      department: push({ slug: push(department) }), category: push({ slug: push(slug) }),
    });
  }
  return `<html><script type="application/json" id="__NUXT_DATA__">${JSON.stringify(data)}</script></html>`;
}

const PAGES: Record<string, Fake[]> = {
  "kod-fisk-fjerkrae/kylling": [
    { id: 1, name: "KYLLINGEBRYSTFILET", size: "650 GR.", price: 49, offer: { price: 39, lastDay: "2026-10-24" } },
    { id: 2, name: "HEL KYLLING", size: "1,1 KG.", price: 45 },
  ],
  "kod-fisk-fjerkrae/hakket-kod": [{ id: 3, name: "HK. OKSEKØD 8-12%", size: "400 GR.", price: 39.95 }],
  "kod-fisk-fjerkrae/gris": [{ id: 4, name: "KOTELETTER", size: "400 GR.", price: 29.95, offer: { price: 25, lastDay: "2026-10-24" } }],
  "kod-fisk-fjerkrae/fisk-skaldyr": [{ id: 5, name: "LAKSEFILETER", size: "225 GR.", price: 43.95, offer: { price: 35, lastDay: "2026-10-31" } }],
  "kolonial/ris-pasta-mv": [{ id: 6, name: "JASMIN RIS", size: "1 KG.", price: 15 }, { id: 7, name: "GRØDRIS", size: "1 KG.", price: 12 }],
  "frugt-gront/kartofler-log": [{ id: 8, name: "LØG", size: "1 KG.", price: 7 }],
};

function fakeHttp(pages: Record<string, Fake[]> = PAGES): HttpClient {
  let count = 0;
  return {
    async get(url) {
      count++;
      const category = REMA_CATEGORIES.find((c) => categoryUrl(c) === url);
      return category ? remaPage(category, pages[category] ?? []) : null;
    },
    blockReason: () => null,
    pagesFetched: () => count,
  };
}

const household: Household = {
  persons: 2,
  weeklyBudgetDkk: 460,
  dinnersPerWeek: 7,
  dishOptions: 12,
  diet: { glutenFree: true, lactoseFree: true, other: "" },
  stores: ["REMA 1000"],
  storeMode: "fixed",
  fixedStore: "REMA 1000",
  planCron: "0 18 * * 0",
  timezone: "Europe/Copenhagen",
  oauthTokenExpires: "2027-10-01",
};

const rules = loadIngredientRules();

test("saves REMA's products for the plan week under their search words, and skips what no dinner uses", async () => {
  const db = openDb(":memory:");
  const summary = await fetchWeek({ db, http: fakeHttp(), household, rules, now: FRIDAY, log: () => {} });

  assert.equal(summary.week, "2026-W43");
  assert.equal(summary.choice.store, "REMA 1000");
  assert.equal(summary.counts["kod-fisk-fjerkrae/kylling"], 2);
  assert.equal(summary.pagesFetched, REMA_CATEGORIES.length);
  assert.equal(summary.saved, 7); // porridge rice is not dinner rice

  const rows = db.prepare("SELECT goma_id, query, price, normal_price, on_offer FROM products WHERE week = ? ORDER BY goma_id").all("2026-W43");
  assert.deepEqual(rows[0], { goma_id: "r1", query: "kylling", price: 39, normal_price: 49, on_offer: 1 });
  assert.ok(!(rows as { goma_id: string }[]).some((r) => r.goma_id === "r7"));

  const fetch = db.prepare("SELECT store, missing_json FROM fetches WHERE week = ?").get("2026-W43") as { store: string; missing_json: string };
  assert.equal(fetch.store, "REMA 1000");
  // Search words with no product this week are priced from earlier weeks.
  assert.ok(JSON.parse(fetch.missing_json).includes("hvidløg"));
  assert.ok(!JSON.parse(fetch.missing_json).includes("kylling"));
});

test("the offers' end date is the day most of them end; without offers there is none", async () => {
  const db = openDb(":memory:");
  const summary = await fetchWeek({ db, http: fakeHttp(), household, rules, now: FRIDAY, log: () => {} });
  assert.deepEqual(summary.leaflet, { store: "REMA 1000", label: "REMA 1000 avisvarer", lastDay: "2026-10-24" });
  const saved = db.prepare("SELECT value FROM meta WHERE key = 'leaflet:2026-W43'").get() as { value: string };
  assert.equal(JSON.parse(saved.value).lastDay, "2026-10-24");

  const plain = Object.fromEntries(Object.entries(PAGES).map(([c, ps]) => [c, ps.map(({ offer: _, ...p }) => p)]));
  const without = await fetchWeek({ db: openDb(":memory:"), http: fakeHttp(plain), household, rules, now: FRIDAY, log: () => {} });
  assert.equal(without.leaflet, null);
});

test("running twice in a week replaces the products instead of duplicating them", async () => {
  const db = openDb(":memory:");
  const run = () => fetchWeek({ db, http: fakeHttp(), household, rules, now: FRIDAY, log: () => {} });
  await run();
  await run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n, 7);
});

test("stops before saving when most of the meat and fish pages are empty", async () => {
  const db = openDb(":memory:");
  const { "kod-fisk-fjerkrae/kylling": _a, "kod-fisk-fjerkrae/gris": _b, "kod-fisk-fjerkrae/fisk-skaldyr": _c, ...rest } = PAGES;
  await assert.rejects(fetchWeek({ db, http: fakeHttp(rest), household, rules, now: FRIDAY, log: () => {} }), SourceChangedError);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n, 0);
  assert.equal(db.prepare("SELECT 1 FROM fetches").get(), undefined);
});

test("a block is reported as REMA refusing, not as a changed source", async () => {
  const db = openDb(":memory:");
  const http = { ...fakeHttp({}), get: async () => null, blockReason: () => "HTTP 429 (Retry-After: 3600)" };
  await assert.rejects(
    fetchWeek({ db, http, household, rules, now: FRIDAY, log: () => {} }),
    (error: Error) => error instanceof SourceBlockedError && error.message === "REMA 1000 afviser hentningen: HTTP 429 (Retry-After: 3600).",
  );
  assert.equal(db.prepare("SELECT 1 FROM fetches").get(), undefined);
});

function recipe(id: number, ingredients: string[], extra: Partial<Recipe> = {}): Recipe {
  return {
    id, kind: "main", name: `Ret ${id}`, category: "Chicken", minutes: 30, servings: 4, rating: 5, reviews: 100,
    ingredients, amounts: ingredients.map(() => "1"), steps: ["Cook.", "Serve."], proteins: ["chicken"], gluten: [], dairy: [], ...extra,
  };
}

test("the cheapest recipes per portion come first, and the estimates are saved for Claude", async () => {
  const db = openDb(":memory:");
  const recipes = [
    recipe(1, ["ground beef", "rice", "onion"], { proteins: ["beef"] }),
    recipe(2, ["chicken breasts", "rice", "onion"]),
    // Garlic and ginger have no price this week: a guess, never a reason to leave it out.
    recipe(3, ["chicken thighs", "garlic", "ginger", "rice"]),
  ];
  const summary = await fetchWeek({ db, http: fakeHttp(), household, recipes, rules, now: FRIDAY, log: () => {} });
  assert.deepEqual(summary.candidates.map((r) => r.id).sort(), [1, 2, 3]);
  const costs = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'candidateCosts:2026-W43'").get() as { value: string }).value) as Record<string, number>;
  assert.ok(costs[2]! < costs[1]!, JSON.stringify(costs)); // chicken on offer is cheaper than beef
  assert.ok(costs[3]! > costs[2]!);
  const ids = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'candidates:2026-W43'").get() as { value: string }).value) as number[];
  assert.deepEqual(ids.sort(), [1, 2, 3]);
});

function savePlan(db: DB, week: string, plan: unknown) {
  db.prepare("INSERT INTO plans (week, store, plan_json, created_at) VALUES (?, 'Netto', ?, 'x')").run(week, JSON.stringify(plan));
}

const LAST_WEEK = {
  options: [
    { title: "Lavet", recipeId: 1 },
    { title: "Sprunget over", recipeId: 2, sideRecipeId: 5 },
    { title: "For meget gluten nu", recipeId: 3 },
    { title: "Claudes egen" },
    { title: "Ikke valgt", recipeId: 4 },
  ],
  selected: [0, 1, 2, 3],
  done: [0],
};

test("the dishes last week's plan didn't get to are the unmade ones, made or unchosen ones are not", () => {
  const db = openDb(":memory:");
  savePlan(db, "2026-W42", LAST_WEEK);
  assert.deepEqual(unmadeDishes(db, "2026-W43"), [
    { title: "Sprunget over", recipeId: 2, sideRecipeId: 5 },
    { title: "For meget gluten nu", recipeId: 3, sideRecipeId: undefined },
  ]);
});

test("only the week's newest plan before this one counts, and only within 4 weeks", () => {
  const plan = (recipeId: number) => ({ options: [{ title: "Ret", recipeId }], selected: [0], done: [] });
  const recipeOf = (db: DB, week: string) => unmadeDishes(db, week).map((d) => d.recipeId);

  const db = openDb(":memory:");
  savePlan(db, "2026-W41", plan(1));
  savePlan(db, "2026-W42", plan(2));
  savePlan(db, "2026-W42", plan(3));
  savePlan(db, "2026-W43", plan(4));
  assert.deepEqual(recipeOf(db, "2026-W43"), [3]); // a rerun of this week's plan sees the same dishes
  assert.deepEqual(recipeOf(db, "2026-W47"), [4]);
  assert.deepEqual(recipeOf(db, "2026-W48"), []);
});

test("a plan from before dishes could be chosen has no unmade dishes", () => {
  const db = openDb(":memory:");
  savePlan(db, "2026-W42", { meals: [{ title: "Gammel" }] });
  assert.deepEqual(unmadeDishes(db, "2026-W43"), []);
});

test("unmade dishes come back first, despite the 4-week rule and a poor rating, if the diet still allows", async () => {
  const db = openDb(":memory:");
  savePlan(db, "2026-W42", LAST_WEEK);
  const dish = (id: number, extra: Partial<Recipe> = {}) => recipe(id, ["chicken", "rice"], extra);
  const recipes = [
    dish(1), dish(2, { rating: 4.5, reviews: 10 }), dish(3, { gluten: ["a", "b", "c"] }), dish(4), dish(6),
    dish(5, { kind: "side", proteins: [], rating: 4.5, reviews: 10 }), dish(7, { kind: "side", proteins: [] }),
  ];
  const logs: string[] = [];
  const summary = await fetchWeek({
    db, http: fakeHttp(), household, recipes, rules, now: FRIDAY, log: (m) => void logs.push(m),
  });
  assert.deepEqual(summary.candidates.map((r) => r.id), [2, 5, 6, 7]);
  assert.ok(logs.includes("Fra sidste plan, ikke lavet: Ret 2, Ret 5."));
});
