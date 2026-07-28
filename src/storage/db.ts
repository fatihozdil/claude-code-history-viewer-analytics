import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import initSqlJs from "sql.js";
import type { Database as SqlJsDb, SqlJsStatic } from "sql.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

let db: SqlJsDb | null = null;
let dbPath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let sqliteStatic: SqlJsStatic | null = null;
const PERSIST_DEBOUNCE_MS = 1000;

/**
 * Sentinel file marking the on-disk database as possibly-in-progress-write.
 * Created before the first persisted write of a session, removed only after
 * `closeDb` completes a clean final flush. Its presence on the next
 * `initDb` means the previous session did not shut down cleanly (crash,
 * force-quit, etc.), so `PRAGMA quick_check` is worth its cost; its absence
 * means the last session closed cleanly and the full-database scan can be
 * skipped on every activation.
 */
export const SENTINEL_FILENAME = "history.sqlite.dirty";

export function sentinelPathFor(dbFilePath: string): string {
  return path.join(path.dirname(dbFilePath), SENTINEL_FILENAME);
}

/** Create the dirty sentinel; best-effort (logs but never throws). */
async function createSentinel(dbFilePath: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(dbFilePath), { recursive: true });
    await fs.writeFile(sentinelPathFor(dbFilePath), "");
  } catch (err) {
    console.error("[claude-history] failed to create dirty sentinel:", err);
  }
}

/** Remove the dirty sentinel; best-effort (logs but never throws). */
async function removeSentinel(dbFilePath: string): Promise<void> {
  try {
    await fs.unlink(sentinelPathFor(dbFilePath));
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error("[claude-history] failed to remove dirty sentinel:", err);
    }
  }
}

function isCorruptDatabaseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database disk image is malformed|file is not a database|database corruption|integrity check failed/i.test(message);
}

function prepareDatabase(SQL: SqlJsStatic, buffer?: Uint8Array, runQuickCheck: boolean = true): SqlJsDb {
  const candidate = new SQL.Database(buffer);
  db = candidate;
  try {
    candidate.run("PRAGMA journal_mode=WAL;");
    candidate.run("PRAGMA foreign_keys=ON;");

    if (buffer && runQuickCheck) {
      const check = candidate.exec("PRAGMA quick_check;");
      const result = check[0]?.values[0]?.[0];
      if (result !== "ok") {
        throw new Error(`SQLite integrity check failed: ${String(result ?? "unknown error")}`);
      }
    }

    // Create only the version table before migration. Running the full current
    // schema against an older sessions table can fail while creating indexes on
    // columns that the old table does not have yet.
    candidate.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    runMigrations();
    return candidate;
  } catch (err) {
    candidate.close();
    db = null;
    throw err;
  }
}

async function preserveCorruptDatabase(filePath: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.corrupt-${stamp}-${process.pid}`;
  try {
    await fs.rename(filePath, backupPath);
    return backupPath;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Resolve the sql-wasm.wasm file bundled alongside the extension. */
function locateWasm(context: vscode.ExtensionContext): string {
  // In the bundled output, sql-wasm.wasm is in the same `dist/` dir.
  const bundled = path.join(context.extensionPath, "dist", "sql-wasm.wasm");
  return existsSync(bundled) ? bundled : require.resolve("sql.js/dist/sql-wasm.wasm");
}

/** Serialize the in-memory DB to disk (debounced). */
function schedulePersist(): void {
  if (!db || !dbPath) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (!db || !dbPath) return;
    const data = db.export();
    try {
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.writeFile(dbPath, Buffer.from(data));
    } catch (err) {
      console.error("[claude-history] failed to persist database:", err);
    }
    persistTimer = null;
  }, PERSIST_DEBOUNCE_MS);
}

/** Flush any pending DB writes immediately. Returns whether the flush succeeded. */
export async function flushDb(): Promise<boolean> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!db || !dbPath) return true;
  const data = db.export();
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, Buffer.from(data));
    return true;
  } catch (err) {
    console.error("[claude-history] failed to flush database:", err);
    return false;
  }
}

/** Initialize or open the sql.js database. */
export async function initDb(context: vscode.ExtensionContext): Promise<SqlJsDb> {
  const wasmFile = locateWasm(context);

  // sql.js 1.x: locateFile is set during init, not on the module.
  const SQL: SqlJsStatic = await initSqlJs({ locateFile: () => wasmFile });
  sqliteStatic = SQL;

  dbPath = path.join(context.globalStorageUri.fsPath, "history.sqlite");

  let buffer: Uint8Array | undefined;
  try {
    const existing = await fs.readFile(dbPath);
    // sql.js expects byte values, not a bare ArrayBuffer. Copy the exact
    // Buffer view so persisted rows survive extension-host restarts.
    buffer = Uint8Array.from(existing);
  } catch {
    // No DB file yet — fresh start.
  }

  // Only pay for a full-database PRAGMA quick_check when the previous
  // session's sentinel is still present — i.e. it didn't shut down cleanly
  // and the on-disk file might be a torn write.
  const dirty = existsSync(sentinelPathFor(dbPath));

  try {
    db = prepareDatabase(SQL, buffer, dirty);
  } catch (err) {
    if (!buffer || !isCorruptDatabaseError(err)) throw err;
    const backupPath = await preserveCorruptDatabase(dbPath);
    console.warn(
      `[claude-history] corrupted database recovered; preserved at ${backupPath ?? "an existing recovery location"}`,
      err,
    );
    db = prepareDatabase(SQL);
  }

  // Create the dirty sentinel before the first persisted write of this
  // session — if the process crashes at any point from here on, the
  // sentinel is left behind and the next activation runs quick_check.
  await createSentinel(dbPath);
  schedulePersist();

  return db;
}

/** Read the stored schema version (0 if absent or meta table missing). */
export function readSchemaVersion(): number {
  try {
    const row = dbGet("SELECT value FROM meta WHERE key = 'schema_version'");
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

/** If the on-disk schema is older than current, drop derived tables so the
 *  next index pass rebuilds them with the new shape. Derived data only —
 *  everything is re-derived from the JSONL files on disk. */
export function runMigrations(): void {
  const stored = readSchemaVersion();
  if (stored === SCHEMA_VERSION) return;

  // Preserve archived/pinned flags across the table drop — they're the only
  // state here that isn't re-derivable from the JSONL files on disk.
  let savedFlags: Record<string, unknown>[] = [];
  try {
    savedFlags = dbAll("SELECT session_id, archived, pinned FROM sessions");
  } catch {
    // sessions table may not exist yet (fresh install).
  }

  getDb().exec(`
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS file_changes;
    DROP TABLE IF EXISTS projects;
  `);
  getDb().exec(SCHEMA_SQL);
  dbExec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);

  if (savedFlags.length > 0) {
    dbExec("CREATE TABLE IF NOT EXISTS _migration_flags (session_id TEXT PRIMARY KEY, archived INTEGER, pinned INTEGER)", []);
    for (const row of savedFlags) {
      dbExec(
        "INSERT OR REPLACE INTO _migration_flags (session_id, archived, pinned) VALUES (?, ?, ?)",
        [String(row.session_id), Number(row.archived ?? 0), Number(row.pinned ?? 0)],
      );
    }
  }
}

/** Re-apply flags saved by runMigrations onto freshly re-indexed sessions, then drop the staging table. */
export function restoreMigratedFlags(): void {
  let rows: Record<string, unknown>[] = [];
  try {
    rows = dbAll("SELECT session_id, archived, pinned FROM _migration_flags");
  } catch {
    return;
  }
  if (rows.length === 0) {
    dbExecDdl("DROP TABLE IF EXISTS _migration_flags;");
    return;
  }
  dbTransaction(() => {
    for (const row of rows) {
      dbExec(
        "UPDATE sessions SET archived = ?, pinned = ? WHERE session_id = ?",
        [Number(row.archived ?? 0), Number(row.pinned ?? 0), String(row.session_id)],
      );
    }
  });
  dbExecDdl("DROP TABLE IF EXISTS _migration_flags;");
}

/** Return the current DB handle (throws if not initialized). */
export function getDb(): SqlJsDb {
  if (!db) throw new Error("Database not initialized. Call initDb first.");
  return db;
}

/** Close and flush the DB. */
export async function closeDb(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (db) {
    const flushed = await flushDb();
    if (flushed && dbPath) {
      await removeSentinel(dbPath);
    }
    db.close();
    db = null;
  }
}

/** Convenience: run a statement and return all rows as objects. */
export function dbAll(
  sql: string,
  params?: Record<string, unknown> | unknown[],
): Record<string, unknown>[] {
  const stmt = getDb().prepare(sql);
  if (params) stmt.bind(params as any);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** Convenience: run a statement and return the first row as an object. */
export function dbGet(
  sql: string,
  params?: Record<string, unknown> | unknown[],
): Record<string, unknown> | undefined {
  const rows = dbAll(sql, params);
  return rows[0];
}

/** Convenience: execute a write statement and return number of changes. */
export function dbExec(sql: string, params?: unknown[]): number {
  const stmt = getDb().prepare(sql);
  if (params) stmt.bind(params);
  stmt.step();
  const changes = getDb().getRowsModified();
  stmt.free();
  schedulePersist();
  return changes;
}

/** Convenience: run raw DDL (schema, index creation). */
export function dbExecDdl(sql: string): void {
  getDb().exec(sql);
  schedulePersist();
}

/** Begin a transaction; returns the db for chaining. */
export function dbTransaction<T>(fn: () => T): T {
  const d = getDb();
  try {
    d.run("BEGIN;");
    const result = fn();
    d.run("COMMIT;");
    schedulePersist();
    return result;
  } catch (e) {
    d.run("ROLLBACK;");
    throw e;
  }
}

/**
 * Ensure the sql.js runtime is loaded. Reuses the module-level instance set up
 * by `initDb` when the extension is running; falls back to a self-contained
 * load (used by tests and by write paths that may run before `initDb`).
 */
async function ensureSqlJs(): Promise<SqlJsStatic> {
  if (sqliteStatic) return sqliteStatic;
  const wasmFile = require.resolve("sql.js/dist/sql-wasm.wasm");
  sqliteStatic = await initSqlJs({ locateFile: () => wasmFile });
  return sqliteStatic;
}

/**
 * Update a single title cell in an external sqlite database (e.g. Antigravity's
 * `conversation_summaries.db`) so that tool's own UI reflects a rename made here.
 * Read-modify-writes the whole file via sql.js. Returns true if a matching row
 * was updated; false when the file is missing or has no such row (the row is not
 * created — the owning tool populates it on the session's next run).
 */
export async function writeExternalSqliteTitle(
  filePath: string,
  tableName: string,
  idCol: string,
  titleCol: string,
  id: string,
  title: string,
): Promise<boolean> {
  let existing: Buffer;
  try {
    existing = await fs.readFile(filePath);
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  const SQL = await ensureSqlJs();
  const tempDb = new SQL.Database(existing);
  try {
    const stmt = tempDb.prepare(`UPDATE ${tableName} SET ${titleCol} = ? WHERE ${idCol} = ?`);
    try {
      stmt.run([title, id]);
    } finally {
      stmt.free();
    }
    if (tempDb.getRowsModified() === 0) return false;
    await fs.writeFile(filePath, Buffer.from(tempDb.export()));
    return true;
  } finally {
    tempDb.close();
  }
}

/** Read external sqlite database and extract conversation titles mapped by id. */
export async function readExternalSqliteTitles(
  filePath: string,
  tableName: string,
  idCol: string,
  titleCol: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!sqliteStatic) return result;
  try {
    const existing = await fs.readFile(filePath);
    const tempDb = new sqliteStatic.Database(existing);
    try {
      const stmt = tempDb.prepare(`SELECT ${idCol}, ${titleCol} FROM ${tableName}`);
      try {
        while (stmt.step()) {
          const row = stmt.getAsObject();
          const id = String(row[idCol] ?? "");
          const title = String(row[titleCol] ?? "");
          if (id && title) {
            result.set(id, title);
          }
        }
      } finally {
        stmt.free();
      }
    } finally {
      tempDb.close();
    }
  } catch (err: any) {
    // Only warn if the database file actually exists; tolerate clean ENOENT.
    if (err?.code !== "ENOENT") {
      console.error(`[claude-history] failed to read external sqlite database ${filePath}:`, err);
    }
  }
  return result;
}
