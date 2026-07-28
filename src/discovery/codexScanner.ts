import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseCodexJsonl } from "../codex/jsonl.js";
import {
  codexArchivedSessionsDir,
  codexSessionsDir,
} from "./paths.js";

export interface CodexScanOptions {
  knownMtimes?: ReadonlyMap<string, number>;
  /** native_session_id per file_path, sourced from the DB, used to resolve title-index updates for unchanged files. */
  knownNativeSessionIds?: ReadonlyMap<string, string>;
}

/** Cheap, stat-only listing of a Codex rollout file. No rollout content is read here. */
export interface CodexFileEntry {
  filePath: string;
  archived: boolean;
  /** max(file mtime, session_index updated_at), with the incomplete-title-index fallback. */
  mtimeMs: number;
  sizeBytes: number;
  /** Session id derived from the filename, used when the file's own id can't be parsed. */
  fallbackNativeSessionId: string;
}

export interface CodexScanResult {
  files: CodexFileEntry[];
  changedPaths: string[];
  titleBySessionId: Map<string, string>;
  complete: boolean;
}

const UUID_AT_END_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function nativeSessionIdFromFilePath(filePath: string): string {
  const fileName = path.basename(filePath);
  return UUID_AT_END_RE.exec(fileName)?.[1] ?? path.basename(fileName, ".jsonl");
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function listJsonlRecursively(rootDir: string): Promise<{ files: string[]; complete: boolean }> {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    return { files: [], complete: isNotFound(error) };
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  let complete = true;
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listJsonlRecursively(entryPath);
      files.push(...nested.files);
      complete &&= nested.complete;
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return { files, complete };
}

interface SessionTitleIndex {
  titles: Map<string, string>;
  updatedAtMs: Map<string, number>;
  complete: boolean;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Small, dedicated title index file — reading it here (not the rollouts) is the sole scanner-side exception. */
async function readSessionTitles(codexDirPath: string): Promise<SessionTitleIndex> {
  let text: string;
  try {
    text = await fs.readFile(path.join(codexDirPath, "session_index.jsonl"), "utf8");
  } catch (error) {
    return { titles: new Map(), updatedAtMs: new Map(), complete: isNotFound(error) };
  }

  const titles = new Map<string, string>();
  const updatedAtMs = new Map<string, number>();
  for (const entry of parseCodexJsonl(text)) {
    const id = typeof entry.id === "string" ? entry.id : "";
    const title = typeof entry.thread_name === "string" ? entry.thread_name.trim() : "";
    if (id !== "" && title !== "") {
      titles.set(id, title);
      updatedAtMs.set(id, timestampMs(entry.updated_at));
    }
  }
  return { titles, updatedAtMs, complete: true };
}

function effectiveMtime(
  filePath: string,
  fileMtimeMs: number,
  nativeSessionId: string,
  titleIndex: SessionTitleIndex,
  knownMtimes: ReadonlyMap<string, number> | undefined,
): number {
  const fromSources = Math.max(
    fileMtimeMs,
    titleIndex.updatedAtMs.get(nativeSessionId) ?? 0,
  );
  if (titleIndex.complete) return fromSources;
  return Math.max(fromSources, knownMtimes?.get(filePath) ?? 0);
}

/**
 * Recursively enumerate active and natively archived Codex rollout files.
 * Stat-only: rollout contents are never read here (only the small session_index.jsonl is).
 */
export async function scanCodexSessions(
  codexDirPath: string,
  opts: CodexScanOptions = {},
): Promise<CodexScanResult> {
  const titleIndex = await readSessionTitles(codexDirPath);
  const titleBySessionId = titleIndex.titles;
  const roots = [
    { dir: codexSessionsDir(codexDirPath), archived: false },
    { dir: codexArchivedSessionsDir(codexDirPath), archived: true },
  ];

  const files: CodexFileEntry[] = [];
  const changedPaths: string[] = [];
  let complete = titleIndex.complete;

  for (const root of roots) {
    const listing = await listJsonlRecursively(root.dir);
    complete &&= listing.complete;
    for (const filePath of listing.files) {
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if (!isNotFound(error)) complete = false;
        continue;
      }

      const mtimeMs = stat.mtimeMs;
      const fallbackNativeSessionId = nativeSessionIdFromFilePath(filePath);
      // Prefer the real native session id known from the DB (survives filename/content
      // mismatches from forked/renamed rollouts); fall back to the filename-derived id
      // for files the DB doesn't know about yet — those count as changed regardless.
      const nativeSessionId = opts.knownNativeSessionIds?.get(filePath) ?? fallbackNativeSessionId;

      const effectiveMtimeMs = effectiveMtime(filePath, mtimeMs, nativeSessionId, titleIndex, opts.knownMtimes);
      if (opts.knownMtimes?.get(filePath) !== effectiveMtimeMs) changedPaths.push(filePath);

      files.push({
        filePath,
        archived: root.archived,
        mtimeMs: effectiveMtimeMs,
        sizeBytes: stat.size,
        fallbackNativeSessionId,
      });
    }
  }

  return { files, changedPaths, titleBySessionId, complete };
}
