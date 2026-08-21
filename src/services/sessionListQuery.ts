import type { SessionMeta } from "../claude/types.js";
import { SESSION_COLUMNS, rowToSession } from "../storage/schema.js";
import { dbAll } from "../storage/db.js";
import type { SnippetPart } from "./searchService.js";
import { detectPossibleForks, getUserMessagePrefixes, type ForkCandidate } from "./forkHeuristics.js";
import type { ProviderFilter } from "./providerFilter.js";
import { providerFilterSql } from "./providerFilter.js";

export type SortMode = "newest" | "oldest" | "messages" | "activity" | "cost" | "impact";

export interface SessionListOptions {
  projectPath?: string;
  sort: SortMode;
  showArchived: boolean;
  providerFilter?: ProviderFilter;
}

export interface SessionCard extends SessionMeta {
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  matchOrdinal?: number;
  matchCount?: number;
  matchSnippet?: SnippetPart[];
  branchCount: number;
  subagentCount: number;
  /**
   * Heuristic IDE-fork parent (derived at query time, never stored).
   * Lower-confidence than parentSessionId, which always takes precedence.
   */
  possibleParentId: string | null;
  /** True if the user dismissed a heuristic fork link on this session ("not a fork"). */
  forkDismissed?: boolean;
  /** True if the session is currently promoted out of its branch group. */
  ungrouped?: boolean;
}

const ORDER_BY: Record<SortMode, string> = {
  newest: "updated_at DESC",
  oldest: "updated_at ASC",
  messages: "message_count DESC",
  activity: "file_mtime DESC",
  cost: "cost DESC",
  impact: "(lines_added + lines_removed) DESC",
};

/**
 * Descending cost with SQLite's NULL placement: `ORDER BY cost DESC` puts rows
 * without a recorded cost after every numeric one, so a null must never tie
 * with a real $0 session.
 */
function costDesc(a: number | null, b: number | null): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return b - a;
}

/**
 * In-memory equivalent of `ORDER BY pinned DESC, ORDER_BY[sort], session_id ASC`.
 * Used for result sets that never go through the list query - search results are
 * hydrated by id and would otherwise stay in raw FTS match order.
 */
export function compareBySort(sort: SortMode): (a: SessionCard, b: SessionCard) => number {
  const bySort = (a: SessionCard, b: SessionCard): number => {
    switch (sort) {
      case "oldest": return (a.updatedAt || "").localeCompare(b.updatedAt || "");
      case "messages": return (b.messageCount || 0) - (a.messageCount || 0);
      case "activity": return (b.mtimeMs || 0) - (a.mtimeMs || 0);
      case "cost": return costDesc(a.cost, b.cost);
      case "impact":
        return ((b.linesAdded || 0) + (b.linesRemoved || 0)) - ((a.linesAdded || 0) + (a.linesRemoved || 0));
      default: return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    }
  };
  return (a, b) =>
    Number(b.pinned) - Number(a.pinned) || bySort(a, b) || a.sessionId.localeCompare(b.sessionId);
}

/** Correlated subqueries that derive per-session impact metrics from file_changes. */
const AGGREGATE_COLUMNS = `
      (SELECT COUNT(DISTINCT fc.file_path) FROM file_changes fc
         WHERE fc.session_id = s.session_id AND fc.operation != 'Read') AS files_modified,
      (SELECT COALESCE(SUM(fc.lines_added), 0) FROM file_changes fc
         WHERE fc.session_id = s.session_id) AS lines_added,
      (SELECT COALESCE(SUM(fc.lines_removed), 0) FROM file_changes fc
         WHERE fc.session_id = s.session_id) AS lines_removed`;

/** Title text that should never be used as a session label. */
function isCommandTitle(t: string): boolean {
  return t.startsWith("/") || t.startsWith("<local-command") || t.startsWith("<command-");
}

function rowToCard(row: Record<string, unknown>): SessionCard {
  const session = rowToSession(row);
  // Clean up stale command-derived titles that may still exist in the DB
  // from before normalizeSession() started filtering them at scan time.
  if (isCommandTitle(session.title)) {
    session.title = "Untitled session";
  }
  return {
    ...session,
    filesModified: Number(row.files_modified ?? 0),
    linesAdded: Number(row.lines_added ?? 0),
    linesRemoved: Number(row.lines_removed ?? 0),
    branchCount: Number(row.branch_count ?? 0),
    possibleParentId: null,
  };
}

/** Grouping parent: exact forkedFrom link wins over the heuristic one. */
function effectiveParentId(s: SessionCard, ungrouped: Set<string>): string | null {
  if (ungrouped.has(s.sessionId)) return null;
  return s.parentSessionId ?? s.possibleParentId;
}

export function groupWithBranches(sessions: SessionCard[], ungrouped: Set<string> = new Set()): SessionCard[] {
  const children = new Map<string, SessionCard[]>();
  const roots: SessionCard[] = [];
  const sessionIds = new Set(sessions.map((s) => s.sessionId));

  for (const s of sessions) {
    const parentId = effectiveParentId(s, ungrouped);
    if (parentId && sessionIds.has(parentId)) {
      const arr = children.get(parentId) ?? [];
      arr.push(s);
      children.set(parentId, arr);
    } else {
      roots.push(s);
    }
  }

  // Collect all descendants at any depth (not just direct children)
  function collectAllDescendants(parentId: string): SessionCard[] {
    const direct = children.get(parentId);
    if (!direct) return [];
    const result: SessionCard[] = [];
    for (const child of direct.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      result.push(child);
      result.push(...collectAllDescendants(child.sessionId));
      children.delete(child.sessionId);
    }
    return result;
  }

  const result: SessionCard[] = [];
  for (const root of roots) {
    result.push(root);
    result.push(...collectAllDescendants(root.sessionId));
    children.delete(root.sessionId);
  }

  // Orphaned branches (parent not in current view)
  for (const kids of children.values()) result.push(...kids);

  return result;
}

export function buildSessionListSql(opts: SessionListOptions): { sql: string; params: unknown[] } {
  const cols = SESSION_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ");
  const params: unknown[] = [];
  const where: string[] = ["s.message_count > 0", opts.showArchived ? "s.archived = 1" : "s.archived = 0", providerFilterSql(opts.providerFilter ?? "all")];
  if (opts.projectPath) {
    const sep = opts.projectPath.includes("\\") ? "\\" : "/";
    const escaped = opts.projectPath.replace(/([\\%_])/g, "\\$1");
    const likePattern = escaped + sep + "%";
    where.push("(s.project_path = ? OR s.project_path LIKE ? ESCAPE '\\')");
    params.push(opts.projectPath, likePattern);
  }
  const sql = `
    SELECT ${cols},${AGGREGATE_COLUMNS}
    FROM sessions s
    WHERE ${where.join(" AND ")}
    ORDER BY pinned DESC, ${ORDER_BY[opts.sort]}, s.session_id ASC
  `;
  return { sql, params };
}

// Recompute branchCount: resolve each branch (exact or possible fork) to its
// ultimate root ancestor, then count all descendants at any depth under it.
export function computeBranchCounts(cards: SessionCard[], ungrouped: Set<string> = new Set()): void {
  const resolveRoot = (sessionId: string, seen = new Set<string>()): string | null => {
    if (seen.has(sessionId)) return null; // cycle guard
    seen.add(sessionId);
    const card = cards.find((c) => c.sessionId === sessionId);
    if (!card) return null;
    const parentId = effectiveParentId(card, ungrouped);
    if (!parentId) return sessionId; // reached a root
    return resolveRoot(parentId, seen);
  };

  const rootOf = new Map<string, string>();
  for (const card of cards) {
    const parentId = effectiveParentId(card, ungrouped);
    if (parentId) {
      const root = resolveRoot(parentId);
      if (root) rootOf.set(card.sessionId, root);
    }
  }

  const childCount = new Map<string, number>();
  for (const [, rootId] of rootOf) {
    childCount.set(rootId, (childCount.get(rootId) ?? 0) + 1);
  }
  for (const card of cards) {
    card.branchCount = childCount.get(card.sessionId) ?? 0;
  }
}

/** Attach heuristic IDE-fork links (possibleParentId) to the given cards. */
export function annotatePossibleForks(cards: SessionCard[], dismissedForks?: Set<string>): void {
  const prefixes = getUserMessagePrefixes(cards.map((c) => c.sessionId));
  const candidates: ForkCandidate[] = cards.map((c) => ({
    sessionId: c.sessionId,
    provider: c.provider,
    projectPath: c.projectPath,
    createdAt: c.createdAt,
    messageCount: c.messageCount,
    parentSessionId: c.parentSessionId,
    userPrefix: prefixes.get(c.sessionId) ?? [],
  }));
  const links = detectPossibleForks(candidates, dismissedForks);
  for (const card of cards) {
    card.possibleParentId = links.get(card.sessionId) ?? null;
    card.forkDismissed = dismissedForks?.has(card.sessionId) ?? false;
  }
}

/** Null out display-facing parent links for ungrouped cards (JSONL data untouched). */
export function applyUngrouped(cards: SessionCard[], ungrouped: Set<string>): void {
  for (const card of cards) {
    if (ungrouped.has(card.sessionId)) {
      card.parentSessionId = null;
      card.possibleParentId = null;
      card.ungrouped = true;
    }
  }
}

export function listSessionCards(
  opts: SessionListOptions,
  dismissedForks?: Set<string>,
  ungroupedBranches?: Set<string>,
): SessionCard[] {
  const { sql, params } = buildSessionListSql(opts);
  const flat = dbAll(sql, params).map(rowToCard);
  annotatePossibleForks(flat, dismissedForks);
  const ungrouped = ungroupedBranches ?? new Set<string>();
  const grouped = groupWithBranches(flat, ungrouped);
  computeBranchCounts(grouped, ungrouped);
  applyUngrouped(grouped, ungrouped);
  return grouped;
}

/**
 * Fetch full session cards for an explicit set of ids (used to hydrate search
 * results, which otherwise carry no metadata). Returned in the given id order.
 */
export function getSessionCardsByIds(ids: string[], ungroupedBranches?: Set<string>): SessionCard[] {
  if (ids.length === 0) return [];
  const cols = SESSION_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ");
  const placeholders = ids.map(() => "?").join(", ");
  const sql = `
    SELECT ${cols},${AGGREGATE_COLUMNS}
    FROM sessions s
    WHERE s.session_id IN (${placeholders})
  `;
  const byId = new Map<string, SessionCard>();
  for (const row of dbAll(sql, ids)) {
    const card = rowToCard(row);
    byId.set(card.sessionId, card);
  }
  const cards = ids.map((id) => byId.get(id)).filter((c): c is SessionCard => c != null);
  if (ungroupedBranches) applyUngrouped(cards, ungroupedBranches);
  return cards;
}
