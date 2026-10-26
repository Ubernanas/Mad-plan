import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseGomaPage, parsePrice, searchUrl } from "./goma.ts";

function fixture(name: string) {
  return parseGomaPage(readFileSync(new URL(`../../fixtures/html/${name}`, import.meta.url), "utf8"));
}

test("parses every card on a store page, offers included", () => {
  // Header on the page: "58 varer · 10 på tilbud".
  const { products, skipped } = fixture("kylling__netto.html");
  assert.equal(skipped, 0);
  assert.equal(products.length, 58);
  assert.equal(products.filter((p) => p.onOffer).length, 10);
  assert.ok(products.every((p) => p.store === "Netto"));
});

test("reads price, normal price, size and price per kg from an offer card", () => {
  const product = fixture("kylling.html").products.find((p) => p.gomaId === "40910");
  assert.deepEqual(product, {
    gomaId: "40910",
    store: "Nemlig",
    name: "Kylling i chili-teriyakisauce",
    packageAmount: 350,
    unit: "g",
    price: 18,
    normalPrice: 35.75,
    perKg: 51.43,
    onOffer: true,
  });
});

test("a 'Tilbud' with the normal price equal to the price is still marked as offer", () => {
  const product = fixture("kylling__netto.html").products.find((p) => p.gomaId === "23297");
  assert.equal(product?.packageAmount, 400); // written "0.4 kg"
  assert.equal(product?.price, 29.95);
  assert.equal(product?.normalPrice, 29.95);
  assert.equal(product?.onOffer, true);
});

test("a 'Tilbud' without a struck-through price has no normal price", () => {
  const product = fixture("kylling.html").products.find((p) => p.gomaId === "6534");
  assert.equal(product?.store, "365discount");
  assert.equal(product?.normalPrice, null);
  assert.equal(product?.onOffer, true);
});

test("a card without a size keeps the product with null size", () => {
  const product = fixture("hakket-oksekoed.html").products.find((p) => p.gomaId === "48985");
  assert.equal(product?.store, "MENY");
  assert.equal(product?.price, 53.95);
  assert.equal(product?.packageAmount, null);
  assert.equal(product?.unit, null);
  assert.equal(product?.perKg, null);
});

test("regular-price products on a store page are not offers", () => {
  const { products } = fixture("hakkede-tomater__rema1000.html");
  assert.equal(products.length, 6);
  assert.ok(products.every((p) => !p.onOffer && p.normalPrice === null && p.store === "REMA 1000"));
});

test("every parsed product has a sane price and, when sized, a unit", () => {
  for (const name of ["kylling.html", "hakket-oksekoed.html", "kylling__netto.html", "ris__netto.html", "hakkede-tomater__rema1000.html"]) {
    const { products, skipped } = fixture(name);
    assert.equal(skipped, 0, name);
    for (const p of products) {
      assert.ok(p.price > 0 && p.price < 2000, `${name}: ${p.name} ${p.price}`);
      assert.equal(p.packageAmount === null, p.unit === null, `${name}: ${p.name}`);
    }
  }
});

test("a page without products parses to nothing instead of failing", () => {
  assert.deepEqual(parseGomaPage("<html><body>Ny side</body></html>"), { products: [], skipped: 0 });
});

test("parsePrice handles Danish formats", () => {
  assert.equal(parsePrice("18,00 kr"), 18);
  assert.equal(parsePrice("1.299,00 kr"), 1299);
  assert.equal(parsePrice("5 kr"), 5);
  assert.equal(parsePrice("kr"), null);
});

test("searchUrl builds cross-store and per-store URLs", () => {
  assert.equal(searchUrl("laks"), "https://goma.gg/tilbud/laks");
  assert.equal(searchUrl("ris", "netto"), "https://goma.gg/tilbud/ris?store=netto");
});
