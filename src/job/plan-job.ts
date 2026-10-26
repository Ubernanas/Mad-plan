// Runs plan generation in the background, one at a time, and records how it
// went so the page can show it. Used by "Lav planen" and by the 18:00 cron.

import { loadIngredientRules, loadItems, loadItemSections, loadPreferences } from "../config.ts";
import { getMeta, setMeta, type DB } from "../db.ts";
import { createHttpClient } from "../fetch/http.ts";
import { getKitchenDraft, setKitchenDraft } from "../kitchen.ts";
import { loadRecipes } from "../recipes.ts";
import { effectiveHousehold } from "../settings.ts";
import { planWeek } from "../week.ts";
import { fetchWeek } from "./fetch-week.ts";
import { generatePlan } from "./generate.ts";

export type JobStatus = {
  state: "idle" | "running" | "done" | "failed";
  message: string;
  at: string;
};

const KEY = "planJob";
const WISHES_KEY = "wishes";
let running = false;

/** The household's wishes for the next plan, written on the page. */
export function getWishes(db: DB): string {
  return getMeta(db, WISHES_KEY) ?? "";
}

export function setWishes(db: DB, wishes: string): void {
  setMeta(db, WISHES_KEY, wishes.trim().slice(0, 1000));
}

export function planJobStatus(db: DB): JobStatus {
  const raw = getMeta(db, KEY);
  return raw ? (JSON.parse(raw) as JobStatus) : { state: "idle", message: "", at: "" };
}

function setStatus(db: DB, state: JobStatus["state"], message: string): void {
  setMeta(db, KEY, JSON.stringify({ state, message, at: new Date().toISOString() }));
}

/** A job marked running when the server starts was cut off by a restart. */
export function resetInterruptedJob(db: DB): void {
  if (planJobStatus(db).state === "running") setStatus(db, "failed", "Planen blev afbrudt, fordi serveren genstartede. Prøv igen.");
}

/**
 * The week's offers and recipes, chosen with the kitchen as it is right now. Pages already
 * fetched this week come from the cache, so pressing "Lav planen" again costs Goma little.
 * Only on Fly (or with CRON=on), so a dev server never fetches from Goma.
 */
export async function fetchOffers(db: DB): Promise<void> {
  if (!process.env.FLY_APP_NAME && process.env.CRON !== "on") return;
  const summary = await fetchWeek({
    db, http: createHttpClient({ db }), household: effectiveHousehold(db), items: loadItems(), recipes: loadRecipes(), rules: loadIngredientRules(),
  });
  console.log(`[plan] Hentet ${summary.saved} varer fra ${summary.choice.store} for ${summary.week} (${summary.pagesFetched} sider, ${summary.candidates.length} opskrifter).`);
}

/**
 * Starts the job unless one is running: first the offers and recipes, then Claude.
 * Returns false if it was already running.
 */
export function startPlanJob(db: DB, generate: typeof generatePlan = generatePlan, fetch: typeof fetchOffers = fetchOffers): boolean {
  if (running) return false;
  running = true;
  setStatus(db, "running", "Henter tilbud og opskrifter …");
  void (async () => {
    try {
      try {
        await fetch(db);
      } catch (error) {
        // An earlier fetch this week still makes a plan; without one there is nothing to plan from.
        if (!db.prepare("SELECT 1 FROM fetches WHERE week = ?").get(planWeek())) throw error;
        console.error(`[plan] Tilbuddene kunne ikke hentes igen; bruger de hentede: ${(error as Error).message}`);
      }
      setStatus(db, "running", "Claude sætter ugens retter sammen …");
      const wishes = getWishes(db);
      const kitchenText = getKitchenDraft(db);
      const { plan } = await generate({
        db, household: effectiveHousehold(db), sections: loadItemSections(), preferences: loadPreferences(), wishes, kitchenText,
      });
      // Used up by this plan. Text changed while it was being made is kept for the next one.
      if (getWishes(db) === wishes) setWishes(db, "");
      if (getKitchenDraft(db) === kitchenText) setKitchenDraft(db, "");
      setStatus(db, "done", `Planen for uge ${Number(plan.week.split("-W")[1])} er klar.`);
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[plan] ${message}`);
      setStatus(db, "failed", message.startsWith("token udløbet")
        ? "Claude kunne ikke logge ind. Tokenet skal fornyes med claude setup-token."
        : message);
    } finally {
      running = false;
    }
  })();
  return true;
}
