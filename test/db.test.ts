import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs from "sql.js";
import {
  initDb, closeDb, flushDb, dbExec, dbExecDdl, getDb, sentinelPathFor, renameWithRetry, dbDataVersion,
  PERSIST_MIN_INTERVAL_MS,
  type DbOptions,
} from "../src/storage/db.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

async function makeRoot(): Promise<{ root: string; dbPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-db-"));
  return { root, dbPath: path.join(root, "storage", "history.sqlite") };
}

/** Every test here covers the sql.js engine, which saves by rewriting the file. */
async function openTestDb(root: string, options?: DbOptions): Promise<void> {
  await initDb({
    extensionPath: REPO_ROOT,
    globalStorageUri: { fsPath: path.join(root, "storage") },
  } as any, { engine: "sqljs", ...options });
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

/**
 * Grow the DB to roughly `targetMb` so a persist takes long enough for a
 * concurrent reader to observe a torn write. A few large blobs beat many
 * small rows here: the insert loop, not the file write, dominates runtime.
 */
async function seedLarge(targetMb: number): Promise<void> {
  getDb().exec("CREATE TABLE IF NOT EXISTS bloat (id INTEGER PRIMARY KEY, val TEXT);");
  const blob = "x".repeat(64 * 1024);
  const rows = Math.ceil((targetMb * 1024 * 1024) / blob.length);
  for (let i = 0; i < rows; i++) {
    dbExec("INSERT INTO bloat (val) VALUES (?)", [blob]);
  }
  await flushDb();
}

test("flushDb swaps the database file in rather than rewriting it in place", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  try {
    await seedAndFlush();
    const first = statSync(dbPath).ino;

    dbExec("INSERT INTO bloat (val) VALUES (?)", ["another row"]);
    await flushDb();
    const second = statSync(dbPath).ino;

    // An in-place overwrite keeps the same inode. A temp-file-plus-rename
    // publishes a new file, so the inode has to change.
    assert.notEqual(second, first, "persist must publish a new file, not overwrite the live one");
  } finally {
    await closeDb();
  }
});

test("a concurrent reader never observes a partially written database", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  try {
    await seedLarge(24);
    const sizeBefore = statSync(dbPath).size;

    // Make the next flush write a payload of a different size.
    for (let i = 0; i < 64; i++) {
      dbExec("INSERT INTO bloat (val) VALUES (?)", ["y".repeat(64 * 1024)]);
    }

    // Sample the live path as fast as the event loop allows while the flush runs.
    const seen = new Set<number>();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          seen.add(statSync(dbPath).size);
        } catch {
          // A reader hitting a missing file is its own failure mode; record it.
          seen.add(-1);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    await flushDb();
    sampling = false;
    await sampler;

    const sizeAfter = statSync(dbPath).size;
    const allowed = new Set([sizeBefore, sizeAfter]);
    const torn = [...seen].filter((s) => !allowed.has(s));
    assert.deepEqual(
      torn,
      [],
      `readers saw ${torn.length} partial state(s); file must only ever be ${sizeBefore} or ${sizeAfter} bytes`,
    );
  } finally {
    await closeDb();
  }
});

/** Build an Error carrying an errno-style `code`, as fs rejections do. */
function codedError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

test("rename retries the codes Windows raises while the target is held open", async () => {
  let calls = 0;
  await renameWithRetry("from", "to", async () => {
    calls++;
    if (calls < 3) throw codedError("EBUSY");
  });
  assert.equal(calls, 3, "must retry until the rename goes through");
});

test("rename gives up immediately on an error that retrying cannot fix", async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry("from", "to", async () => {
      calls++;
      throw codedError("ENOENT");
    }),
    /ENOENT/,
  );
  assert.equal(calls, 1, "a missing source must not be retried");
});

test("rename surfaces the error once the retries are exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry("from", "to", async () => {
      calls++;
      throw codedError("EPERM");
    }),
    /EPERM/,
  );
  assert.equal(calls, 5, "four backoffs plus the first attempt");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a single value from the database file on disk, through an independent sql.js handle. */
async function valueOnDisk(dbPath: string, sql: string): Promise<unknown> {
  const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
  const onDisk = new SQL.Database(new Uint8Array(await fs.readFile(dbPath)));
  try {
    return onDisk.exec(sql)[0]?.values[0]?.[0];
  } finally {
    onDisk.close();
  }
}

/**
 * Count the temp-file writes that publishes make. `delayMs` holds each write
 * open, so two publishes running at once show up as more than one in flight.
 */
function trackPublishes(delayMs: number): {
  started(): number;
  maxInFlight(): number;
  restore(): void;
} {
  const realFs = require("node:fs/promises");
  const original = realFs.writeFile;
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  realFs.writeFile = async (file: unknown, ...rest: unknown[]) => {
    if (!String(file).includes(".tmp-")) return original(file, ...rest);
    started++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delayMs > 0) await sleep(delayMs);
      return await original(file, ...rest);
    } finally {
      inFlight--;
    }
  };
  return {
    started: () => started,
    maxInFlight: () => maxInFlight,
    restore: () => { realFs.writeFile = original; },
  };
}

test("a flush with nothing new since the last publish leaves the file alone", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  try {
    await seedAndFlush();
    const published = statSync(dbPath).ino;

    assert.equal(await flushDb(), true);
    assert.equal(statSync(dbPath).ino, published, "an unchanged database must not be rewritten");
  } finally {
    await closeDb();
  }
});

test("a write that changes no rows does not republish the database", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  try {
    await seedAndFlush();
    const published = statSync(dbPath).ino;

    dbExec("UPDATE bloat SET val = 'unchanged' WHERE id = -1");
    await flushDb();
    assert.equal(statSync(dbPath).ino, published, "a write that matches no rows must not rewrite the file");
  } finally {
    await closeDb();
  }
});

test("a schema-only change is still published", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  try {
    await seedAndFlush();
    const published = statSync(dbPath).ino;

    dbExecDdl("CREATE TABLE IF NOT EXISTS extra (x INTEGER);");
    await flushDb();
    assert.notEqual(statSync(dbPath).ino, published, "DDL does not move total_changes(), so it must still publish");
    assert.equal(await valueOnDisk(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'extra'"), 1);
  } finally {
    await closeDb();
  }
});

test("concurrent flushes never run two publishes at once", async () => {
  const { root } = await makeRoot();
  await openTestDb(root);
  try {
    await seedAndFlush();
    dbExec("INSERT INTO bloat (val) VALUES (?)", ["pending"]);

    const tracker = trackPublishes(150);
    try {
      await Promise.all([flushDb(), flushDb()]);
      assert.equal(tracker.maxInFlight(), 1, "the second flush must wait for the first publish, not overlap it");
    } finally {
      tracker.restore();
    }
  } finally {
    await closeDb();
  }
});

test("sustained writes publish at most once per minimum interval, and every write still lands", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root, { persistMinIntervalMs: 6000 });
  const tracker = trackPublishes(0);
  try {
    getDb().exec("CREATE TABLE IF NOT EXISTS bloat (id INTEGER PRIMARY KEY, val TEXT);");
    // Writes 1.2s apart: every gap is longer than the 1s debounce, which is the
    // cadence watcher passes produce. Without a floor, each write publishes.
    for (let i = 0; i < 3; i++) {
      dbExec("INSERT INTO bloat (val) VALUES (?)", [`row ${i}`]);
      await sleep(1200);
    }
    assert.ok(tracker.started() <= 1, `published ${tracker.started()} times while writes were arriving; the 6s floor allows one`);

    await flushDb();
    assert.equal(await valueOnDisk(dbPath, "SELECT COUNT(*) FROM bloat"), 3, "every write must reach the file");
  } finally {
    tracker.restore();
    await closeDb();
  }
});

test("a failed publish is reported, and the next flush publishes the same change", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root);
  try {
    await seedAndFlush();
    dbExec("INSERT INTO bloat (val) VALUES (?)", ["after failure"]);

    const realFs = require("node:fs/promises");
    const original = realFs.writeFile;
    realFs.writeFile = async (file: unknown, ...rest: unknown[]) => {
      if (String(file).includes(".tmp-")) {
        realFs.writeFile = original;
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return original(file, ...rest);
    };
    try {
      assert.equal(await flushDb(), false, "a failed publish must be reported");
    } finally {
      realFs.writeFile = original;
    }

    assert.equal(await flushDb(), true, "the next flush must retry the change that failed");
    assert.equal(await valueOnDisk(dbPath, "SELECT COUNT(*) FROM bloat WHERE val = 'after failure'"), 1);
  } finally {
    await closeDb();
  }
});

test("dbDataVersion moves on a write, stays put across no-op writes and publishes, and resets per init", async () => {
  const { root } = await makeRoot();
  await openTestDb(root);
  try {
    getDb().exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT);");
    dbExec("INSERT INTO t (v) VALUES ('a')");
    const afterWrite = dbDataVersion();

    // Nothing written: the version must not move.
    assert.equal(dbDataVersion(), afterWrite);

    // A publish resets the connection's total_changes(); the version must still not move.
    await flushDb();
    assert.equal(dbDataVersion(), afterWrite, "publishing alone must not look like a data change");

    // An UPDATE that matches no row changes nothing.
    dbExec("UPDATE t SET v = 'zz' WHERE id = -1");
    assert.equal(dbDataVersion(), afterWrite);

    // A real write after the publish must move the version.
    dbExec("INSERT INTO t (v) VALUES ('b')");
    const afterSecond = dbDataVersion();
    assert.notEqual(afterSecond, afterWrite);

    // A later re-open of the database must never reuse an earlier version.
    await closeDb();
    await openTestDb(root);
    assert.notEqual(dbDataVersion(), afterSecond);
    assert.notEqual(dbDataVersion(), afterWrite);
  } finally {
    await closeDb();
  }
});

/** Wait until `check` passes, polling; fails after `timeoutMs`. */
async function eventually(check: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await sleep(25);
  }
}

test("the default gap between sql.js saves is 30 minutes", () => {
  assert.equal(PERSIST_MIN_INTERVAL_MS, 30 * 60_000);
});

test("a timed save compacts a database that is mostly free pages", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root, { persistDebounceMs: 20, persistMinIntervalMs: 0, vacuumMinIntervalMs: 0 });
  try {
    await seedAndFlush();
    const full = statSync(dbPath).size;

    dbExec("DELETE FROM bloat WHERE id > 100");
    await eventually(() => statSync(dbPath).size < full / 2, 5000, "the timed save did not compact the file");

    assert.equal(await valueOnDisk(dbPath, "SELECT COUNT(*) FROM bloat"), 100, "compaction must keep every live row");
    assert.equal(await valueOnDisk(dbPath, "PRAGMA freelist_count"), 0);
  } finally {
    await closeDb();
  }
});

test("a flush (as on close) saves without compacting", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root, { persistMinIntervalMs: 60_000, vacuumMinIntervalMs: 0 });
  try {
    await seedAndFlush();
    dbExec("DELETE FROM bloat WHERE id > 100");
    await flushDb();
    assert.equal(await valueOnDisk(dbPath, "SELECT COUNT(*) FROM bloat"), 100);
    assert.ok(Number(await valueOnDisk(dbPath, "PRAGMA freelist_count")) > 0, "a flush must not spend time compacting");
  } finally {
    await closeDb();
  }
});

test("a database with little free space is not compacted", async () => {
  const { root, dbPath } = await makeRoot();
  await openTestDb(root, { persistDebounceMs: 20, persistMinIntervalMs: 0, vacuumMinIntervalMs: 0 });
  try {
    await seedAndFlush();
    dbExec("DELETE FROM bloat WHERE id > 2900");
    await sleep(300); // let the timed save (the one allowed to compact) run
    await flushDb();
    assert.ok(Number(await valueOnDisk(dbPath, "PRAGMA freelist_count")) > 0, "a few free pages are not worth a rebuild");
  } finally {
    await closeDb();
  }
});

test("startup removes stale temp files and keeps only the newest corrupt backups", async () => {
  const { root } = await makeRoot();
  const storage = path.join(root, "storage");
  await fs.mkdir(storage, { recursive: true });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const put = async (name: string, when: Date) => {
    await fs.writeFile(path.join(storage, name), "x");
    await fs.utimes(path.join(storage, name), when, when);
  };
  await put("history.sqlite.tmp-111", hoursAgo(3));
  await put("history.db.tmp-222", hoursAgo(3));
  await put("history.sqlite.tmp-333", new Date());
  await put("history.sqlite.corrupt-a", hoursAgo(40));
  await put("history.sqlite.corrupt-b", hoursAgo(30));
  await put("history.sqlite.corrupt-c", hoursAgo(20));
  await put("history.db.corrupt-d", hoursAgo(10));

  await openTestDb(root);
  try {
    const names = new Set(await fs.readdir(storage));
    assert.equal(names.has("history.sqlite.tmp-111"), false, "an abandoned temp file must be removed");
    assert.equal(names.has("history.db.tmp-222"), false, "an abandoned temp file must be removed");
    assert.equal(names.has("history.sqlite.tmp-333"), true, "a temp file another window may be writing must stay");
    assert.deepEqual(
      [...names].filter((n) => n.includes(".corrupt-")).sort(),
      ["history.db.corrupt-d", "history.sqlite.corrupt-c"],
      "only the two newest corrupt backups are kept",
    );
  } finally {
    await closeDb();
  }
});
