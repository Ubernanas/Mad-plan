// Pieces and grams: typical weights per piece from config/units.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Unit } from "./fetch/size.ts";

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
