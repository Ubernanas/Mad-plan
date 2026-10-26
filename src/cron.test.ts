import assert from "node:assert/strict";
import { test } from "node:test";
import cron from "node-cron";
import { loadHousehold } from "./config.ts";
import { planExists } from "./cron.ts";
import { openDb } from "./db.ts";

test("the cron times in household.json are valid and mean Sunday 14:00 and 18:00", () => {
  const household = loadHousehold();
  assert.ok(cron.validate(household.fetchCron));
  assert.ok(cron.validate(household.planCron));
  assert.equal(household.fetchCron, "0 14 * * 0");
  assert.equal(household.planCron, "0 18 * * 0");
  assert.equal(household.timezone, "Europe/Copenhagen");
});

test("the 18:00 job sees a plan made earlier with 'Lav planen'", () => {
  const db = openDb(":memory:");
  assert.equal(planExists(db, "2026-W44"), false);
  db.prepare("INSERT INTO plans (week, store, plan_json, created_at) VALUES ('2026-W44', 'Netto', '{}', 'x')").run();
  assert.equal(planExists(db, "2026-W44"), true);
  assert.equal(planExists(db, "2026-W45"), false);
});
