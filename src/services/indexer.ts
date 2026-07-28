import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  historyPresence, isStaleSession, resolveSessionCollisions, scanHistory,
  type HistoryRoots, type IndexedSessionLocation,
} from "../discovery/historyScanner.js";
import { decodeProjectDirName } from "../discovery/paths.js";
import { readAgyWorkspaces } from "../discovery/agyScanner.js";
import type { FileChange, NormalizedMessage, SessionMeta } from "../claude/types.js";
import { sessionKey } from "../claude/types.js";
import { parseJsonl } from "../claude/jsonl.js";
import { normalizeSession } from "../claude/session.js";
import { parseCodexJsonl } from "../codex/jsonl.js";
import { normalizeCodexSession, parseAndNormalizeCodexSession } from "../codex/session.js";
import { normalizeAgyTranscript } from "../agy/session.js";
import { extractCodexFileChanges } from "../codex/fileChanges.js";
import { extractFileChanges } from "../claude/fileChanges.js";
import { extractCost } from "../claude/cost.js";
import { costForTokens } from "./pricing.js";
import { countSubagents } from "../claude/subagentMeta.js";
import { isCodexArchivedSessionPath } from "../discovery/paths.js";
import {
  dbTransaction, dbExec, dbAll, dbGet, getDb, readExternalSqliteTitles,
} from "../storage/db.js";
import {
  SESSION_COLUMNS, SESSION_PLACEHOLDERS,
  FILE_CHANGE_COLUMNS, FILE_CHANGE_PLACEHOLDERS,
  sessionToRow, fileChangeToRow, rowToSession,
  SCHEMA_VERSION,
} from "../storage/schema.js";

const KNOWN_ROWS_CACHE_SIZE = 20000;
const METADATA_PREFIX_BYTES = 64 * 1024;
const SEARCH_FRAGMENT_MAX_CHARS = 2000;

/**
 * JSON.stringify replacer that truncates string values before serialization,
 * so multi-megabyte tool-input strings are never materialized in full just to
 * be discarded by the final slice.
 */
function truncatingReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > SEARCH_FRAGMENT_MAX_CHARS) {
    return value.slice(0, SEARCH_FRAGMENT_MAX_CHARS);
  }
  return value;
}
let indexQueue: Promise<void> = Promise.resolve();

export interface IndexerProgress {
  phase: "scanning" | "indexing" | "complete" | "error";
  scanned: number;
  total: number;
  message?: string;
}

export type IndexerCallback = (progress: IndexerProgress) => void;

export type { HistoryRoots } from "../discovery/historyScanner.js";

/** Parsed content for a changed file, produced by the single read+parse pass. */
interface ParsedContent {
  messages: NormalizedMessage[];
  fileChanges: FileChange[];
  cost: number | null;
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function enqueueIndex(work: () => Promise<void>): Promise<void> {
  const result = indexQueue.then(work, work);
  indexQueue = result.catch(() => {});
  return result;
}

/**
 * Full incremental index pass.
 * Called on activation and after watcher-triggered refresh.
 */
export function incrementalIndex(
  roots: HistoryRoots,
  maxFileSizeBytes: number,
  onProgress?: IndexerCallback,
): Promise<void> {
  return enqueueIndex(() => incrementalIndexNow(roots, maxFileSizeBytes, onProgress));
}

async function readFilePrefix(filePath: string): Promise<string> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(METADATA_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Build a Codex large-file placeholder meta from a 64KB prefix read (never the full file). */
async function codexLargeFileMeta(
  filePath: string,
  fallbackNativeSessionId: string,
  archived: boolean,
  titleBySessionId: ReadonlyMap<string, string>,
  effectiveMtimeMs: number,
): Promise<SessionMeta> {
  let normalizedMeta: Omit<SessionMeta, "filePath" | "mtimeMs">;
  try {
    normalizedMeta = parseAndNormalizeCodexSession(
      await readFilePrefix(filePath),
      fallbackNativeSessionId,
      { archived, titleBySessionId },
    ).meta;
  } catch {
    normalizedMeta = {
      provider: "codex" as const,
      nativeSessionId: fallbackNativeSessionId,
      sessionId: sessionKey("codex", fallbackNativeSessionId),
      projectPath: "",
      projectName: "Unknown project",
      title: "Untitled session",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      cost: null,
      archived,
      pinned: false,
      parentSessionId: null,
      subagentCount: 0,
    };
  }
  return {
    ...normalizedMeta,
    title: "(large session — not indexed)",
    filePath,
    mtimeMs: effectiveMtimeMs,
    messageCount: 0,
  };
}

async function incrementalIndexNow(
  roots: HistoryRoots,
  maxFileSizeBytes: number,
  onProgress?: IndexerCallback,
  force = false,
): Promise<void> {
  // Load known rows from the DB: mtimes gate re-parsing, native session ids resolve
  // Codex effectiveMtime for unchanged files, and full rows reconstruct SessionMeta
  // for unchanged files without touching disk.
  //
  // Force (reindexAll) only bypasses the changed-file skip (empty knownMtimes makes
  // every file count as changed) — identity bookkeeping (knownNativeSessionIds) is
  // still loaded so Codex effectiveMtime keeps its session_index updated_at boost
  // during a rebuild; otherwise the next incremental pass would spuriously re-read
  // rollouts whose filename UUID differs from their content session id.
  const knownMtimes = new Map<string, number>();
  const knownNativeSessionIds = new Map<string, string>();
  const rowsByPath = new Map<string, Record<string, unknown>>();
  try {
    const rows = dbAll(`SELECT ${SESSION_COLUMNS} FROM sessions`);
    let loaded = 0;
    for (const r of rows) {
      const fp = String(r.file_path);
      if (!fp) continue;
      if (!force) {
        const mt = Number(r.file_mtime ?? 0);
        if (mt) knownMtimes.set(fp, mt);
        rowsByPath.set(fp, r);
      }
      if (r.provider === "codex" && r.native_session_id) {
        knownNativeSessionIds.set(fp, String(r.native_session_id));
      }
      // Prevent unbounded memory growth
      if (++loaded >= KNOWN_ROWS_CACHE_SIZE) break;
    }
  } catch {
    // DB may not be ready on first activation; proceed without known state.
  }

  onProgress?.({ phase: "scanning", scanned: 0, total: 0, message: "Scanning session files..." });

  let scan;
  try {
    scan = await scanHistory(roots, { knownMtimes, knownNativeSessionIds });
  } catch (err) {
    onProgress?.({ phase: "error", scanned: 0, total: 0, message: String(err) });
    return;
  }

  const { claudeFiles, codexFiles, agyFiles, titleBySessionId, completeProviders } = scan;
  const changedSet = new Set(scan.changedPaths);

  let agyTitles = new Map<string, string>();
  if (roots.agyDir) {
    const summariesDbPath = path.join(roots.agyDir, "conversation_summaries.db");
    agyTitles = await readExternalSqliteTitles(summariesDbPath, "conversation_summaries", "conversation_id", "title");
  }

  // Agy workspace lookup is only needed to build metas for changed files; skip the
  // (small) read entirely when there's nothing changed for that provider.
  const needsAgyWorkspaces = roots.agyDir && agyFiles.some((f) => changedSet.has(f.filePath));
  const agyWorkspaces = needsAgyWorkspaces ? await readAgyWorkspaces(roots.agyDir!) : new Map<string, string>();

  // Assemble metas for every listed file: changed files get a single read+parse;
  // unchanged files are reconstructed from their existing DB row (no disk read).
  const metas: SessionMeta[] = [];
  const parsedByPath = new Map<string, ParsedContent>();

  // A non-ENOENT read/parse failure (EACCES, EMFILE, IO error...) means this
  // pass's view of that provider is not authoritative: the file still exists but
  // its session is missing from `metas`, so stale pruning would wrongly delete
  // its DB row. Mirror the scanners' `complete` semantics: drop the provider
  // from completeProviders for this pass. ENOENT stays benign — the file truly
  // vanished, and the presence check handles genuine staleness.
  const failedProviders = new Set<SessionMeta["provider"]>();

  for (const entry of claudeFiles) {
    if (!changedSet.has(entry.filePath)) {
      const row = rowsByPath.get(entry.filePath);
      if (row) { metas.push(rowToSession(row)); continue; }
    }
    if (entry.sizeBytes > maxFileSizeBytes) {
      metas.push({
        sessionId: sessionKey("claude", entry.fallbackId),
        nativeSessionId: entry.fallbackId,
        provider: "claude",
        projectPath: "",
        projectName: decodeProjectDirName(entry.projDirName),
        title: "(large session — not indexed)",
        createdAt: "", updatedAt: "",
        filePath: entry.filePath, mtimeMs: entry.mtimeMs, messageCount: 0,
        cost: null, archived: false, pinned: false, parentSessionId: null,
        subagentCount: 0,
      });
      continue;
    }
    let text: string;
    try {
      text = await fsp.readFile(entry.filePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) failedProviders.add("claude");
      continue;
    }
    const rawEntries = parseJsonl(text);
    const { meta, messages } = normalizeSession(rawEntries, entry.fallbackId);
    const fullMeta: SessionMeta = {
      ...meta,
      projectName: meta.projectPath ? meta.projectName : decodeProjectDirName(entry.projDirName),
      filePath: entry.filePath,
      mtimeMs: entry.mtimeMs,
    };
    metas.push(fullMeta);
    parsedByPath.set(entry.filePath, {
      messages,
      fileChanges: extractFileChanges(messages, fullMeta.sessionId),
      cost: extractCost(rawEntries),
    });
  }

  for (const entry of codexFiles) {
    if (!changedSet.has(entry.filePath)) {
      const row = rowsByPath.get(entry.filePath);
      if (row) { metas.push(rowToSession(row)); continue; }
    }
    if (entry.sizeBytes > maxFileSizeBytes) {
      metas.push(await codexLargeFileMeta(
        entry.filePath, entry.fallbackNativeSessionId, entry.archived, titleBySessionId, entry.mtimeMs,
      ));
      continue;
    }
    let text: string;
    try {
      text = await fsp.readFile(entry.filePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) failedProviders.add("codex");
      continue;
    }
    const rawEntries = parseCodexJsonl(text);
    const { meta, messages } = normalizeCodexSession(rawEntries, entry.fallbackNativeSessionId, {
      archived: entry.archived,
      titleBySessionId,
    });
    const fullMeta: SessionMeta = { ...meta, filePath: entry.filePath, mtimeMs: entry.mtimeMs };
    metas.push(fullMeta);
    parsedByPath.set(entry.filePath, {
      messages,
      fileChanges: extractCodexFileChanges(rawEntries, messages, fullMeta.sessionId),
      cost: messages.reduce((sum, message) => sum + costForTokens(message.model, {
        input: message.inputTokens ?? 0,
        output: message.outputTokens ?? 0,
        cacheCreation: message.cacheCreationTokens ?? 0,
        cacheRead: message.cacheReadTokens ?? 0,
      }), 0),
    });
  }

  for (const entry of agyFiles) {
    if (entry.sizeBytes > maxFileSizeBytes) continue;
    if (!changedSet.has(entry.filePath)) {
      const row = rowsByPath.get(entry.filePath);
      if (row) {
        const meta = rowToSession(row);
        const externalTitle = agyTitles.get(entry.nativeSessionId);
        if (externalTitle && externalTitle !== meta.title) {
          changedSet.add(entry.filePath);
        } else {
          metas.push(meta);
          continue;
        }
      }
    }
    let text: string;
    try {
      text = await fsp.readFile(entry.filePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) failedProviders.add("agy");
      continue;
    }
    const { meta, messages } = normalizeAgyTranscript(
      text,
      entry.nativeSessionId,
      agyWorkspaces.get(entry.nativeSessionId) ?? "",
      { titleBySessionId: agyTitles }
    );
    if (!meta.messageCount) continue;
    const fullMeta: SessionMeta = { ...meta, filePath: entry.filePath, mtimeMs: entry.mtimeMs };
    metas.push(fullMeta);
    parsedByPath.set(entry.filePath, { messages, fileChanges: [], cost: null });
  }

  const dedupedMetas = resolveSessionCollisions(metas);
  const selectedPaths = new Set(dedupedMetas.map((meta) => meta.filePath));
  const changedPaths = [
    ...scan.changedPaths,
    ...agyFiles.filter((f) => changedSet.has(f.filePath) && !scan.changedPaths.includes(f.filePath)).map((f) => f.filePath)
  ].filter((filePath) => selectedPaths.has(filePath));

  const presence = historyPresence(dedupedMetas);
  const authoritativeProviders = new Set(
    [...completeProviders].filter((provider) => !failedProviders.has(provider)),
  );
  const staleRows = dbAll("SELECT session_id, file_path, provider FROM sessions")
    .filter((row) => isStaleSession({
      sessionId: String(row.session_id),
      filePath: String(row.file_path),
      provider: row.provider === "codex" ? "codex" : row.provider === "agy" ? "agy" : "claude",
    } satisfies IndexedSessionLocation, presence, authoritativeProviders));

  if (changedPaths.length === 0 && staleRows.length === 0) {
    onProgress?.({ phase: "complete", scanned: 0, total: 0, message: "Up to date" });
    return;
  }

  const totalWork = changedPaths.length + staleRows.length;

  onProgress?.({ phase: "indexing", scanned: 0, total: totalWork, message: "Indexing conversations..." });

  const changedSetFinal = new Set(changedPaths);

  // Process in small chunks to yield the extension host.
  const CHUNK = 8;
  let processed = 0;
  for (let i = 0; i < dedupedMetas.length; i += CHUNK) {
    const chunk = dedupedMetas.slice(i, i + CHUNK);
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const meta of chunk) {
      // Only process sessions whose file changed
      if (!changedSetFinal.has(meta.filePath)) continue;
      processed += 1;

      // Delete old rows for this session
      dbTransaction(() => {
        dbExec("DELETE FROM messages WHERE session_id = ?", [meta.sessionId]);
        dbExec("DELETE FROM file_changes WHERE session_id = ?", [meta.sessionId]);

        // Upsert session metadata
        if (meta.messageCount > 0) {
          const parsed = parsedByPath.get(meta.filePath);
          if (parsed) {
            writeSessionContent(meta.sessionId, parsed.messages, parsed.fileChanges);
            meta.cost = parsed.cost;
          }
        }

        meta.subagentCount = countSubagents(meta.sessionId, meta.filePath);

        // Preserve archived/pinned flags across re-index: INSERT OR REPLACE would
        // otherwise reset them to the scanner defaults every time a session file changes.
        const existing = dbGet(
          "SELECT archived, pinned, file_path FROM sessions WHERE session_id = ?",
          [meta.sessionId],
        );
        if (existing) {
          // A Codex archive/unarchive moves the rollout. In that case the
          // source directory is authoritative; otherwise preserve the user's
          // local archive flag across ordinary appends.
          if (meta.provider === "codex" && isCodexArchivedSessionPath(meta.filePath)) {
            meta.archived = true;
          } else if (meta.provider !== "codex" || String(existing.file_path) === meta.filePath) {
            meta.archived = Number(existing.archived ?? 0) === 1;
          }
          meta.pinned = Number(existing.pinned ?? 0) === 1;
        }

        dbExec(
          `INSERT OR REPLACE INTO sessions (${SESSION_COLUMNS}) VALUES (${SESSION_PLACEHOLDERS})`,
          sessionToRow(meta),
        );
      });

      // Update project tracking
      if (meta.projectPath) {
        dbExec(
          "INSERT OR REPLACE INTO projects (path, name, last_activity) VALUES (?, ?, ?)",
          [meta.projectPath, meta.projectName, meta.updatedAt || meta.createdAt],
        );
      }
    }

    onProgress?.({ phase: "indexing", scanned: processed, total: totalWork });
  }

  // Remove stale sessions (files no longer on disk)
  for (const row of staleRows) {
    const sessionId = String(row.session_id);
    dbTransaction(() => {
      dbExec("DELETE FROM messages WHERE session_id = ?", [sessionId]);
      dbExec("DELETE FROM file_changes WHERE session_id = ?", [sessionId]);
      dbExec("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
    });
    processed += 1;
  }
  onProgress?.({ phase: "indexing", scanned: processed, total: totalWork });

  // Projects are derived. Remove rows whose last session disappeared without
  // clearing the table (which would make a failed rebuild destructive).
  dbExec(
    "DELETE FROM projects WHERE path NOT IN (SELECT DISTINCT project_path FROM sessions WHERE project_path != '')",
    [],
  );

  // Update schema version
  dbExec(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
    [String(SCHEMA_VERSION)],
  );
  dbExec(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_index_time', ?)",
    [new Date().toISOString()],
  );

  onProgress?.({ phase: "complete", scanned: totalWork, total: totalWork, message: "Index complete" });
}

/** Write pre-parsed messages + file_changes for a changed session (cost is already known from the parse). */
function writeSessionContent(
  sessionId: string,
  messages: NormalizedMessage[],
  fileChanges: FileChange[],
): void {
  const db = getDb();
  const insMsg = db.prepare(
    `INSERT OR REPLACE INTO messages (session_id, uuid, parent_uuid, role, entry_type, ts, ordinal, search_text, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFc = db.prepare(
    `INSERT INTO file_changes (${FILE_CHANGE_COLUMNS}) VALUES (${FILE_CHANGE_PLACEHOLDERS})`,
  );

  for (const msg of messages) {
    // Collect searchable text from all text parts
    const searchParts: string[] = [];
    for (const part of msg.parts) {
      if (part.kind === "text") searchParts.push(part.text);
      else if (part.kind === "tool_use") {
        // Make tool calls + their input searchable
        searchParts.push(part.name);
        const filePath = part.input?.file_path;
        if (typeof filePath === "string") searchParts.push(filePath);
        try {
          searchParts.push(
            JSON.stringify(part.input, truncatingReplacer).slice(0, SEARCH_FRAGMENT_MAX_CHARS),
          );
        } catch {
          // Parsed JSONL inputs should be serializable; skip a malformed value.
        }
      } else if (part.kind === "tool_result") {
        searchParts.push(part.text.slice(0, 2000)); // cap per-message tool output
      }
    }
    const searchText = searchParts.join(" \n ");

    insMsg.run([
      sessionId,
      `${sessionId}-${msg.index}`,  // synthetic UUID
      null,
      msg.role,
      null,
      msg.timestamp ?? null,
      msg.index,
      searchText,
      msg.inputTokens ?? null,
      msg.outputTokens ?? null,
      msg.cacheCreationTokens ?? null,
      msg.cacheReadTokens ?? null,
      msg.model ?? null,
    ]);
  }

  for (const fc of fileChanges) {
    insFc.run(fileChangeToRow(fc));
  }

  insMsg.free();
  insFc.free();
}

/** Rebuild the entire search index from scratch (scan all files). */
export function reindexAll(
  roots: HistoryRoots,
  maxFileSizeBytes: number,
  onProgress?: IndexerCallback,
): Promise<void> {
  return enqueueIndex(() => incrementalIndexNow(roots, maxFileSizeBytes, onProgress, true));
}
