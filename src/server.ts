// The web page and its small JSON API. Everything except /health is behind Basic Auth.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHousehold } from "./config.ts";
import { fetchJobStatus, startCron } from "./cron.ts";
import { effectiveHousehold, saveSettings, settingsOf } from "./settings.ts";
import { getMeta, openDb, setMeta, type DB } from "./db.ts";
import { DAYS, selectDishes, setDayStatus, slotOn, weekStarted, type DayStatus, type Plan } from "./job/compute.ts";
import {
  getKitchenDraft, getWishes, planJobStatus, resetInterruptedJob, setKitchenDraft, setWishes, startPlanJob,
} from "./job/plan-job.ts";
import {
  consume, freeze, freezeAlerts, kitchenText, listKitchen, restore, syncPurchase, todayIso, unfreeze, type Location, type Move,
} from "./kitchen.ts";
import { mondayOf, planWeek, weekKey } from "./week.ts";

type CheckChange = { planId: number; itemKey: string; checked: boolean; at: string };

export function createApp(db: DB, auth = { user: process.env.BASIC_AUTH_USER, pass: process.env.BASIC_AUTH_PASS }) {
  const app = new Hono();

  app.get("/health", (c) => c.text("ok"));

  if (auth.user && auth.pass) {
    app.use("*", basicAuth({ username: auth.user, password: auth.pass, realm: "Madplan" }));
  } else if (process.env.FLY_APP_NAME) {
    throw new Error("BASIC_AUTH_USER og BASIC_AUTH_PASS skal være sat på Fly.");
  } else {
    console.warn("[web] Ingen Basic Auth: BASIC_AUTH_USER/BASIC_AUTH_PASS er ikke sat. Kun til lokal udvikling.");
  }

  app.get("/api/state", (c) => c.json(state(db)));

  app.post("/api/checks", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { changes?: CheckChange[] } | null;
    const changes = body?.changes;
    if (!Array.isArray(changes) || !changes.every(isCheckChange)) return c.json({ error: "Ugyldige flueben." }, 400);
    saveChecks(db, changes);
    return c.json({ checks: checksFor(db, [...new Set(changes.map((ch) => ch.planId))]) });
  });

  // Choosing dishes recomputes the plan from what it already holds; Claude is not called.
  app.put("/api/plans/:id/selection", async (c) => {
    const id = Number(c.req.param("id"));
    const row = db.prepare("SELECT plan_json FROM plans WHERE id = ?").get(id) as { plan_json: string } | undefined;
    if (!row) return c.json({ error: "Planen findes ikke." }, 404);
    const plan = JSON.parse(row.plan_json) as Plan;
    if (!plan.options) return c.json({ error: "Denne plan blev lavet, før man kunne vælge retter." }, 409);

    const body = (await c.req.json().catch(() => null)) as { selected?: unknown } | null;
    const selected = body?.selected;
    if (!Array.isArray(selected) || !selected.every((n) => Number.isInteger(n))) return c.json({ error: "Ugyldigt valg." }, 400);
    if (selected.length < 1 || selected.length > plan.dinnersPerWeek) {
      return c.json({ error: `Vælg mellem 1 og ${plan.dinnersPerWeek} retter.` }, 400);
    }
    if (weekStarted(plan)) return c.json({ error: "Retterne kan ikke skiftes, når ugen er gået i gang." }, 409);
    const updated = selectDishes(plan, selected as number[]);
    db.prepare("UPDATE plans SET plan_json = ? WHERE id = ?").run(JSON.stringify(updated), id);
    return c.json({ plan: { id, ...updated } });
  });

  // "Lavet", "Spring over", or back to planned (undo).
  app.post("/api/plans/:id/days", async (c) => {
    const id = Number(c.req.param("id"));
    const row = db.prepare("SELECT plan_json FROM plans WHERE id = ?").get(id) as { plan_json: string } | undefined;
    if (!row) return c.json({ error: "Planen findes ikke." }, 404);
    const plan = JSON.parse(row.plan_json) as Plan;
    if (!plan.options) return c.json({ error: "Denne plan blev lavet, før dagene kunne markeres." }, 409);

    const body = (await c.req.json().catch(() => null)) as { day?: unknown; status?: unknown } | null;
    const statuses: DayStatus[] = ["planned", "done", "skipped"];
    if (!DAYS.includes(body?.day as string) || !statuses.includes(body?.status as DayStatus)) {
      return c.json({ error: "Ugyldig dag." }, 400);
    }
    const day = body!.day as string;
    const status = body!.status as DayStatus;
    const before = slotOn(plan, day);
    let updated: Plan;
    try {
      updated = setDayStatus(plan, day, status);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }

    // "Lavet" takes the dish's ingredients out of the kitchen; undoing it puts back exactly that.
    const mealId = before?.mealId ?? null;
    if (mealId !== null) {
      const key = `kitchenMoves:${id}:${mealId}`;
      if (status === "done" && before?.status !== "done") {
        setMeta(db, key, JSON.stringify(consume(db, plan.options[mealId]!.ingredients)));
      } else if (status === "planned" && before?.status === "done") {
        restore(db, JSON.parse(getMeta(db, key) ?? "[]") as Move[]);
        setMeta(db, key, "[]");
      }
    }

    db.prepare("UPDATE plans SET plan_json = ? WHERE id = ?").run(JSON.stringify(updated), id);
    return c.json({ plan: { id, ...updated }, kitchen: listKitchen(db) });
  });

  app.post("/api/kitchen/:id/freeze", (c) => {
    const before = freeze(db, Number(c.req.param("id")), todayIso());
    if (!before) return c.json({ error: "Varen findes ikke længere." }, 404);
    return c.json({ before, kitchen: listKitchen(db) });
  });

  app.post("/api/kitchen/:id/unfreeze", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { location?: Location; expires?: string | null } | null;
    if (!body || !["køl", "frost", "skab"].includes(body.location as string)) return c.json({ error: "Ugyldig placering." }, 400);
    unfreeze(db, Number(c.req.param("id")), { location: body.location!, expires: body.expires ?? null });
    return c.json({ kitchen: listKitchen(db) });
  });

  // Sunday's text about the kitchen, saved as a draft until the next plan reads it.
  app.put("/api/kitchen/text", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== "string" || body.text.length > 3000) return c.json({ error: "Teksten er for lang." }, 400);
    setKitchenDraft(db, body.text);
    return c.json({ kitchenDraft: getKitchenDraft(db) });
  });

  app.put("/api/settings", async (c) => {
    const result = saveSettings(db, await c.req.json().catch(() => null));
    return "error" in result ? c.json(result, 400) : c.json(result);
  });

  app.put("/api/wishes", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { wishes?: unknown } | null;
    if (typeof body?.wishes !== "string") return c.json({ error: "Ugyldige ønsker." }, 400);
    setWishes(db, body.wishes);
    return c.json({ wishes: getWishes(db) });
  });

  app.post("/api/plan", (c) => {
    const started = startPlanJob(db);
    return c.json({ started, job: planJobStatus(db) }, started ? 202 : 409);
  });

  app.use("/*", serveStatic({ root: "./public" }));
  return app;
}

/** The newest plan for each of the two latest weeks, plus what the page needs around them. */
function state(db: DB) {
  const rows = db.prepare(`
    SELECT p.id, p.week, p.plan_json FROM plans p
    WHERE p.id = (SELECT MAX(id) FROM plans WHERE week = p.week)
    ORDER BY p.week DESC LIMIT 2`).all() as { id: number; week: string; plan_json: string }[];
  const plans = rows.map((r) => ({ id: r.id, ...JSON.parse(r.plan_json) }));

  const now = new Date();
  const weeks = [...new Set([planWeek(now), weekKey(now), ...rows.map((r) => r.week)])];
  const fetches = Object.fromEntries(
    weeks.flatMap((week) => {
      const row = db.prepare("SELECT store, fetched_at FROM fetches WHERE week = ?").get(week) as
        | { store: string; fetched_at: string } | undefined;
      return row ? [[week, { store: row.store, fetchedAt: row.fetched_at }]] : [];
    }),
  );

  return {
    plans,
    fetches,
    checks: checksFor(db, plans.map((p) => p.id)),
    job: planJobStatus(db),
    fetchJob: fetchJobStatus(db),
    wishes: getWishes(db),
    settings: settingsOf(effectiveHousehold(db)),
    stores: loadHousehold().stores,
    kitchen: listKitchen(db),
    freezeAlerts: (() => {
      const current = plans.find((p) => p.week === weekKey(now)) as Plan | undefined;
      return current?.meals ? freezeAlerts(current.meals, mondayOf(current.week), listKitchen(db), todayIso(now)) : [];
    })(),
    // The draft if it was edited, else the kitchen as text, ready to correct.
    kitchenText: getKitchenDraft(db) || kitchenText(listKitchen(db)),
    kitchenEdited: getKitchenDraft(db) !== "",
    today: todayIso(now),
    serverTime: now.toISOString(),
  };
}

function checksFor(db: DB, planIds: number[]) {
  const checks: Record<number, Record<string, { checked: boolean; at: string }>> = {};
  const select = db.prepare("SELECT item_key, checked, updated_at FROM checks WHERE plan_id = ?");
  for (const id of planIds) {
    checks[id] = {};
    for (const row of select.all(id) as { item_key: string; checked: number; updated_at: string }[]) {
      checks[id]![row.item_key] = { checked: row.checked === 1, at: row.updated_at };
    }
  }
  return checks;
}

/**
 * Last write wins, by the time the tick was made on the phone, so late offline syncs
 * don't undo newer ticks. The kitchen then follows the tick as it ended up.
 */
function saveChecks(db: DB, changes: CheckChange[]) {
  const upsert = db.prepare(`
    INSERT INTO checks (plan_id, item_key, checked, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (plan_id, item_key) DO UPDATE SET checked = excluded.checked, updated_at = excluded.updated_at
    WHERE excluded.updated_at > checks.updated_at`);
  const final = db.prepare("SELECT checked, updated_at FROM checks WHERE plan_id = ? AND item_key = ?");
  const plans = new Map<number, Plan | null>();
  const planFor = (id: number) => {
    if (!plans.has(id)) {
      const row = db.prepare("SELECT plan_json FROM plans WHERE id = ?").get(id) as { plan_json: string } | undefined;
      plans.set(id, row ? (JSON.parse(row.plan_json) as Plan) : null);
    }
    return plans.get(id)!;
  };
  db.transaction(() => {
    for (const ch of changes) {
      const plan = planFor(ch.planId);
      if (!plan) continue;
      upsert.run(ch.planId, ch.itemKey, ch.checked ? 1 : 0, ch.at);
      const line = plan.shoppingList.find((l) => l.productId === ch.itemKey);
      const tick = final.get(ch.planId, ch.itemKey) as { checked: number; updated_at: string };
      if (line?.section) syncPurchase(db, ch.planId, line, tick.checked === 1, todayIso(new Date(tick.updated_at)));
    }
  })();
}

function isCheckChange(value: unknown): value is CheckChange {
  const ch = value as CheckChange;
  return (
    !!ch && Number.isInteger(ch.planId) && typeof ch.itemKey === "string" && ch.itemKey.length < 100 &&
    typeof ch.checked === "boolean" && typeof ch.at === "string" && !Number.isNaN(Date.parse(ch.at))
  );
}

// Start only when run directly, not when a test imports createApp.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env: settings come from the environment (Fly secrets).
  }
  const db = openDb();
  resetInterruptedJob(db);
  // Only on Fly (or when asked), so a dev server on a laptop never fetches from Goma as well.
  if (process.env.FLY_APP_NAME || process.env.CRON === "on") startCron(db);
  const port = Number(process.env.PORT) || 3000;
  serve({ fetch: createApp(db).fetch, port }, () => console.log(`[web] http://localhost:${port}`));
}
