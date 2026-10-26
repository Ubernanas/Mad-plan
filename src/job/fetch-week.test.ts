import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Household } from "../config.ts";
import { openDb } from "../db.ts";
import type { HttpClient } from "../fetch/http.ts";
import { fetchWeek } from "./fetch-week.ts";
import { SourceChangedError } from "./store.ts";

const FRIDAY = () => new Date("2026-10-23T12:00:00Z");

function html(name: string) {
  return readFileSync(new URL(`../../fixtures/html/${name}`, import.meta.url), "utf8");
}

function fakeHttp(pages: Record<string, string>): HttpClient {
  let count = 0;
  return {
    async get(url) {
      count++;
      return pages[url] ?? "<html></html>";
    },
    isBlocked: () => false,
    pagesFetched: () => count,
  };
}

const household: Household = {
  persons: 2,
  weeklyBudgetDkk: 460,
  dinnersPerWeek: 7,
  dishOptions: 12,
  diet: { glutenFree: true, lactoseFree: true, other: "" },
  stores: ["Netto", "REMA 1000"],
  storeMode: "fixed",
  fixedStore: "Netto",
  fetchCron: "0 14 * * 0",
  planCron: "0 18 * * 0",
  timezone: "Europe/Copenhagen",
  oauthTokenExpires: "2027-10-01",
};

const NETTO_PAGES = {
  "https://goma.gg/tilbud/kylling?store=netto": html("kylling__netto.html"),
  "https://goma.gg/tilbud/ris?store=netto": html("ris__netto.html"),
};

test("saves the chosen store's products for the plan week", async () => {
  const db = openDb(":memory:");
  const summary = await fetchWeek({
    db, http: fakeHttp(NETTO_PAGES), household, items: ["kylling", "ris", "laks"], now: FRIDAY, log: () => {},
  });

  assert.equal(summary.week, "2026-W43");
  assert.deepEqual(summary.counts, { kylling: 58, ris: 8, laks: 0 });
  assert.deepEqual(summary.missing, ["laks"]);
  assert.equal(summary.saved, 66);

  const rows = db.prepare("SELECT store, query, on_offer FROM products WHERE week = ?").all("2026-W43") as { store: string; query: string; on_offer: number }[];
  assert.equal(rows.length, 66);
  assert.ok(rows.every((r) => r.store === "Netto"));
  assert.equal(rows.filter((r) => r.on_offer).length, 10);

  const fetch = db.prepare("SELECT store, store_mode, missing_json FROM fetches WHERE week = ?").get("2026-W43");
  assert.deepEqual(fetch, { store: "Netto", store_mode: "fixed", missing_json: '["laks"]' });
});

test("the store's leaflet end is saved for the plan week; without it the fetch still succeeds", async () => {
  const db = openDb(":memory:");
  const pages = { ...NETTO_PAGES, "https://etilbudsavis.dk/Netto": html("etilbudsavis__netto.html") };
  const sunday = () => new Date("2026-10-25T13:00:00Z"); // plan week 2026-W44
  const summary = await fetchWeek({ db, http: fakeHttp(pages), household, items: ["kylling", "ris"], now: sunday, log: () => {} });
  assert.deepEqual(summary.leaflet, { store: "Netto", label: "Netto uge 44", lastDay: "2026-10-30" });
  const saved = db.prepare("SELECT value FROM meta WHERE key = 'leaflet:2026-W44'").get() as { value: string };
  assert.equal(JSON.parse(saved.value).lastDay, "2026-10-30");

  const without = await fetchWeek({ db: openDb(":memory:"), http: fakeHttp(NETTO_PAGES), household, items: ["kylling", "ris"], now: sunday, log: () => {} });
  assert.equal(without.leaflet, null);
  assert.equal(without.saved, 66);
});

test("running twice in a week replaces the products instead of duplicating them", async () => {
  const db = openDb(":memory:");
  const run = () => fetchWeek({ db, http: fakeHttp(NETTO_PAGES), household, items: ["kylling", "ris"], now: FRIDAY, log: () => {} });
  await run();
  await run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n, 66);
});

test("a product found by two search words is stored once", async () => {
  const db = openDb(":memory:");
  const pages = { ...NETTO_PAGES, "https://goma.gg/tilbud/kyllingebryst?store=netto": html("kylling__netto.html") };
  const summary = await fetchWeek({ db, http: fakeHttp(pages), household, items: ["kylling", "kyllingebryst"], now: FRIDAY, log: () => {} });
  assert.equal(summary.saved, 58);
});

test("stops before saving when more than half of the item list is empty", async () => {
  const db = openDb(":memory:");
  await assert.rejects(
    fetchWeek({ db, http: fakeHttp(NETTO_PAGES), household, items: ["kylling", "laks", "æg"], now: FRIDAY, log: () => {} }),
    SourceChangedError,
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n, 0);
  assert.equal(db.prepare("SELECT 1 FROM fetches").get(), undefined);
});

test("exactly half empty is still accepted", async () => {
  const db = openDb(":memory:");
  const summary = await fetchWeek({ db, http: fakeHttp(NETTO_PAGES), household, items: ["kylling", "laks"], now: FRIDAY, log: () => {} });
  assert.deepEqual(summary.missing, ["laks"]);
});
