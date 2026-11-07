/**
 * Loader for Node's built-in SQLite module (`node:sqlite`).
 *
 * It writes changed pages straight to the database file, unlike sql.js, which
 * keeps the database in memory and can only save by rewriting the whole file.
 * VS Code 1.101 (Electron 35, Node 22.15) is the first release whose extension
 * host has it; older hosts and some forks do not, so callers must handle null.
 *
 * Only the part of the API this extension uses is typed here; @types/node for
 * the Node version we compile against predates the module.
 */

export interface NativeStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

export interface NativeSqliteModule {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => NativeDatabase;
}

let cached: NativeSqliteModule | null | undefined;

/** The `node:sqlite` module, or null when this runtime does not have it. */
export function loadNativeSqlite(): NativeSqliteModule | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("node:sqlite") as NativeSqliteModule;
  } catch {
    cached = null;
  }
  return cached;
}
