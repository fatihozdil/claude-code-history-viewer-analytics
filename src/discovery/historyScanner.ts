import type { SessionMeta } from "../claude/types.js";
import { scanCodexSessions, type CodexFileEntry } from "./codexScanner.js";
import { scanAgySessions, type AgyFileEntry } from "./agyScanner.js";
import { projectsDir } from "./paths.js";
import { scanProjects, type ClaudeFileEntry } from "./scanner.js";

export interface HistoryRoots {
  claudeDir: string;
  codexDir: string;
  agyDir?: string;
}

export interface HistoryScanOptions {
  knownMtimes?: Map<string, number>;
  /** native_session_id per file_path, sourced from the DB (Codex effectiveMtime resolution). */
  knownNativeSessionIds?: Map<string, string>;
}

export interface HistoryScanResult {
  claudeFiles: ClaudeFileEntry[];
  codexFiles: CodexFileEntry[];
  agyFiles: AgyFileEntry[];
  /** Codex session titles keyed by native session id, needed to build metas for changed Codex files. */
  titleBySessionId: Map<string, string>;
  changedPaths: string[];
  completeProviders: ReadonlySet<SessionMeta["provider"]>;
}

export interface IndexedSessionLocation {
  sessionId: string;
  filePath: string;
  provider: SessionMeta["provider"];
}

export interface HistoryPresence {
  sessionIds: ReadonlySet<string>;
  filePaths: ReadonlySet<string>;
}

export function historyPresence(metas: readonly SessionMeta[]): HistoryPresence {
  return {
    sessionIds: new Set(metas.map((meta) => meta.sessionId)),
    filePaths: new Set(metas.map((meta) => meta.filePath)),
  };
}

/** Decide whether an indexed row is absent from an authoritative provider scan. */
export function isStaleSession(
  row: IndexedSessionLocation,
  presence: HistoryPresence,
  completeProviders: ReadonlySet<SessionMeta["provider"]>,
): boolean {
  if (!completeProviders.has(row.provider)) return false;
  return !presence.sessionIds.has(row.sessionId) && !presence.filePaths.has(row.filePath);
}

/**
 * Resolve same-session collisions after metas have been assembled (from a fresh parse
 * for changed files, or reconstructed from the DB for unchanged files).
 *
 * A Codex rollout can briefly exist in active and archived locations while it is
 * moving. Prefer the active copy and otherwise the newest file.
 */
export function resolveSessionCollisions(metas: readonly SessionMeta[]): SessionMeta[] {
  const byId = new Map<string, SessionMeta>();
  for (const meta of metas) {
    const previous = byId.get(meta.sessionId);
    if (
      !previous
      || (previous.archived && !meta.archived)
      || (previous.archived === meta.archived && meta.mtimeMs > previous.mtimeMs)
    ) {
      byId.set(meta.sessionId, meta);
    }
  }
  return [...byId.values()];
}

/** Stat-only enumeration of every supported provider, as one snapshot for safe stale-row pruning. */
export async function scanHistory(
  roots: HistoryRoots,
  opts: HistoryScanOptions = {},
): Promise<HistoryScanResult> {
  const [claude, codex, agy] = await Promise.all([
    scanProjects(projectsDir(roots.claudeDir), opts),
    scanCodexSessions(roots.codexDir, opts),
    roots.agyDir
      ? scanAgySessions(roots.agyDir, opts)
      : Promise.resolve({ files: [], changedPaths: [], complete: true }),
  ]);

  const changedPaths = [...new Set([...claude.changedPaths, ...codex.changedPaths, ...agy.changedPaths])];
  const completeProviders = new Set<SessionMeta["provider"]>();
  if (claude.complete) completeProviders.add("claude");
  if (codex.complete) completeProviders.add("codex");
  if (roots.agyDir && agy.complete) completeProviders.add("agy");

  return {
    claudeFiles: claude.files,
    codexFiles: codex.files,
    agyFiles: agy.files,
    titleBySessionId: codex.titleBySessionId,
    changedPaths,
    completeProviders,
  };
}
