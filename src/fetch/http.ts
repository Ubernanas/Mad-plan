// Shared HTTP client for all sources: honest User-Agent, one request at a time
// with 5-10 s pauses, a page cap per run, a weekly cache in SQLite, and robots.txt.
// It never works around a block: 403/429 stops the host for the rest of the run.

import { createHash } from "node:crypto";
import { getMeta, setMeta, type DB } from "../db.ts";
import { mondayOf, planWeek, weekKey } from "../week.ts";
import { allowAll, disallowAll, parseRobots, type Robots } from "./robots.ts";

const TOKEN = "madplan-personlig";

export type HttpOptions = {
  db: DB;
  contactEmail?: string;
  maxPages?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
};

export type HttpClient = {
  /** Page body, or null if the page was skipped (blocked, disallowed, cap reached or failed). */
  get(url: string): Promise<string | null>;
  isBlocked(url: string): boolean;
  pagesFetched(): number;
};

export function userAgent(contactEmail: string): string {
  return `${TOKEN}/1.0 (+kontakt: ${contactEmail})`;
}

/** Weeks of cached pages kept. The cache only saves requests within its own week; the rest are kept a while to look into. */
const CACHE_WEEKS = 4;

/** Deletes cached pages older than CACHE_WEEKS weeks, so the database doesn't grow by every week's pages. */
export function pruneCache(db: DB, now: Date = new Date()): number {
  const oldest = weekKey(new Date(mondayOf(planWeek(now)).getTime() - CACHE_WEEKS * 7 * 86_400_000));
  return db.prepare("DELETE FROM page_cache WHERE week < ?").run(oldest).changes;
}

export function createHttpClient(options: HttpOptions): HttpClient {
  const {
    db,
    contactEmail = process.env.CONTACT_EMAIL,
    maxPages = 25,
    minDelayMs = 5_000,
    maxDelayMs = 10_000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
    log = (message) => console.log(`[http] ${message}`),
  } = options;

  const pruned = pruneCache(db, now());
  if (pruned) log(`${pruned} gemte sider ældre end ${CACHE_WEEKS} uger er slettet.`);

  const blockedHosts = new Set<string>();
  const robotsByHost = new Map<string, Robots>();
  /** The page cap is per site: Goma's limit is Goma's, not eTilbudsavis'. */
  const requestsByHost = new Map<string, number>();
  let requests = 0;

  const readCache = db.prepare("SELECT body FROM page_cache WHERE url = ? AND week = ?");
  const writeCache = db.prepare(
    "INSERT OR REPLACE INTO page_cache (url, week, status, body, fetched_at) VALUES (?, ?, ?, ?, ?)",
  );

  async function request(url: string): Promise<Response | null> {
    if (!contactEmail) throw new Error("CONTACT_EMAIL mangler. Den skal stå i User-Agent.");
    const host = new URL(url).host;
    const fromHost = requestsByHost.get(host) ?? 0;
    if (fromHost >= maxPages) {
      log(`Springer over ${url}: grænsen på ${maxPages} sider pr. kørsel fra ${host} er nået.`);
      return null;
    }
    if (requests > 0) await sleep(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
    requests++;
    requestsByHost.set(host, fromHost + 1);
    try {
      return await fetchImpl(url, {
        headers: { "User-Agent": userAgent(contactEmail) },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      log(`Fejl ved hentning af ${url}: ${(error as Error).message}`);
      return null;
    }
  }

  function block(host: string, reason: string): void {
    blockedHosts.add(host);
    log(`STOP: ${host} ${reason}. Kilden bruges ikke mere i denne kørsel.`);
  }

  async function cachedText(url: string): Promise<string | null | "blocked"> {
    const week = planWeek(now());
    const cached = readCache.get(url, week) as { body: string } | undefined;
    if (cached) return cached.body;

    const response = await request(url);
    if (!response) return null;
    if (response.status === 403 || response.status === 429) return "blocked";
    if (!response.ok) {
      log(`Springer over ${url}: HTTP ${response.status}.`);
      return null;
    }
    const body = await response.text();
    writeCache.run(url, week, response.status, body, now().toISOString());
    return body;
  }

  async function robotsFor(origin: URL): Promise<Robots> {
    const known = robotsByHost.get(origin.host);
    if (known) return known;

    const robotsUrl = `${origin.protocol}//${origin.host}/robots.txt`;
    let robots: Robots;
    const week = planWeek(now());
    const cached = readCache.get(robotsUrl, week) as { body: string } | undefined;
    if (cached) {
      robots = parseRobots(cached.body, TOKEN);
    } else {
      const response = await request(robotsUrl);
      if (!response) {
        robots = disallowAll;
        log(`robots.txt for ${origin.host} kunne ikke hentes. Henter ikke fra værten.`);
      } else if (response.status === 403 || response.status === 429) {
        block(origin.host, `svarede ${response.status} på robots.txt`);
        robots = disallowAll;
      } else if (response.status >= 400 && response.status < 500) {
        robots = allowAll; // RFC 9309: an unavailable robots.txt allows everything.
      } else if (!response.ok) {
        robots = disallowAll; // RFC 9309: an unreachable robots.txt disallows everything.
        log(`robots.txt for ${origin.host} gav HTTP ${response.status}. Henter ikke fra værten.`);
      } else {
        const body = await response.text();
        writeCache.run(robotsUrl, week, response.status, body, now().toISOString());
        noteRobotsChange(origin.host, body);
        robots = parseRobots(body, TOKEN);
      }
    }
    robotsByHost.set(origin.host, robots);
    return robots;
  }

  function noteRobotsChange(host: string, body: string): void {
    const hash = createHash("sha256").update(body).digest("hex");
    const key = `robots:${host}`;
    const previous = getMeta(db, key);
    if (previous && previous !== hash) {
      log(`robots.txt for ${host} er ændret siden sidst. Tjek den. Sider, den nu forbyder, hentes ikke.`);
    }
    setMeta(db, key, hash);
  }

  return {
    async get(url) {
      const parsed = new URL(url);
      if (blockedHosts.has(parsed.host)) return null;

      const robots = await robotsFor(parsed);
      if (blockedHosts.has(parsed.host)) return null;
      if (!robots.isAllowed(parsed.pathname + parsed.search)) {
        log(`Springer over ${url}: forbudt i robots.txt.`);
        return null;
      }

      const result = await cachedText(url);
      if (result === "blocked") {
        block(parsed.host, "svarede 403 eller 429");
        return null;
      }
      return result;
    },
    isBlocked: (url) => blockedHosts.has(new URL(url).host),
    pagesFetched: () => requests,
  };
}
