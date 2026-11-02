import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Household } from "../config.ts";
import { parseGomaPage, type GomaProduct } from "../fetch/goma.ts";
import type { HttpClient } from "../fetch/http.ts";
import { bestStore, chooseStore, SourceBlockedError, SourceChangedError, storeSavings } from "./store.ts";

const STORES = ["Netto", "Føtex", "Bilka", "Lidl", "REMA 1000", "365discount"];

function product(store: string, price: number, normalPrice: number | null, onOffer = true): GomaProduct {
  return { gomaId: "1", store, name: "x", packageAmount: 500, unit: "g", price, normalPrice, perKg: null, onOffer };
}

function household(extra: Partial<Household> = {}): Household {
  return {
    persons: 2,
    weeklyBudgetDkk: 460,
    dinnersPerWeek: 7,
    dishOptions: 12,
    diet: { glutenFree: true, lactoseFree: true, other: "" },
    stores: STORES,
    storeMode: "cheapest",
    fixedStore: null,
    planCron: "0 18 * * 0",
    timezone: "Europe/Copenhagen",
    oauthTokenExpires: "2027-10-01",
    ...extra,
  };
}

/** Serves fixture pages by URL; anything else is an empty page. */
function fakeHttp(pages: Record<string, string | null>): HttpClient & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url) {
      urls.push(url);
      return url in pages ? pages[url]! : "<html></html>";
    },
    blockReason: () => null,
    pagesFetched: () => urls.length,
  };
}

function html(name: string) {
  return readFileSync(new URL(`../../fixtures/html/${name}`, import.meta.url), "utf8");
}

test("sums normal price minus offer price per store", () => {
  const savings = storeSavings(
    [product("Netto", 25, 41.95), product("Netto", 30, 40), product("Føtex", 50, 60)],
    STORES,
  );
  assert.equal(savings.Netto, 26.95);
  assert.equal(savings.Føtex, 10);
  assert.equal(savings.Bilka, 0);
});

test("offers equal to the normal price, without a normal price, or not on offer count for nothing", () => {
  const savings = storeSavings(
    [product("Netto", 29.95, 29.95), product("Netto", 49, null), product("Netto", 10, 20, false)],
    STORES,
  );
  assert.equal(savings.Netto, 0);
});

test("stores outside the config are ignored", () => {
  const savings = storeSavings([product("Nemlig", 18, 35.75)], STORES);
  assert.equal(savings.Nemlig, undefined);
});

test("the largest saving wins; a tie goes to the store listed first", () => {
  assert.equal(bestStore({ Netto: 10, Føtex: 30, Bilka: 30 }, ["Netto", "Føtex", "Bilka"]), "Føtex");
  assert.equal(bestStore({ Netto: 0, Føtex: 0 }, ["Netto", "Føtex"]), "Netto");
});

test("cheapest mode reads the four protein pages and picks a configured store", async () => {
  const http = fakeHttp({
    "https://goma.gg/tilbud/kylling": html("kylling.html"),
    "https://goma.gg/tilbud/hakket-oksekød": html("hakket-oksekoed.html"),
    "https://goma.gg/tilbud/svinekød": html("kylling.html"),
    "https://goma.gg/tilbud/laks": html("kylling.html"),
  });
  const choice = await chooseStore(http, household());
  assert.equal(http.urls.length, 4);
  assert.ok(STORES.includes(choice.store));
  assert.equal(choice.store, bestStore(choice.savings, STORES));
  assert.ok(Object.values(choice.savings).some((s) => s > 0));
});

test("a protein search with 0 products stops the job", async () => {
  const http = fakeHttp({ "https://goma.gg/tilbud/kylling": html("kylling.html") });
  await assert.rejects(chooseStore(http, household()), SourceChangedError);
});

test("a protein page that could not be fetched is skipped, not fatal", async () => {
  const http = fakeHttp({
    "https://goma.gg/tilbud/kylling": null,
    "https://goma.gg/tilbud/hakket-oksekød": html("hakket-oksekoed.html"),
    "https://goma.gg/tilbud/svinekød": html("kylling.html"),
    "https://goma.gg/tilbud/laks": html("kylling.html"),
  });
  const choice = await chooseStore(http, household(), () => {});
  assert.ok(STORES.includes(choice.store));
});

test("a block stops the store choice at once and says what Goma answered", async () => {
  const http = { ...fakeHttp({ "https://goma.gg/tilbud/kylling": null }), blockReason: () => "HTTP 403" };
  await assert.rejects(chooseStore(http, household()), (error: Error) => {
    assert.ok(error instanceof SourceBlockedError);
    assert.equal(error.message, "Goma afviser hentningen: HTTP 403.");
    return true;
  });
  assert.equal(http.urls.length, 1);
});

test("fixed mode uses fixedStore and fetches nothing", async () => {
  const http = fakeHttp({});
  const choice = await chooseStore(http, household({ storeMode: "fixed", fixedStore: "REMA 1000" }));
  assert.deepEqual(choice, { store: "REMA 1000", slug: "rema1000", mode: "fixed", savings: {} });
  assert.equal(http.urls.length, 0);
});

test("an unknown store in the config fails before anything is fetched", async () => {
  const http = fakeHttp({});
  await assert.rejects(chooseStore(http, household({ stores: ["Netto", "Irma"] })), /Ukendt butik "Irma"/);
  assert.equal(http.urls.length, 0);
});

test("the parsed fixtures give real savings for configured stores", () => {
  const products = [...parseGomaPage(html("kylling.html")).products, ...parseGomaPage(html("hakket-oksekoed.html")).products];
  const savings = storeSavings(products, STORES);
  assert.ok(savings.Netto! > 0);
});
