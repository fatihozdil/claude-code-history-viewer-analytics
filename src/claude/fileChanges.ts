import type { NormalizedMessage, FileChange, FileOperation } from "./types.js";

const FILE_OPS = new Set<FileOperation>(["Read", "Write", "Edit", "MultiEdit"]);

/** Number of newline-separated lines; 0 for empty/non-string. */
export function countLines(text: unknown): number {
  if (typeof text !== "string" || text === "") return 0;
  return text.split("\n").length;
}

function lineDelta(name: FileOperation, input: Record<string, unknown>): { added: number; removed: number } {
  if (name === "Write") return { added: countLines(input.content), removed: 0 };
  if (name === "Edit") return { added: countLines(input.new_string), removed: countLines(input.old_string) };
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let added = 0, removed = 0;
    for (const e of edits as Array<Record<string, unknown>>) {
      added += countLines(e?.new_string);
      removed += countLines(e?.old_string);
    }
    return { added, removed };
  }
  return { added: 0, removed: 0 }; // Read
}

export function extractFileChanges(
  messages: NormalizedMessage[],
  sessionId: string,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool_use") continue;
      if (!FILE_OPS.has(part.name as FileOperation)) continue;
      const filePath = part.input.file_path;
      if (typeof filePath !== "string" || filePath === "") continue;
      const { added, removed } = lineDelta(part.name as FileOperation, part.input);
      changes.push({
        sessionId,
        filePath,
        operation: part.name as FileOperation,
        timestamp: message.timestamp,
        messageIndex: message.index,
        linesAdded: added,
        linesRemoved: removed,
      });
    }
  }
  return changes;
}
