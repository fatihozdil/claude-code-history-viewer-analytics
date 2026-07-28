import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";

/** Session IDs are UUIDs: hex chars and hyphens only. */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Backup file names are hex hash + optional @vN suffix (e.g. "f1eff68c55e4bc7e@v1"). */
const BACKUP_NAME_RE = /^[0-9a-fA-F]{14,}@v[0-9]+$/;

function validateComponents(sessionId: string, backupFileName?: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session ID "${sessionId}". Expected a UUID.`);
  }
  if (backupFileName !== undefined && !BACKUP_NAME_RE.test(backupFileName)) {
    throw new Error(
      `Invalid backup file name "${backupFileName}". Expected hex hash with @version.`,
    );
  }
}

/**
 * Verify that `resolved` is inside `base` after resolving both to real paths.
 * Returns the realpath of `resolved`, or null if validation fails.
 */
async function safeRealPath(fullPath: string, baseDir: string): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(fullPath);
  } catch {
    // File doesn't exist — use path.resolve for prefix check instead.
    real = path.resolve(fullPath);
  }
  let base: string;
  try {
    base = await fs.realpath(baseDir);
  } catch {
    base = path.resolve(baseDir);
  }
  // Normalize both to ensure consistent slashes
  const normReal = path.normalize(real) + path.sep;
  const normBase = path.normalize(base) + path.sep;
  if (!normReal.startsWith(normBase)) {
    return null;
  }
  return real;
}

/**
 * Resolve the absolute path to a file-history backup blob.
 * Layout: ~/.claude/file-history/<sessionId>/<backupFileName>
 */
export function backupFilePath(
  claudeDir: string,
  sessionId: string,
  backupFileName: string,
): string {
  validateComponents(sessionId, backupFileName);
  return path.join(claudeDir, "file-history", sessionId, backupFileName);
}

/**
 * Read a backup blob's contents.
 * Returns the file text, or null if the backup doesn't exist or path validation fails.
 */
export async function readBackup(
  claudeDir: string,
  sessionId: string,
  backupFileName: string,
): Promise<string | null> {
  validateComponents(sessionId, backupFileName);
  const absolute = backupFilePath(claudeDir, sessionId, backupFileName);
  const baseDir = path.join(claudeDir, "file-history");
  if (!(await safeRealPath(absolute, baseDir))) return null;
  try {
    return await fs.readFile(absolute, "utf8");
  } catch {
    return null;
  }
}

/**
 * List all backup files for a session.
 */
export async function listBackups(
  claudeDir: string,
  sessionId: string,
): Promise<string[]> {
  validateComponents(sessionId);
  const dir = path.join(claudeDir, "file-history", sessionId);
  const baseDir = path.join(claudeDir, "file-history");
  if (!(await safeRealPath(dir, baseDir))) return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Find the earliest (pre-session) backup blob for a file path within a
 * session, by matching the first-16-hex-chars-of-sha256(filePath) prefix
 * that Claude Code uses for backup file names. Returns the backup file
 * name (not full path), or null if no backup exists for that file.
 */
export async function resolveBackupRef(
  claudeDir: string,
  sessionId: string,
  filePath: string,
): Promise<string | null> {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  const backups = await listBackups(claudeDir, sessionId);
  const matches = backups
    .map((p) => path.basename(p))
    .filter((name) => name.startsWith(`${hash}@v`))
    .map((name) => ({ name, version: Number(name.slice(hash.length + 2)) }))
    .filter((m) => Number.isFinite(m.version));
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.version - b.version);
  return matches[0].name;
}
