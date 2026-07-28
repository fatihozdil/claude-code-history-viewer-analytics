import type { SessionMeta, FileChange } from "../claude/types.js";

export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
-- Metadata & incremental tracking
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Projects (derived from encoded dir names or cwd from jsonl)
CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_activity TEXT
);

-- Sessions: one row per .jsonl file
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  native_session_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'claude',
  project_path TEXT,
  project_name TEXT,
  title TEXT,
  created_at TEXT,
  updated_at TEXT,
  file_path TEXT NOT NULL,
  file_mtime REAL NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  git_branch TEXT,
  version TEXT,
  cost REAL,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  subagent_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_mtime ON sessions(file_mtime);
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

-- Messages: indexed bodies stored for search (not full content, but searchable text)
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  uuid TEXT PRIMARY KEY,
  parent_uuid TEXT,
  role TEXT NOT NULL,
  entry_type TEXT,
  ts TEXT,
  ordinal INTEGER NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

-- File changes: extracted from tool_use blocks and file-history-snapshot entries
CREATE TABLE IF NOT EXISTS file_changes (
  session_id TEXT NOT NULL,
  message_uuid TEXT,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL,
  ts TEXT,
  msg_index INTEGER NOT NULL DEFAULT 0,
  backup_ref TEXT,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id);
`;

// ---- Column / row helpers for sessions ----

export const SESSION_COLUMNS =
  "session_id, native_session_id, provider, project_path, project_name, title, created_at, updated_at, file_path, file_mtime, file_size, message_count, git_branch, version, cost, archived, pinned, parent_session_id, subagent_count";
export const SESSION_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

export function sessionToRow(m: SessionMeta): unknown[] {
  return [
    m.sessionId, m.nativeSessionId, m.provider,
    m.projectPath, m.projectName, m.title,
    m.createdAt, m.updatedAt, m.filePath, m.mtimeMs, 0 /* file_size */,
    m.messageCount, null /* git_branch */, null /* version */,
    m.cost ?? null, m.archived ? 1 : 0, m.pinned ? 1 : 0,
    m.parentSessionId ?? null,
    m.subagentCount,
  ];
}

export function rowToSession(row: Record<string, unknown>): SessionMeta {
  return {
    sessionId: String(row.session_id),
    nativeSessionId: String(row.native_session_id ?? row.session_id),
    provider: row.provider === "codex" ? "codex" : row.provider === "agy" ? "agy" : "claude",
    projectPath: String(row.project_path ?? ""),
    projectName: String(row.project_name ?? ""),
    title: String(row.title ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    filePath: String(row.file_path ?? ""),
    mtimeMs: Number(row.file_mtime ?? 0),
    messageCount: Number(row.message_count ?? 0),
    cost: row.cost == null ? null : Number(row.cost),
    archived: Number(row.archived ?? 0) === 1,
    pinned: Number(row.pinned ?? 0) === 1,
    parentSessionId: row.parent_session_id != null ? String(row.parent_session_id) : null,
    subagentCount: Number(row.subagent_count ?? 0),
  };
}

// ---- Column / row helpers for file_changes ----

export const FILE_CHANGE_COLUMNS = "session_id, message_uuid, file_path, operation, ts, msg_index, backup_ref, lines_added, lines_removed";
export const FILE_CHANGE_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?";

export function fileChangeToRow(c: FileChange): unknown[] {
  return [c.sessionId, null, c.filePath, c.operation, c.timestamp ?? "", c.messageIndex, null, c.linesAdded, c.linesRemoved];
}
