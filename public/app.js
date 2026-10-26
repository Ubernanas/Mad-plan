// Madplan: four screens (I dag, Uge, Indkøb, Køkken) plus recipe, choice,
// settings and the fridge screen, rendered from /api/state. Ticks are saved on the phone first and sent
// to the server when there is a connection, so the shopping list never waits.

const TZ = "Europe/Copenhagen";
const DAYS = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const SECTIONS = ["frugt og grønt", "kød og fisk", "køl", "kolonial", "frost"];
const PLAN_HOUR = 18;

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: keep going in memory */ }
  },
};

let state = store.get("state", null);
/** Ticks made on this phone that the server has not confirmed yet. */
let pending = store.get("pending", []);
let loadError = false;
let basketOpen = false;
let planCountdown = null;
const loadedAt = Date.now();

// ---------- Dates, in Copenhagen time ----------

function copenhagenDate(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${ymd}T00:00:00Z`);
}

function weekKey(now = new Date()) {
  const date = copenhagenDate(now);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Sunday belongs to the coming week (same rule as the server). */
function planWeek(now = new Date()) {
  return weekKey(new Date(now.getTime() + 86400000));
}

function today(now = new Date()) {
  const index = (copenhagenDate(now).getUTCDay() + 6) % 7;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now));
  return { index, day: DAYS[index], hour, week: weekKey(now), planWeek: planWeek(now) };
}

const weekNumber = (week) => Number(week.split("-W")[1]);
/** "2026-10-30" → "fredag". */
const weekdayOf = (isoDate) => new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("da-DK", { weekday: "long", timeZone: "UTC" });

function fetchedText(iso) {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("da-DK", { timeZone: TZ, weekday: "long" }).format(date);
  const time = new Intl.DateTimeFormat("da-DK", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${day} kl. ${time.replace(":", ".")}`;
}

// ---------- Formatting ----------

const kr = (n) => `${n.toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr.`;
const krWhole = (n) => `${Math.round(n).toLocaleString("da-DK")} kr.`;

function amount(qty, unit) {
  const n = (v) => v.toLocaleString("da-DK", { maximumFractionDigits: 2 });
  if (unit === "g" && qty >= 1000) return `${n(qty / 1000)} kg`;
  if (unit === "ml" && qty >= 1000) return `${n(qty / 1000)} l`;
  return `${n(qty)} ${unit}`;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- Icons ----------

/** Words in a product or ingredient name → icon. First match wins, so specific words go first. */
const ICON_WORDS = [
  [/laks|torsk|fisk|sej\b|makrel|sild|tun\b|rødspætte/, "fish"],
  [/reje/, "shrimp"],
  [/kylling|høne|kalkun/, "chicken"],
  [/okse|bøf|steak|gris|svin|flæsk|kotelet|mørbrad|kød|bacon|skinke|pølse|frikadelle|fars/, "steak"],
  [/kartof/, "potato"],
  [/hvidløg/, "garlic"],
  [/løg/, "onion"],
  [/gulerød|gulerod/, "carrot"],
  [/peberfrugt|paprika/, "pepper"],
  [/broccoli|blomkål|grøntsagsblanding/, "broccoli"],
  [/tomat/, "tomato"],
  [/bønne|kikært|linse/, "beans"],
  [/agurk/, "cucumber"],
  [/champignon|svamp/, "mushroom"],
  [/squash|zucchini/, "zucchini"],
  [/aubergine/, "aubergine"],
  [/majs/, "corn"],
  [/ærter/, "peas"],
  [/oliven/, "olive"],
  [/græskar/, "pumpkin"],
  [/rødbede/, "beet"],
  [/radise/, "radish"],
  [/citron|lime/, "lemon"],
  [/kokos/, "coconut"],
  [/ris\b|risotto|basmati|jasmin/, "rice"],
  [/nudl|ramen/, "ramen"],
  [/\bæg\b|æggeblom|æggehvid|skrabeæg|frilandsæg/, "egg"],
  [/salat|spinat|kål/, "salad"],
  [/mælk|fløde|yoghurt/, "milk"],
  [/tortilla|taco/, "taco"],
  [/brød|toast/, "sandwich"],
];
const DRAWN = new Set(["fish", "lemon", "coconut", "basket", "fridge", "snowflake"]);
const SECTION_ICON = { "frugt og grønt": "salad", "kød og fisk": "steak", køl: "milk", kolonial: "pot", frost: "snowflake" };
const PLACE_ICON = { køl: "fridge", frost: "snowflake", skab: "pot" };

function iconName(text) {
  const t = ` ${String(text).toLowerCase()} `;
  return ICON_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
}

function icon(name, cls = "") {
  if (!name) return "";
  return `<img class="icon${cls ? ` ${cls}` : ""}" src="/art/${name}.${DRAWN.has(name) ? "svg" : "webp"}" alt="" loading="lazy">`;
}

/** A dish's icon: its main protein, else its first recognisable ingredient, else a pan. */
function dishIcon(meal) {
  const names = meal.ingredients.map((i) => iconName(i.name)).filter(Boolean);
  return names.find((n) => ["fish", "shrimp", "chicken", "steak", "egg", "beans"].includes(n)) ?? names[0] ?? "pan";
}

const TINTS = ["peach", "pink", "lilac", "butter", "mint", "ice"];
const tintFor = (i) => TINTS[i % TINTS.length];

// ---------- Celebrations ----------

/** One-off animations play only right after the tap, not on every redraw. */
let celebration = null;
function celebrate(kind, key) {
  celebration = { kind, key, until: Date.now() + 1600 };
}
function celebrating(kind, key) {
  return celebration && celebration.kind === kind && celebration.key === key && Date.now() < celebration.until;
}

function sparkles() {
  const star = (fill) => `<path d="M12 2l2.6 6.6L21 9.5l-5 4.4 1.5 6.6L12 17l-5.5 3.5L8 13.9 3 9.5l6.4-.9z" fill="${fill}" stroke="#2e2020" stroke-width="2" stroke-linejoin="round"/>`;
  const heart = (fill) => `<path d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z" fill="${fill}" stroke="#2e2020" stroke-width="2" stroke-linejoin="round"/>`;
  const one = (shape, dx, dy, delay) =>
    `<svg class="spark" style="--dx:${dx}px;--dy:${dy}px;left:calc(50% - 13px);top:62px;animation-delay:${delay}s" viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>`;
  return [
    one(star("#fff1b8"), -110, -50, 0), one(star("#ffd3de"), 110, -60, 0.08), one(heart("#ff8fab"), -90, 40, 0.15),
    one(heart("#e7deff"), 100, 30, 0.22), one(star("#cff3e4"), 0, -80, 0.12),
  ].join("");
}

function confetti() {
  const colors = ["#fff1b8", "#cff3e4", "#e7deff", "#ffffff", "#fff1b8", "#cff3e4"];
  return colors.map((c, i) => `<span class="conf" style="left:${8 + i * 15}%;background:${c};animation-delay:${(i * 0.37) % 1.3}s"></span>`).join("");
}

function steamingPot() {
  return `<div class="hero" style="height:170px">
    <span class="steam" style="--dx:-26px;left:calc(50% - 32px)"></span>
    <span class="steam" style="--dx:8px;left:calc(50% - 9px);animation-delay:.9s"></span>
    <span class="steam" style="--dx:30px;left:calc(50% + 14px);animation-delay:1.8s"></span>
    ${icon("pot", "simmer")}
  </div>`;
}

// ---------- Data ----------

const plans = () => state?.plans ?? [];
const planFor = (week) => plans().find((p) => p.week === week);
const newestPlan = () => plans()[0];
const mealOn = (plan, day) => plan?.meals.find((m) => m.day === day);
/** Once a dish is done or a day skipped, the chosen dishes are fixed (same rule as the server). */
const started = (plan) => (plan?.done?.length ?? 0) > 0 || (plan?.skippedDays?.length ?? 0) > 0;

function isChecked(planId, itemKey) {
  let latest = state?.checks?.[planId]?.[itemKey];
  for (const change of pending) {
    if (change.planId === planId && change.itemKey === itemKey && (!latest || change.at > latest.at)) latest = change;
  }
  return latest?.checked ?? false;
}

async function loadState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    state = await response.json();
    loadError = false;
    store.set("state", state);
  } catch {
    loadError = true;
  }
  render();
  schedulePoll();
}

async function sendPending() {
  if (!pending.length || !navigator.onLine) return;
  const sending = pending.slice();
  try {
    const response = await fetch("/api/checks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: sending }),
    });
    if (!response.ok) throw new Error(String(response.status));
    const { checks } = await response.json();
    if (state) {
      state.checks = { ...state.checks, ...checks };
      store.set("state", state);
    }
    pending = pending.filter((change) => !sending.includes(change));
    store.set("pending", pending);
    if (route().name === "koekken") loadState(); // ticks changed the kitchen on the server
  } catch {
    // Stays in pending and is sent next time.
  }
  render();
}

function tick(planId, itemKey, checked) {
  if (checked) celebrate("tick", itemKey);
  pending.push({ planId, itemKey, checked, at: new Date().toISOString() });
  store.set("pending", pending);
  render();
  sendPending();
}

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const fast = state?.job?.state === "running";
  pollTimer = setTimeout(() => {
    // Nobody reloads the fridge screen by hand, so it reloads itself to pick up new versions of the app.
    if (route().name === "skaerm" && Date.now() - loadedAt > 12 * 3600000) location.reload();
    else if (document.visibilityState === "visible") loadState();
    else schedulePoll();
  }, fast ? 5000 : 30000);
}

// ---------- Undo bar ----------

let undoTimer = null;
/** A short message at the bottom; with onUndo it gets a "Fortryd" button. */
function showUndo(text, onUndo) {
  const bar = document.getElementById("undo");
  const button = document.getElementById("undo-button");
  document.getElementById("undo-text").textContent = text;
  bar.hidden = false;
  button.hidden = !onUndo;
  clearTimeout(undoTimer);
  button.onclick = () => {
    bar.hidden = true;
    clearTimeout(undoTimer);
    onUndo?.();
  };
  undoTimer = setTimeout(() => (bar.hidden = true), 5000);
}

// ---------- Choosing dishes and wishes ----------

let choosing = false;

async function saveSelection(plan, selected) {
  choosing = true;
  render();
  try {
    const response = await fetch(`/api/plans/${plan.id}/selection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    state.plans = state.plans.map((p) => (p.id === plan.id ? body.plan : p));
    store.set("state", state);
  } catch (error) {
    showUndo(navigator.onLine ? error.message || "Valget kunne ikke gemmes." : "Kræver forbindelse.");
  } finally {
    choosing = false;
    render();
  }
}

function toggleDish(id) {
  const plan = newestPlan();
  if (!plan?.options || choosing) return;
  const before = plan.selected;
  const on = before.includes(id);
  if (!on && before.length >= plan.dinnersPerWeek) {
    showUndo(`Der er allerede valgt ${plan.dinnersPerWeek} retter. Fravælg en først.`);
    return;
  }
  if (on && before.length === 1) {
    showUndo("Mindst én ret skal være valgt.");
    return;
  }
  const after = on ? before.filter((x) => x !== id) : [...before, id];
  const title = plan.options[id].title;
  saveSelection(plan, after).then(() =>
    showUndo(on ? `${title} er fravalgt` : `${title} er valgt`, () => saveSelection(newestPlan(), before)));
}

async function postDay(plan, day, status) {
  const response = await fetch(`/api/plans/${plan.id}/days`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ day, status }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  state.plans = state.plans.map((p) => (p.id === plan.id ? body.plan : p));
  store.set("state", state);
}

/** "Lavet" / "Spring over" for a day in this week's plan, with undo. */
async function markDay(day, status) {
  const plan = planFor(today().week);
  if (!plan) return;
  const title = mealOn(plan, day)?.title ?? "Retten";
  try {
    await postDay(plan, day, status);
    if (status === "done") celebrate("done", day);
    render();
    showUndo(status === "done" ? `${title} er lavet` : `${day[0].toUpperCase() + day.slice(1)} er sprunget over`, async () => {
      try { await postDay(planFor(today().week), day, "planned"); } catch { showUndo("Det kunne ikke fortrydes. Kræver forbindelse."); }
      render();
    });
  } catch (error) {
    showUndo(navigator.onLine ? error.message || "Det kunne ikke gemmes." : "Kræver forbindelse.");
  }
}

async function saveWishes(text) {
  try {
    const response = await fetch("/api/wishes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wishes: text }),
    });
    if (!response.ok) throw new Error();
    state.wishes = (await response.json()).wishes;
    store.set("state", state);
    showUndo("Ønskerne er gemt");
  } catch {
    showUndo("Ønskerne kunne ikke gemmes. Kræver forbindelse.");
  }
  render();
}

function wishesField() {
  return `<div class="stack">
    <label for="wishes"><h2>Ønsker til næste plan</h2></label>
    <textarea id="wishes" rows="3" placeholder="Fx noget med fisk, lasagne en dag, ingen svinekød">${esc(state?.wishes ?? "")}</textarea>
    <button class="button secondary" data-action="save-wishes">Gem ønsker</button>
    <p class="small muted">Sendes med, næste gang planen laves.</p>
  </div>`;
}

// ---------- "Lav planen" ----------

/** Waits 5 seconds, so it can be undone before Claude is called. */
function askForPlan() {
  clearTimeout(planCountdown);
  planCountdown = setTimeout(async () => {
    planCountdown = null;
    try {
      const response = await fetch("/api/plan", { method: "POST" });
      const body = await response.json();
      if (state) state.job = body.job;
    } catch {
      if (state) state.job = { state: "failed", message: "Der var ingen forbindelse. Prøv igen, når der er signal." };
    }
    render();
    schedulePoll();
  }, 5000);
  render();
  showUndo("Ny plan laves om 5 sekunder", () => {
    clearTimeout(planCountdown);
    planCountdown = null;
    render();
  });
}

function planButton(label, primary) {
  const t = today();
  const job = state?.job;
  if (planCountdown) return `<p class="notice">Planen laves om lidt …</p>`;
  if (job?.state === "running") {
    return `<div class="card butter stack">${steamingPot()}<p style="text-align:center">Planen er på vej. Det tager et par minutter.</p></div>`;
  }
  const failed = job?.state === "failed" ? `<p class="notice warn">${esc(job.message)}</p>` : "";
  if (!state?.fetches?.[t.planWeek]) {
    const fetchJob = state?.fetchJob;
    if (fetchJob?.state === "running") return `${failed}<p class="notice">Tilbuddene hentes nu. Det tager et par minutter.</p>`;
    const fetchFailed = fetchJob?.state === "failed"
      ? `<p class="notice warn">Tilbuddene kunne ikke hentes: ${esc(fetchJob.message)}</p>` : "";
    return `${failed}${fetchFailed}<p class="muted">Tilbuddene for uge ${weekNumber(t.planWeek)} er ikke hentet endnu. De hentes søndag kl. 14.</p>`;
  }
  const offline = !navigator.onLine;
  return `${failed}<button class="button${primary ? "" : " secondary"}" data-action="plan" ${offline ? "disabled" : ""}>${label}</button>
    ${offline ? `<p class="muted small">Kræver forbindelse.</p>` : ""}`;
}

// ---------- Screens ----------

function screenToday() {
  const t = today();
  const current = planFor(t.week);
  const parts = [];

  if (t.index === 6) {
    const next = planFor(t.planWeek);
    if (next && next.week !== t.week) {
      parts.push(`<section class="card pink stack">
        <div class="hero" style="height:120px">${icon("basket", "bob")}</div>
        <h1>Ny plan for uge ${weekNumber(next.week)} er klar</h1>
        <p><span class="big">${krWhole(next.totalPurchaseCost)}</span> <span class="muted">af ${krWhole(next.weeklyBudgetDkk)}</span></p>
        ${next.options ? `<a class="button" href="#/vaelg">Vælg retter</a>` : ""}
        <a class="button${next.options ? " secondary" : ""}" href="#/indkob">Se indkøbsliste</a>
      </section>`);
    } else {
      parts.push(`<section class="card butter stack">
        ${state.job?.state === "running" ? "" : steamingPot()}
        <h1>${t.hour < PLAN_HOUR ? `Planen for uge ${weekNumber(t.planWeek)} laves kl. ${PLAN_HOUR}` : `Planen for uge ${weekNumber(t.planWeek)} er ikke lavet endnu`}</h1>
        ${wishesField()}
        ${planButton("Lav planen nu", true)}
      </section>`);
    }
  }

  // One forgotten day at a time, oldest first. The system never guesses.
  const forgotten = current?.days?.find((slot, i) => i < t.index && slot.status === "planned" && slot.mealId !== null);
  if (forgotten) {
    const meal = mealOn(current, forgotten.day);
    const when = DAYS.indexOf(forgotten.day) === t.index - 1 ? "i går" : `i ${forgotten.day}s`;
    parts.push(`<section class="card lilac stack">
      <div class="hero" style="height:110px">${icon(dishIcon(meal))}</div>
      <h1>Lavede I ${esc(meal.title.toLowerCase())} ${when}?</h1>
      <button class="button" data-action="day" data-day="${forgotten.day}" data-status="done">Færdig</button>
      <button class="button secondary" data-action="day" data-day="${forgotten.day}" data-status="skipped">Sprunget over</button>
    </section>`);
  }

  const freezeAlerts = state.freezeAlerts ?? [];
  if (freezeAlerts.length && !forgotten) parts.push(freezeCard(freezeAlerts[0], true));

  const slot = current?.days?.[t.index];
  const meal = mealOn(current, t.day);
  if (slot?.status === "skipped") {
    parts.push(`<section class="card stack">
      <div class="empty-art">${icon("pot")}</div>
      <p class="muted small">I dag, ${t.day}</p>
      <h1>I dag er sprunget over</h1>
      <p class="muted">Resten af ugens retter er rykket én dag.</p>
    </section>`);
  } else if (meal) {
    const done = meal.status === "done";
    const party = done && celebrating("done", meal.day);
    parts.push(`<section class="card ${done ? "mint" : "peach"} stack" style="position:relative">
      <div class="hero">${icon(dishIcon(meal), party ? "hop" : done ? "" : "bob")}${party ? sparkles() : ""}</div>
      ${done ? `<span class="stamp${party ? " landing" : ""}">Lavet!</span>` : ""}
      <p class="muted small">I dag, ${t.day} · ${meal.servings} portioner</p>
      <h1>${esc(meal.title)}</h1>
      <p class="muted">${meal.timeMinutes} min · ${kr(meal.pricePerPortion)} pr. portion</p>
      <a class="button secondary" href="#/opskrift/${current.week}/${meal.day}">Se opskrift</a>
    </section>`);
    if (!done && current.days && !forgotten && !freezeAlerts.length) {
      parts.push(`<div class="actions">
        <button class="button secondary" data-action="day" data-day="${t.day}" data-status="skipped">Spring i dag over</button>
        <button class="button" data-action="day" data-day="${t.day}" data-status="done">Lavet</button>
      </div>`);
    }
  } else if (current) {
    parts.push(`<section class="card stack">
      <div class="empty-art">${icon("pan")}</div>
      <p class="muted small">I dag, ${t.day}</p>
      <h1>Ingen ret i dag</h1>
      ${current.dropped?.length ? `<p class="muted">Ugens retter er brugt eller rykket ud.</p>` : ""}
    </section>`);
  } else if (t.index !== 6) {
    parts.push(`<section class="card stack">
      <div class="empty-art">${icon("pot")}</div>
      <h1>Ingen plan for denne uge</h1>
      <p class="muted">Planen laves søndag kl. ${PLAN_HOUR}, når tilbuddene er hentet.</p>
      ${planButton("Lav planen nu", true)}
    </section>`);
  }

  parts.push(tomorrowLine(t, current));
  return parts.join("");
}

/** One line about tomorrow's dish, so something can come out of the freezer. On Sunday it is next week's Monday. */
function tomorrowLine(t, current) {
  const tomorrowPlan = t.index === 6 ? planFor(t.planWeek) : current;
  const tomorrow = mealOn(tomorrowPlan, DAYS[(t.index + 1) % 7]);
  if (!tomorrow) return "";
  return `<div class="card" style="display:flex;align-items:center;gap:14px;padding:12px 14px;margin-top:18px">
      <span class="badge" style="background:var(--lilac)">${icon(dishIcon(tomorrow))}</span>
      <span class="main" style="min-width:0"><span class="small muted" style="display:block">I morgen</span><strong>${esc(tomorrow.title)}</strong></span>
    </div>`;
}

// ---------- Køleskabsskærm ----------

/** For a tablet on the wall: today's dish and the kitchen, readable across the room. No tabs. */
function screenFridge() {
  const t = today();
  const current = planFor(t.week);
  const slot = current?.days?.[t.index];
  const meal = mealOn(current, t.day);
  const date = new Intl.DateTimeFormat("da-DK", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date());

  let dish;
  if (slot?.status === "skipped") {
    dish = `<section class="card stack"><div class="empty-art">${icon("pot")}</div><h1>I dag er sprunget over</h1></section>`;
  } else if (meal) {
    const done = meal.status === "done";
    dish = `<section class="card ${done ? "mint" : "peach"} stack" style="position:relative">
      <div class="hero">${icon(dishIcon(meal), done ? "" : "bob")}</div>
      ${done ? `<span class="stamp">Lavet!</span>` : ""}
      <h1>${esc(meal.title)}</h1>
      <p class="muted">${meal.timeMinutes} min · ${meal.servings} portioner</p>
      <a class="button secondary" href="#/opskrift/${current.week}/${meal.day}">Se opskrift</a>
    </section>`;
  } else {
    dish = `<section class="card stack">
      <div class="empty-art">${icon("pan")}</div>
      <h1>${current ? "Ingen ret i dag" : "Ingen plan for denne uge"}</h1>
      ${current ? "" : `<p class="muted">Planen laves søndag kl. ${PLAN_HOUR}.</p>`}
    </section>`;
  }

  const items = state.kitchen ?? [];
  return `<header class="fridge-top">
      <h1>${date[0].toUpperCase() + date.slice(1)}</h1>
      <a class="back" href="#/i-dag">Til appen ›</a>
    </header>
    <div class="fridge">
      <div>
        ${(state.freezeAlerts ?? []).map((a) => freezeCard(a, true)).join("")}
        ${dish}
        ${tomorrowLine(t, current)}
      </div>
      <div class="fridge-kitchen">
        ${items.length ? kitchenGroups(items) : `<div class="section card stack"><div class="empty-art">${icon("fridge")}</div><p class="muted">Køkkenet er tomt.</p></div>`}
      </div>
    </div>`;
}

function screenWeek() {
  const plan = newestPlan();
  const t = today();
  if (!plan) {
    return `${gear}<section class="card stack">
      <div class="empty-art">${icon("pot")}</div>
      <h1>Ingen plan endnu</h1>
      <p class="muted">Planen laves søndag kl. ${PLAN_HOUR}, når tilbuddene er hentet kl. 14.</p>
      ${planButton("Lav planen nu", true)}
    </section>`;
  }
  const fetched = state.fetches?.[plan.week];
  // Plans from before P2 have meals but no days.
  const slots = plan.days ?? plan.meals.map((m) => ({ day: m.day, mealId: m.id, status: "planned" }));
  const rows = slots.map((slot, i) => {
    const isToday = plan.week === t.week && slot.day === t.day;
    const dayLabel = `<span class="day">${isToday ? "I dag" : slot.day.slice(0, 3)}</span>`;
    if (slot.status === "skipped") {
      return `<div class="row skipped${isToday ? " today" : ""}">${dayLabel}<span class="main">Sprunget over</span></div>`;
    }
    const meal = mealOn(plan, slot.day);
    if (!meal) return "";
    const done = meal.status === "done";
    return `<a class="row${isToday ? " today" : ""}${done ? " done" : ""}" href="#/opskrift/${plan.week}/${meal.day}">
      ${dayLabel}
      <span class="badge" style="background:var(--${tintFor(i)})">${icon(dishIcon(meal))}</span>
      <span class="main"><span class="item">${esc(meal.title)}</span>
        <span class="meta"><span>${kr(meal.pricePerPortion)} pr. portion</span></span></span>
      ${done ? `<span class="box" style="background:var(--mint);color:var(--ink)" aria-label="Lavet">✓</span>` : ""}
    </a>`;
  });
  const spent = Math.min(100, Math.round((plan.totalPurchaseCost / plan.weeklyBudgetDkk) * 100));
  const dropped = (plan.dropped ?? []).map((id) => plan.options[id].title);
  return `${gear}<header class="stack">
      <p class="muted small">Uge ${weekNumber(plan.week)} · ${esc(plan.store)}${fetched ? ` · tilbud hentet ${fetchedText(fetched.fetchedAt)}` : ""}</p>
      <p><span class="big">${krWhole(plan.totalPurchaseCost)}</span> <span class="muted">af ${krWhole(plan.weeklyBudgetDkk)}</span></p>
      <div class="budget" role="img" aria-label="${krWhole(plan.totalPurchaseCost)} af ${krWhole(plan.weeklyBudgetDkk)}"><span style="width:${spent}%"></span></div>
      ${leftoverLine(plan)}
    </header>
    <div class="section">
      <h2 class="section-title">Ugens retter</h2>
      <div class="list">${rows.join("")}</div>
    </div>
    ${dropped.length ? `<p class="small muted" style="margin-top:8px">Rykket ud af ugen: ${dropped.map(esc).join(", ")}.</p>` : ""}
    ${plan.options && !started(plan) ? `<div class="section"><a class="button" href="#/vaelg">Vælg retter (${plan.selected.length} af ${plan.options.length})</a></div>` : ""}
    ${plan.notes?.length ? `<div class="section stack">${plan.notes.map((n) => `<p class="small muted">${esc(n)}</p>`).join("")}</div>` : ""}
    <p class="section small muted">Planen er lavet af AI. Den erstatter ikke at læse varedeklarationen.</p>
    <div class="section card stack">${wishesField()}</div>
    <div class="section">${planButton("Lav en ny plan", false)}</div>`;
}

/** "Rester for 52 kr." with what makes up most of it. Plans from before P2 have no leftovers. */
function leftoverLine(plan) {
  if (plan.leftoverValue == null) return "";
  if (plan.leftovers.length === 0) return `<p class="small muted">Ingen rester. Alle pakninger bliver brugt.</p>`;
  const top = plan.leftovers.slice(0, 3).map((l) => `${amount(l.amount, l.unit)} ${esc(l.item.toLowerCase())}`).join(", ");
  return `<p class="muted">Rester for ${krWhole(plan.leftoverValue)} <span class="small">· mest ${top}</span></p>`;
}

const gear = `<div class="topbar"><a class="gear" href="#/indstillinger" aria-label="Indstillinger">⚙</a></div>`;

function screenSettings() {
  const s = state.settings;
  const back = `<a class="back" href="#/uge">‹ Uge</a>`;
  if (!s) return `${back}<p class="card">Indstillingerne kunne ikke hentes.</p>`;
  const toggle = (key, label) => `<button class="row${s.diet[key] ? " chosen" : ""}" data-action="diet" data-key="${key}" aria-pressed="${s.diet[key]}">
      <span class="box" aria-hidden="true">${s.diet[key] ? "✓" : ""}</span><span class="main">${label}</span></button>`;
  const stepper = (key, label, value, step, unit = "") => `<div class="row stepper">
      <span class="main">${label}</span>
      <button class="step" data-action="step" data-key="${key}" data-delta="${-step}" aria-label="${label} færre">−</button>
      <span class="value">${value}${unit}</span>
      <button class="step" data-action="step" data-key="${key}" data-delta="${step}" aria-label="${label} flere">+</button>
    </div>`;
  const storeRow = (label, mode, store) => {
    const on = mode === "cheapest" ? s.storeMode === "cheapest" : s.storeMode === "fixed" && s.fixedStore === store;
    return `<button class="row${on ? " chosen" : ""}" data-action="store" data-mode="${mode}" data-store="${esc(store ?? "")}" aria-pressed="${on}">
      <span class="box round" aria-hidden="true">${on ? "●" : ""}</span><span class="main">${label}</span></button>`;
  };
  return `${back}
    <header class="stack">
      <h1>Indstillinger</h1>
      <p class="muted">Ændringer gælder fra næste plan.</p>
    </header>
    <div class="section">
      <h2 class="section-title">Kosthensyn</h2>
      <div class="list">${toggle("glutenFree", "Glutenfri")}${toggle("lactoseFree", "Laktosefri")}</div>
      <div class="stack" style="margin-top:12px">
        <label for="diet-other">Andre hensyn</label>
        <input id="diet-other" type="text" maxlength="300" value="${esc(s.diet.other)}" placeholder="Fx ingen nødder">
      </div>
    </div>
    <div class="section">
      <h2 class="section-title">Husstand</h2>
      <div class="list">
        ${stepper("persons", "Personer", s.persons, 1)}
        ${stepper("dinnersPerWeek", "Retter pr. uge", s.dinnersPerWeek, 1)}
        ${stepper("weeklyBudgetDkk", "Budget", s.weeklyBudgetDkk, 20, " kr.")}
      </div>
    </div>
    <div class="section">
      <h2 class="section-title">Butik</h2>
      <div class="list">
        ${storeRow("Billigste: størst besparelse på tilbud", "cheapest")}
        ${(state.stores ?? []).map((store) => storeRow(`Altid ${esc(store)}`, "fixed", store)).join("")}
      </div>
    </div>`;
}

async function saveSetting(change, undoChange, text) {
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    state.settings = body.settings;
    store.set("state", state);
    render();
    if (undoChange) showUndo(text, () => saveSetting(undoChange, null, ""));
  } catch (error) {
    showUndo(navigator.onLine ? error.message || "Det kunne ikke gemmes." : "Kræver forbindelse.");
  }
}

// ---------- Køkken ----------

const PLACES = [["køl", "Køleskab"], ["frost", "Fryser"], ["skab", "Skab"]];

/** "udløbet", "sidste dag i dag", "til i morgen", "til fredag", "til 12. nov." */
function expiryText(expires) {
  if (!expires) return "";
  const days = Math.round((new Date(`${expires}T12:00:00Z`) - new Date(`${state.today}T12:00:00Z`)) / 86400000);
  if (days < 0) return "udløbet";
  if (days === 0) return "sidste dag i dag";
  if (days === 1) return "til i morgen";
  if (days < 7) return `til ${weekdayOf(expires)}`;
  return `til ${new Date(`${expires}T12:00:00Z`).toLocaleDateString("da-DK", { day: "numeric", month: "short", timeZone: "UTC" })}`;
}

function freezeCard(alert, primary) {
  return `<section class="card ice stack">
    <div class="hero" style="height:100px">${icon("snowflake", "spin")}</div>
    <h1>Frys ${esc(alert.name.toLowerCase())} i dag</h1>
    <p class="muted">Den skal bruges til ${esc(alert.mealTitle.toLowerCase())} ${alert.day}, men holder kun ${alert.expires === state.today ? "i dag" : expiryText(alert.expires)}.</p>
    <button class="button${primary ? "" : " secondary"}" data-action="freeze" data-id="${alert.kitchenId}">Læg i fryseren</button>
  </section>`;
}

/** The kitchen grouped by fridge, freezer and cupboard, with what runs out soon marked. */
function kitchenGroups(items) {
  return PLACES.map(([place, label]) => {
    const here = items.filter((i) => i.location === place);
    if (!here.length) return "";
    const rows = here.map((i) => {
      const when = expiryText(i.expires);
      const soon = i.location === "køl" && /udløbet|i dag|i morgen/.test(when);
      return `<div class="row static${soon ? " soon" : ""}">
        ${icon(iconName(i.name) ?? PLACE_ICON[i.location])}
        <span class="main"><span class="item">${esc(i.name)}</span><span class="meta"><span>${amount(i.qty, i.unit)}</span>${when ? `<span class="exp">${when}</span>` : ""}</span></span>
      </div>`;
    });
    return `<div class="section"><h2 class="section-title" style="display:flex;align-items:center;gap:8px">${icon(PLACE_ICON[place]).replace('class="icon"', 'class="icon" style="width:30px;height:30px"')}${label}</h2><div class="list">${rows.join("")}</div></div>`;
  }).join("");
}

function screenKitchen() {
  const t = today();
  const items = state.kitchen ?? [];
  const canPlan = t.index === 6 && !planFor(t.planWeek);
  return `${(state.freezeAlerts ?? []).map((a) => freezeCard(a, false)).join("")}
    <section class="card stack">
      <label for="kitchen-text"><h1>Hvad har I i køkkenet?</h1></label>
      <p class="muted small">Ret teksten, så den passer. Den bruges, næste gang planen laves, og erstatter så listen nedenfor.</p>
      <textarea id="kitchen-text" rows="7" placeholder="Fx 2 løg, en halv pose ris, 300 g hakket kød i fryseren">${esc(state.kitchenText ?? "")}</textarea>
      ${canPlan
        ? `<button class="button" data-action="kitchen-plan">Lav planen</button>`
        : `<button class="button secondary" data-action="kitchen-save">Gem teksten</button>`}
      ${state.kitchenEdited ? `<button class="button secondary" data-action="kitchen-reset">Brug listen, som den står</button>` : ""}
    </section>
    ${items.length ? kitchenGroups(items) : `<div class="section card stack"><div class="empty-art">${icon("fridge")}</div><p class="muted">Køkkenet er tomt. Varer kommer hertil, når I krydser af på indkøbslisten, eller når teksten ovenfor bruges.</p></div>`}
    <p class="section small muted">Køkkenet er et skøn. Frokoster og snacks bliver ikke talt med.</p>
    <a class="back" href="#/skaerm">Vis som køleskabsskærm ›</a>`;
}

async function saveKitchenText(text) {
  const response = await fetch("/api/kitchen/text", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  await loadState();
}

async function freezeItem(id) {
  const name = state.kitchen.find((i) => i.id === id)?.name ?? "Varen";
  try {
    const response = await fetch(`/api/kitchen/${id}/freeze`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    await loadState();
    showUndo(`${name} er lagt i fryseren`, async () => {
      await fetch(`/api/kitchen/${id}/unfreeze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body.before) });
      await loadState();
    });
  } catch (error) {
    showUndo(navigator.onLine ? error.message || "Det kunne ikke gemmes." : "Kræver forbindelse.");
  }
}

/** Ticks everything still open, for when nobody ticked in the shop. One undo unticks them again. */
function markAllBought() {
  const plan = newestPlan();
  const open = plan.shoppingList.filter((l) => !isChecked(plan.id, l.productId));
  celebrate("tick", "all");
  for (const line of open) pending.push({ planId: plan.id, itemKey: line.productId, checked: true, at: new Date().toISOString() });
  store.set("pending", pending);
  render();
  sendPending();
  showUndo(`${open.length} varer er markeret som købt`, () => {
    for (const line of open) pending.push({ planId: plan.id, itemKey: line.productId, checked: false, at: new Date().toISOString() });
    store.set("pending", pending);
    render();
    sendPending();
  });
}

function screenChoose() {
  const plan = newestPlan();
  const back = `<a class="back" href="#/uge">‹ Uge</a>`;
  if (!plan?.options) return `${back}<p class="card">Der er ingen retter at vælge imellem i denne plan.</p>`;
  if (started(plan)) return `${back}<p class="card">Retterne kan ikke skiftes, når ugen er gået i gang.</p>`;
  const over = plan.totalPurchaseCost > plan.weeklyBudgetDkk;
  const rows = plan.options.map((dish, i) => {
    const on = plan.selected.includes(dish.id);
    return `<button class="row${on ? " chosen" : ""}" data-action="choose" data-id="${dish.id}" aria-pressed="${on}" ${choosing ? "disabled" : ""}>
      <span class="box" aria-hidden="true">${on ? "✓" : ""}</span>
      <span class="badge" style="background:var(--${tintFor(i)})">${icon(dishIcon(dish))}</span>
      <span class="main"><span class="item">${esc(dish.title)}</span>
        <span class="meta"><span>${esc(dish.description)}</span></span>
        <span class="meta"><span>${dish.timeMinutes} min · ${kr(dish.pricePerPortion)} pr. portion</span>${dish.suggested ? `<span class="tag suggested">Forslag</span>` : ""}</span></span>
    </button>`;
  });
  return `${back}
    <header class="stack">
      <h1>Vælg ugens retter</h1>
      <p><span class="big">${plan.selected.length} af ${plan.dinnersPerWeek}</span>
        <span class="muted">· ${krWhole(plan.totalPurchaseCost)} af ${krWhole(plan.weeklyBudgetDkk)}</span></p>
      ${leftoverLine(plan)}
      ${over ? `<p class="small muted">Over budget. Det er et mål, ikke en grænse.</p>` : ""}
    </header>
    <p class="section small muted">Indkøbslisten og prisen følger med, når du vælger. Retterne får dagene i den viste rækkefølge.</p>
    <div class="list section">${rows.join("")}</div>
    ${plan.wishes ? `<p class="section small muted">Ønsker til denne plan: ${esc(plan.wishes)}</p>` : ""}
    <div class="section"><a class="button" href="#/uge">Færdig</a></div>`;
}

function screenRecipe(week, day) {
  const plan = planFor(week);
  const meal = mealOn(plan, day);
  const back = `<a class="back" href="#/uge" data-action="back">‹ Tilbage</a>`;
  if (!meal) return `${back}<p class="card">Opskriften findes ikke længere. Der er måske lavet en ny plan.</p>`;
  // A gram of salt reads as noise; small basis amounts are just "lidt".
  const qty = (ing) => (ing.basis && ing.unit !== "stk" && ing.qty < 5 ? "lidt" : amount(ing.qty, ing.unit));
  const ingredients = meal.ingredients.map((ing) => `<li>
      ${icon(iconName(ing.name)) || `<span class="icon" aria-hidden="true" style="width:32px;height:32px"></span>`}
      <span class="qty">${qty(ing)}</span>
      <span class="what">${esc(ing.name)}${ing.kitchenItem ? ` <span class="tag suggested">Fra køkkenet</span>` : ""}${ing.checkLabel ? ` <span class="tag label">Tjek varedeklarationen</span>` : ""}</span>
    </li>`);
  return `${back}
    <header class="stack">
      <div class="hero" style="height:130px">${icon(dishIcon(meal))}</div>
      <p class="muted small">${meal.day[0].toUpperCase() + meal.day.slice(1)}</p>
      <h1>${esc(meal.title)}</h1>
      <p class="muted">${meal.timeMinutes} min · ${meal.servings} portioner · ${kr(meal.pricePerPortion)} pr. portion</p>
    </header>
    <div class="section">
      <h2 class="section-title">Ingredienser</h2>
      <ul class="ingredients card">${ingredients.join("")}</ul>
    </div>
    <div class="section">
      <h2 class="section-title">Sådan gør du</h2>
      <ol class="steps">${meal.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </div>
    <p class="section small muted">Planen er lavet af AI. Den erstatter ikke at læse varedeklarationen.</p>
    ${canMarkDone(plan, meal) ? `<div class="actions"><button class="button" data-action="day" data-day="${meal.day}" data-status="done">Lavet</button></div>` : ""}`;
}

/** "Lavet" belongs to this week's dishes up to today, not to days still ahead. */
function canMarkDone(plan, meal) {
  const t = today();
  return plan.days && plan.week === t.week && meal.status === "planned" && DAYS.indexOf(meal.day) <= t.index;
}

function shoppingRow(plan, line, checked) {
  const tags = [
    line.priceSource === "offer" ? `<span class="tag offer">Tilbud</span>` : "",
    line.priceSource === "estimate" ? `<span class="tag estimate">Skøn</span>` : "",
    line.checkLabel ? `<span class="tag label">Tjek varedeklarationen</span>` : "",
    line.buyEarly ? `<span class="tag early">Senest ${weekdayOf(line.buyBefore)}</span>` : "",
  ].join("");
  const price = `${line.priceSource === "estimate" ? "ca. " : ""}${kr(line.price)}`;
  const pop = checked && (celebrating("tick", line.productId) || celebrating("tick", "all"));
  return `<button class="row${checked ? " checked" : ""}${pop ? " pop" : ""}" data-action="tick" data-plan="${plan.id}" data-key="${esc(line.productId)}" aria-pressed="${checked}">
    <span class="box" aria-hidden="true">${checked ? "✓" : ""}</span>
    ${icon(iconName(line.item) ?? SECTION_ICON[line.section])}
    <span class="main"><span class="item">${line.packages} × ${esc(line.item)}</span>
      <span class="meta"><span>${esc(line.packageSize)}</span>${tags}</span></span>
    <span class="side">${price}</span>
  </button>`;
}

/** Everything ticked. Cheers right after the last tick, then just sits there happily. */
function basketParty(cheer) {
  return `<div class="section card pink party${cheer ? " cheer" : ""}">
    ${cheer ? confetti() : ""}
    ${icon("basket")}
    <div style="position:relative;min-width:0"><h1>Alt er i kurven!</h1><p>Varerne er lagt i køkkenet.</p></div>
  </div>`;
}

function screenShopping() {
  const plan = newestPlan();
  if (!plan) {
    return `<section class="card stack">
      <div class="empty-art">${icon("basket")}</div>
      <h1>Ingen indkøbsliste endnu</h1>
      <p class="muted">Den kommer med planen søndag kl. ${PLAN_HOUR}.</p>
    </section>`;
  }
  const lines = plan.shoppingList;
  const done = lines.filter((l) => isChecked(plan.id, l.productId));
  const open = lines.filter((l) => !isChecked(plan.id, l.productId));
  const waiting = pending.some((p) => p.planId === plan.id);

  const groups = SECTIONS.map((section) => {
    const items = open.filter((l) => l.section === section);
    if (!items.length) return "";
    return `<div class="section"><h2 class="section-title">${section}</h2>
      <div class="list">${items.map((l) => shoppingRow(plan, l, false)).join("")}</div></div>`;
  });

  return `<header class="stack">
      <p class="muted small">Uge ${weekNumber(plan.week)} · ${esc(plan.store)} · ${waiting ? "gemmes, når der er forbindelse" : "alt er gemt"}</p>
      <p><span class="big">${done.length} af ${lines.length}</span> <span class="muted">· ${krWhole(plan.totalPurchaseCost)} i alt</span></p>
      ${plan.buyNote ? `<p class="notice">${esc(plan.buyNote)}</p>` : ""}
    </header>
    ${open.length ? groups.join("") : basketParty(celebration?.kind === "tick" && Date.now() < celebration.until)}
    ${done.length ? `<details class="basket"${basketOpen ? " open" : ""}>
      <summary>I kurven (${done.length})</summary>
      <div class="list">${done.map((l) => shoppingRow(plan, l, true)).join("")}</div>
    </details>` : ""}
    ${open.length ? `<div class="section"><button class="button secondary" data-action="mark-all">Marker alt som købt</button></div>` : ""}`;
}

// ---------- Routing and rendering ----------

function route() {
  const [, name = "i-dag", ...rest] = location.hash.replace(/^#/, "").split("/");
  return { name, rest };
}

function render() {
  const { name, rest } = route();
  const app = document.getElementById("app");
  let html;
  if (!state) {
    html = loadError
      ? `<section class="card stack"><h1>Siden kunne ikke hentes</h1><p class="muted">Tjek forbindelsen. Den prøver igen af sig selv.</p></section>`
      : `<p class="muted">Henter …</p>`;
  } else if (name === "uge") html = screenWeek();
  else if (name === "indkob") html = screenShopping();
  else if (name === "opskrift") html = screenRecipe(rest[0], decodeURIComponent(rest[1] ?? ""));
  else if (name === "vaelg") html = screenChoose();
  else if (name === "indstillinger") html = screenSettings();
  else if (name === "koekken") html = screenKitchen();
  else if (name === "skaerm") html = screenFridge();
  else html = screenToday();

  if (state && loadError) {
    html = `<p class="notice small" style="margin-bottom:16px">Ingen forbindelse. Du ser det, der sidst blev hentet.</p>${html}`;
  }
  // Redrawing must not lose what is being typed in a text field.
  // Only text the user changed or is typing in; otherwise fresh data from the server wins.
  const drafts = ["wishes", "diet-other", "kitchen-text"].flatMap((id) => {
    const el = document.getElementById(id);
    if (!el) return [];
    const focused = document.activeElement === el;
    return focused || el.value !== el.defaultValue ? [{ id, value: el.value, focused, at: el.selectionStart }] : [];
  });
  app.innerHTML = html;
  document.body.classList.toggle("has-actions", !!app.querySelector(".actions"));
  document.body.classList.toggle("kiosk", name === "skaerm");
  for (const draft of drafts) {
    const field = document.getElementById(draft.id);
    if (!field) continue;
    field.value = draft.value;
    if (draft.focused) {
      field.focus();
      field.setSelectionRange(draft.at, draft.at);
    }
  }

  const tab = ["opskrift", "vaelg", "indstillinger"].includes(name) ? "uge" : name;
  for (const link of document.querySelectorAll(".tabs a")) {
    if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  // The fridge screen stays on in the daytime only, so the tablet can sleep at night.
  const hour = today().hour;
  keepScreenOn(name === "opskrift" || name === "indkob" || (name === "skaerm" && hour >= 6 && hour < 22));
}

// ---------- Screen stays on while cooking and shopping ----------

let wakeLock = null;
async function keepScreenOn(on) {
  if (!("wakeLock" in navigator)) return;
  if (on && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } catch { /* not allowed right now, e.g. tab hidden */ }
  } else if (!on && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// ---------- Events ----------

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "tick") {
    const planId = Number(target.dataset.plan);
    const key = target.dataset.key;
    const checked = !isChecked(planId, key);
    const name = newestPlan()?.shoppingList.find((l) => l.productId === key)?.item ?? "Varen";
    tick(planId, key, checked);
    showUndo(checked ? `${name} er i kurven` : `${name} er tilbage på listen`, () => tick(planId, key, !checked));
  } else if (action === "freeze") {
    freezeItem(Number(target.dataset.id));
  } else if (action === "mark-all") {
    markAllBought();
  } else if (action === "kitchen-save" || action === "kitchen-plan") {
    const text = document.getElementById("kitchen-text").value;
    saveKitchenText(text)
      .then(() => (action === "kitchen-plan" ? askForPlan() : showUndo("Teksten er gemt. Den bruges, når planen laves.")))
      .catch((error) => showUndo(navigator.onLine ? error.message : "Kræver forbindelse."));
  } else if (action === "kitchen-reset") {
    saveKitchenText("").then(() => showUndo("Listen bruges, som den står")).catch(() => showUndo("Kræver forbindelse."));
  } else if (action === "diet") {
    const key = target.dataset.key;
    const was = state.settings.diet[key];
    const label = key === "glutenFree" ? "Glutenfri" : "Laktosefri";
    saveSetting({ diet: { [key]: !was } }, { diet: { [key]: was } }, `${label} er ${was ? "slået fra" : "slået til"}`);
  } else if (action === "step") {
    const key = target.dataset.key;
    const was = state.settings[key];
    const next = was + Number(target.dataset.delta);
    saveSetting({ [key]: next }, { [key]: was }, "Gemt");
  } else if (action === "store") {
    const s = state.settings;
    const undo = s.storeMode === "cheapest" ? { storeMode: "cheapest" } : { storeMode: "fixed", fixedStore: s.fixedStore };
    const change = target.dataset.mode === "cheapest" ? { storeMode: "cheapest" } : { storeMode: "fixed", fixedStore: target.dataset.store };
    saveSetting(change, undo, change.storeMode === "cheapest" ? "Butikken vælges ud fra tilbud" : `Altid ${change.fixedStore}`);
  } else if (action === "day") {
    markDay(target.dataset.day, target.dataset.status);
  } else if (action === "choose") {
    toggleDish(Number(target.dataset.id));
  } else if (action === "save-wishes") {
    saveWishes(document.getElementById("wishes")?.value ?? "");
  } else if (action === "plan") {
    askForPlan();
  } else if (action === "back" && history.length > 1) {
    event.preventDefault();
    history.back();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "diet-other" || !state?.settings) return;
  const was = state.settings.diet.other;
  saveSetting({ diet: { other: event.target.value } }, { diet: { other: was } }, "Andre hensyn er gemt");
});

document.addEventListener("toggle", (event) => {
  if (event.target.matches?.("details.basket")) basketOpen = event.target.open;
}, true);

window.addEventListener("hashchange", () => {
  if (["koekken", "skaerm"].includes(route().name)) loadState();
  render();
  window.scrollTo(0, 0);
});
window.addEventListener("online", () => { sendPending(); loadState(); });
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { sendPending(); loadState(); }
});

if ("serviceWorker" in navigator) {
  // The page starts from the cached copy. When a new version is deployed, its service worker
  // takes over with fresh files, and the page reloads once to use them. Not on the first visit.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  }
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

render();
sendPending();
loadState();
