// Runs plan generation in the background, one at a time, and records how it
// went so the page can show it. Used by "Lav planen" and (later) by cron.

import { loadItemSections, loadPreferences } from "../config.ts";
import { getMeta, setMeta, type DB } from "../db.ts";
import { effectiveHousehold } from "../settings.ts";
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

const KITCHEN_DRAFT_KEY = "kitchenDraft";

/** The Køkken page's text, if it was edited since the last plan. Empty means: use the kitchen as it is. */
export function getKitchenDraft(db: DB): string {
  return getMeta(db, KITCHEN_DRAFT_KEY) ?? "";
}

export function setKitchenDraft(db: DB, text: string): void {
  setMeta(db, KITCHEN_DRAFT_KEY, text.trim().slice(0, 3000));
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

/** Starts the job unless one is running. Returns false if it was already running. */
export function startPlanJob(db: DB, generate: typeof generatePlan = generatePlan): boolean {
  if (running) return false;
  running = true;
  setStatus(db, "running", "");
  void (async () => {
    try {
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
