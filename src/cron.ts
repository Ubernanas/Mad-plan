// Sunday at planCron (18:00): fetch the offers and recipes and make the plan, unless
// it was already made with "Lav planen". There is no separate fetch: "Lav planen"
// fetches too, so the recipes are chosen with the kitchen as it is when you are ready.

import cron from "node-cron";
import { loadHousehold, type Household } from "./config.ts";
import type { DB } from "./db.ts";
import { startPlanJob } from "./job/plan-job.ts";
import { planWeek } from "./week.ts";

export function planExists(db: DB, week: string): boolean {
  return db.prepare("SELECT 1 FROM plans WHERE week = ?").get(week) !== undefined;
}

export function startCron(db: DB, household: Household = loadHousehold()): void {
  cron.schedule(household.planCron, () => {
    const week = planWeek();
    if (planExists(db, week)) console.log(`[cron] Planen for ${week} er allerede lavet.`);
    else startPlanJob(db);
  }, { timezone: household.timezone });
  console.log(`[cron] Henter tilbud og laver planen "${household.planCron}" (${household.timezone}), hvis den ikke er lavet.`);
}
