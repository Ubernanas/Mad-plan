// Runs the Sunday fetch by hand: npm run fetch-week

import { loadHousehold, loadItems } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createHttpClient } from "../src/fetch/http.ts";
import { fetchWeek } from "../src/job/fetch-week.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env: CONTACT_EMAIL must come from the environment.
}

const db = openDb();
try {
  const summary = await fetchWeek({ db, http: createHttpClient({ db }), household: loadHousehold(), items: loadItems() });
  const savings = Object.entries(summary.choice.savings).sort(([, a], [, b]) => b - a);
  if (savings.length) {
    console.log("\nBesparelse på proteintilbud:");
    for (const [store, kr] of savings) console.log(`  ${store.padEnd(12)} ${kr.toFixed(2).replace(".", ",")} kr.`);
  }
  console.log("\nVarer pr. søgeord:");
  for (const [query, count] of Object.entries(summary.counts)) console.log(`  ${query.padEnd(16)} ${count}`);
  console.log(`\nGemt: ${summary.saved} varer fra ${summary.choice.store} for ${summary.week}.`);
  if (summary.missing.length) console.log(`Bliver skøn: ${summary.missing.join(", ")}.`);
  console.log(`Forespørgsler til Goma: ${summary.pagesFetched}.`);
} catch (error) {
  console.error(`Hentningen stoppede: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
