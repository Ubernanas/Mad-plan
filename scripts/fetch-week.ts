// Runs the Sunday fetch by hand: npm run fetch-week

import { loadHousehold, loadIngredientRules } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createHttpClient } from "../src/fetch/http.ts";
import { REMA_HTTP } from "../src/fetch/rema.ts";
import { fetchWeek } from "../src/job/fetch-week.ts";
import { loadRecipes } from "../src/recipes.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env: CONTACT_EMAIL must come from the environment.
}

const db = openDb();
try {
  const summary = await fetchWeek({
    db, http: createHttpClient({ db, ...REMA_HTTP }), household: loadHousehold(), recipes: loadRecipes(), rules: loadIngredientRules(),
  });
  console.log("\nVarer pr. kategori:");
  for (const [category, count] of Object.entries(summary.counts)) console.log(`  ${category.padEnd(46)} ${count}`);
  console.log(`\nGemt: ${summary.saved} varer fra ${summary.choice.store} for ${summary.week}.`);
  if (summary.missing.length) console.log(`Kunne ikke hentes: ${summary.missing.join(", ")}.`);
  console.log(`\nOpskrifter at vælge imellem (${summary.candidates.length}):`);
  for (const r of summary.candidates) console.log(`  ${r.name} (${r.proteins.join(", ")}, ${r.rating}★/${r.reviews})`);
  console.log(`Forespørgsler til REMA: ${summary.pagesFetched}.`);
} catch (error) {
  console.error(`Hentningen stoppede: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
