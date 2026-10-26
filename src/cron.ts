// The two Sunday jobs: fetch offers at fetchCron (14:00) and make the plan at
// planCron (18:00) unless one was already made with "Lav planen".

import cron from "node-cron";
import { loadHousehold, loadItems, type Household } from "./config.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import { createHttpClient } from "./fetch/http.ts";
import { fetchWeek } from "./job/fetch-week.ts";
import { startPlanJob, type JobStatus } from "./job/plan-job.ts";
import { effectiveHousehold } from "./settings.ts";
import { planWeek } from "./week.ts";

const FETCH_KEY = "fetchJob";

export function fetchJobStatus(db: DB): JobStatus {
  const raw = getMeta(db, FETCH_KEY);
  return raw ? (JSON.parse(raw) as JobStatus) : { state: "idle", message: "", at: "" };
}

function setFetchStatus(db: DB, state: JobStatus["state"], message: string): void {
  setMeta(db, FETCH_KEY, JSON.stringify({ state, message, at: new Date().toISOString() }));
}

export async function runFetchJob(db: DB): Promise<void> {
  setFetchStatus(db, "running", "");
  try {
    const summary = await fetchWeek({ db, http: createHttpClient({ db }), household: effectiveHousehold(db), items: loadItems() });
    const missing = summary.missing.length ? ` Skøn: ${summary.missing.join(", ")}.` : "";
    console.log(`[cron] Hentet ${summary.saved} varer fra ${summary.choice.store} for ${summary.week} (${summary.pagesFetched} sider).${missing}`);
    setFetchStatus(db, "done", `${summary.saved} varer fra ${summary.choice.store}.${missing}`);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[cron] Hentningen stoppede: ${message}`);
    setFetchStatus(db, "failed", message);
  }
}

export function planExists(db: DB, week: string): boolean {
  return db.prepare("SELECT 1 FROM plans WHERE week = ?").get(week) !== undefined;
}

export function startCron(db: DB, household: Household = loadHousehold()): void {
  const options = { timezone: household.timezone };
  cron.schedule(household.fetchCron, () => runFetchJob(db), options);
  cron.schedule(household.planCron, () => {
    const week = planWeek();
    if (planExists(db, week)) console.log(`[cron] Planen for ${week} er allerede lavet.`);
    else startPlanJob(db);
  }, options);
  console.log(`[cron] Henter "${household.fetchCron}" og laver plan "${household.planCron}" (${household.timezone}).`);
}
