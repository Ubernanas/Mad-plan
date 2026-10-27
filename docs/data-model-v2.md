# Datamodel v2: plan

Planen bygger på Tristans dokument "Madplan – data model v2" (27. oktober 2026), gennemgået mod den rigtige kode. Den beskriver, hvad vi bygger, i hvilken rækkefølge, og hvad vi bevidst ikke bygger. Læs "Data og opdateringer" i `CLAUDE.md` først: de regler gælder for hvert trin her.

## Hvorfor

Tre problemer, vi har set i praksis:

1. **Dobbelte linjer.** Indkøbslisten har én linje pr. Goma-produkt. Bruger to retter hver sin agurk (agurk og snackagurker), kommer begge på listen.
2. **Varer uden pris.** Uge 44 havde 7 af 30 linjer uden pris. Halvdelen skyldes manglende ord i `config/ingredients.json` eller Goma-søgeord, der ikke findes, ikke for få sider.
3. **Langsom plan.** Ét Claude-kald gør fire ting på én gang: vælger 12 retter, oversætter dem, omregner mængder og matcher hver ingrediens til et af ca. 300 produkter. Det tager 5-8 minutter pr. forsøg.

## Sådan er det i dag

| Emne | I dag |
|---|---|
| Goma | Almindelig kode (`goma.ts`, `http.ts`), cache pr. URL pr. uge, højst 24 sider pr. kørsel, ingen Claude og intet Pro-forbrug |
| Claude | Ét kald pr. plan (`generate.ts`): vælger, oversætter, skalerer og matcher til `productId` |
| Indkøbslisten | Ren kode (`compute.ts`), bygges på millisekunder, også når man vælger andre retter |
| Opskrifter | Fil (`recipes/foodcom.json.gz`) med engelske ingredienser og mængder uden enheder |
| Kobling opskrift → vare | `config/ingredients.json`: engelske ord → Goma-søgeord (med glutenfri/laktosefri variant). Det er en grov udgave af "canonical item" |
| Varer | `products`: én række pr. uge, butik og Goma-produkt med pris, normalpris, kilopris og tilbud. Et ugentligt øjebliksbillede, ikke en prislog |
| Tilbuddets slutdato | Ikke pr. vare; kun avisens slutdato fra eTilbudsavis (`meta`, `leaflet:<uge>`) |
| Erstatninger | `substitutes` i `household.json`, efter Goma-søgeord |
| Køkkenet | `kitchen`: navn, mængde, enhed, sted, udløb, evt. `product_id` |
| Planer | `plans.plan_json`: et komplet øjebliksbillede, som siden kan vise alene |
| Indkøbsdato | Findes ikke |
| Migreringer | `db.ts`: `CREATE TABLE IF NOT EXISTS` og `ADDED_COLUMNS` (tilføjer kolonner, der mangler). Kun tilføjende |

## Beslutninger

- **Ja:** canonical items med aliasser, en prislog med en fast rækkefølge for, hvor prisen kommer fra, og opskrifter, der oversættes én gang og gemmes.
- **Claude navngiver varer, koden vælger produkter.** Claude skriver "agurk 200 g" (et canonical item); koden finder det billigste produkt pr. enhed i ugens butik. Claude ser ikke længere 300 produkter.
- **Goma hentes stadig én gang om ugen** (søndag, når vi trykker "Lav planen", ellers kl. 18). Et lille natligt løb overvejes først i trin 4, og kun hvis der stadig mangler mange priser.
- **Én butik ad gangen.** At kombinere to kæder kræver, at alle søgeord hentes fra flere kæder, og det sprænger grænsen på ca. 25 sider.
- **Intet `ingredient-parser-nlp`.** Datasættet har mistet enhederne ("1/2", ikke "1/2 cup"), så der er ingen rå linje at parse, og det er Python i et Node-projekt. Claude omregner i stedet, én gang pr. opskrift.
- **Gamle planer forbliver, som de er.** v2 bruges fra den første plan efter, hvert trin er deployet. Siden skal kunne vise begge formater.

## Trin 0: forarbejde (ingen ændring af databasen)

Billigst og fjerner det meste af "pris ukendt".

1. **Automatisk backup ved opstart.** `deploy/start.sh` kopierer `/data/madplan.db` til `/data/backups/madplan-<tidspunkt>.db` med `better-sqlite3`'s `db.backup()`, før serveren starter, og beholder de seneste 8. En deploy genstarter maskinen, så hver deploy får en backup af sig selv. Tjek, at kopien kan åbnes.
2. **Ordtabellen.** Tilføj de ingredienser, der manglede i uge 44 (porre, rød karrypasta …), og find Goma-søgeord, der virker, for dem, der gav 404 hos REMA 1000: `tamari`, `soja`, `majsstivelse`, `citron`, `worcestershire-sauce`, `sorte-bønner`, `chilisauce`. Brug ord, Goma selv bruger i produktnavnene fra tidligere hentninger. Hent ikke ekstra sider for at teste.
3. **Knappen "Brug listen, som den står"** på Køkken-siden smider den gemte tekst væk uden fortryd. Giv den "Fortryd", der lægger teksten tilbage, og et navn, der siger, at teksten kasseres.

**Færdigt, når:** backuppen kører ved hver deploy, og en søndag har højst 2-3 linjer uden pris.

## Trin 1: canonical items og aliasser

Fjerner dobbelte linjer og gør Claude-kaldet mindre.

**Nye tabeller**

```sql
CREATE TABLE IF NOT EXISTS canonical_item (
  id          INTEGER PRIMARY KEY,
  name_da     TEXT NOT NULL UNIQUE,   -- 'agurk', 'fløde', 'laktosefri fløde'
  section     TEXT NOT NULL,          -- indkøbslistens afdeling
  base_unit   TEXT NOT NULL CHECK (base_unit IN ('g', 'ml', 'stk')),
  is_staple   INTEGER NOT NULL DEFAULT 0,  -- olie, salt, krydderier: købes aldrig
  goma_query  TEXT,                   -- søgeordet, varen hentes med
  name_filter TEXT                    -- fx 'laktosefri', når varianten deler side med grundvaren
);

CREATE TABLE IF NOT EXISTS item_alias (
  alias             TEXT PRIMARY KEY,  -- normaliseret: 'heavy cream', 'snackagurker'
  canonical_item_id INTEGER NOT NULL REFERENCES canonical_item (id),
  source            TEXT NOT NULL,     -- 'rule' | 'claude' | 'user'
  confirmed         INTEGER NOT NULL DEFAULT 0
);
```

Plus en kolonne via `ADDED_COLUMNS`: `products.canonical_item_id` og `kitchen.canonical_item_id`.

**Sådan**

1. **Indhold.** `config/ingredients.json` er stadig kilden til de faste aliasser (`source = 'rule'`), versioneret i git. Ved opstart lægges de ind i tabellerne (idempotent upsert). Hver regel bliver ét canonical item; basisregler bliver `is_staple`. Kostvarianter (laktosefri fløde) er egne items med `name_filter`, så de kan vælges på grundvarens side.
2. **Hentning.** `fetchWeek` sætter `canonical_item_id` på hver vare ud fra søgeordet og `name_filter`.
3. **Claude.** `input.json` får ugens canonical items (navn, enhed, om der er en pris, og pris pr. enhed) i stedet for alle produkter. Claudes ingredienser får `item` (et canonical items navn) eller, for noget nyt, `buy` med et dansk navn som i dag. Nye navne gemmes som `item_alias` med `source = 'claude'` og `confirmed = 0`.
4. **Koden vælger produktet.** `compute.ts` lægger mængderne sammen pr. canonical item (agurk + snackagurker = én linje) og vælger produktet med lavest pris pr. enhed, der dækker mængden med færrest rester. Planen gemmer, hvilket produkt der blev valgt, som i dag, så den stadig er et øjebliksbillede.
5. **Plan-format.** `plan_json` får `version: 2`. Siden viser både version 1 og 2.
6. **Køkkenet.** Afkrydsede varer og Køkken-tekstens varer får et `canonical_item_id`, så "Lavet" og næste uges plan finder dem på varen, ikke på et bestemt Goma-produkt.

**Færdigt, når:** ingen vare står to gange på listen, Claude-kaldet er tydeligt kortere (mål tid og `total_cost_usd`), og den igangværende uges plan stadig vises rigtigt efter deploy.

## Trin 2: prislog og prisens kilde

Giver en pris eller en tydelig markering på hver linje.

**Nye tabeller**

```sql
-- Et fast produkt på hylden, på tværs af uger
CREATE TABLE IF NOT EXISTS catalog_product (
  id                INTEGER PRIMARY KEY,
  chain             TEXT NOT NULL,
  goma_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  pack_qty          REAL,             -- i varens base_unit
  unit              TEXT,
  canonical_item_id INTEGER REFERENCES canonical_item (id),
  UNIQUE (chain, goma_id)
);

-- Hver pris, vi har set
CREATE TABLE IF NOT EXISTS price_observation (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES catalog_product (id),
  price        REAL NOT NULL,
  normal_price REAL,
  is_offer     INTEGER NOT NULL,
  valid_to     TEXT,                  -- avisens sidste dag for tilbud
  source       TEXT NOT NULL,         -- 'goma' (senere 'receipt', 'manual')
  observed_at  TEXT NOT NULL
);
```

Navnet `catalog_product` undgår at røre den eksisterende `products`-tabel.

**Sådan**

1. **Kopiér historikken.** En engangsmigrering kopierer alle rækker fra `products` over i `catalog_product` og `price_observation`. `products` står urørt.
2. **Skriv begge steder.** Hentningen skriver til både `products` og de nye tabeller i mindst to uger, så vi kan sammenligne. Først derefter læser planen fra de nye.
3. **Prisens kilde, i rækkefølge:** ugens tilbud → seneste normalpris → ældre observation (vises "ca.") → median pr. enhed for varen på tværs af kæder (vises "ca.") → ukendt ("pris ukendt"). `priceSource` får de samme navne.
4. **Tilbuddets slutdato.** Avisens sidste dag skrives som `valid_to` på tilbud, så "køb senest" kommer fra observationen.

**Færdigt, når:** næste plan viser en pris eller "ca." på næsten alle linjer, og de gamle uger stadig vises med deres oprindelige priser.

## Trin 3: opskrifter oversat én gang

Gør planen hurtig: Claude vælger og tilpasser i stedet for at oversætte alt hver gang.

**Nye tabeller**

```sql
CREATE TABLE IF NOT EXISTS recipe (
  id            INTEGER PRIMARY KEY,  -- Food.com-id'et
  kind          TEXT NOT NULL,        -- 'main' | 'side'
  title_en      TEXT NOT NULL,
  title_da      TEXT,
  servings      INTEGER,
  minutes       INTEGER,
  steps_da_json TEXT,                 -- trin på dansk, metrisk, °C
  translated_at TEXT
);

CREATE TABLE IF NOT EXISTS recipe_ingredient (
  id                INTEGER PRIMARY KEY,
  recipe_id         INTEGER NOT NULL REFERENCES recipe (id),
  raw_en            TEXT NOT NULL,    -- 'heavy cream'
  qty               REAL,             -- i varens base_unit
  canonical_item_id INTEGER REFERENCES canonical_item (id),
  optional          INTEGER NOT NULL DEFAULT 0,
  needs_review      INTEGER NOT NULL DEFAULT 0
);
```

**Sådan**

1. **Kun det, der bruges.** Når søndagens kandidater er valgt, oversættes de, der ikke er oversat endnu, i små portioner (fx 10 pr. kald): dansk titel og trin, metriske mængder, og hver ingrediens koblet til et canonical item. Resultatet gemmes. Samlingen vokser hver uge, og det samme arbejde gøres aldrig to gange.
2. **Planen bliver et lille kald.** Claude får de oversatte opskrifter i kort form og returnerer valg, tilbehør, skalering og ændringer (erstatninger, kosthensyn, køkkenvarer) i stedet for 12 fulde opskrifter.
3. **Kø til gennemsyn.** Ingredienser med `needs_review` vises senere som en kort liste at rette; en rettelse gemmes som et bekræftet alias.
4. **Pro-forbrug.** Mål `total_cost_usd` på oversættelseskaldene de første uger. Bliver det for meget, sænkes antallet af nye kandidater pr. uge.

**Færdigt, når:** en plan tager få minutter, og en anden plan i samme uge (efter et ønske) ikke oversætter noget igen.

## Trin 4 (kun hvis det trænger): lille natligt Goma-løb

Kun hvis der efter trin 0 og 2 stadig mangler mere end 3-4 priser om ugen.

- Ca. 15 sider pr. nat med 5-10 sekunders pause, kun ord uden pris de sidste 4 uger, først i den kæde, vi oftest ender i. Samme side hentes aldrig to gange på en uge, og løbet stopper ved første 403 eller 429.
- Giver mest normalpriser; tilbuddene kommer stadig fra søndagens hentning.
- Kræver, at høflighedsreglen i `CLAUDE.md` ændres bevidst fra "én planlagt kørsel om ugen" til "ét lille løb pr. nat".

## Ikke nu

| Ide | Hvorfor ikke |
|---|---|
| Kombinere to butikker (`max_stores`) | Kræver hentning af alle søgeord fra flere kæder; sprænger sidegrænsen |
| Kvitteringer, købshændelser og regelforslag | Godt, men stort. Tidligst, når trin 1-3 har kørt et par uger |
| "Lav en frokost" | En ny funktion; kræver reservationer af ugens middage. Efter trin 1 |
| Præferencetabel (økologi, mærke, prisstrategi) | Giver først mening, når koden vælger produkter (trin 1) og har en prislog (trin 2) |
| Apify, Nemlig | Betalt eller dækket af Goma |
| `ingredient-parser-nlp` | Data mangler enheder, og det er Python |

## For hvert trin

1. Lav ændringen bag de eksisterende tabeller (kun tilføjende), med tests mod fixtures.
2. Hent en backup af den rigtige database, kør den nye kode mod den lokalt, og tjek den igangværende plan, flueben og køkkenet.
3. Deploy; backuppen tages ved opstart (trin 0).
4. Brug det nye fra næste plan. Den igangværende uge røres ikke.
5. Opdatér `CLAUDE.md`, når trinnet har kørt en søndag.
