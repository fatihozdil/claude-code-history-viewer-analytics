import type { FileChange, FileOperation, NormalizedMessage } from "../claude/types.js";
import type { CodexEntry } from "./types.js";

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function countLines(value: unknown): number {
  return typeof value === "string" && value !== "" ? value.split("\n").length : 0;
}

function diffLineCounts(diff: unknown): { added: number; removed: number } {
  if (typeof diff !== "string") return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function operationOf(changeType: unknown): FileOperation {
  return typeof changeType === "string" && changeType.toLowerCase() === "add"
    ? "Write"
    : "Edit";
}

function nearestMessageIndex(
  messages: NormalizedMessage[],
  timestamp: string | undefined,
): number {
  if (messages.length === 0) return 0;
  if (!timestamp) return messages[messages.length - 1].index;
  let nearest = messages[0].index;
  for (const message of messages) {
    if (message.timestamp && message.timestamp > timestamp) break;
    nearest = message.index;
  }
  return nearest;
}

/** Extract Codex's structured patch-application events for impact summaries. */
export function extractCodexFileChanges(
  entries: CodexEntry[],
  messages: NormalizedMessage[],
  sessionId: string,
): FileChange[] {
  const fileChanges: FileChange[] = [];

  for (const entry of entries) {
    if (entry.type !== "event_msg") continue;
    const payload = recordOf(entry.payload);
    if (!payload || payload.type !== "patch_apply_end" || payload.success === false) continue;
    const changes = recordOf(payload.changes);
    if (!changes) continue;

    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const messageIndex = nearestMessageIndex(messages, timestamp);
    for (const [filePath, rawChange] of Object.entries(changes)) {
      if (filePath === "") continue;
      const change = recordOf(rawChange) ?? {};
      const changeType = change.type ?? change.operation;
      const operation = operationOf(changeType);
      let { added, removed } = diffLineCounts(
        change.unified_diff ?? change.diff ?? change.patch,
      );

      if (added === 0 && removed === 0) {
        const contentLines = countLines(change.content);
        const kind = typeof changeType === "string" ? changeType.toLowerCase() : "";
        if (kind === "delete") removed = contentLines;
        else if (kind === "add") added = contentLines;
      }

      fileChanges.push({
        sessionId,
        filePath,
        operation,
        timestamp,
        messageIndex,
        linesAdded: added,
        linesRemoved: removed,
      });
    }
  }

  return fileChanges;
}
