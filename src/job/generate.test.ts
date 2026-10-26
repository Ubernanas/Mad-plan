import assert from "node:assert/strict";
import { test } from "node:test";
import type { Household, Section } from "../config.ts";
import { openDb, setMeta, type DB } from "../db.ts";
import { listKitchen, replaceKitchen } from "../kitchen.ts";
import type { Recipe } from "../recipes.ts";
import type { ClaudeResponse } from "./compute.ts";
import { buildPrompt, generatePlan, jobEnv, loadProducts, minRecipeDishes, parseClaudeOutput, PlanError, validateResponse, type RunClaude } from "./generate.ts";

const FRIDAY = () => new Date("2026-10-23T12:00:00Z"); // plan week 2026-W43
const SECTIONS: Record<string, Section> = { ris: "kolonial", kylling: "kød og fisk" };

const household: Household = {
  persons: 2, weeklyBudgetDkk: 460, dinnersPerWeek: 2, dishOptions: 3,
  diet: { glutenFree: true, lactoseFree: true, other: "" },
  stores: ["Netto"], storeMode: "cheapest", fixedStore: null,
  fetchCron: "0 14 * * 0", planCron: "0 18 * * 0", timezone: "Europe/Copenhagen", oauthTokenExpires: "2027-10-01",
};

function seed(db: DB, week = "2026-W43", missing: string[] = []) {
  const insert = db.prepare(`INSERT INTO products (week, store, goma_id, query, name, package_amount, unit, price, normal_price, per_kg, on_offer, fetched_at)
    VALUES (?, 'Netto', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'x')`);
  insert.run(week, "1", "ris", "Basmatiris", 1000, "g", 20, 0);
  insert.run(week, "2", "kylling", "Kyllingebryst", 500, "g", 40, 1);
  db.prepare("INSERT INTO fetches VALUES (?, 'Netto', 'cheapest', '{\"Netto\":100}', ?, 'x')").run(week, JSON.stringify(missing));
}

function good(): ClaudeResponse {
  const meal = (title: string, suggested = true) => ({
    title, description: "Kylling og ris.", suggested, servings: 2, timeMinutes: 30, steps: ["Kog risene."],
    ingredients: [
      { name: "kylling", qty: 250, unit: "g" as const, productId: "2", checkLabel: false },
      { name: "ris", qty: 150, unit: "g" as const, productId: "1", checkLabel: false },
      { name: "salt", qty: 2, unit: "g" as const, basis: true, checkLabel: false },
    ],
  });
  return { storeReason: "Netto har størst besparelse.", dietRespected: ["glutenfri", "laktosefri"], dishes: [meal("Risret", false), meal("Kylling med ris"), meal("Kyllingeris")], notes: [] };
}

function claudeSays(...responses: unknown[]): RunClaude & { prompts: string[]; inputs: string[] } {
  const prompts: string[] = [];
  const inputs: string[] = [];
  const run = (async (stdin: string, prompt: string) => {
    prompts.push(prompt);
    inputs.push(stdin);
    const next = responses[prompts.length - 1];
    return { code: 0, stdout: JSON.stringify({ type: "result", is_error: false, structured_output: next }), stderr: "" };
  }) as RunClaude & { prompts: string[]; inputs: string[] };
  run.prompts = prompts;
  run.inputs = inputs;
  return run;
}

const options = (db: DB, run: RunClaude) => ({ db, household, sections: SECTIONS, preferences: "Vi kan lide kylling.", now: FRIDAY, run, log: () => {} });

test("a valid answer is computed and saved as the week's plan", async () => {
  const db = openDb(":memory:");
  seed(db);
  const run = claudeSays(good());
  const { plan } = await generatePlan(options(db, run));

  assert.equal(plan.week, "2026-W43");
  assert.equal(plan.totalPurchaseCost, 20 + 40); // 300 g of 1 kg rice, 500 g of 500 g chicken
  const saved = db.prepare("SELECT week, store FROM plans").all();
  assert.deepEqual(saved, [{ week: "2026-W43", store: "Netto" }]);

  const input = JSON.parse(run.inputs[0]!);
  assert.equal(input.products.length, 2);
  assert.deepEqual(Object.keys(input.products[0]).sort(), ["id", "name", "onOffer", "packageAmount", "perKg", "price", "unit"]);
  assert.equal(input.preferences, "Vi kan lide kylling.");
  assert.equal(input.household.dishOptions, 3);
  assert.equal(plan.options.length, 3);
  assert.deepEqual(plan.meals.map((m) => m.day), ["mandag", "tirsdag"]);
});

const bourbon: Recipe = {
  id: 1, name: "Bourbon Chicken", category: "Chicken Breast", minutes: 35, servings: 4, rating: 5, reviews: 3063,
  ingredients: ["chicken breasts", "soy sauce", "rice"], amounts: ["2", "1/3", "1"], steps: ["Fry.", "Simmer."],
  proteins: ["chicken"], gluten: ["soy sauce"], dairy: [],
};

test("the week's recipes are sent to Claude, and the dishes made from them credit Food.com", async () => {
  const db = openDb(":memory:");
  seed(db);
  setMeta(db, "candidates:2026-W43", "[1]");
  const answer = good();
  answer.dishes[1]!.recipeId = 1;
  const run = claudeSays(answer);
  const { plan } = await generatePlan({ ...options(db, run), recipes: [bourbon] });

  const sent = JSON.parse(run.inputs[0]!).recipes;
  assert.deepEqual(sent.map((r: Recipe) => r.name), ["Bourbon Chicken"]);
  assert.deepEqual(sent[0].gluten, ["soy sauce"]);
  assert.match(run.prompts[0]!, /blandt de 1 opskrifter/);
  assert.deepEqual(plan.options[1]!.source, { name: "Bourbon Chicken", rating: 5, reviews: 3063, url: "https://www.food.com/recipe/1" });
  assert.equal(plan.options[0]!.source, undefined); // written by Claude itself
});

test("a week without candidates sends no recipes and does not ask for them", async () => {
  const db = openDb(":memory:");
  seed(db);
  const run = claudeSays(good());
  await generatePlan({ ...options(db, run), recipes: [bourbon] });
  assert.deepEqual(JSON.parse(run.inputs[0]!).recipes, []);
  assert.doesNotMatch(run.prompts[0]!, /opskrifter i recipes/);
});

test("recipeId must be one of the week's recipes, and each recipe is used once", () => {
  const products = loadProducts(seededDb(), "2026-W43", "Netto", []);
  const answer = good();
  answer.dishes[0]!.recipeId = 1;
  answer.dishes[1]!.recipeId = 1;
  answer.dishes[2]!.recipeId = 99;
  const errors = validateResponse(answer, products, household, { items: [] }, new Map([[1, bourbon]]));
  assert.ok(errors.includes("recipeId 99 findes ikke i recipes."), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("To retter har samme recipeId")), errors.join("\n"));
});

test("a dish may not swap its recipe's protein: shrimp made with chicken loses the recipe", () => {
  const products = loadProducts(seededDb(), "2026-W43", "Netto", []);
  const shrimp: Recipe = { ...bourbon, id: 7, name: "Cajun Sauteed Shrimp", proteins: ["fish"] };
  const answer = good();
  answer.dishes[2]!.recipeId = 7; // made with Kyllingebryst
  const errors = validateResponse(answer, products, household, { items: [] }, new Map([[7, shrimp]]));
  assert.ok(errors.some((e) => e.includes('"Cajun Sauteed Shrimp" er med fisk')), errors.join("\n"));
  // The same dish with the chicken recipe is fine.
  answer.dishes[2]!.recipeId = 1;
  assert.deepEqual(validateResponse(answer, products, household, { items: [] }, new Map([[1, bourbon]])), []);
});

test("the recipe's protein may come from the kitchen", () => {
  const products = loadProducts(seededDb(), "2026-W43", "Netto", []);
  const burger: Recipe = { ...bourbon, id: 8, name: "Hamburgers", proteins: ["beef"] };
  const kitchen = { items: [{ id: 3, name: "Hakket oksekød", qty: 300, unit: "g" as const, location: "frost" as const, expires: null, productId: null, source: null }] };
  const answer = good();
  answer.dishes[2]!.recipeId = 8;
  answer.dishes[2]!.ingredients[0] = { name: "hakket oksekød", qty: 300, unit: "g", kitchenItem: "k3", checkLabel: false };
  assert.deepEqual(validateResponse(answer, products, household, kitchen, new Map([[8, burger]])), []);
});

test("all but 2 dishes come from the recipes, when there are enough of them", () => {
  assert.equal(minRecipeDishes(12, 40), 10);
  assert.equal(minRecipeDishes(12, 12), 10);
  assert.equal(minRecipeDishes(12, 11), 0); // a thin week: Claude may write more itself
  assert.equal(minRecipeDishes(2, 40), 0);

  const products = loadProducts(seededDb(), "2026-W43", "Netto", []);
  const three = new Map([1, 2, 3].map((id) => [id, { ...bourbon, id }] as const));
  const answer = good(); // 3 dishes, none from the recipes
  assert.ok(validateResponse(answer, products, household, { items: [] }, three)
    .includes("Kun 0 retter kommer fra recipes. Mindst 1 af de 3 retter skal være opskrifter fra recipes med recipeId."));
  answer.dishes[0]!.recipeId = 1;
  assert.deepEqual(validateResponse(answer, products, household, { items: [] }, three), []);

  assert.match(buildPrompt("2026-W45", "Netto", { ...household, dishOptions: 12 }, "", 40), /Mindst 10 af de 12 retter skal komme fra recipes/);
  assert.doesNotMatch(buildPrompt("2026-W45", "Netto", { ...household, dishOptions: 12 }, "", 8), /Mindst/);
});

function seededDb() {
  const db = openDb(":memory:");
  seed(db);
  return db;
}

test("the kitchen is sent without expired fresh items, and kitchen ingredients are not bought", async () => {
  const db = openDb(":memory:");
  seed(db);
  replaceKitchen(db, [
    { id: "a", name: "Ris", qty: 500, unit: "g", location: "skab", category: "holdbart" },
    { id: "b", name: "Gammel laks", qty: 200, unit: "g", location: "køl", category: "fisk" },
  ], "2026-10-10"); // the laks expired on the 12th
  const rice = listKitchen(db).find((i) => i.name === "Ris")!;
  const answer = good();
  for (const dish of answer.dishes) dish.ingredients[1] = { name: "ris", qty: 150, unit: "g", kitchenItem: `k${rice.id}`, checkLabel: false };
  const run = claudeSays(answer);
  const { plan } = await generatePlan(options(db, run));

  const sent = JSON.parse(run.inputs[0]!).kitchen;
  assert.deepEqual(sent.map((k: { name: string }) => k.name), ["Ris"]);
  assert.equal(plan.shoppingList.some((l) => l.productId === "1"), false); // rice comes from the kitchen
  assert.equal(plan.totalPurchaseCost, 40);
});

test("the Køkken text is converted by Claude and replaces the kitchen; dishes point at the new rows", async () => {
  const db = openDb(":memory:");
  seed(db);
  replaceKitchen(db, [{ id: "old", name: "Noget gammelt", qty: 1, unit: "stk", location: "skab", category: "holdbart" }], "2026-10-20");
  const answer: ClaudeResponse = {
    ...good(),
    kitchen: [{ id: "k1", name: "Ris", qty: 500, unit: "g", location: "skab", category: "holdbart" }],
  };
  for (const dish of answer.dishes) dish.ingredients[1] = { name: "ris", qty: 150, unit: "g", kitchenItem: "k1", checkLabel: false };
  const run = claudeSays(answer);
  const { plan } = await generatePlan({ ...options(db, run), kitchenText: "en halv pose ris" });

  assert.equal(JSON.parse(run.inputs[0]!).kitchenText, "en halv pose ris");
  const kitchen = listKitchen(db);
  assert.deepEqual(kitchen.map((k) => k.name), ["Ris"]);
  assert.equal(plan.options[1]!.ingredients[1]!.kitchenItem, `k${kitchen[0]!.id}`);
});

test("validation catches kitchen items that don't exist, wrong units, too much, and a missing conversion", () => {
  const db = openDb(":memory:");
  seed(db);
  const products = loadProducts(db, "2026-W43", "Netto", []);
  const items = [{ id: 7, name: "Ris", qty: 200, unit: "g" as const, location: "skab" as const, expires: null, productId: null, source: null }];
  const r = good();
  r.dishes[0]!.ingredients[1] = { name: "ris", qty: 150, unit: "g", kitchenItem: "k99", checkLabel: false };
  r.dishes[1]!.ingredients[1] = { name: "ris", qty: 1, unit: "stk", kitchenItem: "k7", checkLabel: false };
  r.dishes[2]!.ingredients[1] = { name: "ris", qty: 500, unit: "g", kitchenItem: "k7", checkLabel: false };
  const errors = validateResponse(r, products, household, { items });
  assert.ok(errors.some((e) => e.includes("k99 findes ikke")));
  assert.ok(errors.some((e) => e.includes("enheden skal være g som køkkenvaren")));
  assert.ok(errors.some((e) => e.includes("kun 200 g")));
  assert.ok(validateResponse(good(), products, household, { text: "2 løg" }).some((e) => e.includes("mangler kitchen")));
});

test("wishes go into both the prompt and the input, and are kept on the plan", async () => {
  const db = openDb(":memory:");
  seed(db);
  const run = claudeSays(good());
  const { plan } = await generatePlan({ ...options(db, run), wishes: "noget med fisk" });
  assert.match(run.prompts[0]!, /Ønsker til ugen: noget med fisk/);
  assert.equal(JSON.parse(run.inputs[0]!).wishes, "noget med fisk");
  assert.equal(plan.wishes, "noget med fisk");
});

test("an invalid answer is retried once, with the errors in the prompt", async () => {
  const db = openDb(":memory:");
  seed(db);
  const bad = good();
  bad.dishes[0]!.ingredients[0]!.productId = "999";
  const run = claudeSays(bad, good());
  await generatePlan(options(db, run));
  assert.equal(run.prompts.length, 2);
  assert.match(run.prompts[1]!, /productId 999 findes ikke/);
});

test("two invalid answers save nothing and keep the previous plan", async () => {
  const db = openDb(":memory:");
  seed(db);
  const bad = good();
  bad.dishes.pop();
  await assert.rejects(generatePlan(options(db, claudeSays(bad, bad))), /ugyldigt to gange/);
  assert.equal(db.prepare("SELECT 1 FROM plans").get(), undefined);
});

test("a login failure is reported as an expired or invalid token, without retrying", async () => {
  const db = openDb(":memory:");
  seed(db);
  let calls = 0;
  const run: RunClaude = async () => {
    calls++;
    return { code: 1, stdout: "", stderr: "Invalid API key · Please run /login" };
  };
  await assert.rejects(generatePlan(options(db, run)), (e: Error) => e instanceof PlanError && e.message.startsWith("token udløbet eller ugyldigt"));
  assert.equal(calls, 1);
});

test("no fetch for the plan week means no Claude call", async () => {
  const db = openDb(":memory:");
  const run = claudeSays(good());
  await assert.rejects(generatePlan(options(db, run)), /ikke hentet tilbud for 2026-W43/);
  assert.equal(run.prompts.length, 0);
});

test("missing search words fall back to last known prices, marked as estimates", () => {
  const db = openDb(":memory:");
  seed(db, "2026-W42");
  db.prepare("DELETE FROM fetches").run();
  const insert = db.prepare(`INSERT INTO products (week, store, goma_id, query, name, package_amount, unit, price, normal_price, per_kg, on_offer, fetched_at)
    VALUES ('2026-W43', 'Netto', '1', 'ris', 'Basmatiris', 1000, 'g', 21, NULL, NULL, 0, 'x')`);
  insert.run();
  const products = loadProducts(db, "2026-W43", "Netto", ["kylling"]);
  assert.equal(products.get("1")?.price, 21);
  assert.equal(products.get("1")?.estimate, false);
  assert.equal(products.get("2")?.estimate, true);
  assert.equal(products.get("2")?.onOffer, false);
});

test("validation catches unit mismatches, two sources, zero amounts, duplicates and the wrong number suggested", () => {
  const db = openDb(":memory:");
  seed(db);
  const products = loadProducts(db, "2026-W43", "Netto", []);
  const r = good();
  r.dishes[0]!.ingredients[0]!.unit = "stk";
  r.dishes[0]!.ingredients[1]!.basis = true;
  r.dishes[0]!.ingredients[2]!.qty = 0;
  r.dishes[2]!.title = "kylling med ris";
  r.dishes[0]!.suggested = true;
  const errors = validateResponse(r, products, household);
  assert.ok(errors.some((e) => e.includes("enheden skal være g")));
  assert.ok(errors.some((e) => e.includes("præcis én kilde")));
  assert.ok(errors.some((e) => e.includes("større end 0")));
  assert.ok(errors.some((e) => e.includes("samme navn")));
  assert.ok(errors.some((e) => e.includes("suggested: true, men 3 har")));
  assert.deepEqual(validateResponse(good(), products, household), []);
  const short = good();
  short.dishes.pop();
  assert.ok(validateResponse(short, products, household).some((e) => e.includes("3 retter at vælge imellem")));
  const noLeftoverDish = good();
  noLeftoverDish.dishes.reverse();
  assert.ok(validateResponse(noLeftoverDish, products, household).some((e) => e.includes("resteretten")));
});

test("parseClaudeOutput reads structured_output and reports failures", () => {
  assert.deepEqual(parseClaudeOutput({ code: 0, stdout: '{"is_error":false,"structured_output":{"a":1}}', stderr: "" }), { response: { a: 1 } });
  assert.ok("error" in parseClaudeOutput({ code: 0, stdout: "not json", stderr: "" }));
  assert.ok("error" in parseClaudeOutput({ code: 1, stdout: '{"is_error":true,"result":"Max tokens reached"}', stderr: "" }));
  assert.ok("loginError" in parseClaudeOutput({ code: 1, stdout: "", stderr: "Not logged in · Please run /login" }));
  // Seen for real: exit code 0, but is_error with an expired session.
  const expired = '{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}';
  assert.ok("loginError" in parseClaudeOutput({ code: 0, stdout: expired, stderr: "" }));
});

test("the job environment keeps only the OAuth token of the Claude variables", () => {
  const env = jobEnv({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_ENTRYPOINT: "x", ANTHROPIC_BASE_URL: "y", CLAUDECODE: "1" });
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.equal(jobEnv({ CLAUDE_CODE_OAUTH_TOKEN: " sk-ant-oat01-x\n" }).CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-x");
});

test("the prompt names the week, dates, store, diet and number of dinners", () => {
  const prompt = buildPrompt("2026-W44", "Netto", { ...household, dinnersPerWeek: 7, dishOptions: 12 });
  assert.match(prompt, /uge 44: mandag 26\. oktober til søndag 1\. november 2026/);
  assert.match(prompt, /Butik: Netto\./);
  assert.match(prompt, /Kosthensyn: glutenfri, laktosefri\./);
  assert.match(prompt, /Foreslå 12 retter, og markér de 7, du anbefaler, til 2 personer/);
  assert.doesNotMatch(prompt, /Ønsker/);
});
