// Shows which REMA products each ingredient search word finds, from the saved
// fixtures/rema-products.json: npm run rema-map. Use it when changing config/rema.json.

import { readFileSync } from "node:fs";
import { compileRules, loadRemaRules, queryOfProduct } from "../src/fetch/rema-match.ts";
import { loadIngredientRules } from "../src/config.ts";
const products = JSON.parse(readFileSync("fixtures/rema-products.json", "utf8"));
const rules = compileRules(loadRemaRules());
const by = new Map<string, string[]>();
for (const p of products) { const q = queryOfProduct(p, rules); if (q) (by.get(q) ?? by.set(q, []).get(q)!).push(`${p.name.toLowerCase()} ${p.packageAmount}${p.unit} ${p.price}`); }
const queries = new Set(loadIngredientRules().flatMap((r) => [r.query, r.glutenFree, r.lactoseFree]).filter(Boolean) as string[]);
for (const q of queries) console.log(q.padEnd(24), by.has(q) ? `${by.get(q)!.length}: ${by.get(q)!.slice(0, 5).join(" | ")}` : "—");
console.log("matched", [...by.values()].flat().length, "of", products.length);
