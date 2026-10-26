// Fetches and parses Goma's server-rendered search pages (goma.gg/tilbud/<vare>).
// When Goma changes its markup, update fixtures/html/ and this file together.

import { parse, type HTMLElement } from "node-html-parser";
import type { HttpClient } from "./http.ts";
import { parseSize, type Unit } from "./size.ts";

export type GomaProduct = {
  gomaId: string;
  store: string;
  name: string;
  packageAmount: number | null;
  unit: Unit | null;
  price: number;
  normalPrice: number | null;
  /** Price per kg or per litre. */
  perKg: number | null;
  onOffer: boolean;
};

export type GomaPage = { products: GomaProduct[]; skipped: number };

const BASE = "https://goma.gg/tilbud/";

export function searchUrl(query: string, storeSlug?: string): string {
  return BASE + query + (storeSlug ? `?store=${storeSlug}` : "");
}

/** Fetches one search page. Null if the client skipped it. */
export async function fetchSearch(http: HttpClient, query: string, storeSlug?: string): Promise<GomaPage | null> {
  const html = await http.get(searchUrl(query, storeSlug));
  return html === null ? null : parseGomaPage(html);
}

export function parseGomaPage(html: string): GomaPage {
  const root = parse(html);
  const products: GomaProduct[] = [];
  let skipped = 0;
  for (const card of root.querySelectorAll(".goma-product-grid > div")) {
    const product = parseCard(card);
    if (product) products.push(product);
    else skipped++;
  }
  return { products, skipped };
}

function parseCard(card: HTMLElement): GomaProduct | null {
  // The card has two links to the product: the image and the text block.
  const links = card.querySelectorAll('a[href^="/varer/"]');
  const info = links[links.length - 1];
  if (!info) return null;

  const gomaId = /-(\d+)$/.exec(info.getAttribute("href") ?? "")?.[1];
  const store = text(info.querySelector("span"));
  const name = text(info.querySelector("h3"));
  const struck = info.querySelector(".line-through");
  const priceElement = info.querySelectorAll(".tabular-nums").find((el) => el !== struck);
  const price = parsePrice(text(priceElement));
  if (!gomaId || !store || !name || price === null) return null;

  const [sizeSpan, perSpan] = info.querySelectorAll("div.text-xs span");
  const size = parseSize(text(sizeSpan));
  const per = /([\d.,]+)\s*kr\/(kg|l)\b/.exec(text(perSpan));

  let perKg = per ? parsePrice(per[1]!) : null;
  if (perKg === null && size && size.unit !== "stk") perKg = round((price / size.amount) * 1000);

  return {
    gomaId,
    store,
    name,
    packageAmount: size?.amount ?? null,
    unit: size?.unit ?? null,
    price,
    normalPrice: struck ? parsePrice(text(struck)) : null,
    perKg,
    onOffer: card.querySelector(".offer-badge") !== null,
  };
}

function text(element: HTMLElement | null | undefined): string {
  return element?.text.replace(/\s+/g, " ").trim() ?? "";
}

/** "18,00 kr" → 18, "1.299,00 kr" → 1299. */
export function parsePrice(value: string): number | null {
  const match = /(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/.exec(value);
  if (!match) return null;
  return Number(`${match[1]!.replace(/\./g, "")}.${match[2] ?? "0"}`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
