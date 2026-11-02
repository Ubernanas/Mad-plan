import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../db.ts";
import { createHttpClient, pruneCache, userAgent } from "./http.ts";
import { parseRobots } from "./robots.ts";
import { planWeek, weekKey } from "../week.ts";

type Route = { status: number; body?: string; headers?: Record<string, string> };

function fakeServer(routes: Record<string, Route>) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("User-Agent") });
    const route = routes[url] ?? { status: 404, body: "" };
    return new Response(route.body ?? "", { status: route.status, headers: route.headers });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(routes: Record<string, Route>, extra: { maxPages?: number } = {}) {
  const server = fakeServer(routes);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const db = openDb(":memory:");
  const http = createHttpClient({
    db,
    contactEmail: "test@example.com",
    fetchImpl: server.fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
    log: (message) => void logs.push(message),
    ...extra,
  });
  return { http, db, sleeps, logs, calls: server.calls };
}

const ROBOTS = "https://goma.gg/robots.txt";

test("sends an honest User-Agent and pauses 5-10 s between requests", async () => {
  const { http, calls, sleeps } = client({
    [ROBOTS]: { status: 200, body: "User-agent: *\nDisallow: /api/internal/" },
    "https://goma.gg/tilbud/laks": { status: 200, body: "laks" },
    "https://goma.gg/tilbud/ris": { status: 200, body: "ris" },
  });

  assert.equal(await http.get("https://goma.gg/tilbud/laks"), "laks");
  assert.equal(await http.get("https://goma.gg/tilbud/ris"), "ris");

  assert.equal(calls[0]!.userAgent, userAgent("test@example.com"));
  assert.match(calls[0]!.userAgent!, /^madplan-personlig\/1\.0 \(\+kontakt: test@example\.com\)$/);
  assert.equal(sleeps.length, 2); // none before the first request
  for (const ms of sleeps) assert.ok(ms >= 5_000 && ms <= 10_000);
});

test("never fetches the same page twice in a week", async () => {
  const { http, calls } = client({
    [ROBOTS]: { status: 200, body: "" },
    "https://goma.gg/tilbud/laks": { status: 200, body: "laks" },
  });
  await http.get("https://goma.gg/tilbud/laks");
  await http.get("https://goma.gg/tilbud/laks");
  assert.equal(calls.filter((c) => c.url.endsWith("/laks")).length, 1);
});

test("the cache survives a new client in the same week", async () => {
  const routes = { [ROBOTS]: { status: 200, body: "" }, "https://goma.gg/tilbud/laks": { status: 200, body: "laks" } };
  const first = client(routes);
  await first.http.get("https://goma.gg/tilbud/laks");

  const server = fakeServer(routes);
  const second = createHttpClient({ db: first.db, contactEmail: "x@y.z", fetchImpl: server.fetchImpl, log: () => {} });
  assert.equal(await second.get("https://goma.gg/tilbud/laks"), "laks");
  assert.equal(server.calls.length, 0);
});

test("skips pages disallowed by robots.txt", async () => {
  const { http, calls } = client({
    [ROBOTS]: { status: 200, body: "User-agent: *\nDisallow: /api/internal/" },
  });
  assert.equal(await http.get("https://goma.gg/api/internal/products"), null);
  assert.equal(calls.length, 1); // only robots.txt
});

test("stops the host on 403 or 429", async () => {
  const { http, calls, logs } = client({
    [ROBOTS]: { status: 200, body: "" },
    "https://goma.gg/tilbud/laks": { status: 429 },
    "https://goma.gg/tilbud/ris": { status: 200, body: "ris" },
  });
  assert.equal(await http.get("https://goma.gg/tilbud/laks"), null);
  assert.equal(await http.get("https://goma.gg/tilbud/ris"), null);
  assert.equal(http.blockReason("https://goma.gg/tilbud/ris"), "HTTP 429");
  assert.equal(calls.length, 2);
  assert.ok(logs.some((l) => l.startsWith("STOP")));
});

test("a block logs the exact status, Retry-After and Server, and which page", async () => {
  const { http, logs } = client({
    [ROBOTS]: { status: 200, body: "" },
    "https://goma.gg/tilbud/laks": { status: 403, headers: { "Retry-After": "3600", Server: "cloudflare" } },
  });
  await http.get("https://goma.gg/tilbud/laks");
  assert.equal(http.blockReason("https://goma.gg/"), "HTTP 403 (Retry-After: 3600, Server: cloudflare)");
  assert.ok(logs.includes("STOP: goma.gg svarede HTTP 403 (Retry-After: 3600, Server: cloudflare) på https://goma.gg/tilbud/laks. Kilden bruges ikke mere i denne kørsel."));
});

test("a block on robots.txt logs its status too", async () => {
  const { http, calls, logs } = client({ [ROBOTS]: { status: 429 } });
  assert.equal(await http.get("https://goma.gg/tilbud/laks"), null);
  assert.equal(http.blockReason("https://goma.gg/"), "HTTP 429");
  assert.equal(calls.length, 1);
  assert.ok(logs.some((l) => l.includes(`HTTP 429 på ${ROBOTS}`)));
});

test("a host that hasn't refused anything has no block reason", () => {
  const { http } = client({});
  assert.equal(http.blockReason("https://goma.gg/"), null);
});

test("respects the page cap, counting robots.txt", async () => {
  const { http } = client(
    {
      [ROBOTS]: { status: 200, body: "" },
      "https://goma.gg/tilbud/a": { status: 200, body: "a" },
      "https://goma.gg/tilbud/b": { status: 200, body: "b" },
    },
    { maxPages: 2 },
  );
  assert.equal(await http.get("https://goma.gg/tilbud/a"), "a");
  assert.equal(await http.get("https://goma.gg/tilbud/b"), null);
  assert.equal(http.pagesFetched(), 2);
});

test("the page cap counts each site on its own", async () => {
  const { http } = client(
    {
      [ROBOTS]: { status: 200, body: "" },
      "https://goma.gg/tilbud/a": { status: 200, body: "a" },
      "https://etilbudsavis.dk/robots.txt": { status: 200, body: "" },
      "https://etilbudsavis.dk/Netto": { status: 200, body: "netto" },
    },
    { maxPages: 2 },
  );
  assert.equal(await http.get("https://goma.gg/tilbud/a"), "a");
  assert.equal(await http.get("https://etilbudsavis.dk/Netto"), "netto");
  assert.equal(http.pagesFetched(), 4);
});

test("a failed page is skipped, not cached", async () => {
  const { http, db } = client({
    [ROBOTS]: { status: 200, body: "" },
    "https://goma.gg/tilbud/laks": { status: 500 },
  });
  assert.equal(await http.get("https://goma.gg/tilbud/laks"), null);
  const row = db.prepare("SELECT 1 FROM page_cache WHERE url = ?").get("https://goma.gg/tilbud/laks");
  assert.equal(row, undefined);
});

test("robots.txt: own group beats *, longest rule wins, wildcards work", () => {
  const robots = parseRobots(
    [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: madplan-personlig",
      "Disallow: /tilbud/",
      "Allow: /tilbud/laks",
      "Disallow: /*.json$",
    ].join("\n"),
    "madplan-personlig",
  );
  assert.ok(robots.isAllowed("/"));
  assert.ok(!robots.isAllowed("/tilbud/ris"));
  assert.ok(robots.isAllowed("/tilbud/laks?store=netto"));
  assert.ok(!robots.isAllowed("/data/x.json"));
  assert.ok(robots.isAllowed("/data/x.json?y=1"));
});

test("weekKey uses ISO weeks in Copenhagen time", () => {
  assert.equal(weekKey(new Date("2026-10-23T12:00:00Z")), "2026-W43");
  // Summer time ends 25 Oct: 22:30 UTC is Sunday 23:30 local, 23:30 UTC is Monday 00:30 local.
  assert.equal(weekKey(new Date("2026-10-25T22:30:00Z")), "2026-W43");
  assert.equal(weekKey(new Date("2026-10-25T23:30:00Z")), "2026-W44");
  assert.equal(weekKey(new Date("2027-01-01T12:00:00Z")), "2026-W53");
});

test("planWeek: Sunday belongs to the coming week", () => {
  assert.equal(planWeek(new Date("2026-10-23T12:00:00Z")), "2026-W43"); // Friday
  assert.equal(planWeek(new Date("2026-10-24T12:00:00Z")), "2026-W43"); // Saturday
  assert.equal(planWeek(new Date("2026-10-25T13:00:00Z")), "2026-W44"); // Sunday 14:00
  assert.equal(planWeek(new Date("2026-10-26T12:00:00Z")), "2026-W44"); // Monday
});

test("pages older than 4 weeks are deleted; the last 4 weeks stay", () => {
  const db = openDb(":memory:");
  const insert = db.prepare("INSERT INTO page_cache (url, week, status, body, fetched_at) VALUES ('u', ?, 200, '', 'x')");
  for (const week of ["2026-W39", "2026-W40", "2026-W41", "2026-W44", "2026-W45"]) insert.run(week);
  // Thursday of week 45: weeks 41 to 45 are kept.
  assert.equal(pruneCache(db, new Date("2026-11-05T12:00:00Z")), 2);
  assert.deepEqual(db.prepare("SELECT week FROM page_cache ORDER BY week").all().map((r) => (r as { week: string }).week), ["2026-W41", "2026-W44", "2026-W45"]);
});
