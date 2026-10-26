// Makes the week's plan by hand: npm run make-plan
//   --save-fixtures  also write fixtures/claude-response.json and fixtures/uge<NN>.json
//   --from-fixture   use fixtures/claude-response.json instead of calling Claude

import { readFileSync, writeFileSync } from "node:fs";
import { loadItemSections, loadPreferences } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { generatePlan, type RunClaude } from "../src/job/generate.ts";
import { getWishes, setWishes } from "../src/job/plan-job.ts";
import { getKitchenDraft, listKitchen, setKitchenDraft } from "../src/kitchen.ts";
import { effectiveHousehold } from "../src/settings.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env: CLAUDE_CODE_OAUTH_TOKEN must come from the environment.
}

const args = process.argv.slice(2);
const RESPONSE_FIXTURE = "fixtures/claude-response.json";

const fromFixture: RunClaude = async () => ({
  code: 0,
  stdout: JSON.stringify({ type: "result", is_error: false, structured_output: JSON.parse(readFileSync(RESPONSE_FIXTURE, "utf8")) }),
  stderr: "",
});

const db = openDb();
try {
  const started = Date.now();
  const { plan, response } = await generatePlan({
    db,
    household: effectiveHousehold(db),
    sections: loadItemSections(),
    preferences: loadPreferences(),
    wishes: getWishes(db),
    kitchenText: getKitchenDraft(db),
    ...(args.includes("--from-fixture") ? { run: fromFixture } : {}),
  });
  // Used up, as in the real plan job.
  if (!args.includes("--from-fixture")) {
    setWishes(db, "");
    setKitchenDraft(db, "");
  }
  const kr = (n: number) => `${n.toFixed(2).replace(".", ",")} kr.`;
  console.log(`\nPlan for ${plan.week} fra ${plan.store} (${Math.round((Date.now() - started) / 1000)} s):`);
  for (const meal of plan.meals) {
    console.log(`  ${meal.day.padEnd(8)} ${meal.title} · ${meal.timeMinutes} min · ${kr(meal.pricePerPortion)} pr. portion`);
  }
  const fromKitchen = plan.meals.flatMap((m) => m.ingredients.filter((i) => i.kitchenItem).map((i) => `${m.day}: ${i.qty} ${i.unit} ${i.name}`));
  if (fromKitchen.length) console.log(`\nFra køkkenet:\n  ${fromKitchen.join("\n  ")}`);
  console.log(`\nKøkkenet nu: ${listKitchen(db).map((k) => `${k.qty} ${k.unit} ${k.name} (${k.location}, til ${k.expires})`).join("; ") || "tomt"}`);
  console.log(`\nIndkøbspris: ${kr(plan.totalPurchaseCost)} af ${plan.weeklyBudgetDkk} kr. (${plan.shoppingList.length} varer)`);
  for (const line of plan.shoppingList) {
    const marks = [line.priceSource === "offer" && "Tilbud", line.priceSource === "estimate" && "ca.", line.checkLabel && "tjek varedeklarationen"].filter(Boolean);
    console.log(`  [${line.section}] ${line.packages} × ${line.item} (${line.packageSize}) ${kr(line.price)}${marks.length ? `  ${marks.join(", ")}` : ""}`);
  }
  if (args.includes("--save-fixtures")) {
    const week = plan.week.split("-W")[1];
    writeFileSync(RESPONSE_FIXTURE, JSON.stringify(response, null, 2) + "\n");
    writeFileSync(`fixtures/uge${week}.json`, JSON.stringify(plan, null, 2) + "\n");
    console.log(`\nGemt: ${RESPONSE_FIXTURE} og fixtures/uge${week}.json`);
  }
} catch (error) {
  console.error(`Planen blev ikke lavet: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
