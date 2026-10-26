import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb, type DB } from "../db.ts";
import { planWeek } from "../week.ts";
import type { generatePlan } from "./generate.ts";
import { planJobStatus, startPlanJob } from "./plan-job.ts";

/** Waits until the background job has finished. */
async function finished(db: DB) {
  while (planJobStatus(db).state === "running") await new Promise((r) => setTimeout(r, 5));
  return planJobStatus(db);
}

const plan = { week: "2026-W45" };
const fakeGenerate = (calls: string[]) =>
  (async () => { calls.push("plan"); return { plan, response: {} }; }) as unknown as typeof generatePlan;

test("'Lav planen' fetches the offers and recipes first, then makes the plan", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  assert.equal(startPlanJob(db, fakeGenerate(calls), async () => { calls.push("fetch"); }), true);
  assert.equal(planJobStatus(db).message, "Henter tilbud og opskrifter …");
  assert.equal((await finished(db)).state, "done");
  assert.deepEqual(calls, ["fetch", "plan"]);
});

test("a failed fetch still makes the plan from what this week already fetched", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO fetches VALUES (?, 'Netto', 'cheapest', '{}', '[]', 'x')").run(planWeek());
  const calls: string[] = [];
  startPlanJob(db, fakeGenerate(calls), async () => { throw new Error("Goma svarede 429"); });
  assert.equal((await finished(db)).state, "done");
  assert.deepEqual(calls, ["plan"]);
});

test("a failed fetch with nothing fetched this week stops the job and says why", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  startPlanJob(db, fakeGenerate(calls), async () => { throw new Error("Kilden har ændret sig: søgningen på kylling gav 0 varer."); });
  const status = await finished(db);
  assert.equal(status.state, "failed");
  assert.match(status.message, /Kilden har ændret sig/);
  assert.deepEqual(calls, []);
});
