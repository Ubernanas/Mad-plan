import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { createApp } from "./server.ts";

const AUTH = { user: "tristan", pass: "hemmelig" };
const HEADERS = { Authorization: `Basic ${Buffer.from("tristan:hemmelig").toString("base64")}`, "Content-Type": "application/json" };

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO plans (week, store, plan_json, created_at) VALUES ('2026-W43', 'Netto', ?, 'x')").run(
    JSON.stringify({ week: "2026-W43", store: "Netto", meals: [], shoppingList: [] }),
  );
  return { db, app: createApp(db, AUTH) };
}

const post = (app: ReturnType<typeof createApp>, changes: unknown) =>
  app.request("/api/checks", { method: "POST", headers: HEADERS, body: JSON.stringify({ changes }) });

test("/health answers without login; everything else needs it", async () => {
  const { app } = setup();
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/api/state")).status, 401);
  assert.equal((await app.request("/")).status, 401);
  assert.equal((await app.request("/api/state", { headers: HEADERS })).status, 200);
});

test("state returns the newest plan per week with its ticks", async () => {
  const { app } = setup();
  await post(app, [{ planId: 1, itemKey: "40910", checked: true, at: "2026-10-24T10:00:00.000Z" }]);
  const body = await (await app.request("/api/state", { headers: HEADERS })).json();
  assert.equal(body.plans.length, 1);
  assert.equal(body.plans[0].id, 1);
  assert.equal(body.plans[0].store, "Netto");
  assert.deepEqual(body.checks["1"], { "40910": { checked: true, at: "2026-10-24T10:00:00.000Z" } });
});

test("the newest tick wins, even when an older one arrives later", async () => {
  const { app, db } = setup();
  await post(app, [{ planId: 1, itemKey: "a", checked: true, at: "2026-10-24T10:05:00.000Z" }]);
  await post(app, [{ planId: 1, itemKey: "a", checked: false, at: "2026-10-24T10:00:00.000Z" }]); // offline, older
  const row = db.prepare("SELECT checked FROM checks WHERE item_key = 'a'").get() as { checked: number };
  assert.equal(row.checked, 1);
});

function planWithOptions() {
  const db = openDb(":memory:");
  const option = (id: number, title: string, productId: string, qty: number) => ({
    id, title, description: "", suggested: id < 2, servings: 2, timeMinutes: 20, steps: [], mealCost: 0, pricePerPortion: 0,
    ingredients: [{ name: title, qty, unit: "g", productId, checkLabel: false }],
  });
  const plan = {
    week: "2026-W44", store: "Netto", createdAt: "x", weeklyBudgetDkk: 460, dinnersPerWeek: 2, wishes: "",
    storeReason: "", dietRespected: [], notes: [],
    options: [option(0, "Ris", "ris", 300), option(1, "Laks", "laks", 250), option(2, "Kylling", "kylling", 500)],
    selected: [0, 1], meals: [], shoppingList: [], totalPurchaseCost: 0,
    products: {
      ris: { id: "ris", name: "Ris", query: "ris", packageAmount: 1000, unit: "g", price: 20, onOffer: false, perKg: 20, estimate: false, section: "kolonial" },
      laks: { id: "laks", name: "Laks", query: "laks", packageAmount: 250, unit: "g", price: 50, onOffer: true, perKg: 200, estimate: false, section: "kød og fisk" },
      kylling: { id: "kylling", name: "Kylling", query: "kylling", packageAmount: 500, unit: "g", price: 40, onOffer: true, perKg: 80, estimate: false, section: "kød og fisk" },
    },
  };
  db.prepare("INSERT INTO plans (week, store, plan_json, created_at) VALUES ('2026-W44', 'Netto', ?, 'x')").run(JSON.stringify(plan));
  return { db, app: createApp(db, AUTH) };
}

const choose = (app: ReturnType<typeof createApp>, selected: unknown) =>
  app.request("/api/plans/1/selection", { method: "PUT", headers: HEADERS, body: JSON.stringify({ selected }) });

test("choosing dishes recomputes and saves the plan", async () => {
  const { app } = planWithOptions();
  const response = await choose(app, [2, 0]);
  assert.equal(response.status, 200);
  const { plan } = await response.json();
  assert.deepEqual(plan.selected, [0, 2]);
  assert.deepEqual(plan.meals.map((m: { day: string; title: string }) => `${m.day} ${m.title}`), ["mandag Ris", "tirsdag Kylling"]);
  assert.equal(plan.totalPurchaseCost, 60);
  const state = await (await app.request("/api/state", { headers: HEADERS })).json();
  assert.equal(state.plans[0].totalPurchaseCost, 60);
});

test("choosing more dishes than there are dinners, or none, is refused", async () => {
  const { app } = planWithOptions();
  assert.equal((await choose(app, [0, 1, 2])).status, 400);
  assert.equal((await choose(app, [])).status, 400);
  assert.equal((await choose(app, ["0"])).status, 400);
});

const mark = (app: ReturnType<typeof createApp>, day: string, status: string) =>
  app.request("/api/plans/1/days", { method: "POST", headers: HEADERS, body: JSON.stringify({ day, status }) });

test("'Lavet' and 'Spring over' are saved, and the dishes then cannot be swapped", async () => {
  const { app } = planWithOptions();
  const done = await (await mark(app, "mandag", "done")).json();
  assert.deepEqual(done.plan.done, [0]);
  const skipped = await (await mark(app, "tirsdag", "skipped")).json();
  assert.deepEqual(skipped.plan.days.slice(0, 3).map((d: { mealId: number | null; status: string }) => `${d.mealId}:${d.status}`), ["0:done", "null:skipped", "1:planned"]);
  assert.equal((await choose(app, [0, 2])).status, 409);
});

test("bad day data is refused", async () => {
  const { app } = planWithOptions();
  assert.equal((await mark(app, "fredagx", "done")).status, 400);
  assert.equal((await mark(app, "mandag", "eaten")).status, 400);
  assert.equal((await mark(app, "søndag", "skipped")).status, 409); // no dish on Sunday
});

test("ticks fill the kitchen, 'Lavet' takes out, undo puts back, unticking removes", async () => {
  const { app } = planWithOptions();
  await choose(app, [0, 1]); // computes the shopping list: ris and laks
  const kitchen = async () => (await (await app.request("/api/state", { headers: HEADERS })).json()).kitchen as { productId: string; qty: number }[];
  const qty = async (id: string) => (await kitchen()).find((k) => k.productId === id)?.qty;

  await post(app, [{ planId: 1, itemKey: "laks", checked: true, at: "2026-10-26T15:00:00.000Z" }]);
  await post(app, [{ planId: 1, itemKey: "ris", checked: true, at: "2026-10-26T15:00:01.000Z" }]);
  assert.equal(await qty("laks"), 250);
  assert.equal(await qty("ris"), 1000);

  await mark(app, "tirsdag", "done"); // Laks: 250 g laks
  assert.equal(await qty("laks"), undefined);
  await mark(app, "tirsdag", "planned"); // undo
  assert.equal(await qty("laks"), 250);

  await post(app, [{ planId: 1, itemKey: "ris", checked: false, at: "2026-10-26T15:05:00.000Z" }]);
  assert.equal(await qty("ris"), undefined);
});

test("an item can be frozen and the freezing undone", async () => {
  const { app } = planWithOptions();
  await choose(app, [0, 1]);
  await post(app, [{ planId: 1, itemKey: "laks", checked: true, at: "2026-10-26T15:00:00.000Z" }]);
  const state = await (await app.request("/api/state", { headers: HEADERS })).json();
  const laks = state.kitchen.find((k: { productId: string }) => k.productId === "laks");
  const frozen = await (await app.request(`/api/kitchen/${laks.id}/freeze`, { method: "POST", headers: HEADERS })).json();
  assert.equal(frozen.kitchen.find((k: { id: number }) => k.id === laks.id).location, "frost");
  const back = await (await app.request(`/api/kitchen/${laks.id}/unfreeze`, { method: "POST", headers: HEADERS, body: JSON.stringify(frozen.before) })).json();
  assert.equal(back.kitchen.find((k: { id: number }) => k.id === laks.id).location, "køl");
});

test("the Køkken text is the kitchen until edited, then the saved draft", async () => {
  const { app } = planWithOptions();
  await choose(app, [0, 1]);
  await post(app, [{ planId: 1, itemKey: "laks", checked: true, at: "2026-10-26T15:00:00.000Z" }]);
  const before = await (await app.request("/api/state", { headers: HEADERS })).json();
  assert.equal(before.kitchenText, "250 g laks");
  assert.equal(before.kitchenEdited, false);
  await app.request("/api/kitchen/text", { method: "PUT", headers: HEADERS, body: JSON.stringify({ text: "250 g laks\n2 løg" }) });
  const after = await (await app.request("/api/state", { headers: HEADERS })).json();
  assert.equal(after.kitchenText, "250 g laks\n2 løg");
  assert.equal(after.kitchenEdited, true);
});

test("plans made before dishes could be chosen cannot be changed", async () => {
  const { app } = setup();
  assert.equal((await choose(app, [0])).status, 409);
});

test("wishes are saved and returned with the state", async () => {
  const { app } = setup();
  const response = await app.request("/api/wishes", { method: "PUT", headers: HEADERS, body: JSON.stringify({ wishes: "  noget med fisk  " }) });
  assert.deepEqual(await response.json(), { wishes: "noget med fisk" });
  const state = await (await app.request("/api/state", { headers: HEADERS })).json();
  assert.equal(state.wishes, "noget med fisk");
});

test("bad tick data is rejected, and ticks for unknown plans are ignored", async () => {
  const { app, db } = setup();
  assert.equal((await post(app, [{ planId: "1", itemKey: "a", checked: true, at: "x" }])).status, 400);
  assert.equal((await post(app, [{ planId: 99, itemKey: "a", checked: true, at: "2026-10-24T10:00:00.000Z" }])).status, 200);
  assert.equal(db.prepare("SELECT 1 FROM checks").get(), undefined);
});
