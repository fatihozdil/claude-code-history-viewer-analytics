import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface CodexUsage {
  primaryRemainingPct: number;
  primaryWindowMinutes?: number;
  primaryResetsAt?: number;
  /** Undefined when Codex has not reported the secondary window yet. */
  secondaryRemainingPct?: number;
  secondaryWindowMinutes?: number;
  secondaryResetsAt?: number;
  sourcePath: string;
}

/** Reads Codex CLI's rate-limit snapshot embedded in token_count events. */
export async function readCodexUsage(codexDir: string): Promise<CodexUsage | null> {
  let files: string[];
  try { files = await jsonlFiles(path.join(codexDir, "sessions")); } catch { return null; }
  let best: CodexUsage | null = null;
  let newest = -Infinity;
  for (const file of files) {
    try {
      const lines = (await fs.readFile(file, "utf8")).trimEnd().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const row = JSON.parse(lines[i]) as { timestamp?: string; payload?: { type?: string; rate_limits?: any } };
        const limits = row.payload?.rate_limits;
        if (row.payload?.type !== "token_count" || !limits?.primary || typeof limits.primary.used_percent !== "number") continue;
        const timestamp = Date.parse(row.timestamp ?? "") || 0;
        if (timestamp < newest) break;
        newest = timestamp;
        best = {
          primaryRemainingPct: Math.max(0, 100 - limits.primary.used_percent),
          ...(typeof limits.primary.window_minutes === "number" ? { primaryWindowMinutes: limits.primary.window_minutes } : {}),
          ...(typeof limits.primary.resets_at === "number" ? { primaryResetsAt: limits.primary.resets_at } : {}),
          ...(typeof limits.secondary?.used_percent === "number" ? { secondaryRemainingPct: Math.max(0, 100 - limits.secondary.used_percent) } : {}),
          ...(typeof limits.secondary?.window_minutes === "number" ? { secondaryWindowMinutes: limits.secondary.window_minutes } : {}),
          ...(typeof limits.secondary?.resets_at === "number" ? { secondaryResetsAt: limits.secondary.resets_at } : {}),
          sourcePath: file,
        };
        break;
      }
    } catch { /* tolerate active/partial rollouts */ }
  }
  return best;
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await jsonlFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(file);
  }
  return out;
}
