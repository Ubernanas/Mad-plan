// Turns Claude's dishes into the finished plan: cost per dish, the chosen dishes
// on their days, one shopping-list line per product in whole packages, and the
// purchase cost. Claude never does any of this arithmetic. Choosing other dishes
// later recomputes from the plan alone (selectDishes), without Claude.

import { SECTIONS, type Section } from "../config.ts";
import type { Unit } from "../fetch/size.ts";
import type { ConvertedItem } from "../kitchen.ts";
import { mondayOf } from "../week.ts";

export const DAYS = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];

export type Product = {
  id: string;
  name: string;
  query: string;
  packageAmount: number;
  unit: Unit;
  price: number;
  onOffer: boolean;
  perKg: number | null;
  /** Price taken from an earlier week because this week's page was missing. */
  estimate: boolean;
};

export type Ingredient = {
  name: string;
  qty: number;
  unit: Unit;
  productId?: string;
  /** "k12": taken from the kitchen, so not bought. */
  kitchenItem?: string;
  basis?: boolean;
  checkLabel: boolean;
};

export type Dish = {
  title: string;
  description: string;
  /** Part of the week Claude recommends. */
  suggested: boolean;
  servings: number;
  timeMinutes: number;
  steps: string[];
  ingredients: Ingredient[];
};

/** Claude's answer, shaped by schema.json. */
export type ClaudeResponse = {
  storeReason: string;
  dietRespected: string[];
  dishes: Dish[];
  notes: string[];
  /** Claude's reading of the Køkken page's text; only when that text was sent. */
  kitchen?: ConvertedItem[];
};

export type PriceSource = "offer" | "regular" | "estimate";

export type ShoppingItem = {
  productId: string;
  section: Section;
  item: string;
  packageSize: string;
  packageAmount: number;
  unit: Unit;
  /** How much the meals use, in the product's unit. */
  usedAmount: number;
  packages: number;
  price: number;
  priceSource: PriceSource;
  checkLabel: boolean;
  /** Last day of the offer (YYYY-MM-DD), for offers when the leaflet's end is known. */
  buyBefore: string | null;
  /** The offer ends before the last day the product is used. */
  buyEarly: boolean;
};

/** What is left of a product after the planned meals: a forecast, not what is really in the kitchen. */
export type Leftover = { productId: string; item: string; amount: number; unit: Unit; value: number };

/** A dish to choose from; id is its place in Claude's list. */
export type DishOption = Dish & { id: number; mealCost: number; pricePerPortion: number };
export type DayStatus = "planned" | "done" | "skipped";
export type PlannedMeal = DishOption & { day: string; status: DayStatus };
/** One day of the week. A skipped day has no dish: its dish moved to the next day. */
export type DaySlot = { day: string; mealId: number | null; status: DayStatus };
export type PlanProduct = Product & { section: Section };

export type PlanMeta = {
  week: string;
  store: string;
  createdAt: string;
  weeklyBudgetDkk: number;
  dinnersPerWeek: number;
  wishes: string;
  /** Last day of the store's weekly leaflet (YYYY-MM-DD), if known. */
  leafletLastDay: string | null;
};

export type Plan = PlanMeta & {
  storeReason: string;
  dietRespected: string[];
  notes: string[];
  options: DishOption[];
  /** Ids of the chosen dishes, in the order they are cooked. */
  selected: number[];
  /** The products the dishes use, as priced when the plan was made. */
  products: Record<string, PlanProduct>;
  /** Ids of the dishes marked "Lavet". */
  done: number[];
  /** Days marked "Spring over". */
  skippedDays: string[];
  days: DaySlot[];
  /** Chosen dishes pushed past Sunday by skipped days. */
  dropped: number[];
  meals: PlannedMeal[];
  shoppingList: ShoppingItem[];
  totalPurchaseCost: number;
  leftovers: Leftover[];
  leftoverValue: number;
  /** E.g. "Køb laks til lørdag senest fredag, eller frys den ned." Null when nothing needs it. */
  buyNote: string | null;
};

export function computePlan(
  response: ClaudeResponse,
  products: Map<string, Product>,
  sections: Record<string, Section>,
  meta: PlanMeta,
): Plan {
  const snapshot: Record<string, PlanProduct> = {};
  for (const dish of response.dishes) {
    for (const ingredient of dish.ingredients) {
      if (!ingredient.productId) continue;
      const product = products.get(ingredient.productId);
      if (!product) throw new Error(`Ukendt productId ${ingredient.productId}`);
      snapshot[product.id] = { ...product, section: sectionFor(product, sections) };
    }
  }

  const options = response.dishes.map((dish, id): DishOption => {
    let mealCost = 0;
    for (const ingredient of dish.ingredients) {
      const product = ingredient.productId ? snapshot[ingredient.productId] : undefined;
      if (product) mealCost += (ingredient.qty / product.packageAmount) * product.price;
    }
    return { ...dish, id, mealCost: kr(mealCost), pricePerPortion: kr(mealCost / dish.servings) };
  });

  const plan: Plan = {
    ...meta,
    storeReason: response.storeReason,
    dietRespected: response.dietRespected,
    notes: response.notes,
    options,
    selected: [],
    products: snapshot,
    done: [],
    skippedDays: [],
    days: [],
    dropped: [],
    meals: [],
    shoppingList: [],
    totalPurchaseCost: 0,
    leftovers: [],
    leftoverValue: 0,
    buyNote: null,
  };
  return selectDishes(plan, options.filter((o) => o.suggested).map((o) => o.id));
}

/** True once a dish is marked done or a day skipped; the chosen dishes are then fixed. */
export function weekStarted(plan: Plan): boolean {
  return (plan.done?.length ?? 0) > 0 || (plan.skippedDays?.length ?? 0) > 0;
}

/**
 * Places the chosen dishes on the days, in order from Monday. A skipped day stays
 * empty and pushes the remaining dishes one day on; what no longer fits drops out.
 */
function layOut(plan: Plan): Plan {
  const done = plan.done ?? [];
  const skippedDays = plan.skippedDays ?? [];
  const queue = [...plan.selected];
  const days = DAYS.map((day): DaySlot => {
    if (skippedDays.includes(day)) return { day, mealId: null, status: "skipped" };
    const id = queue.shift();
    if (id === undefined) return { day, mealId: null, status: "planned" };
    return { day, mealId: id, status: done.includes(id) ? "done" : "planned" };
  });
  const meals = days.flatMap((slot): PlannedMeal[] =>
    slot.mealId === null ? [] : [{ ...plan.options[slot.mealId]!, day: slot.day, status: slot.status }],
  );
  return { ...plan, done, skippedDays, days, dropped: queue, meals };
}

/** The day as it lies now, after skipped days have moved dishes. */
export function slotOn(plan: Plan, day: string): DaySlot | undefined {
  return layOut(plan).days.find((s) => s.day === day);
}

/** "Lavet", "Spring over", or back to planned (undo). Shopping list and prices stay as planned. */
export function setDayStatus(plan: Plan, day: string, status: DayStatus): Plan {
  const current = layOut(plan);
  const slot = current.days.find((s) => s.day === day);
  if (!slot) throw new Error(`Ukendt dag "${day}".`);
  let { done, skippedDays } = current;

  if (status === "done") {
    if (slot.mealId === null) throw new Error(`Der er ingen ret ${day}.`);
    done = [...new Set([...done, slot.mealId])];
  } else if (status === "skipped") {
    if (slot.status !== "planned" || slot.mealId === null) throw new Error(`${day} kan ikke springes over.`);
    skippedDays = [...skippedDays, day];
  } else {
    skippedDays = skippedDays.filter((d) => d !== day);
    if (slot.mealId !== null) done = done.filter((id) => id !== slot.mealId);
  }
  return layOut({ ...plan, done, skippedDays });
}

/** The plan with these dishes chosen. They get the days in Claude's order, from Monday. */
export function selectDishes(plan: Plan, selected: number[]): Plan {
  const ids = [...new Set(selected)].filter((id) => plan.options[id]).sort((a, b) => a - b);
  if (ids.length > DAYS.length) throw new Error(`Højst ${DAYS.length} retter kan vælges.`);
  const meals = ids.map((id) => plan.options[id]!);

  const used = new Map<string, { amount: number; checkLabel: boolean; days: number[] }>();
  meals.forEach((meal, dayIndex) => {
    for (const ingredient of meal.ingredients) {
      if (!ingredient.productId) continue; // basis items are not bought
      const entry = used.get(ingredient.productId) ?? { amount: 0, checkLabel: false, days: [] };
      entry.amount += ingredient.qty;
      entry.checkLabel ||= ingredient.checkLabel;
      entry.days.push(dayIndex);
      used.set(ingredient.productId, entry);
    }
  });

  // Days (by index from Monday) that fall after the leaflet's last day.
  const lastDay = plan.leafletLastDay ?? null;
  const dateOf = (dayIndex: number) => isoDate(new Date(mondayOf(plan.week).getTime() + dayIndex * 86_400_000));
  const afterOffer = (dayIndex: number) => lastDay !== null && dateOf(dayIndex) > lastDay;
  const lateDays = new Set<number>();

  const shoppingList = [...used].map(([id, { amount, checkLabel, days }]): ShoppingItem => {
    const product = plan.products[id]!;
    // The epsilon keeps 500 g of a 500 g pack from becoming two packs through float noise.
    const packages = Math.max(1, Math.ceil(amount / product.packageAmount - 1e-9));
    const onOffer = !product.estimate && product.onOffer;
    const buyEarly = onOffer && days.some(afterOffer);
    if (buyEarly) for (const d of days.filter(afterOffer)) lateDays.add(d);
    return {
      productId: id,
      section: product.section,
      item: product.name,
      packageSize: formatSize(product.packageAmount, product.unit),
      packageAmount: product.packageAmount,
      unit: product.unit,
      usedAmount: amount,
      packages,
      price: kr(packages * product.price),
      priceSource: product.estimate ? "estimate" : product.onOffer ? "offer" : "regular",
      checkLabel,
      buyBefore: onOffer ? lastDay : null,
      buyEarly,
    };
  });

  shoppingList.sort(
    (a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.item.localeCompare(b.item, "da"),
  );

  // Bought minus used, valued at the price per unit actually paid.
  const leftovers = shoppingList
    .map((line): Leftover => {
      const amount = Math.round((line.packages * line.packageAmount - line.usedAmount) * 100) / 100;
      return { productId: line.productId, item: line.item, amount, unit: line.unit, value: kr((amount / line.packageAmount) * plan.products[line.productId]!.price) };
    })
    .filter((leftover) => leftover.value >= 0.5)
    .sort((a, b) => b.value - a.value);

  return layOut({
    ...plan,
    selected: ids,
    shoppingList,
    totalPurchaseCost: kr(shoppingList.reduce((sum, line) => sum + line.price, 0)),
    leftovers,
    leftoverValue: kr(leftovers.reduce((sum, leftover) => sum + leftover.value, 0)),
    buyNote: buyNote(shoppingList.filter((l) => l.buyEarly), [...lateDays].sort(), lastDay),
  });
}

/**
 * Meat and fish: "Køb flæskesteg til søndag senest fredag, og frys den ned."
 * Things that keep only lose the offer price: "Tilbuddet på kartofler slutter fredag."
 */
function buyNote(lines: ShoppingItem[], dayIndexes: number[], lastDay: string | null): string | null {
  if (!lines.length || !lastDay) return null;
  const weekday = new Date(`${lastDay}T12:00:00Z`).toLocaleDateString("da-DK", { weekday: "long", timeZone: "UTC" });
  const name = (line: ShoppingItem) => line.item.charAt(0).toLowerCase() + line.item.slice(1);
  const fresh = lines.filter((l) => l.section === "kød og fisk");
  const keeps = lines.filter((l) => l.section !== "kød og fisk");
  const sentences: string[] = [];
  if (fresh.length) {
    const days = listDa(dayIndexes.map((d) => DAYS[d]!));
    sentences.push(`Køb ${listDa(fresh.map(name))} til ${days} senest ${weekday}, og frys ${fresh.length === 1 ? "det" : "dem"} ned.`);
  }
  if (keeps.length) {
    sentences.push(`${keeps.length === 1 ? "Tilbuddet" : "Tilbuddene"} på ${listDa(keeps.map(name))} slutter ${weekday}.`);
  }
  return sentences.join(" ");
}

/** "a, b og c". */
function listDa(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} og ${words.at(-1)}`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function sectionFor(product: Pick<Product, "name" | "query">, sections: Record<string, Section>): Section {
  if (/frost|frossen|frosne|dybfrost/i.test(product.name)) return "frost";
  return sections[product.query] ?? "kolonial";
}

/** 1500 g → "1,5 kg", 400 ml → "400 ml", 6 stk → "6 stk". */
export function formatSize(amount: number, unit: Unit): string {
  const number = (n: number) => String(Math.round(n * 100) / 100).replace(".", ",");
  if (unit === "g" && amount >= 1000) return `${number(amount / 1000)} kg`;
  if (unit === "ml" && amount >= 1000) return `${number(amount / 1000)} l`;
  return `${number(amount)} ${unit}`;
}

function kr(value: number): number {
  return Math.round(value * 100) / 100;
}
