// Builds the input and prompt, runs `claude -p`, validates the answer, and saves
// the computed plan. On an invalid answer it tries once more; if that fails too,
// nothing is saved and the previous plan stays.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Household, Section } from "../config.ts";
import { getMeta, type DB } from "../db.ts";
import type { Unit } from "../fetch/size.ts";
import type { LeafletInfo } from "../fetch/validity.ts";
import { isExpired, listKitchen, replaceKitchen, todayIso, type KitchenItem } from "../kitchen.ts";
import { mondayOf, planWeek } from "../week.ts";
import { computePlan, type ClaudeResponse, type Plan, type Product } from "./compute.ts";

export const BASIS_ITEMS = ["olie", "salt", "peber", "tørre krydderier", "eddike", "sukker"];
const JOB_FILES = import.meta.dirname;

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type RunClaude = (stdin: string, prompt: string) => Promise<RunResult>;

export class PlanError extends Error {}

type Options = {
  db: DB;
  household: Household;
  sections: Record<string, Section>;
  preferences: string;
  /** The household's wishes for this week, from the page. */
  wishes?: string;
  /** The Køkken page's text, if edited. Claude converts it, and it then replaces the kitchen. */
  kitchenText?: string;
  now?: () => Date;
  run?: RunClaude;
  log?: (message: string) => void;
};

export async function generatePlan({
  db, household, sections, preferences, wishes = "", kitchenText = "", now = () => new Date(), run = runClaude, log = console.log,
}: Options): Promise<{ plan: Plan; response: ClaudeResponse }> {
  const week = planWeek(now());
  const fetch = db.prepare("SELECT store, savings_json, missing_json FROM fetches WHERE week = ?").get(week) as
    | { store: string; savings_json: string; missing_json: string }
    | undefined;
  if (!fetch) throw new PlanError(`Der er ikke hentet tilbud for ${week} endnu.`);

  const products = loadProducts(db, week, fetch.store, JSON.parse(fetch.missing_json) as string[]);
  const today = todayIso(now());
  // Either the kitchen as it stands (expired fresh items left out), or the household's own words about it.
  const kitchen: KitchenSource = kitchenText.trim()
    ? { text: kitchenText.trim() }
    : { items: listKitchen(db).filter((item) => !isExpired(item, today)) };
  const input = JSON.stringify({
    storeChoice: { store: fetch.store, savingsOnProteinOffers: JSON.parse(fetch.savings_json) },
    household: {
      persons: household.persons,
      dinnersPerWeek: household.dinnersPerWeek,
      dishOptions: household.dishOptions,
      weeklyBudgetDkk: household.weeklyBudgetDkk,
      diet: household.diet,
    },
    preferences,
    wishes,
    basisItems: BASIS_ITEMS,
    ...("text" in kitchen
      ? { kitchenText: kitchen.text }
      : { kitchen: kitchen.items.map((i) => ({ id: `k${i.id}`, name: i.name, qty: i.qty, unit: i.unit, location: i.location, expires: i.expires })) }),
    products: [...products.values()].map(({ query, estimate, ...p }) => (estimate ? { ...p, estimate } : p)),
  });
  const prompt = buildPrompt(week, fetch.store, household, wishes);

  let errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryNote = errors.length
      ? `\n\nDit forrige svar blev afvist med disse fejl. Ret dem:\n- ${errors.join("\n- ")}`
      : "";
    const result = await run(input, prompt + retryNote);
    const parsed = parseClaudeOutput(result);
    if ("loginError" in parsed) throw new PlanError(`token udløbet eller ugyldigt (claude: ${parsed.loginError})`);
    errors = "error" in parsed ? [parsed.error] : validateResponse(parsed.response, products, household, kitchen);
    if (errors.length === 0 && "response" in parsed) {
      const response = parsed.response as ClaudeResponse;
      const createdAt = now().toISOString();
      if ("text" in kitchen) useConvertedKitchen(db, response, today);
      const leaflet = JSON.parse(getMeta(db, `leaflet:${week}`) ?? "null") as LeafletInfo | null;
      const plan = computePlan(response, products, sections, {
        week, store: fetch.store, createdAt, weeklyBudgetDkk: household.weeklyBudgetDkk,
        dinnersPerWeek: household.dinnersPerWeek, wishes,
        leafletLastDay: leaflet?.store === fetch.store ? leaflet.lastDay : null,
      });
      db.prepare("INSERT INTO plans (week, store, plan_json, created_at) VALUES (?, ?, ?, ?)").run(
        week, fetch.store, JSON.stringify(plan), createdAt,
      );
      return { plan, response };
    }
    log(`Forsøg ${attempt}: svaret blev afvist (${errors.length} fejl): ${errors.slice(0, 5).join("; ")}`);
  }
  throw new PlanError(`Claudes svar var ugyldigt to gange. Den forrige plan bliver stående. Fejl: ${errors.join("; ")}`);
}

/** The kitchen as Claude gets it: its rows, or the household's text to convert. */
export type KitchenSource = { items: KitchenItem[] } | { text: string };

/** The converted text replaces the kitchen, and the dishes then point at the new rows. */
function useConvertedKitchen(db: DB, response: ClaudeResponse, today: string): void {
  const ids = replaceKitchen(db, response.kitchen ?? [], today);
  for (const dish of response.dishes) {
    for (const ingredient of dish.ingredients) {
      if (ingredient.kitchenItem) ingredient.kitchenItem = `k${ids.get(ingredient.kitchenItem)}`;
    }
  }
}

/** This week's products, plus last known prices for search words that failed this week. */
export function loadProducts(db: DB, week: string, store: string, missing: string[]): Map<string, Product> {
  type Row = { goma_id: string; name: string; query: string; package_amount: number; unit: Unit; price: number; on_offer: number; per_kg: number | null };
  const toProduct = (row: Row, estimate: boolean): Product => ({
    id: row.goma_id, name: row.name, query: row.query, packageAmount: row.package_amount, unit: row.unit,
    price: row.price, onOffer: !estimate && row.on_offer === 1, perKg: row.per_kg, estimate,
  });
  const columns = "goma_id, name, query, package_amount, unit, price, on_offer, per_kg";

  const products = new Map<string, Product>();
  const current = db.prepare(`SELECT ${columns} FROM products WHERE week = ? AND store = ? AND package_amount IS NOT NULL`).all(week, store) as Row[];
  for (const row of current) products.set(row.goma_id, toProduct(row, false));

  for (const query of missing) {
    const latest = db.prepare("SELECT MAX(week) AS week FROM products WHERE query = ? AND week < ?").get(query, week) as { week: string | null };
    if (!latest.week) continue;
    const rows = db.prepare(`SELECT ${columns} FROM products WHERE query = ? AND week = ? AND package_amount IS NOT NULL`).all(query, latest.week) as Row[];
    for (const row of rows) if (!products.has(row.goma_id)) products.set(row.goma_id, toProduct(row, true));
  }
  return products;
}

export function buildPrompt(week: string, store: string, household: Household, wishes = ""): string {
  const monday = mondayOf(week);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const date = (d: Date) => d.toLocaleDateString("da-DK", { day: "numeric", month: "long", timeZone: "UTC" });
  const diet = [
    household.diet.glutenFree && "glutenfri",
    household.diet.lactoseFree && "laktosefri",
    household.diet.other.trim(),
  ].filter(Boolean);
  return [
    `Lav madplanen for uge ${Number(week.split("-W")[1])}: mandag ${date(monday)} til søndag ${date(sunday)} ${sunday.getUTCFullYear()}.`,
    `Butik: ${store}.`,
    `Kosthensyn: ${diet.length ? diet.join(", ") : "ingen"}.`,
    `Foreslå ${household.dishOptions} retter, og markér de ${household.dinnersPerWeek}, du anbefaler, til ${household.persons} personer. Budget: ca. ${household.weeklyBudgetDkk} kr.`,
    wishes.trim() ? `Ønsker til ugen: ${wishes.trim()}` : "",
    "Varer, præferencer, ønsker og kosthensyn står i JSON på stdin.",
  ].filter(Boolean).join("\n");
}

/** loginError holds what claude said, for the log. */
type Parsed = { response: unknown } | { error: string } | { loginError: string };

export function parseClaudeOutput({ code, stdout, stderr }: RunResult): Parsed {
  const loginProblem = /not logged in|please run \/login|log ?in again|oauth|authenticat|invalid (api key|token)|token (has )?expired|\b401\b|unauthori[sz]ed/i;
  let output: { is_error?: boolean; result?: string; structured_output?: unknown } | undefined;
  try {
    output = JSON.parse(stdout);
  } catch {
    // Handled below.
  }
  if (code !== 0 || !output || output.is_error) {
    const text = `${output?.result ?? stdout} ${stderr}`;
    if (loginProblem.test(text)) return { loginError: text.trim().slice(0, 300) };
    return { error: `claude fejlede (exit ${code}): ${text.trim().slice(0, 300)}` };
  }
  if (output.structured_output === undefined) return { error: "Svaret havde intet structured_output." };
  return { response: output.structured_output };
}

export function validateResponse(
  value: unknown,
  products: Map<string, Product>,
  household: Pick<Household, "dinnersPerWeek" | "dishOptions">,
  kitchen: KitchenSource = { items: [] },
): string[] {
  const response = value as ClaudeResponse;
  if (!response || !Array.isArray(response.dishes)) return ["Svaret har ingen dishes-liste."];
  const errors: string[] = [];
  const { dishes } = response;

  // What kitchenItem may point at: the kitchen we sent, or Claude's reading of the text.
  const available = new Map<string, { unit: Unit; qty: number }>();
  if ("text" in kitchen) {
    if (!Array.isArray(response.kitchen)) errors.push("Svaret mangler kitchen: omregn kitchenText til varer.");
    for (const item of response.kitchen ?? []) {
      if (available.has(item.id)) errors.push(`Køkkenvaren ${item.id} findes to gange.`);
      if (!(Number.isFinite(item.qty) && item.qty >= 0)) errors.push(`Køkkenvaren ${item.name}: mængden skal være 0 eller mere.`);
      available.set(item.id, { unit: item.unit, qty: item.qty });
    }
  } else {
    for (const item of kitchen.items) available.set(`k${item.id}`, { unit: item.unit, qty: item.qty });
  }

  if (dishes.length !== household.dishOptions) {
    errors.push(`Der skal være ${household.dishOptions} retter at vælge imellem, men der er ${dishes.length}.`);
  }
  const suggested = dishes.filter((d) => d.suggested).length;
  if (suggested !== household.dinnersPerWeek) {
    errors.push(`Præcis ${household.dinnersPerWeek} retter skal have suggested: true, men ${suggested} har.`);
  }
  if (dishes.length && !dishes[dishes.length - 1]!.suggested) {
    errors.push("Den sidste ret i listen skal være resteretten og have suggested: true.");
  }
  const titles = dishes.map((d) => d.title.trim().toLowerCase());
  if (new Set(titles).size !== titles.length) errors.push("To retter har samme navn. Hver ret skal være forskellig.");

  for (const meal of dishes) {
    const where = meal.title;
    if (!Number.isInteger(meal.servings) || meal.servings < 1) errors.push(`${where}: servings skal være mindst 1.`);
    if (!meal.ingredients?.length) errors.push(`${where}: ingen ingredienser.`);
    for (const ing of meal.ingredients ?? []) {
      const label = `${where}, ${ing.name}`;
      if (!(Number.isFinite(ing.qty) && ing.qty > 0)) errors.push(`${label}: mængden skal være større end 0.`);
      const hasProduct = ing.productId !== undefined;
      const fromKitchen = ing.kitchenItem !== undefined;
      const isBasis = ing.basis === true;
      if ([hasProduct, fromKitchen, isBasis].filter(Boolean).length !== 1) {
        errors.push(`${label}: skal have præcis én kilde: productId, kitchenItem eller basis.`);
        continue;
      }
      if (fromKitchen) {
        const item = available.get(ing.kitchenItem!);
        if (!item) errors.push(`${label}: kitchenItem ${ing.kitchenItem} findes ikke i køkkenet.`);
        else if (item.unit !== ing.unit) errors.push(`${label}: enheden skal være ${item.unit} som køkkenvaren, ikke ${ing.unit}.`);
        else if (ing.qty > item.qty * 1.05) errors.push(`${label}: der er kun ${item.qty} ${item.unit} i køkkenet.`);
      }
      if (hasProduct) {
        const product = products.get(ing.productId!);
        if (!product) errors.push(`${label}: productId ${ing.productId} findes ikke i products.`);
        else if (product.unit !== ing.unit) {
          errors.push(`${label}: enheden skal være ${product.unit} som produktet, ikke ${ing.unit}.`);
        }
      }
    }
  }
  return errors;
}

/**
 * The environment for the job: everything except other Claude/Anthropic settings,
 * so only CLAUDE_CODE_OAUTH_TOKEN decides how it logs in. Matters when this runs
 * from inside another Claude Code session, whose variables would otherwise leak in.
 */
export function jobEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key === "CLAUDE_CODE_OAUTH_TOKEN" || !/^(CLAUDE|ANTHROPIC)/.test(key))
      // A token pasted into a dashboard easily gets a stray space or line break.
      .map(([key, value]) => [key, key === "CLAUDE_CODE_OAUTH_TOKEN" ? value?.trim() : value]),
  );
}

/** Runs the unmodified Claude Code CLI on the subscription token, from a folder outside the repo. */
export const runClaude: RunClaude = (stdin, prompt) => {
  // Outside the repo, so Claude Code does not pick up this project's CLAUDE.md
  // (it reads CLAUDE.md files in the working folder and every parent folder).
  const jobDir = process.env.JOB_DIR || (process.env.FLY_APP_NAME ? "/data/jobdir" : join(tmpdir(), "madplan-jobdir"));
  mkdirSync(jobDir, { recursive: true });

  const args = [
    "-p", prompt,
    "--append-system-prompt-file", join(JOB_FILES, "system-prompt.md"),
    "--disallowedTools", "WebFetch,WebSearch,Bash,PowerShell",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", readFileSync(join(JOB_FILES, "schema.json"), "utf8"),
  ];

  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: jobDir, env: jobEnv(process.env), timeout: 15 * 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
};
