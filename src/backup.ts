// Before the server starts (deploy/start.sh): a copy of the database in backups/ next to it.
// A deploy restarts the machine, so every deploy gets a backup from just before its code
// touches the data. The latest 8 are kept.
//
// The copy is one self-contained file (no -wal). To restore: stop the machine, delete
// madplan.db-wal and madplan.db-shm, copy the backup over madplan.db, and start again.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDbPath } from "./db.ts";

const KEEP = 8;
/** Room that must be left on the volume after the copy, so the live database can still grow. */
const MARGIN = 50 * 1024 * 1024;

/** Copies the database, checks that the copy opens, and keeps the latest backups. Null if there is no database yet. */
export async function backupDb(path: string, dir: string, now = new Date(), log = console.log): Promise<string | null> {
  if (!existsSync(path)) {
    log("[backup] Ingen database endnu. Intet at tage backup af.");
    return null;
  }
  mkdirSync(dir, { recursive: true });

  // A full volume would stop the live database too, so no copy is better than that.
  const size = sizeOf(path) + sizeOf(`${path}-wal`);
  const { bavail, bsize } = statfsSync(dir);
  if (bavail * bsize < size + MARGIN) {
    throw new Error(`for lidt plads på disken: ${mb(bavail * bsize)} fri, kopien fylder ca. ${mb(size)}`);
  }

  const target = join(dir, `madplan-${now.toISOString().slice(0, 19).replace(/:/g, "-")}.db`);
  const db = new Database(path, { fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  let plans: number;
  try {
    plans = check(target);
  } catch (error) {
    rmSync(target, { force: true });
    throw new Error(`kopien kunne ikke åbnes: ${(error as Error).message}`);
  }

  // Only after a good copy, so a failed one never pushes out the older backups.
  const backups = readdirSync(dir).filter((f) => /^madplan-.+\.db$/.test(f)).sort();
  for (const old of backups.slice(0, -KEEP)) rmSync(join(dir, old));

  log(`[backup] ${target} (${mb(sizeOf(target))}, ${plans} planer). ${Math.min(backups.length, KEEP)} backups i alt.`);
  return target;
}

/** Makes the copy one self-contained file and checks it. Returns how many plans it holds. */
function check(path: string): number {
  const copy = new Database(path, { fileMustExist: true });
  try {
    copy.pragma("journal_mode = DELETE");
    const result = copy.pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error(String(result));
    const hasPlans = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plans'").get();
    return hasPlans ? (copy.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n : 0;
  } finally {
    copy.close();
  }
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Run by deploy/start.sh. A failed backup is logged loudly, but the site still starts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = defaultDbPath();
  try {
    await backupDb(path, join(dirname(path), "backups"));
  } catch (error) {
    console.error(`[backup] FEJL: ${(error as Error).message}. Serveren starter alligevel, men uden ny backup.`);
    process.exitCode = 1;
  }
}
