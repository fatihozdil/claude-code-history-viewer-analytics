import type { CodexEntry } from "./types.js";

/**
 * Parse a Codex rollout JSONL file in order.
 *
 * Rollouts are append-only, so a read can race the writer and observe a
 * partial final line. Malformed lines are skipped instead of rejecting the
 * entire conversation.
 */
export function parseCodexJsonl(text: string): CodexEntry[] {
  const entries: CodexEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        entries.push(value as CodexEntry);
      }
    } catch {
      // Codex can be appending the last line while the history is refreshed.
    }
  }
  return entries;
}
