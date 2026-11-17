import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileRules, loadRemaRules, queryOfProduct } from "./rema-match.ts";
import { parseRemaPage, type RemaProduct } from "./rema.ts";

const page = readFileSync(new URL("../../fixtures/html/rema__hakket-kod.html", import.meta.url), "utf8");

test("reads every product on a category page, with REMA's id, size and price per kg", () => {
  // The page says "Vis 17 resultater"; its offers run 15.-21. november 2026.
  const products = parseRemaPage(page, new Date("2026-11-16"));
  assert.equal(products.length, 17);
  assert.deepEqual(products.find((p) => p.id === "r400171"), {
    id: "r400171", category: "kod-fisk-fjerkrae/hakket-kod", name: "HK. OKSEKØD 8-12%", packageAmount: 400, unit: "g",
    price: 39.95, normalPrice: null, perKg: 99.88, onOffer: false, offerLastDay: null,
  });
});

test("an offer has its regular price and last day; the week after, the regular price counts", () => {
  const offer = parseRemaPage(page, new Date("2026-11-16")).find((p) => p.id === "r400466")!;
  assert.deepEqual([offer.price, offer.normalPrice, offer.onOffer, offer.offerLastDay], [25, 29.95, true, "2026-11-21"]);
  const after = parseRemaPage(page, new Date("2026-11-23")).find((p) => p.id === "r400466")!;
  assert.deepEqual([after.price, after.normalPrice, after.onOffer, after.offerLastDay], [29.95, null, false, null]);
});

test("a page without product data gives no products", () => {
  assert.deepEqual(parseRemaPage("<html><body>Vedligeholdelse</body></html>", new Date("2026-11-16")), []);
});

test("REMA's short names find the right ingredient, and other things none", () => {
  const rules = compileRules(loadRemaRules());
  const query = (name: string, category: string) => queryOfProduct({ name, category } as RemaProduct, rules);
  const cases: [string, string, string | null][] = [
    ["HK. OKSEKØD 8-12%", "kod-fisk-fjerkrae/hakket-kod", "hakket-oksekød"],
    ["HK. GRISEKØD 8-12%", "kod-fisk-fjerkrae/hakket-kod", "hakket-svinekød"],
    ["HK. KYLLINGEKØD 4-7%", "kod-fisk-fjerkrae/hakket-kod", "kylling"],
    ["KYLLINGEBRYSTFILET", "kod-fisk-fjerkrae/kylling", "kylling"],
    ["HVIDLØG I NET", "frugt-gront/kartofler-log", "hvidløg"],
    ["RØDLØG", "frugt-gront/kartofler-log", "rødløg"],
    ["LØG", "frugt-gront/kartofler-log", "løg"],
    ["SØDE KARTOFLER", "frugt-gront/kartofler-log", "søde-kartofler"],
    ["HAKKEDE TOMATER", "kolonial/konserves-survarer", "hakkede-tomater"],
    ["ØKO. CHERRYTOMATER", "frugt-gront/agurk-tomat-peberfrugt", "cherrytomater"],
    ["MADLAVNINGSFLØDE 8%", "mejeri/flode-mv", "fløde"],
    ["GRØDRIS", "kolonial/ris-pasta-mv", null],
    ["KYLLINGEPÅLÆG", "kol/palaeg", null],
    ["HONNING MELON", "frugt-gront/melon-baer-vindruer-eksotisk-frugt", null],
    ["SNACK AGURKER", "frugt-gront/agurk-tomat-peberfrugt", null],
  ];
  for (const [name, category, expected] of cases) assert.equal(query(name, category), expected, name);
});

test("every search word in config/rema.json is one the word table knows", async () => {
  const { loadIngredientRules } = await import("../config.ts");
  const known = new Set(loadIngredientRules().flatMap((r) => [r.query, r.glutenFree, r.lactoseFree]).filter(Boolean));
  for (const rule of loadRemaRules()) assert.ok(known.has(rule.query), rule.query);
});
