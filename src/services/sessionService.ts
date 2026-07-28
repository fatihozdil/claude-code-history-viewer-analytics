import * as fs from "node:fs/promises";
import type { NormalizedMessage, SessionMeta } from "../claude/types.js";
import { parseJsonl } from "../claude/jsonl.js";
import { normalizeSession } from "../claude/session.js";
import { parseCodexJsonl } from "../codex/jsonl.js";
import { normalizeCodexSession } from "../codex/session.js";
import { normalizeAgyTranscript } from "../agy/session.js";
import { rowToSession, SESSION_COLUMNS } from "../storage/schema.js";
import { dbAll, dbGet } from "../storage/db.js";

/** Load session list from DB, optionally filtered by project path. */
export async function listSessions(projectPath?: string): Promise<SessionMeta[]> {
  let sql = `SELECT ${SESSION_COLUMNS} FROM sessions`;
  const params: unknown[] = [];
  if (projectPath) {
    const sep = projectPath.includes("\\") ? "\\" : "/";
    const escaped = projectPath.replace(/([\\%_])/g, "\\$1");
    const likePattern = escaped + sep + "%";
    sql += " WHERE (project_path = ? OR project_path LIKE ? ESCAPE '\\')";
    params.push(projectPath, likePattern);
  }
  sql += " ORDER BY updated_at DESC";
  return dbAll(sql, params).map(rowToSession);
}

/** List distinct project paths from indexed sessions. */
export async function listProjects(): Promise<
  { path: string; name: string; sessionCount: number }[]
> {
  const rows = dbAll(`
    SELECT project_path, project_name, COUNT(*) AS cnt
    FROM sessions
    WHERE project_path != ''
    GROUP BY project_path
    ORDER BY MAX(updated_at) DESC
  `);
  return rows.map((r) => ({
    path: String(r.project_path),
    name: String(r.project_name),
    sessionCount: Number(r.cnt),
  }));
}

/** Load a full conversation by streaming from its .jsonl file on disk. */
export async function loadConversation(
  filePath: string,
): Promise<{ meta: SessionMeta; messages: NormalizedMessage[] }> {
  const text = await fs.readFile(filePath, "utf8");

  // Both products append `.jsonl`, so dispatch from indexed metadata and only
  // sniff the envelope when opening a file that has not been indexed yet.
  const indexedByPath = dbGet(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE file_path = ?`,
    [filePath],
  );
  const normalizeClaudeText = () => {
    const entries = parseJsonl(text);
    const nativeSessionId = entries.find((e) => e.sessionId)?.sessionId
      ?? entries.find((e) => e.uuid)?.uuid
      ?? "unknown";
    return normalizeSession(entries, nativeSessionId);
  };

  let normalized;
  if (indexedByPath?.provider === "agy") {
    normalized = normalizeAgyTranscript(text, String(indexedByPath.native_session_id), String(indexedByPath.project_path ?? ""));
  } else if (indexedByPath?.provider === "codex") {
    normalized = normalizeCodexSession(
      parseCodexJsonl(text),
      String(indexedByPath.native_session_id),
    );
  } else if (indexedByPath) {
    normalized = normalizeClaudeText();
  } else {
    const codexEntries = parseCodexJsonl(text);
    normalized = codexEntries.some((entry) => entry.type === "session_meta")
      ? normalizeCodexSession(codexEntries, "unknown")
      : normalizeClaudeText();
  }

  // Try to load metadata from DB (has the richer fields)
  const dbMeta = indexedByPath ?? dbGet(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`,
      [normalized.meta.sessionId],
    );

  const meta: SessionMeta = dbMeta
    ? { ...rowToSession(dbMeta), filePath }
    : { ...normalized.meta, filePath, mtimeMs: 0, cost: null, archived: false, pinned: false };

  return { meta, messages: normalized.messages };
}
