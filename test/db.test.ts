import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initDb, closeDb, flushDb, dbExec, getDb, sentinelPathFor,
} from "../src/storage/db.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

async function makeRoot(): Promise<{ root: string; dbPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-db-"));
  return { root, dbPath: path.join(root, "storage", "history.sqlite") };
}

async function openTestDb(root: string): Promise<void> {
  await initDb({
    extensionPath: REPO_ROOT,
    globalStorageUri: { fsPath: path.join(root, "storage") },
  } as any);
}

/** Grow the DB with enough rows to span multiple sqlite pages, then flush. */
async function seedAndFlush(): Promise<void> {
  getDb().exec("CREATE TABLE IF NOT EXISTS bloat (id INTEGER PRIMARY KEY, val TEXT);");
  for (let i = 0; i < 3000; i++) {
    dbExec("INSERT INTO bloat (val) VALUES (?)", [`value-${i}-`.repeat(30)]);
  }
  await flushDb();
}

/**
 * Flip several runs of bytes well past the header/first pages so
 * `new SQL.Database` still constructs successfully but a full-scan
 * `PRAGMA quick_check` detects corruption. A single corrupted offset can
 * land on an unused/free page depending on exact table layout, so several
 * spread-out regions are corrupted to reliably hit at least one live
 * btree page. (Verified empirically against this schema.)
 */
async function corruptOnDisk(dbPath: string): Promise<void> {
  const buf = await fs.readFile(dbPath);
  for (const frac of [0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
    const offset = Math.floor(buf.length * frac);
    for (let i = 0; i < 300; i++) {
      buf[offset + i] = (buf[offset + i] + 137) % 256;
    }
  }
  await fs.writeFile(dbPath, buf);
}

async function listCorruptBackups(root: string): Promise<string[]> {
  const dir = path.join(root, "storage");
  const names = await fs.readdir(dir);
  return names.filter((n) => n.includes(".corrupt-"));
}

test("sentinel file is created during initDb, before the first persisted write", async () => {
  const { root, dbPath } = await makeRoot();
  try {
    assert.equal(existsSync(sentinelPathFor(dbPath)), false);
    await openTestDb(root);
    assert.equal(existsSync(sentinelPathFor(dbPath)), true, "sentinel must exist once initDb returns");
  } finally {
    await closeDb();
  }
});

test("sentinel file is removed after a clean closeDb", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  assert.equal(existsSync(sentinelPathFor(dbPath)), true);
  await closeDb();
  assert.equal(existsSync(sentinelPathFor(dbPath)), false, "sentinel must be gone after clean shutdown");
});

test("quick_check is skipped when the sentinel is absent (clean prior shutdown) — corruption not caught", async () => {
  const { root, dbPath } = await makeRoot();

  // First session: seed data, then shut down cleanly. Sentinel is removed.
  await openTestDb(root);
  await seedAndFlush();
  await closeDb();
  assert.equal(existsSync(sentinelPathFor(dbPath)), false);

  // Corrupt the on-disk file directly, without leaving a sentinel behind
  // (simulating disk-level bit-rot rather than a crash mid-write).
  await corruptOnDisk(dbPath);

  // Reopening must not run quick_check (no sentinel) and therefore must not
  // detect the corruption or trigger backup+recreate.
  await openTestDb(root);
  try {
    assert.deepEqual(await listCorruptBackups(root), [], "no corruption recovery should have run");
  } finally {
    // Clean up without flushing over more fixtures.
    await closeDb();
  }
});

test("quick_check runs and recovers when the sentinel is present (unclean prior shutdown)", async () => {
  const { root, dbPath } = await makeRoot();

  // First session: seed data, then shut down cleanly.
  await openTestDb(root);
  await seedAndFlush();
  await closeDb();

  // Corrupt the on-disk file, then simulate a crash by leaving the sentinel
  // behind (what a real crash mid-persist would do).
  await corruptOnDisk(dbPath);
  await fs.mkdir(path.dirname(sentinelPathFor(dbPath)), { recursive: true });
  await fs.writeFile(sentinelPathFor(dbPath), "");

  // Reopening must run quick_check, detect the corruption, back up the
  // corrupt file, and recreate a fresh empty database.
  await openTestDb(root);
  try {
    const backups = await listCorruptBackups(root);
    assert.equal(backups.length, 1, "exactly one corrupt backup should have been preserved");
    const rows = getDb().exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='bloat';");
    assert.equal(rows[0]?.values[0]?.[0], 0, "fresh database should not contain the corrupted table");
  } finally {
    await closeDb();
  }
});

test("corruption-recovery path still works when triggered (regression guard)", async () => {
  // Same as above but asserts the recovered DB is fully usable afterward.
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  await seedAndFlush();
  await closeDb();

  await corruptOnDisk(dbPath);
  await fs.writeFile(sentinelPathFor(dbPath), "");

  await openTestDb(root);
  try {
    dbExec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);", []);
    dbExec("INSERT OR REPLACE INTO meta (key, value) VALUES ('probe', 'ok')", []);
    const row = getDb().exec("SELECT value FROM meta WHERE key = 'probe';");
    assert.equal(row[0]?.values[0]?.[0], "ok");
  } finally {
    await closeDb();
  }
});
