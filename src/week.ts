const TIMEZONE = "Europe/Copenhagen";

/** The calendar date in Copenhagen, as a UTC midnight Date (so date math ignores DST). */
export function copenhagenDate(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return new Date(`${parts}T00:00:00Z`);
}

/** ISO week key in Copenhagen time, e.g. "2026-W43". */
export function weekKey(now: Date = new Date()): string {
  const date = copenhagenDate(now);
  const weekday = date.getUTCDay() || 7;
  // The Thursday of this week decides which year the week belongs to.
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The week a plan made now is for. Sunday belongs to the coming week, because
 * Sunday's fetch and plan cover Monday to Sunday after it. Used for the page
 * cache and products, so Sunday never reuses pages fetched earlier in the old week.
 */
export function planWeek(now: Date = new Date()): string {
  return weekKey(new Date(now.getTime() + 86_400_000));
}

/** Monday of an ISO week key, as a UTC midnight Date. */
export function mondayOf(week: string): Date {
  const [year, number] = week.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (number - 1) * 7);
  return monday;
}
