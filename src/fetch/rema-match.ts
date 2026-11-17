// Which ingredient search word a REMA product is. REMA's names are short ("HK. OKSEKØD
// 8-12%"), so config/rema.json says, per search word, which categories to look in and
// what the name must (and must not) contain. The first rule that fits wins.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RemaProduct } from "./rema.ts";

export type RemaRule = { query: string; match: string; in?: string[]; not?: string };
type Compiled = { query: string; match: RegExp; in: string[]; not: RegExp | null };

export function loadRemaRules(): RemaRule[] {
  return JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "config", "rema.json"), "utf8")) as RemaRule[];
}

export function compileRules(rules: RemaRule[]): Compiled[] {
  return rules.map((r) => ({ query: r.query, match: new RegExp(r.match), in: r.in ?? [], not: r.not ? new RegExp(r.not) : null }));
}

/** The search word for a product, or null if no dinner ingredient is sold as it. */
export function queryOfProduct(product: Pick<RemaProduct, "name" | "category">, rules: Compiled[]): string | null {
  const name = product.name.toLowerCase();
  for (const rule of rules) {
    if (rule.in.length && !rule.in.some((c) => product.category === c || product.category.startsWith(`${c}/`))) continue;
    if (rule.match.test(name) && !rule.not?.test(name)) return rule.query;
  }
  return null;
}
