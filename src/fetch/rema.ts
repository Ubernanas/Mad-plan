// Prices from REMA 1000's web shop (shop.rema1000.dk). Each food category page is
// server-rendered and embeds its products as Nuxt data: name, size, regular price,
// and the offer price with its dates. When REMA changes the page, update
// fixtures/html/rema__*.html and this file together.

import type { HttpClient } from "./http.ts";
import { parseSize, type Unit } from "./size.ts";

export const REMA_STORE = "REMA 1000";
const BASE = "https://shop.rema1000.dk/varer/";

/**
 * The food categories fetched every week: what dinners are made of. Sweets, drinks,
 * bread for breakfast and the like are left out. Keep in step with config/ingredients.json.
 */
export const REMA_CATEGORIES = [
  "frugt-gront/agurk-tomat-peberfrugt",
  "frugt-gront/blommer-fersken-nektariner-kiwi",
  "frugt-gront/friske-faerdige-salater",
  "frugt-gront/grov-gront",
  "frugt-gront/kal",
  "frugt-gront/kartofler-log",
  "frugt-gront/krydderurter-smagsforstaerkere",
  "frugt-gront/melon-baer-vindruer-eksotisk-frugt",
  "frugt-gront/paere-aeble-banan-citrusfrugt",
  "frugt-gront/saeson",
  "frugt-gront/salater-fint-gront-avocado",
  "kod-fisk-fjerkrae/fisk-skaldyr",
  "kod-fisk-fjerkrae/gris",
  "kod-fisk-fjerkrae/hakket-kod",
  "kod-fisk-fjerkrae/kylling",
  "kod-fisk-fjerkrae/lam",
  "kod-fisk-fjerkrae/oksekod",
  "kod-fisk-fjerkrae/plantebaserede-alternativer",
  "kol/bacon-toppings",
  "kol/dej",
  "kol/dressing-saucer",
  "kol/fisk-sild-skaldyr",
  "kol/frisk-pasta",
  "kol/palaeg",
  "kol/plantebaserede-produkter",
  "kol/polser",
  "frost/fisk-skaldyr",
  "frost/grontsager-frugt-baer",
  "frost/kartofler",
  "frost/kod-fjerkrae",
  "kolonial/dressing",
  "kolonial/fiskekonserves",
  "kolonial/ketchup-remoulade-mayonnaise-mv",
  "kolonial/konserves-survarer",
  "kolonial/krydderier",
  "kolonial/mel-sukker-bagning",
  "kolonial/nodder-torret-frugt",
  "kolonial/ris-pasta-mv",
  "kolonial/saucer-nem-mad",
  "kolonial/tex-mex",
  "mejeri/aeg",
  "mejeri/flode-mv",
  "mejeri/maelk-mv",
  "mejeri/smor-fedtstoffer",
  "mejeri/syrnede-produkter",
  "mejeri/yoghurt-mv",
  "ost-mv/hard-ost",
  "ost-mv/madlavningsost-mv",
  "ost-mv/plantebaseret",
  "ost-mv/skaereost",
  "ost-mv/smoreost",
  "ost-mv/specialost",
  "brod-bavinchi/brod",
  "brod-bavinchi/fast-food-brod",
] as const;

/** The category pages with the core of every week; if most of them come back empty, the page has changed. */
export const REMA_CORE = ["kod-fisk-fjerkrae/kylling", "kod-fisk-fjerkrae/hakket-kod", "kod-fisk-fjerkrae/gris", "kod-fisk-fjerkrae/fisk-skaldyr"];

export type RemaProduct = {
  /** "r400466": REMA's product id, prefixed so it never meets an old Goma id. */
  id: string;
  /** "kod-fisk-fjerkrae/hakket-kod" */
  category: string;
  name: string;
  packageAmount: number | null;
  unit: Unit | null;
  /** The price on the plan week's Monday. */
  price: number;
  /** The regular price, when it is on offer and REMA shows it. */
  normalPrice: number | null;
  /** Price per kg or per litre. */
  perKg: number | null;
  onOffer: boolean;
  /** Last day of the offer (YYYY-MM-DD), when on offer. */
  offerLastDay: string | null;
};

export const categoryUrl = (category: string) => BASE + category;

/**
 * The HTTP limits for a REMA run: all the category pages plus robots.txt, a few seconds
 * apart. REMA's robots.txt allows everything; it is still one run a week, one page at a time.
 */
export const REMA_HTTP = { maxPages: REMA_CATEGORIES.length + 5, minDelayMs: 2_000, maxDelayMs: 4_000 };

/** Fetches every category page. Pages the client skipped (blocked, failed) are listed in `failed`. */
export async function fetchRema(http: HttpClient, monday: Date): Promise<{ products: RemaProduct[]; counts: Record<string, number>; failed: string[] }> {
  const products: RemaProduct[] = [];
  const counts: Record<string, number> = {};
  const failed: string[] = [];
  for (const category of REMA_CATEGORIES) {
    const html = await http.get(categoryUrl(category));
    if (html === null) {
      failed.push(category);
      counts[category] = 0;
      continue;
    }
    const found = parseRemaPage(html, monday, category);
    counts[category] = found.length;
    products.push(...found);
  }
  return { products, counts, failed };
}

type RawPrice = {
  price: number;
  is_advertised?: boolean;
  is_campaign?: boolean;
  starting_at?: string;
  ending_at?: string;
  compare_unit?: string;
  compare_unit_price?: number;
};
type RawProduct = { id: number; name: string; underline?: string; prices: RawPrice[]; category?: { slug?: string }; department?: { slug?: string } };

/** The products embedded in a category page, priced for the week that starts on `monday`. */
export function parseRemaPage(html: string, monday: Date, category?: string): RemaProduct[] {
  const data = nuxtData(html);
  if (!data) return [];
  const seen = new Set<number>();
  const products: RemaProduct[] = [];
  for (let i = 0; i < data.length; i++) {
    const raw = data[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("prices" in raw) || !("name" in raw) || !("underline" in raw)) continue;
    const product = toProduct(readProduct(data, raw as Record<string, unknown>), monday, category);
    if (product && !seen.has(Number(product.id.slice(1)))) {
      seen.add(Number(product.id.slice(1)));
      products.push(product);
    }
  }
  return products;
}

function toProduct(raw: RawProduct, monday: Date, category?: string): RemaProduct | null {
  if (typeof raw.id !== "number" || typeof raw.name !== "string" || !Array.isArray(raw.prices) || raw.prices.length === 0) return null;
  const current = priceOn(raw.prices, monday);
  if (!current || typeof current.price !== "number") return null;
  const onOffer = !!(current.is_campaign || current.is_advertised);
  const regular = raw.prices.find((p) => !p.is_campaign && !p.is_advertised && typeof p.price === "number");
  const normalPrice = onOffer && regular && regular.price > current.price ? regular.price : null;

  // "400 GR. / REMA 1000": the size comes before the brand.
  let size = parseSize((raw.underline ?? "").split("/")[0]!.trim());
  const per = typeof current.compare_unit_price === "number" && /^(kg|l|ltr)$/i.test(current.compare_unit ?? "") ? current.compare_unit_price : null;
  if (!size && per) size = { amount: round((current.price / per) * 1000), unit: /^kg$/i.test(current.compare_unit!) ? "g" : "ml" };
  const slug = raw.department?.slug && raw.category?.slug ? `${raw.department.slug}/${raw.category.slug}` : category ?? "";

  return {
    id: `r${raw.id}`,
    category: slug,
    name: clean(raw.name),
    packageAmount: size?.amount ?? null,
    unit: size?.unit ?? null,
    price: current.price,
    normalPrice,
    perKg: per ?? (size && size.unit !== "stk" ? round((current.price / size.amount) * 1000) : null),
    onOffer,
    offerLastDay: onOffer && current.ending_at && !current.ending_at.startsWith("2099") ? current.ending_at.slice(0, 10) : null,
  };
}

/**
 * The price in force on the plan week's Monday. A page fetched before the week starts
 * also shows the offer that is about to end; then the next price is the one that counts.
 * REMA's leaflet "15.11-21.11" has ending_at 21.11 00:00, so the end date is the last day.
 */
function priceOn(prices: RawPrice[], monday: Date): RawPrice | undefined {
  const day = monday.toISOString().slice(0, 10);
  const valid = (p: RawPrice) => (!p.starting_at || p.starting_at.slice(0, 10) <= day) && (!p.ending_at || p.ending_at.slice(0, 10) >= day);
  return prices.find(valid) ?? prices.find((p) => !p.starting_at || p.starting_at.slice(0, 10) > day) ?? prices[0];
}

/** "HK. OKSEKØD  4-7%" → "HK. OKSEKØD 4-7%". */
function clean(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------- Nuxt's payload: a flat array where objects point at other entries by index ----------

function nuxtData(html: string): unknown[] | null {
  const match = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]!) as unknown;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Only the fields a product needs: following every reference walks the whole page many times over. */
function readProduct(data: unknown[], raw: Record<string, unknown>): RawProduct {
  const at = (ref: unknown) => (typeof ref === "number" && ref >= 0 ? data[ref] : undefined);
  const object = (ref: unknown) => {
    const value = at(ref);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  };
  const flat = (ref: unknown) => Object.fromEntries(Object.entries(object(ref)).map(([key, i]) => [key, at(i)]));
  const prices = at(raw.prices);
  return {
    id: at(raw.id) as number,
    name: at(raw.name) as string,
    underline: at(raw.underline) as string | undefined,
    prices: Array.isArray(prices) ? prices.map((i) => flat(i) as RawPrice) : [],
    department: { slug: at(object(raw.department).slug) as string | undefined },
    category: { slug: at(object(raw.category).slug) as string | undefined },
  };
}
