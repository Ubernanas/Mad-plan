import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
-- One row per fetched page per week, so the same page is never fetched twice in a week.
CREATE TABLE IF NOT EXISTS page_cache (
  url        TEXT NOT NULL,
  week       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (url, week)
);

-- Small key/value store, e.g. the last seen robots.txt per host.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The chosen store's products for a plan week. A product found by several
-- search words is stored once, under the first word that found it.
CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY,
  week           TEXT NOT NULL,
  store          TEXT NOT NULL,
  goma_id        TEXT NOT NULL,
  query          TEXT NOT NULL,
  name           TEXT NOT NULL,
  package_amount REAL,
  unit           TEXT CHECK (unit IN ('g', 'ml', 'stk')),
  price          REAL NOT NULL,
  normal_price   REAL,
  per_kg         REAL,
  on_offer       INTEGER NOT NULL,
  fetched_at     TEXT NOT NULL,
  UNIQUE (week, store, goma_id)
);

-- One row per plan week: which store was chosen and why.
CREATE TABLE IF NOT EXISTS fetches (
  week         TEXT PRIMARY KEY,
  store        TEXT NOT NULL,
  store_mode   TEXT NOT NULL,
  savings_json TEXT NOT NULL,
  missing_json TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id         INTEGER PRIMARY KEY,
  week       TEXT NOT NULL,
  store      TEXT NOT NULL,
  plan_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Ticks on the shopping list, keyed by plan and product.
CREATE TABLE IF NOT EXISTS checks (
  plan_id    INTEGER NOT NULL REFERENCES plans (id),
  item_key   TEXT NOT NULL,
  checked    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_key)
);

-- The kitchen: an estimate of what is at home, not an exact stock.
CREATE TABLE IF NOT EXISTS kitchen (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  qty      REAL NOT NULL CHECK (qty >= 0),
  unit     TEXT NOT NULL CHECK (unit IN ('g', 'ml', 'stk')),
  location TEXT NOT NULL CHECK (location IN ('køl', 'frost', 'skab')),
  expires  TEXT
);

-- What a recipe asks for ('agurk', 'laktosefri fløde'), whatever product it is bought as.
-- Built from config/ingredients.json at startup; Claude's names for new things are added too.
CREATE TABLE IF NOT EXISTS canonical_item (
  id          INTEGER PRIMARY KEY,
  name_da     TEXT NOT NULL UNIQUE,
  section     TEXT NOT NULL,
  base_unit   TEXT NOT NULL CHECK (base_unit IN ('g', 'ml', 'stk')),
  is_staple   INTEGER NOT NULL DEFAULT 0,  -- oil, salt, spices: never bought
  goma_query  TEXT,                        -- the search word it is fetched with
  name_filter TEXT                         -- e.g. 'laktosefri', when the variant shares its page with the plain item
);

-- Other names for an item: the recipes' English words, and Claude's own names.
CREATE TABLE IF NOT EXISTS item_alias (
  alias             TEXT PRIMARY KEY,
  canonical_item_id INTEGER NOT NULL REFERENCES canonical_item (id),
  source            TEXT NOT NULL,         -- 'rule' | 'claude' | 'user'
  confirmed         INTEGER NOT NULL DEFAULT 0
);
`;

/** Columns added after a table was first created. Added if missing, so old databases catch up. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  // The Goma product a kitchen row was bought as, so "Lavet" can find it.
  ["kitchen", "product_id", "TEXT"],
  // "plan:<id>:<product>" for rows from a tick, so unticking removes exactly that row.
  ["kitchen", "source", "TEXT"],
  // The canonical item a product or kitchen row is, so the plan finds it by item, not by one product.
  ["products", "canonical_item_id", "INTEGER"],
  ["kitchen", "canonical_item_id", "INTEGER"],
];

function migrate(db: DB): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS kitchen_source ON kitchen (source)");
}

export function defaultDbPath(): string {
  return process.env.DB_PATH || (process.env.FLY_APP_NAME ? "/data/madplan.db" : "./data/madplan.db");
}

export function openDb(path: string = defaultDbPath()): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}
