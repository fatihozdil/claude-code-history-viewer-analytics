import type { RawEntry } from "./types.js";

/** Parse Claude Code JSONL text into entries, skipping blank/malformed lines. */
export function parseJsonl(text: string): RawEntry[] {
  const entries: RawEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    try {
      entries.push(JSON.parse(line) as RawEntry);
    } catch {
      // Tolerate partial writes / corrupt lines — Claude appends incrementally.
    }
  }
  return entries;
}
