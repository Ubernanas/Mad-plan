// Fetches a few Goma pages once and saves them to fixtures/html/, so the parser
// can be developed without touching Goma again. Goes through the polite client.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createHttpClient } from "../src/fetch/http.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env: CONTACT_EMAIL must come from the environment.
}

const pages: [file: string, url: string][] = [
  ["kylling.html", "https://goma.gg/tilbud/kylling"],
  ["hakket-oksekoed.html", "https://goma.gg/tilbud/hakket-oksekød"],
  ["kylling__netto.html", "https://goma.gg/tilbud/kylling?store=netto"],
  ["ris__netto.html", "https://goma.gg/tilbud/ris?store=netto"],
  ["hakkede-tomater__rema1000.html", "https://goma.gg/tilbud/hakkede-tomater?store=rema1000"],
  ["etilbudsavis__netto.html", "https://etilbudsavis.dk/Netto"],
];

const db = openDb();
const http = createHttpClient({ db });

for (const [file, url] of pages) {
  const body = await http.get(url);
  if (body === null) {
    console.log(`Mangler: ${url}`);
    continue;
  }
  writeFileSync(join("fixtures", "html", file), body);
  console.log(`Gemt: ${file} (${body.length} tegn)`);
}
console.log(`Forespørgsler i alt: ${http.pagesFetched()}`);
db.close();
