// Normalises package sizes as Goma writes them ("1,5 kg", "4 x 125 g", "3 pak")
// to an amount in g, ml or stk.

export type Unit = "g" | "ml" | "stk";
export type Size = { amount: number; unit: Unit };

const FACTORS: Record<string, Size> = {
  kg: { amount: 1000, unit: "g" },
  g: { amount: 1, unit: "g" },
  gr: { amount: 1, unit: "g" },
  l: { amount: 1000, unit: "ml" },
  ltr: { amount: 1000, unit: "ml" },
  liter: { amount: 1000, unit: "ml" },
  dl: { amount: 100, unit: "ml" },
  cl: { amount: 10, unit: "ml" },
  ml: { amount: 1, unit: "ml" },
  stk: { amount: 1, unit: "stk" },
  pak: { amount: 1, unit: "stk" },
  pk: { amount: 1, unit: "stk" },
  bdt: { amount: 1, unit: "stk" },
  ds: { amount: 1, unit: "stk" },
  rl: { amount: 1, unit: "stk" },
};

/** Danish numbers: "1,5" is a decimal, "1.000" is a thousand, "1.5" is a decimal. */
function number(text: string): number {
  if (/^\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ""));
  return Number(text.replace(",", "."));
}

/** Returns null when the text is not a size we understand. */
export function parseSize(text: string): Size | null {
  const clean = text.toLowerCase().replace(/^ca\.?\s*/, "").replace(/\s+/g, " ").trim();

  // "4 x 125 g" or "4x125g": a multipack.
  const multi = /^(\d+)\s*x\s*(\d+(?:,\d+)?)\s*([a-zæøå]+)\.?$/.exec(clean);
  if (multi) {
    const factor = FACTORS[multi[3]!];
    if (!factor) return null;
    return { amount: round(Number(multi[1]) * number(multi[2]!) * factor.amount), unit: factor.unit };
  }

  // "1,5 kg", "500 g", "3 pak". A range like "400-500 g" uses the lower bound.
  const single = /^(\d+(?:[.,]\d+)?)(?:\s*-\s*\d+(?:[.,]\d+)?)?\s*([a-zæøå]+)\.?$/.exec(clean);
  if (single) {
    const factor = FACTORS[single[2]!];
    if (!factor) return null;
    return { amount: round(number(single[1]!) * factor.amount), unit: factor.unit };
  }

  return null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
