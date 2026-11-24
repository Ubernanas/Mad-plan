# Madplan

Hver uge henter Madplan priser og tilbud fra REMA 1000's webshop, vælger godt bedømte opskrifter, der er billige med ugens priser, og lader Claude sætte en madplan med 7 aftensmåltider sammen. Du får en mobilvenlig side med ugens retter, opskrifter og en indkøbsliste, I kan krydse af sammen.

Hver husstand kører sin egen kopi: sin egen side på Fly.io, sin egen database og sit eget Claude-abonnement. Ingen deler data eller login.

## Det skal du bruge

- **Et Claude-abonnement (Pro eller højere).** Planen laves af Claude Code med dit eget login. Det bruger lidt af dine Pro-grænser et par gange om ugen.
- **En konto på [fly.io](https://fly.io)** med et betalingskort. Appen kører på én lille maskine med 1 GB RAM, der altid er tændt, så den kan lave planen søndag aften. Se Fly's priser; det er et lille beløb om måneden.
- **Git**, og adgang til dette repo (bed Tristan om en invitation).

Du behøver ikke Node eller Docker på din egen computer. Fly bygger appen.

## Opsætning (ca. 20 minutter, én gang)

### 1. Hent koden

```powershell
git clone <repo-url> madplan
cd madplan
```

### 2. Installer Fly og Claude Code

Windows (PowerShell):

```powershell
iwr https://fly.io/install.ps1 -useb | iex
irm https://claude.ai/install.ps1 | iex
```

Mac:

```bash
brew install flyctl
curl -fsSL https://claude.ai/install.sh | bash
```

### 3. Lav et Claude-token

```powershell
claude setup-token
```

Log ind med dit Claude-abonnement. Kommandoen skriver et token, der starter med `sk-ant-oat01-` og virker i et år. Gem det til trin 5, og del det ikke med nogen.

### 4. Opret din app på Fly

```powershell
fly auth login
fly launch --copy-config --no-deploy --name madplan-<dit-navn> --region arn
```

Vælg et navn, ingen andre har brugt, fx `madplan-anna`. Siden kommer til at hedde `https://madplan-<dit-navn>.fly.dev`. Svar nej, hvis den spørger om en database (Postgres, Redis eller lignende): appen bruger SQLite på et volume.

Lav så volumet, som databasen ligger på, hvis `fly volumes list` ikke allerede viser et, der hedder `madplan_data`:

```powershell
fly volumes create madplan_data --region arn --size 1
```

### 5. Sæt dine hemmeligheder

```powershell
fly secrets set CLAUDE_CODE_OAUTH_TOKEN=<dit token> BASIC_AUTH_USER=<brugernavn> BASIC_AUTH_PASS=<adgangskode> CONTACT_EMAIL=<din e-mail>
```

- `BASIC_AUTH_USER` og `BASIC_AUTH_PASS`: det login, I bruger til siden. Vælg selv; I deler det i husstanden.
- `CONTACT_EMAIL`: sendes med, når appen henter priser fra REMA, så de kan kontakte dig, hvis der er noget. Det er høflig skik for automatiske hentninger.

### 6. Tilpas til jer

Skriv jeres smag i `config/preferences.md` (hvad I kan lide, hvad I ikke kan lide, hvor lang tid maden må tage). Claude læser den hver gang.

Skriv datoen, hvor dit token udløber (om et år), i `oauthTokenExpires` i `config/household.json`, så du kan huske at forny det.

Gem ændringerne i din kopi:

```powershell
git commit -am "Vores indstillinger"
```

### 7. Deploy

```powershell
fly deploy
```

Åbn `https://madplan-<dit-navn>.fly.dev` og log ind.

### 8. Ret indstillingerne, før den første plan

Tryk på tandhjulet (⚙). **Standarden er glutenfri og laktosefri til 2 personer**, så ret kosthensyn, antal personer, budget og antal aftener til jer. Det gemmes i databasen.

Tryk så på **"Lav planen"** på forsiden. Første gang tager det nogle minutter, fordi priserne skal hentes. Derefter laves planen automatisk hver søndag kl. 18, hvis I ikke selv har trykket.

## Få nye versioner

Når Tristan har lavet noget nyt:

```powershell
git pull
fly deploy
```

Appen tager en backup af databasen, hver gang den starter, så jeres planer og flueben er sikre. Siger `git pull`, at der er en konflikt i en af filerne fra trin 6, så behold jeres egen linje.

## Når noget går galt

- **"Token udløbet eller ugyldigt":** lav et nyt med `claude setup-token`, og sæt det med `fly secrets set CLAUDE_CODE_OAUTH_TOKEN=<nyt token>`.
- **Se, hvad appen laver:** `fly logs`.
- **Planen er lavet af AI.** Læs altid varedeklarationen, hvis I har allergier.

## For udviklere

`CLAUDE.md` beskriver, hvordan systemet er bygget, og reglerne for at ændre det. Lokalt: `npm install`, kopiér `.env.example` til `.env`, og kør `npm run dev` og `npm test`. Under udvikling hentes der ikke fra REMA, og Claude kaldes ikke; alt kører mod `fixtures/`.
