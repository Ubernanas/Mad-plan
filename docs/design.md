# Design

Målet er en app, man forstår uden at tænke over den. Den bruges i tre situationer, og strukturen er bygget op om dem, ikke om data.

## Tre situationer

| Situation | Hvor | Hvad man skal | Hvad det kræver |
|---|---|---|---|
| **Planlægning** | Sofaen søndag | Se ugens plan og pris, evt. rette køkkenet | Overblik, tid til at læse |
| **Indkøb** | I butikken med én hånd på vognen | Finde og krydse varer af hurtigt | Store trykflader, sortering efter afdeling, virker med dårligt signal |
| **Madlavning** | Køkkenet med beskidte hænder | Følge opskriften og trykke "Lavet" | Stor tekst, skærmen slukker ikke, få tryk |

Hver skærm er designet til én af de tre situationer.

## Principper

Principperne er valgt fra kendt UX-forskning og oversat til konkrete regler for appen.

1. **Én opgave pr. skærm.** Jo flere valg, jo længere tid tager det at beslutte sig (Hick's lov). Hver skærm har én primær handling, og den er visuelt tydeligst.
2. **Synlig navigation, højst 4 faner.** NN/g fandt, at skjult navigation (hamburger-menu) gav over 20 % dårligere opdagelse af indhold, og anbefaler synlige links ved 4 eller færre punkter. Appen har en fast fanebjælke i bunden med højst 4 faner.
3. **Progressiv visning, højst 2 niveauer.** Det, man bruger ofte, er synligt. Det sjældne ligger ét tryk længere inde. Aldrig mere end 2 niveauer, fordi brugere farer vild derefter (NN/g). Fx: Uge → Opskrift, aldrig Uge → Dag → Opskrift → Trin.
4. **Til tommelfingeren.** Halvdelen af mobilbrug foregår med én hånd (Hoober). Primære handlinger ligger i bunden af skærmen. Trykflader er mindst 48 × 48 px (Apple 44 pt, Material 48 dp) med mindst 8 px imellem.
5. **Genkend, frem for at huske.** Alt, man skal bruge, er synligt: status, pris, om noget er på tilbud. Man skal aldrig huske noget fra én skærm til den næste.
6. **Brug vores ord.** "Lavet", "Spring over", "Tilbud", "ca.", "Rester". Aldrig systemord som "status", "generate", "sync" eller "item".
7. **Vis altid, hvad systemet laver.** Hvornår tilbud sidst blev hentet, om planen er på vej, om et flueben er gemt. Fejl forklares på dansk med, hvad man kan gøre.
8. **Fortryd i stedet for "Er du sikker?".** Alle tryk kan fortrydes i 5 sekunder via en lille bjælke i bunden. Der er ingen bekræftelsesdialoger. Det er hurtigere og forebygger fejl bedre.
9. **Rolig teknologi.** Appen kræver så lidt opmærksomhed som muligt. Ingen notifikationer, ingen røde badges, ingen animationer for animationernes skyld. Den spørger højst om én ting ad gangen (fx en glemt dag).
10. **Små klumper.** Folk kan holde ca. 7 ting i hovedet ad gangen (Millers lov). Indkøbslisten deles i afdelinger, og en ret viser kun 3 fakta på listen: navn, tid og pris pr. portion.
11. **Som apps, I kender.** Fanebjælke i bunden, afkrydsningsliste som i Påmindelser eller Noter, swipe kun som genvej, aldrig som eneste vej (Jakobs lov).
12. **Tomme tilstande forklarer.** En tom skærm siger, hvorfor den er tom, og hvad der sker, fx "Planen laves søndag kl. 18" med knappen "Lav planen nu".

## Struktur

### Faner

```
[ I dag ]   [ Uge ]   [ Indkøb ]   [ Køkken ]
```

- **Køkken** kommer først med i P3. Indtil da er der 3 faner.
- **Indstillinger** er ikke en fane, men et tandhjul øverst på Uge-skærmen, fordi de bruges sjældent (progressiv visning).
- Appen åbner altid på **I dag**.

### Skærmkort

```
I dag ─────────── Opskrift (niveau 2)
Uge ───────────── Opskrift (niveau 2)
   ├ Vælg retter ── (niveau 2)
   └ ⚙ ─────────── Indstillinger (niveau 2)
Indkøb
Køkken (P3) ──── Køleskabsskærm (uden faner)
```

### I dag (forsiden)

Viser kun det, der er relevant lige nu, i denne rækkefølge, og skjuler det, der ikke er relevant:

1. **Spørgsmål** (P2): "Lavede I chili con carne i går?" med "Færdig" og "Sprunget over". Kun ved en glemt dag.
2. **Frys i dag** (P3): kun når en vare ellers bliver for gammel.
3. **Dagens ret:** navn, tid og pris pr. portion. Knappen "Se opskrift".
4. **I morgen:** én linje, så man kan tage noget op af fryseren.
5. **Handlinger i bunden** (P2): "Lavet" som primær knap og "Spring over" som sekundær.

**Søndag** er forsiden i stedet: "Ny plan for uge 44 er klar" med indkøbspris og knappen "Se indkøbsliste", eller før kl. 18 "Planen laves kl. 18" med "Lav planen nu" (og "Ret køkkenet først" fra P3).

### Uge

- **Øverst:** indkøbspris mod budget, fx "464 kr. af 460 kr.", og fra P2 "Rester for 52 kr.". Butik og "tilbud hentet søndag kl. 14".
- **Liste:** 7 rækker med dag, ret, pris pr. portion og status (P2: lavet ✓, sprunget over, i dag).
- Tryk på en ret åbner opskriften.
- **Vælg retter (7 af 12)** åbner valget: alle Claudes forslag med en sætning, tid og pris pr. portion. Claudes anbefalede er valgt på forhånd og mærket "Forslag". Tryk på en ret vælger eller fravælger den, og indkøbspris mod budget opdateres med det samme. Højst så mange retter, som der er aftener. Kan fortrydes. Knappen forsvinder, når ugen er gået i gang (en ret er lavet eller en dag sprunget over).
- **Ønsker til næste plan:** et tekstfelt, der sendes med, næste gang planen laves. Står også på søndagskortet på I dag, før planen er lavet.
- "Lav planen" ligger her, ikke på forsiden, efter søndag.

### Opskrift

- Øverst: navn, tid, portioner og pris pr. portion.
- Ingredienser med mængder. Varer med "tjek varedeklarationen" er markeret.
- Trin som nummereret liste med stor tekst. Skærmen slukker ikke, mens opskriften er åben (Screen Wake Lock).
- "Lavet" fast i bunden.

### Indkøb

Designet til én hånd i butikken:

- **Øverst:** butik, fremskridt ("12 af 21"), samlet pris og evt. "køb kødet til weekenden senest fredag" (P2).
- **Grupperet efter afdeling** i den rækkefølge, man går rundt i en typisk butik: frugt og grønt, kød og fisk, køl, kolonial, frost.
- **Hver række er én stor trykflade** (hele rækken, ikke kun fluebenet): antal × vare, pakningsstørrelse, pris til højre, og mærker for "Tilbud", "ca." og "Tjek varedeklarationen".
- **Afkrydsede varer** bliver grå og glider ned i en sammenfoldet sektion "I kurven (12)", så det, der mangler, altid er øverst.
- **Virker uden signal:** fluebenene gemmes lokalt og synkroniseres, når der er forbindelse igen. Man skal aldrig vente på serveren for at sætte et flueben.
- Skærmen slukker ikke, mens listen er åben.
- P3: "Marker alt som købt" i bunden.

### Køkken (P3)

- Øverst: "Frys i dag"-beskeder, hvis der er nogen.
- Fritekstfeltet med "Lav planen" som primær knap (kun søndag før planen er lavet), ellers "Gem teksten". Er teksten rettet, kan "Brug listen, som den står" smide rettelsen væk.
- Under det: beholdningen grupperet efter køl, frost og skab, med det, der snart udløber, øverst og markeret.
- Nederst: en kort note om, at køkkenet er et skøn.

### Køleskabsskærm

En tablet på væggen i køkkenet, åbnet på `#/skaerm` (link nederst på Køkken). Ingen faner, samme 4 tekststørrelser, bare større, så den kan læses på afstand.

- Til venstre: dato, "Frys i dag"-beskeder, dagens ret med "Se opskrift" og én linje om i morgen.
- Til højre: køkkenbeholdningen som på Køkken. Står tabletten på højkant, kommer den under.
- Skærmen holdes tændt kl. 6-22, så tabletten kan slukke om natten. Siden henter nye data hvert halve minut og genindlæser sig selv efter 12 timer, så den får nye versioner af appen.
- "Til appen" øverst fører til I dag.

### Indstillinger

Glutenfri, laktosefri, andre hensyn, budget, antal personer, antal retter, butik (billigste eller fast). Ændringer gælder fra næste plan, og det står på skærmen. Hver ændring gemmes med det samme og kan fortrydes; der er ingen "Gem"-knap. Tal ændres med − og + (48 px), budgettet i trin af 20 kr.

## Visuelt: kawaii, men rolig

Retningen kommer fra moodboardet "Food app ui" og forhåndsvisningen "Madplan kawaii".

- **Lys og varm:** cremet baggrund (#FFF4EC), pastelkort (lyserød, fersken, smør, mynte, lilla, frost) og én knapfarve (#FF8FAB). Statusfarver bruges kun til betydning: tilbud (smørgul), skøn (stiplet), advarsel (rød).
- **Klistermærke-look:** kort og knapper har en mørk kant (3 px) og en hård skygge under. Knapper trykkes ned, når man trykker.
- **Skrift:** Fredoka til overskrifter og store tal, Nunito til tekst. Begge ligger i appen (`public/fonts/`), så de virker uden signal.
- **Ikoner:** mad med ansigter i samme stil: tyk sort kant, to toner og røde kinder. De fleste er fra Flaticon (`Kawaii png/`), og laks, citron, kokosmælk, kurv, køleskab og frost er tegnet i samme stil (`art/drawn/`). `npm run build-art` laver lette kopier i `public/art/`. Varer, retter og køkkenvarer får ikon efter ord i navnet, ellers afdelingens eller stedets ikon.
- **Pastelflader har altid mørk tekst**, også i mørkt tema.
- **4 tekststørrelser** i alt: lille (mærker), brødtekst, overskrift, stort tal (priser øverst). Brødtekst mindst 16 px.
- **Tekst må aldrig løbe ud af sin boks.** Lange ord deles med bindestreg. Kort i en rullende kolonne må ikke klemmes sammen. Navnet får pladsen, og prisen kan flytte under navnet. Tjek ved 360 px.
- **Tal:** dansk format ("464 kr.", "23,40 kr."), og tal i kolonner med `font-variant-numeric: tabular-nums`.
- **Mørkt tema** følger telefonens indstilling: mørk blomme-baggrund, pastelkort beholder deres farve.
- **Kontrast** mindst WCAG AA (4,5:1 for tekst).

### Bevægelse

Rolig teknologi gælder stadig. Bevægelse er med, når den bekræfter noget eller viser, at systemet arbejder:

- **Bekræftelser, kun lige efter trykket:** fluebenet popper og varen vipper, "Lavet!" stemples med stjerner og hjerter, og kurven jubler med konfetti, når alt er købt. Under 1 sekund, og konfetti højst to gange.
- **Små, langsomme løkker, højst én pr. skærm:** dagens ret svæver let, gryden damper, mens planen laves, og snefnugget drejer på "Frys i dag".
- **Ingen bevægelse**, når telefonen er sat til mindre bevægelse.

## Tjekliste før en skærm er færdig

- Har skærmen én tydelig primær handling, og ligger den i bunden?
- Kan alt bruges med én tommelfinger, og er alle trykflader mindst 48 px?
- Står der kun ord, vi selv ville bruge?
- Kan sidste tryk fortrydes?
- Hvad viser skærmen, når der ingen data er, og når noget fejler?
- Ser den rigtig ud i mørkt tema og på en 360 px bred skærm?

## Kilder

- Nielsens 10 usability-heuristikker, opsummeret af [The Decision Lab](https://thedecisionlab.com/reference-guide/design/nielsens-heuristics)
- NN/g, [Progressive Disclosure](https://nngroup.com/articles/progressive-disclosure/)
- NN/g, [Hamburger Menus and Hidden Navigation](https://www.nngroup.com/articles/hamburger-menus/)
- Steven Hoober, [How Do Users Really Hold Mobile Devices?](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)
- Smashing Magazine, [The Thumb Zone](https://smashingmagazine.com/2016/09/the-thumb-zone-designing-for-mobile-users)
- OpenReplay, [Improving Tap Targets](https://blog.openreplay.com/improving-tap-targets-mobile-ux/)
- Fast Company, [10 Laws of UX, Illustrated](https://www.fastcompany.com/90157775/10-laws-of-ux-illustrated)
- Amber Case, [Principles of Calm Technology](https://www.caseorganic.com/post/principles-of-calm-technology)
