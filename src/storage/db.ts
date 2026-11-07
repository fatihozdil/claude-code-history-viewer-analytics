import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import initSqlJs from "sql.js";
import type { Database as SqlJsDb, SqlJsStatic } from "sql.js";
import { performance } from "node:perf_hooks";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { loadNativeSqlite, type NativeDatabase, type NativeStatement } from "./nativeSqlite.js";

/**
 * Two storage engines sit behind the db* helpers below:
 *
 * - `native` (`node:sqlite`, VS Code 1.101+): the database lives in
 *   `history.db` and every commit writes only the pages it changed. Windows
 *   share the file through SQLite's own locking (WAL mode).
 * - `sqljs` (fallback for older hosts): sql.js keeps the database in memory, so
 *   the only way to save is to serialize all of it and replace
 *   `history.sqlite`. Saves are therefore batched and kept rare.
 *
 * Either way the database is a rebuildable cache: pins, archives and titles
 * live in globalState, and the indexer re-reads any session file whose mtime
 * no longer matches its row.
 */
export type DbEngine = "native" | "sqljs";

export const NATIVE_DB_FILENAME = "history.db";
export const LEGACY_DB_FILENAME = "history.sqlite";

type Params = Record<string, unknown> | unknown[];

/** A prepared write statement, reused across many rows. */
export interface PreparedWrite {
  run(params: unknown[]): void;
  free(): void;
}

interface Connection {
  readonly engine: DbEngine;
  all(sql: string, params?: Params): Record<string, unknown>[];
  /** Run one statement; returns the number of rows it changed. */
  run(sql: string, params?: Params): number;
  /** Run one or more statements, discarding any rows. */
  exec(sql: string): void;
  prepare(sql: string): PreparedWrite;
  close(): void;
}

function sqlJsConnection(d: SqlJsDb): Connection {
  return {
    engine: "sqljs",
    all(sql, params) {
      const stmt = d.prepare(sql);
      try {
        if (params) stmt.bind(params as any);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    run(sql, params) {
      const stmt = d.prepare(sql);
      try {
        if (params) stmt.bind(params as any);
        stmt.step();
        return d.getRowsModified();
      } finally {
        stmt.free();
      }
    },
    exec(sql) {
      d.exec(sql);
    },
    prepare(sql) {
      const stmt = d.prepare(sql);
      return { run: (params) => { stmt.run(params as any); }, free: () => { stmt.free(); } };
    },
    close() {
      d.close();
    },
  };
}

/** node:sqlite rejects undefined (and booleans before Node 24); sql.js binds them as NULL and 1/0. */
function bindValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function bindArgs(params?: Params): unknown[] {
  if (!params) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) named[key] = bindValue(value);
  return [named];
}

/** Prepared statements kept per SQL text; cleared when it grows past this. */
const STATEMENT_CACHE_LIMIT = 256;

function nativeConnection(d: NativeDatabase): Connection {
  const statements = new Map<string, NativeStatement>();
  const statement = (sql: string): NativeStatement => {
    let stmt = statements.get(sql);
    if (!stmt) {
      if (statements.size >= STATEMENT_CACHE_LIMIT) statements.clear();
      stmt = d.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };
  return {
    engine: "native",
    // Rows come back with a null prototype; callers (and deepEqual) expect plain objects.
    all: (sql, params) => statement(sql).all(...bindArgs(params)).map((row) => ({ ...row })),
    run: (sql, params) => Number(statement(sql).run(...bindArgs(params)).changes),
    exec: (sql) => d.exec(sql),
    prepare: (sql) => {
      const stmt = statement(sql);
      return { run: (params) => { stmt.run(...bindArgs(params)); }, free: () => {} };
    },
    close: () => {
      statements.clear();
      d.close();
    },
  };
}

let conn: Connection | null = null;
/** The sql.js handle behind `conn` when the sql.js engine is active. */
let sqlJsDb: SqlJsDb | null = null;
let dbPath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let sqliteStatic: SqlJsStatic | null = null;

/** Delay between a write and its save, so a burst of writes shares one save. */
const PERSIST_DEBOUNCE_MS = 1000;
/**
 * Minimum gap between sql.js saves. Each save rewrites the whole file (400 MB
 * on a large history), and an active session changes the database every few
 * seconds, so at a one-minute gap a large history wrote ~24 GB an hour (#23).
 * Writes made inside the gap are not lost: they are saved when the next slot
 * opens or on close, and if VS Code exits first the next start re-indexes the
 * session files that changed.
 */
export const PERSIST_MIN_INTERVAL_MS = 30 * 60_000;
/** Minimum gap between compactions (VACUUM) of the sql.js database. */
const VACUUM_MIN_INTERVAL_MS = 24 * 60 * 60_000;
/** Compact before a timed save once this share of the file is free pages. */
const VACUUM_FREE_RATIO = 0.25;
/** Below this many pages a compaction is not worth its cost. */
const VACUUM_MIN_PAGES = 64;
/** How long a native write waits for another window's write to finish. */
const NATIVE_BUSY_TIMEOUT_MS = 3000;
/** A temp file older than this is a leftover from an interrupted save. */
const STALE_TEMP_FILE_MS = 60 * 60_000;
/** Corrupt databases kept aside for diagnosis; older ones are deleted. */
const CORRUPT_BACKUPS_KEPT = 2;

export interface DbOptions {
  /** Which engine to use; "auto" (the default) prefers node:sqlite. */
  engine?: "auto" | DbEngine;
  /** sql.js: overrides the delay between a write and its save. */
  persistDebounceMs?: number;
  /** sql.js: overrides the minimum gap between saves. */
  persistMinIntervalMs?: number;
  /** sql.js: overrides the minimum gap between compactions. */
  vacuumMinIntervalMs?: number;
}

let persistDebounceMs = PERSIST_DEBOUNCE_MS;
let persistMinIntervalMs = PERSIST_MIN_INTERVAL_MS;
let vacuumMinIntervalMs = VACUUM_MIN_INTERVAL_MS;
/** Start of the latest save on the monotonic clock; -Infinity until the first one. */
let lastPublishAt = Number.NEGATIVE_INFINITY;
/** Start of the latest compaction on the monotonic clock. */
let lastVacuumAt = Number.NEGATIVE_INFINITY;
/** Saves run one after another, so two never write the temp file at once. */
let publishChain: Promise<unknown> = Promise.resolve();
/**
 * Set when the file on disk is behind the database in a way total_changes()
 * cannot see: after DDL, which it does not count, or after a failed save.
 * Cleared when a save takes its snapshot.
 */
let forcePublish = false;
/**
 * Identifies the current initDb() session, so a version from a previous
 * database instance can never match one from this instance.
 */
let dbGeneration = 0;
/**
 * sql.js: total_changes() restarts from zero at every export(), so the rows
 * written before each snapshot are added here. Together they give a count that
 * only grows while the database is open.
 */
let changesBeforeSnapshot = 0;

function getConn(): Connection {
  if (!conn) throw new Error("Database not initialized. Call initDb first.");
  return conn;
}

function totalChanges(): number {
  return Number(getConn().all("SELECT total_changes() AS n")[0]?.n ?? 0);
}

/** The engine in use, or null before initDb. */
export function dbEngine(): DbEngine | null {
  return conn?.engine ?? null;
}

/**
 * A value that changes whenever the database contents may have changed, and
 * stays the same when nothing was written. Callers compare it to decide whether
 * a derived result (such as the analytics aggregation) must be recomputed.
 */
export function dbDataVersion(): string {
  if (!conn) return "none";
  const changes = totalChanges();
  if (conn.engine === "native") {
    // data_version moves when another connection (another window) commits.
    const others = Number(conn.all("PRAGMA data_version")[0]?.data_version ?? 0);
    return `${dbGeneration}:${changes}:${others}`;
  }
  return `${dbGeneration}:${changesBeforeSnapshot + changes}`;
}

/**
 * Sentinel file marking the sql.js database as possibly-in-progress-write.
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

/** Create the version table and bring the schema up to date. */
function prepareSchema(c: Connection): void {
  // Create only the version table before migration. Running the full current
  // schema against an older sessions table can fail while creating indexes on
  // columns that the old table does not have yet.
  c.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  runMigrations();
}

function prepareSqlJsDatabase(SQL: SqlJsStatic, buffer?: Uint8Array, runQuickCheck: boolean = true): void {
  const candidate = new SQL.Database(buffer);
  sqlJsDb = candidate;
  conn = sqlJsConnection(candidate);
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
    prepareSchema(conn);
  } catch (err) {
    candidate.close();
    sqlJsDb = null;
    conn = null;
    throw err;
  }
}

function openNativeDatabase(file: string, runQuickCheck: boolean): void {
  const sqlite = loadNativeSqlite();
  if (!sqlite) throw new Error("node:sqlite is not available in this runtime");
  const candidate = nativeConnection(new sqlite.DatabaseSync(file));
  conn = candidate;
  try {
    // First, so the journal-mode switch below waits for another window
    // instead of failing.
    candidate.exec(`PRAGMA busy_timeout = ${NATIVE_BUSY_TIMEOUT_MS};`);
    candidate.exec("PRAGMA journal_mode = WAL;");
    // WAL + NORMAL can lose the last commits on power loss, never consistency;
    // the indexer re-reads whatever was lost.
    candidate.exec("PRAGMA synchronous = NORMAL;");
    candidate.exec("PRAGMA foreign_keys = ON;");
    if (runQuickCheck) {
      const result = candidate.all("PRAGMA quick_check")[0]?.quick_check;
      if (result !== "ok") {
        throw new Error(`SQLite integrity check failed: ${String(result ?? "unknown error")}`);
      }
    }
    prepareSchema(candidate);
  } catch (err) {
    try {
      candidate.close();
    } catch {
      // Already unusable; the caller handles the original error.
    }
    conn = null;
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

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn(`[claude-history] could not remove ${file}:`, err);
  }
}

/**
 * Delete what interrupted saves and corruption recoveries leave behind: temp
 * files nobody has touched for an hour (a fresh one may be another window's
 * save in progress), and all but the newest corrupt-database backups, each of
 * which is a full copy of the database.
 */
async function removeStorageLeftovers(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  const backups: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const isTemp = /^history\.(sqlite|db)\.tmp-/.test(name);
    const isBackup = /^history\.(sqlite|db)\.corrupt-/.test(name);
    if (!isTemp && !isBackup) continue;
    try {
      const { mtimeMs } = await fs.stat(path.join(dir, name));
      if (isBackup) backups.push({ name, mtimeMs });
      else if (now - mtimeMs > STALE_TEMP_FILE_MS) await unlinkIfPresent(path.join(dir, name));
    } catch {
      // Vanished or locked: leave it for the next start.
    }
  }
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of backups.slice(CORRUPT_BACKUPS_KEPT)) {
    await unlinkIfPresent(path.join(dir, old.name));
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
 * sql.js: arm the save timer. The timer reads the database when it fires, so
 * the one armed timer covers every write made before then. Later writes do not
 * re-arm it: a stream of writes would otherwise postpone the save forever.
 * The native engine has nothing to save: each commit is already on disk.
 */
function schedulePersist(): void {
  if (!sqlJsDb || !dbPath || persistTimer) return;
  const sinceLastPublish = performance.now() - lastPublishAt;
  const delay = Math.max(persistDebounceMs, persistMinIntervalMs - sinceLastPublish);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void enqueuePublish(true);
  }, delay);
}

/**
 * Queue a save behind any already running, so saves never overlap. Only timed
 * saves may compact first: a flush (on close) must finish quickly.
 */
function enqueuePublish(allowCompaction: boolean): Promise<boolean> {
  const run = publishChain.then(() => publishIfChanged(allowCompaction));
  publishChain = run.catch(() => {});
  return run;
}

/** True when the file on disk is not the same as the in-memory database. */
function hasUnpublishedChanges(): boolean {
  if (forcePublish) return true;
  // export() reopens the connection, which resets total_changes() to zero, so
  // this counts the rows written since the last snapshot. A write that changes
  // no rows adds nothing and so leaves the file alone.
  return totalChanges() > 0;
}

function pragmaNumber(d: SqlJsDb, name: string): number {
  return Number(d.exec(`PRAGMA ${name};`)[0]?.values[0]?.[0] ?? 0);
}

/**
 * Rebuild the sql.js database without its free pages when they make up a
 * large share of it. SQLite reuses free pages but never gives them back, and
 * every sql.js save writes them out with the rest of the file. A compaction
 * rewrites the whole database in memory, so it runs at most once a day.
 */
function compactIfMostlyFree(d: SqlJsDb): void {
  if (performance.now() - lastVacuumAt < vacuumMinIntervalMs) return;
  const pages = pragmaNumber(d, "page_count");
  const free = pragmaNumber(d, "freelist_count");
  if (pages < VACUUM_MIN_PAGES || free / pages < VACUUM_FREE_RATIO) return;
  lastVacuumAt = performance.now();
  try {
    d.exec("VACUUM;");
  } catch (err) {
    console.warn("[claude-history] database compaction skipped:", err);
  }
}

/**
 * Snapshot and save the sql.js database if it has changed since the last
 * snapshot. Never rejects: a failure is logged, and the change stays pending
 * for the next attempt.
 */
async function publishIfChanged(allowCompaction: boolean): Promise<boolean> {
  const d = sqlJsDb;
  if (!d || !dbPath) return true;
  const target = dbPath;
  try {
    if (!hasUnpublishedChanges()) return true;
    lastPublishAt = performance.now();
    const sinceSnapshot = totalChanges();
    if (allowCompaction) compactIfMostlyFree(d);
    const data = d.export();
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

/** Save any pending writes now. Returns whether the file on disk is current. */
export async function flushDb(): Promise<boolean> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (conn?.engine === "native") return true;
  return enqueuePublish(false);
}

/** Open the database with the best engine available; returns the engine used. */
export async function initDb(context: vscode.ExtensionContext, options: DbOptions = {}): Promise<DbEngine> {
  persistDebounceMs = options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
  persistMinIntervalMs = options.persistMinIntervalMs ?? PERSIST_MIN_INTERVAL_MS;
  vacuumMinIntervalMs = options.vacuumMinIntervalMs ?? VACUUM_MIN_INTERVAL_MS;
  lastPublishAt = Number.NEGATIVE_INFINITY;
  lastVacuumAt = Number.NEGATIVE_INFINITY;
  forcePublish = false;
  dbGeneration++;
  changesBeforeSnapshot = 0;

  const storageDir = context.globalStorageUri.fsPath;
  await removeStorageLeftovers(storageDir);

  if (chooseEngine(options.engine ?? "auto") === "native") {
    await openNative(storageDir);
    return "native";
  }
  await openSqlJs(context, storageDir);
  return "sqljs";
}

function chooseEngine(requested: "auto" | DbEngine): DbEngine {
  if (requested === "sqljs") return "sqljs";
  if (loadNativeSqlite()) return "native";
  if (requested === "native") throw new Error("node:sqlite is not available in this runtime");
  return "sqljs";
}

async function openNative(storageDir: string): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  const target = path.join(storageDir, NATIVE_DB_FILENAME);
  const legacy = path.join(storageDir, LEGACY_DB_FILENAME);

  // Carry the sql.js index over instead of re-indexing everything. A new file
  // name keeps a window still running an older version, which replaces
  // history.sqlite wholesale, from swapping out a file this one has open.
  const carried = !existsSync(target) && existsSync(legacy) && await copyLegacyDatabase(legacy, target);

  try {
    openNativeDatabase(target, carried);
  } catch (err) {
    if (!isCorruptDatabaseError(err)) throw err;
    const backupPath = await preserveCorruptDatabase(target);
    // A leftover log would be replayed into the fresh database.
    await unlinkIfPresent(`${target}-wal`);
    await unlinkIfPresent(`${target}-shm`);
    console.warn(
      `[claude-history] corrupted database recovered; preserved at ${backupPath ?? "an existing recovery location"}`,
      err,
    );
    openNativeDatabase(target, false);
  }
  dbPath = target;

  // The sql.js file is no longer read; drop it to free the disk space.
  await unlinkIfPresent(legacy);
  await unlinkIfPresent(sentinelPathFor(legacy));
}

/**
 * Copy the sql.js file to `target` without ever replacing an existing target:
 * two windows starting at once both find no history.db, and a rename by the
 * second would swap out the file the first already has open (on POSIX it
 * would keep writing to an unlinked file). A hard link fails with EEXIST
 * instead, so the first window to finish wins and the other opens its file.
 */
async function copyLegacyDatabase(legacy: string, target: string): Promise<boolean> {
  const tmpPath = `${target}.tmp-${process.pid}`;
  try {
    await fs.copyFile(legacy, tmpPath);
    try {
      await fs.link(tmpPath, target);
    } catch (err: any) {
      if (err?.code === "EEXIST") return false;
      // No hard links on this filesystem (FAT, some network shares): fall back
      // to a rename, guarded by a fresh existence check.
      if (existsSync(target)) return false;
      await renameWithRetry(tmpPath, target);
    }
    return true;
  } catch (err) {
    console.warn("[claude-history] could not carry over history.sqlite; rebuilding the index:", err);
    return false;
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function openSqlJs(context: vscode.ExtensionContext, storageDir: string): Promise<void> {
  const wasmFile = locateWasm(context);

  // sql.js 1.x: locateFile is set during init, not on the module.
  const SQL: SqlJsStatic = await initSqlJs({ locateFile: () => wasmFile });
  sqliteStatic = SQL;

  dbPath = path.join(storageDir, LEGACY_DB_FILENAME);

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
    prepareSqlJsDatabase(SQL, buffer, dirty);
  } catch (err) {
    if (!buffer || !isCorruptDatabaseError(err)) throw err;
    const backupPath = await preserveCorruptDatabase(dbPath);
    console.warn(
      `[claude-history] corrupted database recovered; preserved at ${backupPath ?? "an existing recovery location"}`,
      err,
    );
    prepareSqlJsDatabase(SQL);
  }

  // Create the dirty sentinel before the first persisted write of this
  // session — if the process crashes at any point from here on, the
  // sentinel is left behind and the next activation runs quick_check.
  await createSentinel(dbPath);
  schedulePersist();
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

  getConn().exec(`
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS file_changes;
    DROP TABLE IF EXISTS projects;
  `);
  getConn().exec(SCHEMA_SQL);
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

/**
 * The raw sql.js handle, for tests of the sql.js engine only. Application code
 * goes through the db* helpers, which work on either engine.
 */
export function getDb(): SqlJsDb {
  if (sqlJsDb) return sqlJsDb;
  throw new Error(conn ? "getDb() is only available on the sql.js engine" : "Database not initialized. Call initDb first.");
}

/** Close the DB, saving pending sql.js writes first. */
export async function closeDb(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!conn) return;
  if (conn.engine === "sqljs") {
    const flushed = await flushDb();
    if (flushed && dbPath) {
      await removeSentinel(dbPath);
    }
  }
  conn.close();
  conn = null;
  sqlJsDb = null;
}

/** Convenience: run a statement and return all rows as objects. */
export function dbAll(
  sql: string,
  params?: Record<string, unknown> | unknown[],
): Record<string, unknown>[] {
  return getConn().all(sql, params);
}

/** Convenience: run a statement and return the first row as an object. */
export function dbGet(
  sql: string,
  params?: Record<string, unknown> | unknown[],
): Record<string, unknown> | undefined {
  return dbAll(sql, params)[0];
}

/** Convenience: execute a write statement and return number of changes. */
export function dbExec(sql: string, params?: unknown[]): number {
  const changes = getConn().run(sql, params);
  schedulePersist();
  return changes;
}

/** Prepare a write statement for many rows; free() it when done. */
export function dbPrepare(sql: string): PreparedWrite {
  const stmt = getConn().prepare(sql);
  return {
    run: (params) => {
      stmt.run(params);
      schedulePersist();
    },
    free: () => stmt.free(),
  };
}

/** Convenience: run raw DDL (schema, index creation). */
export function dbExecDdl(sql: string): void {
  getConn().exec(sql);
  forcePublish = true;
  schedulePersist();
}

/**
 * Run `fn` in a transaction. IMMEDIATE takes the write lock up front, so with
 * two windows on one native database the second waits (busy_timeout) rather
 * than failing when its read lock cannot be upgraded.
 */
export function dbTransaction<T>(fn: () => T): T {
  const c = getConn();
  c.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    c.exec("COMMIT;");
    schedulePersist();
    return result;
  } catch (e) {
    try {
      c.exec("ROLLBACK;");
    } catch {
      // The failed statement may already have ended the transaction.
    }
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
 * With node:sqlite this is a normal locked update of one row; the sql.js
 * fallback read-modify-writes the whole file. Returns true if a matching row
 * was updated; false when the file is missing or has no such row (the row is
 * not created — the owning tool populates it on the session's next run).
 */
export async function writeExternalSqliteTitle(
  filePath: string,
  tableName: string,
  idCol: string,
  titleCol: string,
  id: string,
  title: string,
): Promise<boolean> {
  const sql = `UPDATE ${tableName} SET ${titleCol} = ? WHERE ${idCol} = ?`;
  const sqlite = loadNativeSqlite();
  if (sqlite) {
    // Opening a missing path would create an empty database there.
    if (!existsSync(filePath)) return false;
    const external = new sqlite.DatabaseSync(filePath);
    try {
      external.exec(`PRAGMA busy_timeout = ${NATIVE_BUSY_TIMEOUT_MS};`);
      return Number(external.prepare(sql).run(title, id).changes) > 0;
    } finally {
      external.close();
    }
  }

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
    const stmt = tempDb.prepare(sql);
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
  const sql = `SELECT ${idCol}, ${titleCol} FROM ${tableName}`;
  const add = (row: Record<string, unknown>) => {
    const id = String(row[idCol] ?? "");
    const title = String(row[titleCol] ?? "");
    if (id && title) result.set(id, title);
  };

  const sqlite = loadNativeSqlite();
  if (sqlite && existsSync(filePath)) {
    try {
      const external = new sqlite.DatabaseSync(filePath, { readOnly: true });
      try {
        for (const row of external.prepare(sql).all()) add(row);
        return result;
      } finally {
        external.close();
      }
    } catch (err) {
      // Fall through to the sql.js copy, which needs no locks or -shm file.
      console.warn(`[claude-history] node:sqlite could not read ${filePath}; retrying with sql.js:`, err);
      result.clear();
    }
  }

  if (!sqliteStatic && !sqlite) return result;
  try {
    const existing = await fs.readFile(filePath);
    const SQL = await ensureSqlJs();
    const tempDb = new SQL.Database(existing);
    try {
      const stmt = tempDb.prepare(sql);
      try {
        while (stmt.step()) add(stmt.getAsObject());
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
