// When the store's weekly leaflet ends, read from its chain page on eTilbudsavis
// (dates only; the page has no products). Used for "køb senest" on offers.

import type { HttpClient } from "./http.ts";

/** Goma's store name → the chain page on etilbudsavis.dk (from their business sitemap). */
export const LEAFLET_SLUGS: Record<string, string> = {
  Netto: "Netto",
  Føtex: "fotex",
  Bilka: "Bilka",
  Lidl: "Lidl",
  "REMA 1000": "REMA-1000",
  "365discount": "365discount",
  SuperBrugsen: "SuperBrugsen",
  MENY: "MENY",
  Kvickly: "Kvickly",
};

export type Leaflet = { label: string; validFrom: Date; validUntil: Date };
/** The weekly leaflet and its last valid day (YYYY-MM-DD, Copenhagen). */
export type LeafletInfo = { store: string; label: string; lastDay: string };

/** The leaflets in the page's embedded data: a label followed by its validity. */
export function parseLeaflets(html: string): Leaflet[] {
  const data = html.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const leaflets: Leaflet[] = [];
  const seen = new Set<string>();
  for (const match of data.matchAll(/"label":"([^"]+)"[^{}]*?"validFrom":"([^"]+)","validUntil":"([^"]+)"/g)) {
    const [, label, from, until] = match as unknown as [string, string, string, string];
    const key = `${label}|${from}|${until}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const validFrom = new Date(from);
    const validUntil = new Date(until);
    if (!Number.isNaN(validFrom.getTime()) && !Number.isNaN(validUntil.getTime())) leaflets.push({ label, validFrom, validUntil });
  }
  return leaflets;
}

/**
 * The grocery leaflet in force on the plan week's Monday: not nonfood, and
 * preferably the one named "uge N"; otherwise the one that ends first.
 */
export function weeklyLeaflet(leaflets: Leaflet[], monday: Date): Leaflet | null {
  // Monday noon in Copenhagen, safely inside the day whatever the DST offset.
  const at = new Date(monday.getTime() + 10 * 3_600_000);
  const candidates = leaflets
    .filter((l) => !/non-?food/i.test(l.label) && l.validFrom <= at && at < l.validUntil)
    .sort((a, b) => a.validUntil.getTime() - b.validUntil.getTime());
  return candidates.find((l) => /\buge\s*\d+/i.test(l.label)) ?? candidates[0] ?? null;
}

/** The last day a leaflet is valid. validUntil is the moment it stops, often midnight. */
export function lastValidDay(validUntil: Date): string {
  const lastMoment = new Date(validUntil.getTime() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(lastMoment);
}

export async function fetchLeaflet(http: HttpClient, store: string, monday: Date): Promise<LeafletInfo | null> {
  const slug = LEAFLET_SLUGS[store];
  if (!slug) return null;
  const html = await http.get(`https://etilbudsavis.dk/${slug}`);
  if (!html) return null;
  const leaflet = weeklyLeaflet(parseLeaflets(html), monday);
  return leaflet ? { store, label: leaflet.label, lastDay: lastValidDay(leaflet.validUntil) } : null;
}
