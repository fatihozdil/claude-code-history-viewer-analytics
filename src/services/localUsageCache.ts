import { readAgyUsage, type AgyUsage } from "../agy/usage.js";
import { readCodexUsage, type CodexUsage } from "../codex/usage.js";
import { TtlCache } from "./ttlCache.js";

/**
 * Codex usage comes from recursively scanning local session JSONL files. That
 * is the costlier of the two reads, and its value only moves while a Codex
 * session is running, so it can be reused for a minute.
 */
export const CODEX_USAGE_TTL_MS = 60_000;

/**
 * Antigravity usage probes local processes and their localhost quota RPC. The
 * number moves faster while a session is active, so it is reused for less time.
 */
export const AGY_USAGE_TTL_MS = 30_000;

const codexUsageCache = new TtlCache<CodexUsage | null>(CODEX_USAGE_TTL_MS);
const agyUsageCache = new TtlCache<AgyUsage | null>(AGY_USAGE_TTL_MS);

/**
 * Codex usage for `codexDir`, reusing the last reading for CODEX_USAGE_TTL_MS.
 * Pass `fresh: true` to bypass the cache (explicit refreshes, periodic polls).
 */
export function readCodexUsageCached(
  codexDir: string,
  opts: { fresh?: boolean } = {},
): Promise<CodexUsage | null> {
  return codexUsageCache.get(codexDir, () => readCodexUsage(codexDir), opts);
}

/**
 * Antigravity usage for `agyDir`, reusing the last reading for AGY_USAGE_TTL_MS.
 * Pass `fresh: true` to bypass the cache (explicit refreshes, periodic polls).
 */
export function readAgyUsageCached(
  agyDir: string,
  opts: { fresh?: boolean } = {},
): Promise<AgyUsage | null> {
  return agyUsageCache.get(agyDir, () => readAgyUsage(agyDir), opts);
}
