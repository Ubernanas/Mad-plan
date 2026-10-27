import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDb } from "./backup.ts";
import { openDb } from "./db.ts";

const quiet = () => {};

function withDir(run: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "madplan-backup-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("the backup is a self-contained copy with the plans in it, also what is still in the WAL", withDir(async (dir) => {
  const path = join(dir, "madplan.db");
  const live = openDb(path);
  live.prepare("INSERT INTO plans (week, store, plan_json, created_at) VALUES ('2026-W44', 'REMA 1000', '{}', 'nu')").run();

  const target = await backupDb(path, join(dir, "backups"), new Date("2026-10-27T18:32:05Z"), quiet);
  live.close();

  assert.equal(target, join(dir, "backups", "madplan-2026-10-27T18-32-05.db"));
  assert.ok(!existsSync(`${target}-wal`));
  const copy = new Database(target!, { readonly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n, 1);
  assert.equal(copy.pragma("journal_mode", { simple: true }), "delete");
  copy.close();
}));

test("only the latest 8 backups are kept", withDir(async (dir) => {
  const path = join(dir, "madplan.db");
  openDb(path).close();
  for (let day = 1; day <= 10; day++) {
    await backupDb(path, join(dir, "backups"), new Date(`2026-11-${String(day).padStart(2, "0")}T12:00:00Z`), quiet);
  }
  const kept = readdirSync(join(dir, "backups")).sort();
  assert.equal(kept.length, 8);
  assert.equal(kept[0], "madplan-2026-11-03T12-00-00.db");
  assert.equal(kept[7], "madplan-2026-11-10T12-00-00.db");
}));

test("no database yet: nothing to back up", withDir(async (dir) => {
  assert.equal(await backupDb(join(dir, "madplan.db"), join(dir, "backups"), new Date(), quiet), null);
}));
