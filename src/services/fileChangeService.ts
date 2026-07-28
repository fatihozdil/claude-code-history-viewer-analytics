import { dbAll } from "../storage/db.js";
import { resolveBackupRef } from "../data/fileHistory.js";
import type { FileChange, FileOperation } from "../claude/types.js";

export interface FileChangeWithBackup extends FileChange {
  backupRef?: string;
}

/** List file changes for a session from the DB index. */
export function listFileChanges(sessionId: string): FileChangeWithBackup[] {
  const rows = dbAll(
    `SELECT file_path, operation, ts, msg_index, backup_ref, lines_added, lines_removed
     FROM file_changes
     WHERE session_id = ?
     ORDER BY msg_index`,
    [sessionId],
  );
  return rows.map((r) => ({
    sessionId,
    filePath: String(r.file_path),
    operation: r.operation as FileOperation,
    timestamp: r.ts ? String(r.ts) : undefined,
    messageIndex: Number(r.msg_index ?? 0),
    backupRef: r.backup_ref ? String(r.backup_ref) : undefined,
    linesAdded: Number(r.lines_added ?? 0),
    linesRemoved: Number(r.lines_removed ?? 0),
  }));
}

/** Group changes by file path, deduplicating repeated operations on the same file. */
export function dedupedFileChanges(sessionId: string): FileChangeWithBackup[] {
  const all = listFileChanges(sessionId);
  const seen = new Map<string, FileChangeWithBackup>();
  for (const fc of all) {
    const key = `${fc.filePath}|${fc.operation}`;
    const existing = seen.get(key);
    // Keep the latest occurrence
    if (!existing || fc.messageIndex > existing.messageIndex) {
      seen.set(key, fc);
    }
  }
  return [...seen.values()].sort((a, b) => a.messageIndex - b.messageIndex);
}

export interface FileChangeSummary {
  filePath: string;
  operations: FileOperation[];
  linesAdded: number;
  linesRemoved: number;
  lastMessageIndex: number;
  canDiff: boolean;
}

export function summarizeFileChangeRows(rows: FileChangeWithBackup[]): FileChangeSummary[] {
  const byFile = new Map<string, FileChangeSummary>();
  for (const r of rows) {
    let s = byFile.get(r.filePath);
    if (!s) {
      s = {
        filePath: r.filePath,
        operations: [],
        linesAdded: 0,
        linesRemoved: 0,
        lastMessageIndex: r.messageIndex,
        canDiff: false,
      };
      byFile.set(r.filePath, s);
    }
    if (!s.operations.includes(r.operation)) s.operations.push(r.operation);
    s.linesAdded += r.linesAdded;
    s.linesRemoved += r.linesRemoved;
    if (r.messageIndex > s.lastMessageIndex) s.lastMessageIndex = r.messageIndex;
    if (r.operation !== "Read") s.canDiff = true;
  }
  return [...byFile.values()].sort((a, b) => a.lastMessageIndex - b.lastMessageIndex);
}

export function summarizeFileChanges(sessionId: string): FileChangeSummary[] {
  return summarizeFileChangeRows(listFileChanges(sessionId)).filter((s) =>
    s.operations.some((op) => op !== "Read"),
  );
}

export interface BackupLocation {
  sessionId: string;
  backupFileName: string;
}

/**
 * Find the backup blob that captures `filePath` as it stood right after
 * `sessionId` finished editing it — i.e. the earliest backup of the next
 * session (chronologically) that also touched this file. Used to scope a
 * diff to just this session's edits instead of comparing against the live
 * file on disk, which may include later unrelated changes.
 */
export async function findScopedAfterBackup(
  claudeDir: string,
  sessionId: string,
  filePath: string,
): Promise<BackupLocation | null> {
  const lastTsRows = dbAll(
    `SELECT MAX(ts) as max_ts FROM file_changes WHERE session_id = ? AND file_path = ?`,
    [sessionId, filePath],
  );
  const lastTs = lastTsRows[0]?.max_ts ? String(lastTsRows[0].max_ts) : null;
  if (!lastTs) return null;

  const nextRows = dbAll(
    `SELECT session_id, MIN(ts) as first_ts FROM file_changes
     WHERE file_path = ? AND session_id != ? AND ts > ?
     GROUP BY session_id ORDER BY first_ts ASC LIMIT 1`,
    [filePath, sessionId, lastTs],
  );
  if (nextRows.length === 0) return null;

  const nextSessionId = String(nextRows[0].session_id);
  const backupFileName = await resolveBackupRef(claudeDir, nextSessionId, filePath);
  if (!backupFileName) return null;
  return { sessionId: nextSessionId, backupFileName };
}
