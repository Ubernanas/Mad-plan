import assert from "node:assert/strict";
import { test } from "node:test";
import type { Household, Section } from "../config.ts";
import { openDb, setMeta, type DB } from "../db.ts";
import { listKitchen, replaceKitchen } from "../kitchen.ts";
import type { Recipe } from "../recipes.ts";
import type { ClaudeResponse } from "./compute.ts";
import { buildPrompt, generatePlan, jobEnv, loadProducts, parseClaudeOutput, PlanError, validateResponse, type RunClaude } from "./generate.ts";

const FRIDAY = () => new Date("2026-10-23T12:00:00Z"); // plan week 2026-W43
const SECTIONS: Record<string, Section> = { ris: "kolonial", kylling: "kød og fisk" };

const household: Household = {
  persons: 2, weeklyBudgetDkk: 460, dinnersPerWeek: 2, dishOptions: 3,
  diet: { glutenFree: true, lactoseFree: true, other: "" },
  stores: ["Netto"], storeMode: "cheapest", fixedStore: null,
  planCron: "0 18 * * 0", timezone: "Europe/Copenhagen", oauthTokenExpires: "2027-10-01",
};

function seed(db: DB, week = "2026-W43", missing: string[] = []) {
  const insert = db.prepare(`INSERT INTO products (week, store, goma_id, query, name, package_amount, unit, price, normal_price, per_kg, on_offer, fetched_at)
    VALUES (?, 'Netto', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'x')`);
  insert.run(week, "1", "ris", "Basmatiris", 1000, "g", 20, 0);
  insert.run(week, "2", "kylling", "Kyllingebryst", 500, "g", 40, 1);
  insert.run(week, "3", "gulerødder", "Gulerødder", 1000, "g", 10, 0);
  db.prepare("INSERT INTO fetches VALUES (?, 'Netto', 'cheapest', '{\"Netto\":100}', ?, 'x')").run(week, JSON.stringify(missing));
}

function good(): ClaudeResponse {
  const meal = (title: string, suggested = true) => ({
    title, description: "Kylling og ris.", suggested, servings: 2, timeMinutes: 30, steps: ["Kog risene."],
    ingredients: [
      { name: "kylling", qty: 250, unit: "g" as const, productId: "2", checkLabel: false },
      { name: "ris", qty: 150, unit: "g" as const, productId: "1", checkLabel: false },
      { name: "gulerødder", qty: 100, unit: "g" as const, productId: "3", checkLabel: false },
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
  assert.equal(plan.totalPurchaseCost, 20 + 40 + 10); // 300 g of 1 kg rice, 500 g of 500 g chicken, 200 g of 1 kg carrots
  const saved = db.prepare("SELECT week, store FROM plans").all();
  assert.deepEqual(saved, [{ week: "2026-W43", store: "Netto" }]);

  const input = JSON.parse(run.inputs[0]!);
  assert.equal(input.products.length, 3);
  assert.deepEqual(Object.keys(input.products[0]).sort(), ["id", "name", "onOffer", "packageAmount", "perKg", "price", "unit"]);
  assert.equal(input.preferences, "Vi kan lide kylling.");
  assert.equal(input.household.dishOptions, 3);
  assert.equal(plan.options.length, 3);
  assert.deepEqual(plan.meals.map((m) => m.day), ["mandag", "tirsdag"]);
});

const bourbon: Recipe = {
  id: 1, kind: "main", name: "Bourbon Chicken", category: "Chicken Breast", minutes: 35, servings: 4, rating: 5, reviews: 3063,
  ingredients: ["chicken breasts", "soy sauce", "rice"], amounts: ["2", "1/3", "1"], steps: ["Fry.", "Simmer."],
  proteins: ["chicken"], gluten: ["soy sauce"], dairy: [],
};
const lemonPotatoes: Recipe = {
  ...bourbon, id: 2, kind: "side", name: "Greek Lemon Potatoes", rating: 4.8, reviews: 120, proteins: [], gluten: [],
  ingredients: ["potatoes", "lemon", "olive oil"],
};

test("the week's mains and sides are sent to Claude, and a dinner credits both", async () => {
  const db = openDb(":memory:");
  seed(db);
  setMeta(db, "candidates:2026-W43", "[1,2]");
  const answer = good();
  answer.dishes[1]!.recipeId = 1;
  answer.dishes[1]!.sideRecipeId = 2;
  const run = claudeSays(answer);
  const { plan } = await generatePlan({ ...options(db, run), recipes: [bourbon, lemonPotatoes] });

  const sent = JSON.parse(run.inputs[0]!).recipes;
  assert.deepEqual(sent.map((r: Recipe) => `${r.kind}: ${r.name}`), ["main: Bourbon Chicken", "side: Greek Lemon Potatoes"]);
  assert.deepEqual(sent[0].gluten, ["soy sauce"]);
  assert.match(run.prompts[0]!, /hovedret og et tilbehør fra recipes/);
  assert.deepEqual(plan.options[1]!.sources, [
    { name: "Bourbon Chicken", rating: 5, reviews: 3063, url: "https://www.food.com/recipe/1" },
    { name: "Greek Lemon Potatoes", rating: 4.8, reviews: 120, url: "https://www.food.com/recipe/2" },
  ]);
  assert.equal(plan.options[0]!.sources, undefined); // written by Claude itself
});

test("a week without candidates sends no recipes and does not ask for them", async () => {
  const db = openDb(":memory:");
  seed(db);
  const run = claudeSays(good());
  await generatePlan({ ...options(db, run), recipes: [bourbon] });
  assert.deepEqual(JSON.parse(run.inputs[0]!).recipes, []);
  assert.doesNotMatch(run.prompts[0]!, /fra recipes/);
});

test("recipeId must be a main and sideRecipeId a side from the week's recipes; each main is used once", () => {
  const products = loadProducts(seededDb(), "2026-W43", "Netto", []);
  const recipes = new Map([[1, bourbon], [2, lemonPotatoes]]);
  const answer = good();
  answer.dishes[0]!.recipeId = 1;
  answer.dishes[1]!.recipeId = 1;
  answer.dishes[2]!.recipeId = 2;
  answer.dishes[2]!.sideRecipeId = 1;
  const errors = validateResponse(answer, products, household, { items: [] }, recipes);
  assert.ok(errors.includes("recipeId 2 er ikke en hovedret i recipes."), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("To retter har samme recipeId")), errors.join("\n"));
  assert.ok(errors.some((e) => e.endsWith("sideRecipeId 1 er ikke et tilbehør i recipes.")), errors.join("\n"));
});

test("shrimp made with chicken keeps its place in the plan, but not the recipe's credit", async () => {
  const db = openDb(":memory:");
  seed(db);
  setMeta(db, "candidates:2026-W43", "[1,2,7]");
  const shrimp: Recipe = { ...bourbon, id: 7, name: "Cajun Sauteed Shrimp", proteins: ["fish"] };
  const answer = good();
  answer.dishes[1]!.recipeId = 1; // chicken from the chicken recipe: credited
  answer.dishes[2]!.recipeId = 7; // made with Kyllingebryst, not shrimp
  answer.dishes[2]!.sideRecipeId = 2;
  const logged: string[] = [];
  const { plan } = await generatePlan({ ...options(db, claudeSays(answer)), recipes: [bourbon, lemonPotatoes, shrimp], log: (m) => logged.push(m) });
  assert.deepEqual(plan.options[1]!.sources?.map((s) => s.name), ["Bourbon Chicken"]);
  assert.deepEqual(plan.options[2]!.sources?.map((s) => s.name), ["Greek Lemon Potatoes"]);
  assert.ok(logged.some((m) => m.includes('har ikke proteinet fra "Cajun Sauteed Shrimp"')));
});

test("duck, lamb and game are protein too, so confit de canard is a whole dinner", () => {
  const products = loadProducts(seededDb(), "2026-W43", "Netto", []);
  const answer = good();
  answer.dishes[0]!.ingredients[0] = { name: "confit de canard", qty: 360, unit: "g", kitchenItem: "k1", checkLabel: false };
  const kitchen = { items: [{ id: 1, name: "Confit de canard", qty: 725, unit: "g" as const, location: "skab" as const, expires: null, productId: null, source: null }] };
  assert.deepEqual(validateResponse(answer, products, household, kitchen), []);
});

test("a failed answer is kept, so it can be looked into", async () => {
  const db = openDb(":memory:");
  seed(db);
  const bad = good();
  bad.dishes[0]!.ingredients[0]!.productId = "999";
  await assert.rejects(generatePlan(options(db, claudeSays(bad, bad))));
  const saved = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'lastRejected'").get() as { value: string }).value);
  assert.equal(saved.attempt, 2);
  assert.ok(saved.errors.some((e: string) => e.includes("productId 999")));
  assert.equal(saved.response.dishes.length, 3);
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

test("an ingredient without a product is bought anyway, on the list as \"pris ukendt\"", async () => {
  const db = openDb(":memory:");
  seed(db);
  const answer = good();
  for (const dish of answer.dishes) dish.ingredients.push({ name: "lime", qty: 1, unit: "stk", buy: true, section: "frugt og grønt", checkLabel: false });
  answer.dishes[0]!.ingredients.push({ name: "feta", qty: 100, unit: "g", buy: true, checkLabel: false });
  const products = loadProducts(db, "2026-W43", "Netto", []);
  assert.ok(validateResponse(answer, products, household).some((e) => e.includes("feta: en vare med buy skal have section")));

  answer.dishes[0]!.ingredients.pop();
  const { plan } = await generatePlan(options(db, claudeSays(answer)));
  const lime = plan.shoppingList.find((l) => l.item === "Lime")!;
  // One lime for each of the 2 chosen dishes, on one line without a price.
  assert.deepEqual([lime.priceSource, lime.price, lime.packageSize, lime.section], ["unknown", 0, "2 stk", "frugt og grønt"]);
  assert.equal(plan.unpricedCount, 1);
  assert.equal(plan.totalPurchaseCost, 20 + 40 + 10);
  assert.equal(plan.options[1]!.unpriced, 1);
  assert.equal(plan.leftovers.some((l) => l.item === "Lime"), false);
});

test("every dish is a whole dinner: protein, a filling side and vegetables", () => {
  const products = loadProducts(seededDb(), "2026-W43", "Netto", []);
  const answer = good();
  const [skewers, rice, carrots] = [answer.dishes[0]!, answer.dishes[1]!, answer.dishes[2]!];
  skewers.title = "Græsk kyllingespyd";
  skewers.ingredients = skewers.ingredients.filter((i) => i.productId === "2"); // only the chicken
  rice.ingredients = rice.ingredients.filter((i) => i.productId !== "2"); // no protein
  carrots.ingredients = carrots.ingredients.filter((i) => i.productId !== "3"); // no vegetables
  const errors = validateResponse(answer, products, household);
  assert.ok(errors.some((e) => e.startsWith("Græsk kyllingespyd: retten mangler mættende tilbehør")), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("Græsk kyllingespyd: retten mangler grønt")), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith(`${rice.title}: retten mangler protein`)), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith(`${carrots.title}: retten mangler grønt`)), errors.join("\n"));
  assert.equal(errors.length, 4, errors.join("\n"));
});

test("ketchup is not a vegetable, but potatoes and rice from the kitchen are a side", () => {
  const db = seededDb();
  db.prepare(`INSERT INTO products (week, store, goma_id, query, name, package_amount, unit, price, normal_price, per_kg, on_offer, fetched_at)
    VALUES ('2026-W43', 'Netto', '4', 'ketchup', 'Tomatketchup', 500, 'g', 9, NULL, NULL, 0, 'x')`).run();
  const products = loadProducts(db, "2026-W43", "Netto", []);
  const answer = good();
  answer.dishes[0]!.ingredients = [
    { name: "kylling", qty: 250, unit: "g", productId: "2", checkLabel: false },
    { name: "ketchup", qty: 40, unit: "g", productId: "4", checkLabel: false },
    { name: "kartofler", qty: 400, unit: "g", kitchenItem: "k1", checkLabel: false },
  ];
  const kitchen = { items: [{ id: 1, name: "Kartofler", qty: 1000, unit: "g" as const, location: "skab" as const, expires: null, productId: null, source: null }] };
  const errors = validateResponse(answer, products, household, kitchen);
  assert.deepEqual(errors, [`${answer.dishes[0]!.title}: retten mangler grønt (grøntsager eller salat; løg, hvidløg og krydderurter tæller ikke). Tilføj et tilbehør fra recipes eller et enkelt tilbehør, og skriv trinene til det.`]);
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
  assert.equal(plan.totalPurchaseCost, 40 + 10);
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
