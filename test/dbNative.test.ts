import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initDb, closeDb, dbExec, dbExecDdl, dbAll, dbTransaction, dbDataVersion,
  NATIVE_DB_FILENAME, LEGACY_DB_FILENAME,
} from "../src/storage/db.js";
import { loadNativeSqlite } from "../src/storage/nativeSqlite.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const native = loadNativeSqlite();
// These tests need a runtime with node:sqlite (Node 22.13+, VS Code 1.101+).
const skip = native ? false : "node:sqlite is not available in this Node runtime";

async function makeStorage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-native-"));
  return path.join(root, "storage");
}

function contextFor(storage: string): any {
  return { extensionPath: REPO_ROOT, globalStorageUri: { fsPath: storage } };
}

function fileSize(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

test("the default engine is node:sqlite when the runtime has it", { skip }, async () => {
  const storage = await makeStorage();
  const engine = await initDb(contextFor(storage));
  try {
    assert.equal(engine, "native");
    assert.equal(existsSync(path.join(storage, NATIVE_DB_FILENAME)), true);
  } finally {
    await closeDb();
  }
});

test("native: a committed write is on disk at once, with no whole-file save", { skip }, async () => {
  const storage = await makeStorage();
  await initDb(contextFor(storage), { engine: "native" });
  try {
    dbExec("INSERT OR REPLACE INTO meta (key, value) VALUES ('probe', 'live')");
    const reader = new native!.DatabaseSync(path.join(storage, NATIVE_DB_FILENAME), { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT value FROM meta WHERE key = 'probe'").get()?.value, "live");
    } finally {
      reader.close();
    }
    assert.equal(existsSync(path.join(storage, LEGACY_DB_FILENAME)), false, "the sql.js file must not be written");
  } finally {
    await closeDb();
  }
});

test("native: one small write adds a few pages, not a copy of the database (#23)", { skip }, async () => {
  const storage = await makeStorage();
  await initDb(contextFor(storage), { engine: "native" });
  try {
    const file = path.join(storage, NATIVE_DB_FILENAME);
    dbExecDdl("CREATE TABLE IF NOT EXISTS bloat (id INTEGER PRIMARY KEY, val TEXT);");
    dbTransaction(() => {
      for (let i = 0; i < 2000; i++) dbExec("INSERT INTO bloat (val) VALUES (?)", ["x".repeat(4000)]);
    });
    dbAll("PRAGMA wal_checkpoint(TRUNCATE)");
    const inode = statSync(file).ino;
    assert.ok(statSync(file).size > 6 * 1024 * 1024, "the fixture should be several megabytes");

    const walBefore = fileSize(`${file}-wal`);
    dbExec("INSERT INTO bloat (val) VALUES (?)", ["one more row"]);
    const written = fileSize(`${file}-wal`) - walBefore;

    assert.ok(written > 0, "the write must reach the write-ahead log");
    assert.ok(written < 64 * 1024, `one row must not rewrite the database; ${written} bytes were written`);
    assert.equal(statSync(file).ino, inode, "the database file must be updated in place, not replaced");
  } finally {
    await closeDb();
  }
});

test("native: an existing sql.js history.sqlite is carried over, then removed", { skip }, async () => {
  const storage = await makeStorage();
  await initDb(contextFor(storage), { engine: "sqljs" });
  dbExec("INSERT INTO sessions (session_id, file_path, provider, title) VALUES ('s1', '/x/s1.jsonl', 'claude', 'kept')");
  await closeDb();
  assert.equal(existsSync(path.join(storage, LEGACY_DB_FILENAME)), true);

  await initDb(contextFor(storage), { engine: "native" });
  try {
    assert.deepEqual(dbAll("SELECT session_id, title FROM sessions"), [{ session_id: "s1", title: "kept" }]);
    assert.equal(existsSync(path.join(storage, LEGACY_DB_FILENAME)), false, "the old file must be removed after the move");
  } finally {
    await closeDb();
  }
});

test("native: dbDataVersion moves when another window writes", { skip }, async () => {
  const storage = await makeStorage();
  await initDb(contextFor(storage), { engine: "native" });
  try {
    const before = dbDataVersion();
    const other = new native!.DatabaseSync(path.join(storage, NATIVE_DB_FILENAME));
    try {
      other.exec("PRAGMA busy_timeout = 3000;");
      other.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('other', 'window')").run();
    } finally {
      other.close();
    }
    assert.notEqual(dbDataVersion(), before, "a commit from another connection must count as a change");
  } finally {
    await closeDb();
  }
});

test("native: a corrupt database file is preserved and replaced", { skip }, async () => {
  const storage = await makeStorage();
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, NATIVE_DB_FILENAME), Buffer.from("not a sqlite database"));

  await initDb(contextFor(storage), { engine: "native" });
  try {
    assert.deepEqual(dbAll("SELECT value FROM meta WHERE key = 'schema_version'"), [{ value: "5" }]);
    const backup = (await fs.readdir(storage)).find((name) => name.startsWith(`${NATIVE_DB_FILENAME}.corrupt-`));
    assert.ok(backup, "the corrupt file must be kept aside");
    assert.equal(await fs.readFile(path.join(storage, backup!), "utf8"), "not a sqlite database");
  } finally {
    await closeDb();
  }
});

test("native: values sql.js accepts bind the same way (undefined, booleans)", { skip }, async () => {
  const storage = await makeStorage();
  await initDb(contextFor(storage), { engine: "native" });
  try {
    dbExec(
      "INSERT INTO sessions (session_id, file_path, provider, title, archived) VALUES (?, ?, ?, ?, ?)",
      ["s1", "/x/s1.jsonl", "claude", undefined, true],
    );
    assert.deepEqual(dbAll("SELECT title, archived FROM sessions"), [{ title: null, archived: 1 }]);
  } finally {
    await closeDb();
  }
});

test("native: an existing history.db is never replaced by the old history.sqlite", { skip }, async () => {
  const storage = await makeStorage();
  // The old file, as another window running an older version might still write it.
  await initDb(contextFor(storage), { engine: "sqljs" });
  dbExec("INSERT INTO sessions (session_id, file_path, provider, title) VALUES ('old', '/x/old.jsonl', 'claude', 'stale')");
  await closeDb();
  // A history.db another window already opened (simulated by a direct open).
  const other = new native!.DatabaseSync(path.join(storage, NATIVE_DB_FILENAME));
  other.exec("CREATE TABLE marker (x INTEGER); INSERT INTO marker VALUES (1);");
  other.close();

  await initDb(contextFor(storage), { engine: "native" });
  try {
    assert.deepEqual(dbAll("SELECT x FROM marker"), [{ x: 1 }], "the existing history.db must be the one opened");
    assert.deepEqual(dbAll("SELECT session_id FROM sessions WHERE session_id = 'old'"), []);
    assert.equal(existsSync(path.join(storage, LEGACY_DB_FILENAME)), false);
  } finally {
    await closeDb();
  }
});
