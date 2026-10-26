// The kitchen: an estimate of what is at home. Ticked purchases go in with a shelf
// life by category, "Lavet" takes the dish's ingredients out (never below 0), and
// Sunday's text on the Køkken page can replace it all. It is never exact.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Section } from "./config.ts";
import type { DB } from "./db.ts";
import type { Unit } from "./fetch/size.ts";
import { buyKey } from "./job/compute.ts";

export type Location = "køl" | "frost" | "skab";
export type Category = "fisk" | "hakket" | "kød" | "grønt" | "køl" | "holdbart" | "frost";

export type KitchenItem = {
  id: number;
  name: string;
  qty: number;
  unit: Unit;
  location: Location;
  /** Last good day, YYYY-MM-DD. */
  expires: string | null;
  productId: string | null;
  source: string | null;
};

/** What was taken out for a dish, so "Lavet" can be undone exactly. */
export type Move = { id: number; amount: number };

export const SHELF_LIFE_DAYS: Record<Category, number> = {
  fisk: 2, hakket: 2, kød: 3, grønt: 5, køl: 14, holdbart: 180, frost: 90,
};

/** The category decides shelf life and where it is kept. */
export function categoryOf(name: string, section: Section | null): Category {
  const n = name.toLowerCase();
  if (section === "frost" || /frost|frossen|frosne/.test(n)) return "frost";
  if (section === "kød og fisk") {
    if (/laks|torsk|fisk|rejer|sild|makrel|tun\b|kuller|sej|rødspætte/.test(n)) return "fisk";
    if (/hakket|hk\.?\s|fars|frikadelle/.test(n)) return "hakket";
    return "kød";
  }
  if (section === "frugt og grønt") return "grønt";
  if (section === "køl") return "køl";
  return "holdbart";
}

export function locationOf(category: Category, name: string): Location {
  if (category === "frost") return "frost";
  if (category === "holdbart") return "skab";
  if (category === "grønt" && /kartof|løg|hvidløg/i.test(name)) return "skab";
  return "køl";
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today in Copenhagen, YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

type Row = { id: number; name: string; qty: number; unit: Unit; location: Location; expires: string | null; product_id: string | null; source: string | null };
const toItem = (r: Row): KitchenItem => ({
  id: r.id, name: r.name, qty: r.qty, unit: r.unit, location: r.location, expires: r.expires, productId: r.product_id, source: r.source,
});

/** What is in the kitchen, soonest to expire first within each place. */
export function listKitchen(db: DB): KitchenItem[] {
  const rows = db.prepare("SELECT * FROM kitchen WHERE qty > 0 ORDER BY location, expires IS NULL, expires, name").all() as Row[];
  return rows.map(toItem);
}

/** Fresh items past their last good day. Frozen and cupboard items are not checked. */
export function isExpired(item: KitchenItem, today: string): boolean {
  return item.location === "køl" && item.expires !== null && item.expires < today;
}

/** A ticked shopping-list line goes into the kitchen; unticking takes exactly that row out again. */
export function syncPurchase(
  db: DB,
  planId: number,
  line: { productId: string; item: string; packages: number; packageAmount: number; unit: Unit; section: Section },
  checked: boolean,
  day: string,
): void {
  const source = `plan:${planId}:${line.productId}`;
  if (!checked) {
    db.prepare("DELETE FROM kitchen WHERE source = ?").run(source);
    return;
  }
  const category = categoryOf(line.item, line.section);
  db.prepare(`
    INSERT OR IGNORE INTO kitchen (name, qty, unit, location, expires, product_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    line.item, line.packages * line.packageAmount, line.unit, locationOf(category, line.item),
    addDays(day, SHELF_LIFE_DAYS[category]), line.productId, source,
  );
}

// ---------- Units ----------

let unitWeights: Record<string, number> | undefined;
function weights(): Record<string, number> {
  unitWeights ??= JSON.parse(readFileSync(join(import.meta.dirname, "..", "config", "units.json"), "utf8")) as Record<string, number>;
  return unitWeights;
}

/** Grams per piece for a name, from config/units.json ("2 løg" → 150 g each). */
export function gramsPerPiece(name: string): number | null {
  const n = name.toLowerCase();
  const key = Object.keys(weights()).sort((a, b) => b.length - a.length).find((k) => n.includes(k));
  return key ? weights()[key]! : null;
}

/** Converts between units where it makes sense; null where it doesn't. ml and g count as equal. */
export function convert(qty: number, from: Unit, to: Unit, name: string): number | null {
  if (from === to) return qty;
  if (from !== "stk" && to !== "stk") return qty;
  const grams = gramsPerPiece(name);
  if (!grams) return null;
  return from === "stk" ? qty * grams : qty / grams;
}

// ---------- "Lavet" ----------

type Usage = { qty: number; unit: Unit; name: string; productId?: string; kitchenItem?: string; basis?: boolean; buy?: boolean };

/** Takes a dish's ingredients out of the kitchen. Returns what was actually taken, for undo. */
export function consume(db: DB, ingredients: Usage[]): Move[] {
  const moves: Move[] = [];
  const take = db.prepare("UPDATE kitchen SET qty = qty - ? WHERE id = ?");
  db.transaction(() => {
    for (const ing of ingredients) {
      // Unpriced items were ticked into the kitchen under their shopping-list key.
      const productId = ing.productId ?? (ing.buy ? buyKey(ing) : undefined);
      const rows: Row[] = ing.kitchenItem
        ? (db.prepare("SELECT * FROM kitchen WHERE id = ? AND qty > 0").all(kitchenId(ing.kitchenItem)) as Row[])
        : productId
          ? (db.prepare("SELECT * FROM kitchen WHERE product_id = ? AND qty > 0 ORDER BY expires IS NULL, expires").all(productId) as Row[])
          : [];
      let left = ing.qty; // in the ingredient's unit
      for (const row of rows) {
        if (left <= 0) break;
        const wanted = convert(left, ing.unit, row.unit, row.name);
        if (wanted === null) continue;
        const amount = Math.min(row.qty, wanted);
        take.run(amount, row.id);
        moves.push({ id: row.id, amount });
        left -= convert(amount, row.unit, ing.unit, row.name) ?? left;
      }
    }
  })();
  return moves;
}

/** Puts back what consume took. Rows that are gone since are skipped. */
export function restore(db: DB, moves: Move[]): void {
  const put = db.prepare("UPDATE kitchen SET qty = qty + ? WHERE id = ?");
  db.transaction(() => {
    for (const move of moves) put.run(move.amount, move.id);
  })();
}

/** "k12" → 12. Claude refers to kitchen rows by these ids. */
export function kitchenId(ref: string): number {
  return Number(ref.replace(/^k/, ""));
}

// ---------- Freezing ----------

export const FROZEN_DAYS = SHELF_LIFE_DAYS.frost;

export function freeze(db: DB, id: number, today: string): { location: Location; expires: string | null } | null {
  const row = db.prepare("SELECT location, expires FROM kitchen WHERE id = ?").get(id) as { location: Location; expires: string | null } | undefined;
  if (!row) return null;
  db.prepare("UPDATE kitchen SET location = 'frost', expires = ? WHERE id = ?").run(addDays(today, FROZEN_DAYS), id);
  return row;
}

export function unfreeze(db: DB, id: number, before: { location: Location; expires: string | null }): void {
  db.prepare("UPDATE kitchen SET location = ?, expires = ? WHERE id = ?").run(before.location, before.expires, id);
}

// ---------- "Frys i dag" ----------

export type FreezeAlert = { kitchenId: number; name: string; expires: string; mealTitle: string; day: string };

type PlannedDish = { day: string; title: string; status: string; ingredients: Usage[] };

/**
 * Fresh items that will be past their last good day before the dish that uses them,
 * e.g. because a skipped day moved it. Freeze them today, while they are still good.
 */
export function freezeAlerts(
  meals: PlannedDish[],
  weekMonday: Date,
  kitchen: KitchenItem[],
  today: string,
): FreezeAlert[] {
  const days = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
  const alerts = new Map<number, FreezeAlert>();
  for (const meal of meals) {
    if (meal.status !== "planned") continue;
    const date = addDays(weekMonday.toISOString().slice(0, 10), days.indexOf(meal.day));
    if (date <= today) continue;
    for (const ing of meal.ingredients) {
      const rows = ing.kitchenItem
        ? kitchen.filter((k) => k.id === kitchenId(ing.kitchenItem!))
        : ing.productId ? kitchen.filter((k) => k.productId === ing.productId) : [];
      for (const row of rows) {
        if (row.location !== "køl" || !row.expires || row.expires < today || row.expires >= date || alerts.has(row.id)) continue;
        alerts.set(row.id, { kitchenId: row.id, name: row.name, expires: row.expires, mealTitle: meal.title, day: meal.day });
      }
    }
  }
  return [...alerts.values()];
}

// ---------- The Køkken page's text ----------

/** "300 g hakket oksekød i fryseren" per line, the way you would say it. */
export function kitchenText(items: KitchenItem[]): string {
  const amount = (qty: number, unit: Unit) => {
    const n = (v: number) => String(Math.round(v * 100) / 100).replace(".", ",");
    if (unit === "stk") return n(qty);
    if (unit === "g" && qty >= 1000) return `${n(qty / 1000)} kg`;
    if (unit === "ml" && qty >= 1000) return `${n(qty / 1000)} l`;
    return `${n(qty)} ${unit}`;
  };
  return items
    .map((i) => `${amount(i.qty, i.unit)} ${i.name.toLowerCase()}${i.location === "frost" ? " i fryseren" : ""}`)
    .join("\n");
}

export type ConvertedItem = { id: string; name: string; qty: number; unit: Unit; location: Location; category: Category };

/**
 * Replaces the kitchen with Claude's reading of the text. Items that match an
 * existing row by name keep its expiry and product; new ones get the category's
 * shelf life. Returns Claude's ids mapped to the new row ids.
 */
export function replaceKitchen(db: DB, items: ConvertedItem[], today: string): Map<string, number> {
  const old = db.prepare("SELECT * FROM kitchen").all() as Row[];
  const ids = new Map<string, number>();
  const insert = db.prepare("INSERT INTO kitchen (name, qty, unit, location, expires, product_id) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM kitchen").run();
    for (const item of items) {
      const match = old.find((r) => r.name.toLowerCase() === item.name.toLowerCase() && r.location === item.location);
      // In the freezer it keeps like frozen food, whatever it is (minced meat in the freezer is not 2 days).
      const category = item.location === "frost" ? "frost" : item.category;
      const expires = match?.expires ?? addDays(today, SHELF_LIFE_DAYS[category] ?? SHELF_LIFE_DAYS.holdbart);
      const result = insert.run(item.name, Math.max(0, item.qty), item.unit, item.location, expires, match?.product_id ?? null);
      ids.set(item.id, Number(result.lastInsertRowid));
    }
  })();
  return ids;
}
