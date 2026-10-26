# Madplan

Personligt system, der hver uge henter tilbud fra de butikker, vi handler i, og laver en madplan og en indkøbsliste ud fra dem. Kun til eget brug (Tristan og Sille). Det er ikke et produkt: hold det simpelt, og byg kun den fase, vi er i.

## Hvad det gør (når alle faser er bygget)

1. **Søndag kl. 14 (Europe/Copenhagen)** henter koden ugens tilbud og priser fra Goma og gemmer dem i SQLite.
2. **Valgfrit (P3):** mellem kl. 14 og 18 kan vi rette, hvad vi har i køkkenet, og trykke "Lav planen".
3. **Søndag kl. 18** laves planen automatisk, hvis den ikke allerede er lavet. `claude -p` foreslår `dishOptions` retter (standard 12) ud fra de hentede produkter og anbefaler `dinnersPerWeek` af dem. Koden bygger indkøbslisten og regner alle priser ud.
4. Planen vises på en mobilvenlig webside med ugens retter og en indkøbsliste, vi begge kan krydse af. Claudes anbefalede retter er valgt på forhånd, men vi kan selv vælge andre blandt forslagene.

## Faser

Byg én fase ad gangen. Gå først videre, når fasen har kørt et par søndage.

### P1: første brugbare søndag

- Hentning og parsing af Goma, med cache og høflighedsregler
- Automatisk valg af butik
- Claude vælger retter. Koden bygger indkøbslisten og regner indkøbspris og portionspris ud
- Webside med ugens retter, opskrifter og indkøbsliste med afkrydsning gemt på serveren
- Knappen "Lav planen" (bruger de allerede hentede data)
- Valg af retter blandt Claudes forslag, og et felt til ønsker til næste plan
- Kosthensyn fra `config/household.json`
- HTTP Basic Auth, cron og deploy på Fly.io

### P2: når P1 kører

- Forventede rester ("Rester for X kr.") på siden
- Bufferregler i prompten
- Dagstatus: "Lavet", "Spring i dag over" og glemte dage
- Gyldighedsdatoer fra eTilbudsavis og "køb senest"-noter
- Indstillingsside til kosthensyn og butikstilstand

### P3: køkkenet

- Køkkenbeholdning med holdbarhed
- "Frys i dag"-beskeder
- Køkkensiden med fritekst før planen laves
- Det, der er tilbage i køkkenet, bruges i næste uges plan

### Ikke i nogen fase

Brugerkonti, flere husstande, notifikationer, bedømmelse af retter, byt én ret med et nyt Claude-kald (valg blandt forslagene dækker behovet), opskriftsdatabase, native app. Senere features står i `docs/ideer.md`: lagerkøb og "planlæg resten af ugen igen". Køleskabsskærmen (`#/skaerm`) er bygget. Byg dem ikke, men design datamodellen, så de kan tilføjes: gem kilopriser, og giv `kitchen`-tabellen mængde, enhed, placering (køl, frost, skab) og holdbarhed fra start.

## Arkitektur

- **Én Fly-app**, én maskine, `min_machines_running = 1` og ingen auto-stop, så cron kan køre. Volume på `/data` til SQLite.
- **Stack:** Node 22 + TypeScript, Hono til web, `better-sqlite3`, `node-cron` med tidszone `Europe/Copenhagen`, plain HTML/CSS med lidt vanilla JS. Ingen frontend-framework og intet build-step til frontend.
- **Claude Code** installeres i Docker-imaget som npm-pakken `@anthropic-ai/claude-code` med fastlåst version.
- **Mapper:**
  - `src/server.ts`: web og routes
  - `src/fetch/http.ts`: fælles HTTP-klient med User-Agent, pauser og cache
  - `src/fetch/goma.ts`: henter og parser Gomas søgesider
  - `src/fetch/validity.ts` (P2): avisernes gyldighedsdatoer fra eTilbudsavis
  - `src/job/store.ts`: vælger ugens butik
  - `src/job/generate.ts`: bygger prompt, kører `claude -p` og validerer svaret
  - `src/job/compute.ts`: bygger indkøbslisten og regner priser og rester ud
  - `src/job/schema.json`: JSON Schema for Claudes svar
  - `src/job/system-prompt.md`: instruktioner til den Claude, der laver planen
  - `src/db.ts`: SQLite
  - `config/`: husstand, præferencer, vareliste og enhedstabel
  - Arbejdsmappen, som `claude -p` køres fra, ligger uden for repoet: `/data/jobdir` på Fly, temp-mappen lokalt (`JOB_DIR` overstyrer)

## Arbejdsdeling mellem Claude og koden

Claude er god til at vælge retter. Koden er god til at regne. Hold dem adskilt:

- **Claude** foreslår retter, anbefaler ugens udvalg, skriver opskrifter og angiver for hver ingrediens hvilket produkt fra de hentede data den bruger (`productId`) og hvor meget, i gram, milliliter eller stk.
- **Koden** gør resten: samler indkøbslisten pr. produkt, runder op til hele pakninger, slår priser op, regner indkøbspris, portionspris og forventede rester ud, og markerer varer med `checkLabel`.

Claude skal aldrig regne priser eller pakninger ud. Det fjerner den største fejlkilde.

## Claude-kaldet

Godkendelse sker med `CLAUDE_CODE_OAUTH_TOKEN`, et 1-årigt token lavet lokalt med `claude setup-token` og sat som Fly-secret.

- **Brug den uændrede `claude`-CLI.** Kald ikke Anthropic API'et direkte med abonnementstokenet, og brug ikke Agent SDK-pakkerne med det. Abonnementslogin er kun tilladt i Anthropics egne apps som Claude Code.
- **Brug ikke `--bare`.** Bare mode læser ikke `CLAUDE_CODE_OAUTH_TOKEN`.
- **Kør fra en mappe uden for repoet,** så denne CLAUDE.md ikke bliver læst ind i jobbet. Claude Code læser CLAUDE.md i arbejdsmappen og alle mapper over den, så en undermappe i repoet er ikke nok. Jobbet får kun `CLAUDE_CODE_OAUTH_TOKEN` af Claude- og Anthropic-variablerne og kører med `--strict-mcp-config` og `--no-session-persistence`.
- **Ingen web-værktøjer.** Produkterne sendes ind som JSON via stdin:

  ```bash
  cat input.json | claude -p "<ugens prompt med dato, butik, kosthensyn og antal retter>" \
    --append-system-prompt-file ../src/job/system-prompt.md \
    --disallowedTools "WebFetch,WebSearch,Bash" \
    --permission-mode dontAsk --permission-prompts none \
    --output-format json --json-schema "$(cat ../src/job/schema.json)"
  ```

- `input.json` indeholder ugens produkter fra den valgte butik (`id`, `name`, `packageAmount`, `unit`, `price`, `onOffer`, `perKg`), præferencer, ønsker til ugen (`wishes`) og kosthensyn. Fra P3 også køkkenbeholdningen.
- Claude må kun bruge produkter fra `input.json`, basisvarer og (fra P3) køkkenvarer.
- Læs `structured_output`, og valider: hver `productId` findes, mængderne er positive, enheden passer til produktet, der er præcis `dishOptions` forskellige retter, og præcis `dinnersPerWeek` har `suggested: true`. Ved fejl prøves én gang til. Fejler det igen, logges fejlen, og den forrige plan bliver stående.
- Exit code ≠ 0 eller fejltekst om login: log "token udløbet eller ugyldigt". Tokenet fornyes en gang om året. Udløbsdatoen står i `config/household.json`.
- Planen laves højst et par gange om ugen. Forbruget tæller med i Pro-grænserne.

## Skema

### Claudes svar (`schema.json`)

- `storeReason`: kort begrundelse for butikken
- `dietRespected[]`: hvilke kosthensyn planen overholder
- `dishes[]`: `title`, `description` (én sætning til valget), `suggested`, `servings`, `timeMinutes`, `steps[]` og `ingredients[]` med:
  - retterne står i den rækkefølge, de bør laves i; de valgte får dagene fra mandag i den rækkefølge
  - `name`, `qty`, `unit` (`g`, `ml` eller `stk`)
  - præcis én kilde: `productId` (fra `input.json`), `kitchenItem` (P3) eller `basis: true`
  - `checkLabel`: true for varer, hvor allergener ofte gemmer sig (bouillon, saucer, krydderiblandinger, færdigretter, pålæg)
- `notes[]`

### Det koden beregner (`compute.ts`)

- `shoppingList[]`: én linje pr. produkt med `section`, `item`, `packageSize`, `packages`, `price`, `priceSource`, `checkLabel`, og fra P2 `buyBefore`
- `totalPurchaseCost`, og pr. ret `mealCost` og `pricePerPortion`
- `options[]` (alle forslag med pris), `selected[]` (de valgte), `meals[]` (de valgte med dag) og `products` (et øjebliksbillede af de brugte varer). Vælger vi andre retter, regnes planen om ud fra disse felter alene (`selectDishes`), uden Claude og uden databasen.
- P2: `leftovers[]` og `leftoverValue`

`fixtures/uge44.json` fra smoke-testen viser, hvordan den færdige plan ser ud på siden (efter kodens beregninger). Det er ikke Claudes rå svar.

## Tilbudsdata

Der findes ikke et åbent API for danske tilbudsaviser. Gomas Data API kræver en aftale og bruges ikke. Koden henter derfor fra offentlige sider, høfligt og sjældent.

### Kilder

- **Goma.** Søgesiderne er server-renderet HTML:
  - `goma.gg/tilbud/<vare>`: tilbud på tværs af kæder med butik, produkt, størrelse, pris, normalpris og kilopris. Kun side 1 hentes.
  - `goma.gg/tilbud/<vare>?store=<kæde>`: alle kædens varer for søgningen, også normalpriser, uden paginering. Kæde-slugs: `netto`, `fotex`, `bilka`, `lidl`, `rema1000`, `365discount`, `superbrugsen`, `meny`, `kvickly`.
- **eTilbudsavis (P2, kun datoer).** Kædesiderne (fx `etilbudsavis.dk/Netto`) indeholder avisernes gyldighedsperioder, men ingen produkter.
- **REMA 1000 (reserve, bygges kun hvis Goma holder op med at virke).** `shop.rema1000.dk/avisvarer` kan læses som tekst.

**Virker ikke, og skal ikke forsøges:** Gomas butikssider (`/dagligvarer?store=…`, JavaScript), tilbudsaviser som billeder (Goma, eTilbudsavis, Netto), Lidls sider (afviste hentning) og `goma.gg/api/internal/` (spærret i robots.txt).

### Parsing

- Hver række gemmes med `store`, `name`, `packageAmount`, `unit` (`g`, `ml` eller `stk`), `price`, `normalPrice`, `perKg`, `onOffer`, `fetchedAt`.
- Størrelser normaliseres: "1,5 kg" bliver 1500 g, "0,6 kg" bliver 600 g, "3 pak" og "1 stk" bliver stk.
- Parseren testes mod gemte sider i `fixtures/html/`. Når Goma ændrer sin side, opdateres eksemplet og parseren sammen.

### Butiksvalg

- `storeMode: "cheapest"` (standard): hent `goma.gg/tilbud/<vare>` for de 4 proteinvarer (`kylling`, `hakket-oksekød`, `svinekød`, `laks`). For hver kæde i `stores` summeres besparelsen (normalpris minus tilbudspris) på tilbuddene. Tilbud, hvor prisen er lig normalprisen, tæller ikke. Kæden med størst samlet besparelse vælges.
- `storeMode: "fixed"`: brug `fixedStore`, og spring trinnet over.
- Derefter hentes `goma.gg/tilbud/<vare>?store=<kæde>` for hver vare i `config/varer.json`.

### Høflighed

- **Maks. ca. 25 sider pr. kørsel pr. side** (Goma og eTilbudsavis tæller hver for sig), én ad gangen med **5-10 sekunders pause**. Én planlagt kørsel om ugen. Over ca. 25 sider på få minutter begyndte Goma at fejle i testen.
- **Cache pr. URL i SQLite** i ugen. Samme side hentes aldrig to gange i samme uge, heller ikke ved "Lav planen".
- **Ærlig User-Agent:** `madplan-personlig/1.0 (+kontakt: <CONTACT_EMAIL>)`. Ingen forklædning som browser.
- **Omgå aldrig en blokering.** Ingen falske headers, proxyer, skiftende IP-adresser eller headless browser. Ved 403, 429 eller ændret robots.txt: stop med kilden, og log det tydeligt.
- Tjek robots.txt ved opstart. En fejlet side springes over, og varen bliver et skøn.

### Sikring mod tomme data

Giver en proteinsøgning 0 rækker, eller giver over halvdelen af varelisten 0 rækker, stopper jobbet **før** Claude-kaldet med "kilden har ændret sig". Den forrige plan bliver stående.

## Madplanen

- `dinnersPerWeek` aftensmåltider (standard 7, mandag-søndag) til `persons` personer, med rester til frokost hvor det giver mening.
- Basisvarer (olie, salt, peber, tørre krydderier, eddike, sukker) står ikke på indkøbslisten.
- Opskrifterne skrives af Claude. Kopiér ikke opskrifter fra andre sider.
- Retter, der deler ingredienser, foretrækkes, så hele pakninger bliver brugt.
- Indkøbslisten er grupperet efter afdeling og tænkt til 1-2 store indkøb om ugen.
- **Budget:** `weeklyBudgetDkk` er et mål, ikke en grænse. Claude skal sigte efter det. Siden viser indkøbsprisen ved siden af budgettet, men en plan over budget afvises ikke.

### Kosthensyn

- P1: `diet` i `household.json` (`glutenFree`, `lactoseFree`, `other`). P2: samme valg på indstillingssiden, gemt i SQLite.
- Planen må ikke indeholde ingredienser med de valgte allergener og skal bruge passende varianter (fx glutenfri pasta). Mangler en variant i varelisten, vælger Claude en anden ret.
- Varer med `checkLabel` vises med "tjek varedeklarationen".
- Siden viser en kort note om, at planen er lavet af AI og ikke erstatter at læse varedeklarationen.

## Priser

- **Indkøbspris** (`totalPurchaseCost`): hvad der betales ved kassen, summen af hele pakninger. Køber vi 1 kg ris og bruger 300 g, tæller hele pakken.
- **Portionspris** (`pricePerPortion`): prisen for den mængde, retten bruger, delt med antal portioner.
- **`priceSource`** pr. vare: `"offer"` (tilbud fra Goma), `"regular"` (normalpris fra Goma) eller `"estimate"` (kunne ikke hentes, vises med "ca.").

## P2: rester, buffer og dagstatus

### Forventede rester

Koden regner købt mængde minus planlagt forbrug ud pr. vare og viser "Rester for X kr." under indkøbsprisen. Målet er under 10 % af indkøbsprisen. Smoke-testen gav 11 % (ca. 52 kr.). Det er en prognose ved planlægning, ikke det, der faktisk er i køkkenet.

### Buffer i planen

- Retter med de mest letfordærvelige varer (fisk, hakket kød, frisk grønt) lægges først i ugen. Holdbare og frosne lægges sidst.
- Ugens sidste ret er en **resteret** med holdbare varer, så den kan laves, selv om en dag er blevet sprunget over.

### Gyldighed

Avisens slutdato fra eTilbudsavis giver `buyBefore` på tilbudsvarer. Avisernes perioder passer ikke med mandag-søndag (Netto lørdag-fredag, REMA og Lidl slutter lørdag), så planen skriver fx "Køb flæskesteg til lørdag og søndag senest fredag, og frys den ned." Kun kød og fisk får besked om at fryse; varer, der holder, får "Tilbuddet på kartofler slutter fredag."

- Søndagsjobbet henter kædesiden (fx `etilbudsavis.dk/Netto`) efter Goma: 1 side plus robots.txt. Fejler den, laves planen uden "køb senest"-noter.
- Siden er en JavaScript-app, men HTML'en indeholder hver avis som JSON med `label`, `validFrom` og `validUntil`. Ugeavisen er den, der gælder planugens mandag, ikke hedder "nonfood" og helst hedder "uge N". `validUntil` er midnat, så sidste dag er dagen før.
- Kædesidernes adresser står i `src/fetch/validity.ts` og kommer fra eTilbudsavis' sitemap: `Netto`, `fotex`, `Bilka`, `REMA-1000`, `Lidl`, `365discount`, `SuperBrugsen`, `MENY`, `Kvickly`.
- Parseren testes mod `fixtures/html/etilbudsavis__netto.html`.

### Dagstatus

Hver ret har status `planned`, `done` eller `skipped`.

- **"Lavet"** sætter `done`.
- **"Spring i dag over"** sætter `skipped`, og koden flytter de resterende retter én dag frem uden at kalde Claude. Ugens sidste ret ryger ud.
- **Glemte dage:** har en tidligere dag stadig `planned`, viser forsiden øverst "Lavede I [ret] i går?" med **"Færdig"** og **"Sprunget over"**. De virker som "Lavet" og "Spring over". Ved flere glemte dage spørges der om én ad gangen, ældste først. Systemet gætter aldrig selv.
- Når ugen er gået i gang (en ret er lavet, eller en dag er sprunget over), kan retterne ikke vælges om, så tidligere dage ikke bliver byttet rundt. Dagstatus ændrer ikke indkøbslisten eller priserne.

## P3: køkkenet

Køkkenbeholdningen er et **skøn**, ikke et præcist lager. Vi registrerer ikke frokoster, snacks og halve løg, så den bliver aldrig helt rigtig. Søndagens køkkenside er stedet, hvor den rettes.

### `kitchen`-tabellen

- Felter: `name`, `qty`, `unit`, `location` (`køl`, `frost`, `skab`), `expires`.
- Afkrydsede varer på indkøbslisten lægges i køkkenet med en holdbarhed ud fra kategorien: frisk fisk 2 dage, hakket kød 2 dage, andet kød 3 dage, grønt 5 dage, køl (fx æg) 14 dage, holdbart 6 måneder, frost 3 måneder. Kartofler, løg og hvidløg ligger i skab, andet grønt i køl. Holdbarheden regnes fra den dag, varen krydses af.
- Hver afkrydsning laver én række med `source` = `plan:<id>:<produkt>`, så en fortrudt afkrydsning fjerner præcis den række igen. Rækken husker Goma-produktet (`product_id`).
- Knappen **"Marker alt som købt"** findes, så køkkenet ikke er tomt, fordi listen ikke blev krydset af i butikken.
- "Lavet" trækker rettens ingredienser fra. Mængder går aldrig under 0.
- "Lavet" trækker fra de rækker, retten bruger: via `product_id` for købte varer (ældste først) og via `kitchenItem` for køkkenvarer. Stk og gram omregnes med `config/units.json`. Det, der faktisk blev trukket fra, gemmes, så "Fortryd" lægger præcis det tilbage.
- Udløbne friske varer fjernes automatisk fra listen, der sendes til Claude.
- **"Frys i dag":** ligger en ret efter holdbarheden for en af dens friske varer i køleskabet (fordi den er flyttet, eller fordi den var planlagt sådan), vises beskeden på forsiden og på køkkensiden, og varen flyttes til frost i 3 måneder, når man trykker. Kan fortrydes.

### Køkkensiden (valgfri)

- Ét fritekstfelt, udfyldt på forhånd med køkkenets indhold, fx "2 løg, en halv pose ris, 300 g hakket kød i fryseren".
- Teksten gemmes som kladde ("Gem teksten", eller "Lav planen" søndag før planen er lavet), og den næste plan sender den med til Claude, også planen kl. 18. Claude omregner den til `kitchen[]` med `g`, `ml` eller `stk`, sted og kategori, og bruger varerne i samme kald. Teksten erstatter derefter `kitchen`: varer med samme navn og sted beholder deres holdbarhed, nye får kategoriens. Kladden ryddes, når den er brugt.
- Uden kladde får Claude køkkenets rækker (`kitchen` med id'er som `k12`) og kan bruge dem med `kitchenItem`. Køkkenvarer kommer ikke på indkøbslisten og koster 0 kr. i portionsprisen.
- Til omregning fra stk til gram bruger koden `config/units.json` med typiske vægte (fx 1 løg ≈ 150 g, 1 peberfrugt ≈ 170 g, 1 æg ≈ 60 g).
- Bruges siden ikke, laves planen kl. 18 med køkkenet, som det står. Ingen påmindelser.

## Konfiguration

`config/household.json` (startværdier, skal bekræftes):

```json
{
  "persons": 2,
  "weeklyBudgetDkk": 460,
  "dinnersPerWeek": 7,
  "dishOptions": 12,
  "diet": { "glutenFree": true, "lactoseFree": true, "other": "" },
  "stores": ["Netto", "Føtex", "Bilka", "REMA 1000"],
  "storeMode": "cheapest",
  "fixedStore": null,
  "fetchCron": "0 14 * * 0",
  "planCron": "0 18 * * 0",
  "timezone": "Europe/Copenhagen",
  "oauthTokenExpires": "YYYY-MM-DD"
}
```

- `config/varer.json`: ca. 20 Goma-søgeord, der prissættes hver uge, fx `["kylling", "hakket-oksekød", "svinekød", "laks", "kartofler", "løg", "gulerødder", "peberfrugt", "broccoli", "ris", "hakkede-tomater", "kokosmælk", "kidneybønner", "hvidløg", "æg", "agurk", "citron"]`. Mangler planen ofte en vare, tilføjes den her.
- `config/preferences.md`: fri tekst om, hvad vi kan lide og ikke kan lide, og hvor lang tid en hverdagsret må tage.
- `config/units.json` (P3): typiske vægte pr. stk.
- Fra P2 overstyrer indstillingssiden kosthensyn, personer, retter pr. uge, budget og butik (`src/settings.ts`). Kun de værdier, der afviger fra `household.json`, gemmes i SQLite, så `household.json` stadig er standarden for resten. Jobbene bruger `effectiveHousehold(db)`, ikke `loadHousehold()`.
- Butikkerne skal kunne skiftes ved flytning (Fredericia) uden kodeændringer.

## Deploy

- `fly launch` med Dockerfile, volume `madplan_data` på `/data`, region `arn`.
- Secrets: `CLAUDE_CODE_OAUTH_TOKEN`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`, `CONTACT_EMAIL`.
- Mindst 1 GB RAM, da Claude Code kører i containeren.
- `GET /health` til Fly health check.

## Design

Følg `docs/design.md` for struktur, skærme og principper. Kort sagt: én opgave pr. skærm, fanebjælke i bunden med højst 4 faner, højst 2 niveauer, trykflader på mindst 48 px, fortryd i stedet for bekræftelser, og indkøbslisten skal virke uden signal. Brug tjeklisten i bunden af filen, før en skærm er færdig.

## Arbejdsform

- Kode og identifikatorer på engelsk. Brugerfladen på dansk.
- Små, læsbare filer. Ingen abstraktioner til fremtidige behov.
- Udvikl mod fixtures, så der hverken hentes fra Goma eller bruges abonnement under udvikling: gemte Goma-sider i `fixtures/html/` (hentet én gang i starten), et gemt Claude-svar i `fixtures/claude-response.json` og den færdige plan i `fixtures/uge44.json`.
- **Byggerækkefølge for P1:** 1) `http.ts` og Goma-parseren mod fixtures, 2) én rigtig hentning af varelisten, 3) butiksvalg, 4) Claude-kaldet og `compute.ts`, 5) websiden, 6) deploy og cron.
- Hvis noget i denne fil er uklart eller ikke kan lade sig gøre, så spørg, før du bygger rundt om det.
