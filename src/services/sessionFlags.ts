import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { dbAll, dbExec, dbGet, writeExternalSqliteTitle } from "../storage/db.js";

/**
 * User-set flags (pinned / archived) are the only state in the DB that cannot be
 * re-derived from the JSONL files on disk. The sql.js database is a whole-file,
 * last-writer-wins cache shared across every VS Code window via globalStorage —
 * so any window flushing its (stale) in-memory snapshot can clobber a flag set
 * in another window. To survive that, the durable source of truth for these
 * flags is `context.globalState` (a per-key, multi-window-coordinated store).
 * The DB columns are kept in sync only so existing list queries keep working,
 * and are re-applied from globalState after every index pass.
 */

const PINNED_KEY = "claudeHistory.pinnedSessions";
const ARCHIVED_KEY = "claudeHistory.archivedSessions";
const UNGROUPED_BRANCHES_KEY = "claudeHistory.ungroupedBranches";

let state: vscode.Memento | null = null;

/** Wire up the durable flag store. Call once during activation, before indexing. */
export function initSessionFlags(globalState: vscode.Memento): void {
  state = globalState;
}

function readSet(key: string): Set<string> {
  const arr = state?.get<string[]>(key) ?? [];
  return new Set(arr);
}

async function writeSet(key: string, set: Set<string>): Promise<void> {
  await state?.update(key, [...set]);
}

async function setFlag(key: string, sessionId: string, on: boolean): Promise<void> {
  const set = readSet(key);
  if (on) set.add(sessionId);
  else set.delete(sessionId);
  await writeSet(key, set);
}

/** Set or clear a session's archived flag (persists to globalState + DB cache). */
export function setArchived(sessionId: string, archived: boolean): void {
  dbExec("UPDATE sessions SET archived = ? WHERE session_id = ?", [archived ? 1 : 0, sessionId]);
  void setFlag(ARCHIVED_KEY, sessionId, archived);
}

/** True if the session is currently archived. */
export function isArchived(sessionId: string): boolean {
  if (state) return readSet(ARCHIVED_KEY).has(sessionId);
  const row = dbGet("SELECT archived FROM sessions WHERE session_id = ?", [sessionId]);
  return row ? Number(row.archived ?? 0) === 1 : false;
}

/** Set or clear a session's pinned flag (persists to globalState + DB cache). */
export function setPinned(sessionId: string, pinned: boolean): void {
  dbExec("UPDATE sessions SET pinned = ? WHERE session_id = ?", [pinned ? 1 : 0, sessionId]);
  void setFlag(PINNED_KEY, sessionId, pinned);
}

/** True if the session is currently pinned. */
export function isPinned(sessionId: string): boolean {
  if (state) return readSet(PINNED_KEY).has(sessionId);
  const row = dbGet("SELECT pinned FROM sessions WHERE session_id = ?", [sessionId]);
  return row ? Number(row.pinned ?? 0) === 1 : false;
}

// ── Dismissed possible forks ───────────────────────────

const DISMISSED_FORKS_KEY = "claudeHistory.dismissedForks";

/**
 * Mark a session as "not a fork" (or undo that). Dismissed sessions are never
 * linked as heuristic fork children. Pure globalState — the link itself is
 * derived at query time, so there is no DB column to sync.
 */
export function setForkDismissed(sessionId: string, dismissed: boolean): void {
  void setFlag(DISMISSED_FORKS_KEY, sessionId, dismissed);
}

/** Session ids the user has marked as "not a fork". */
export function getDismissedForks(): Set<string> {
  return readSet(DISMISSED_FORKS_KEY);
}

// ── Ungrouped branches ──────────────────────────────────────

/**
 * Mark a branch (real forkedFrom link or possible-fork link) as ungrouped —
 * displayed as a standalone top-level item instead of nested under its
 * parent. Pure globalState — grouping is derived at query time, so there is
 * no DB column to sync.
 */
export function setBranchUngrouped(sessionId: string, ungrouped: boolean): void {
  void setFlag(UNGROUPED_BRANCHES_KEY, sessionId, ungrouped);
}

/** Session ids the user has promoted out of their branch group. */
export function getUngroupedBranches(): Set<string> {
  return readSet(UNGROUPED_BRANCHES_KEY);
}

// ── Custom titles ──────────────────────────────────────

const CUSTOM_TITLES_KEY = "claudeHistory.customTitles";

/** Get all custom titles as a { sessionId: title } map. */
export function getCustomTitles(): Record<string, string> {
  if (!state) return {};
  return state.get<Record<string, string>>(CUSTOM_TITLES_KEY) ?? {};
}

/** Set a custom title for a session. Persists to globalState + DB search cache. */
export async function setCustomTitle(sessionId: string, title: string): Promise<void> {
  const titles = { ...getCustomTitles(), [sessionId]: title };
  await state?.update(CUSTOM_TITLES_KEY, titles);
  dbExec("UPDATE sessions SET title = ? WHERE session_id = ?", [title, sessionId]);
}

/**
 * Append a `custom-title` entry to the session's own JSONL file, in the same
 * format the official Claude Code extension writes via its `/branch` command
 * (see src/claude/session.ts). Without this, a rename here only lives in this
 * extension's own globalState/DB cache and the official extension's tab title
 * never picks it up.
 */
export async function writeCustomTitleToSessionFile(
  filePath: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const line = `${JSON.stringify({ type: "custom-title", sessionId, customTitle: title })}\n`;
  await fs.appendFile(filePath, line, "utf8");
}

/**
 * Propagate a rename into Codex's own store. Codex derives the title shown in
 * its resume picker (CLI and the ChatGPT/Codex extension) from the `thread_name`
 * field in `~/.codex/session_index.jsonl`, keyed by the rollout's session `id` —
 * it never reads the Claude-style `custom-title` line. Rewrite the matching
 * entry (or append one if the session isn't indexed yet) so the rename shows up.
 */
export async function writeCodexThreadName(
  codexDir: string,
  nativeSessionId: string,
  title: string,
): Promise<void> {
  const indexPath = path.join(codexDir, "session_index.jsonl");
  let text: string;
  try {
    text = await fs.readFile(indexPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return; // no index yet; nothing the picker reads
    throw err;
  }
  let found = false;
  const out = text.split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.id === nativeSessionId) {
          entry.thread_name = title;
          found = true;
          return JSON.stringify(entry);
        }
      } catch {
        // Preserve any malformed / partially-written line untouched.
      }
      return line;
    });
  if (!found) {
    out.push(JSON.stringify({ id: nativeSessionId, thread_name: title, updated_at: new Date().toISOString() }));
  }
  await fs.writeFile(indexPath, out.join("\n") + "\n", "utf8");
}

/**
 * Propagate a rename into Antigravity's own store. The agy CLI reads its
 * conversation title from the `title` column of `conversation_summaries.db`
 * (keyed by `conversation_id`), not from any transcript line. Update that cell
 * so the agy CLI's own conversation list reflects the rename.
 */
export async function writeAgyConversationTitle(
  agyDir: string,
  conversationId: string,
  title: string,
): Promise<void> {
  const dbPath = path.join(agyDir, "conversation_summaries.db");
  await writeExternalSqliteTitle(dbPath, "conversation_summaries", "conversation_id", "title", conversationId, title);
}

/** Get a custom title for a session, or null if none set. */
export function getCustomTitle(sessionId: string): string | null {
  return getCustomTitles()[sessionId] ?? null;
}

/**
 * Re-apply the durable globalState flags onto the DB cache. Call after every
 * index pass (and on activation) so the rebuildable cache reflects the source
 * of truth, even if another window clobbered the shared DB file.
 */
export function applyFlagsToDb(): void {
  if (!state) return;
  const pinned = readSet(PINNED_KEY);
  const archived = readSet(ARCHIVED_KEY);
  const customTitles = getCustomTitles();
  // Reset every row to the globalState truth (so unpins/unarchives also propagate).
  dbExec("UPDATE sessions SET pinned = 0 WHERE pinned <> 0", []);
  dbExec("UPDATE sessions SET archived = 0 WHERE archived <> 0", []);
  for (const sid of pinned) {
    dbExec("UPDATE sessions SET pinned = 1 WHERE session_id = ?", [sid]);
  }
  for (const sid of archived) {
    dbExec("UPDATE sessions SET archived = 1 WHERE session_id = ?", [sid]);
  }
  for (const [sid, title] of Object.entries(customTitles)) {
    dbExec("UPDATE sessions SET title = ? WHERE session_id = ?", [title, sid]);
  }
}

/**
 * One-time migration: if globalState has no flags yet but the DB already has
 * some (from a prior version that only stored flags in the DB), seed
 * globalState from the DB so existing pins/archives aren't lost on upgrade.
 */
export function seedFlagsFromDbIfEmpty(): void {
  if (!state) return;
  const hasState = (state.get<string[]>(PINNED_KEY)?.length ?? 0) > 0
    || (state.get<string[]>(ARCHIVED_KEY)?.length ?? 0) > 0
    || state.get<boolean>("claudeHistory.flagsSeeded") === true;
  if (hasState) return;
  try {
    const pinnedRows = dbAll("SELECT session_id FROM sessions WHERE pinned = 1")
      .map((r) => String(r.session_id));
    const archivedRows = dbAll("SELECT session_id FROM sessions WHERE archived = 1")
      .map((r) => String(r.session_id));
    void writeSet(PINNED_KEY, new Set(pinnedRows));
    void writeSet(ARCHIVED_KEY, new Set(archivedRows));
  } catch {
    // sessions table may not exist yet; nothing to seed.
  }
  void state.update("claudeHistory.flagsSeeded", true);
}
