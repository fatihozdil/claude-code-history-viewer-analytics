import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import initSqlJs from "sql.js";
import type { Database as SqlJsDb, SqlJsStatic } from "sql.js";
import { performance } from "node:perf_hooks";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

let db: SqlJsDb | null = null;
let dbPath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let sqliteStatic: SqlJsStatic | null = null;

/** Delay between a write and its publish, so a burst of writes shares one publish. */
const PERSIST_DEBOUNCE_MS = 1000;
/**
 * Minimum gap between publishes. A publish rewrites the whole database file,
 * and an active session triggers an index pass every few seconds, so without a
 * floor the file would be rewritten at that cadence. Writes made inside the gap
 * are not dropped: they publish when the next slot opens, or on flush/close.
 */
const PERSIST_MIN_INTERVAL_MS = 60_000;

export interface DbOptions {
  /** Overrides the delay between a write and its publish. */
  persistDebounceMs?: number;
  /** Overrides the minimum gap between publishes. */
  persistMinIntervalMs?: number;
}

let persistDebounceMs = PERSIST_DEBOUNCE_MS;
let persistMinIntervalMs = PERSIST_MIN_INTERVAL_MS;
/** Start of the latest publish on the monotonic clock; -Infinity until the first one. */
let lastPublishAt = Number.NEGATIVE_INFINITY;
/** Publishes run one after another, so two never write the temp file at once. */
let publishChain: Promise<unknown> = Promise.resolve();
/**
 * Set when the file on disk is behind the database in a way total_changes()
 * cannot see: after DDL, which it does not count, or after a failed publish.
 * Cleared when a publish takes its snapshot.
 */
let forcePublish = false;
/**
 * Identifies the current initDb() session, so a version from a previous
 * database instance can never match one from this instance.
 */
let dbGeneration = 0;
/**
 * total_changes() restarts from zero at every export(), so the rows written
 * before each snapshot are added here. Together they give a count that only
 * grows while the database is open.
 */
let changesBeforeSnapshot = 0;

/**
 * A value that changes whenever the database contents may have changed, and
 * stays the same when nothing was written. Callers compare it to decide whether
 * a derived result (such as the analytics aggregation) must be recomputed.
 */
export function dbDataVersion(): string {
  if (!db) return "none";
  const sinceSnapshot = Number(getDb().exec("SELECT total_changes();")[0]?.values[0]?.[0] ?? 0);
  return `${dbGeneration}:${changesBeforeSnapshot + sinceSnapshot}`;
}

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

/** Backoff before each rename retry, in milliseconds. */
const RENAME_RETRY_DELAYS_MS = [10, 25, 60, 120];

/** Errors Windows raises when something else still holds the target file. */
const RENAME_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Rename, retrying the codes Windows raises while another process holds the
 * target open. Antivirus and the search indexer both take brief handles on a
 * file just written, so a first attempt can fail on a machine where nothing is
 * wrong. POSIX replaces the target regardless and succeeds on the first try.
 *
 * `rename` is injectable so the retry behaviour can be tested without a
 * Windows host.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: (a: string, b: string) => Promise<void> = fs.rename,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err: any) {
      if (!RENAME_RETRYABLE_CODES.has(err?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Publish the serialized database by writing a sibling temp file and renaming
 * it over the target. Rename is atomic within a filesystem, so a window
 * reading the database while another window persists sees either the previous
 * file or the new one. Writing straight to `dbPath` truncates it first, which
 * leaves a multi-megabyte window where readers get a torn file and
 * `PRAGMA quick_check` fails.
 *
 * The pid in the temp name keeps two windows from colliding on the temp file
 * itself.
 */
async function publishDatabaseFile(targetPath: string, data: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmpPath, data);
    await renameWithRetry(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Arm the publish timer. The timer reads the database when it fires, so the
 * one armed timer covers every write made before then. Later writes do not
 * re-arm it: a stream of writes would otherwise postpone the publish forever.
 */
function schedulePersist(): void {
  if (!db || !dbPath || persistTimer) return;
  const sinceLastPublish = performance.now() - lastPublishAt;
  const delay = Math.max(persistDebounceMs, persistMinIntervalMs - sinceLastPublish);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void enqueuePublish();
  }, delay);
}

/** Queue a publish behind any already running, so publishes never overlap. */
function enqueuePublish(): Promise<boolean> {
  const run = publishChain.then(publishIfChanged);
  publishChain = run.catch(() => {});
  return run;
}

/** True when the file on disk is not the same as the in-memory database. */
function hasUnpublishedChanges(): boolean {
  if (forcePublish) return true;
  // export() reopens the connection, which resets total_changes() to zero, so
  // this counts the rows written since the last snapshot. A write that changes
  // no rows adds nothing and so leaves the file alone.
  return Number(getDb().exec("SELECT total_changes();")[0]?.values[0]?.[0] ?? 0) > 0;
}

/**
 * Snapshot and publish the database if it has changed since the last snapshot.
 * Never rejects: a failure is logged, and the change stays pending for the
 * next attempt.
 */
async function publishIfChanged(): Promise<boolean> {
  if (!db || !dbPath) return true;
  const target = dbPath;
  try {
    if (!hasUnpublishedChanges()) return true;
    lastPublishAt = performance.now();
    const sinceSnapshot = Number(db.exec("SELECT total_changes();")[0]?.values[0]?.[0] ?? 0);
    const data = db.export();
    changesBeforeSnapshot += sinceSnapshot;
    forcePublish = false;
    await publishDatabaseFile(target, data);
    return true;
  } catch (err) {
    forcePublish = true;
    console.error("[claude-history] failed to persist database:", err);
    return false;
  }
}

/** Publish any pending DB writes now. Returns whether the file on disk is current. */
export async function flushDb(): Promise<boolean> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return enqueuePublish();
}

/** Initialize or open the sql.js database. */
export async function initDb(context: vscode.ExtensionContext, options: DbOptions = {}): Promise<SqlJsDb> {
  const wasmFile = locateWasm(context);

  // sql.js 1.x: locateFile is set during init, not on the module.
  const SQL: SqlJsStatic = await initSqlJs({ locateFile: () => wasmFile });
  sqliteStatic = SQL;
  persistDebounceMs = options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
  persistMinIntervalMs = options.persistMinIntervalMs ?? PERSIST_MIN_INTERVAL_MS;
  lastPublishAt = Number.NEGATIVE_INFINITY;
  forcePublish = false;
  dbGeneration++;
  changesBeforeSnapshot = 0;

  dbPath =path.join(context.globalStorageUri.fsPath, "history.sqlite");

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
  forcePublish = true;
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
