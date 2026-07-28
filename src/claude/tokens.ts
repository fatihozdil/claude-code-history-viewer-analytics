import type { RawEntry } from "./types.js";

/**
 * Extract token-usage data from a single assistant entry.
 * Returns null for non-assistant entries or when usage data is absent.
 * Model is read from `message.model` (nullable).
 */
export function extractMessageUsage(
  entry: RawEntry,
): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string | null;
} | null {
  if (entry.type !== "assistant") return null;
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return null;
  const usage = (msg as Record<string, unknown>).usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;

  return {
    inputTokens: typeof (usage as Record<string, unknown>).input_tokens === "number"
      ? (usage as Record<string, unknown>).input_tokens as number : 0,
    outputTokens: typeof (usage as Record<string, unknown>).output_tokens === "number"
      ? (usage as Record<string, unknown>).output_tokens as number : 0,
    cacheCreationTokens: typeof (usage as Record<string, unknown>).cache_creation_input_tokens === "number"
      ? (usage as Record<string, unknown>).cache_creation_input_tokens as number : 0,
    cacheReadTokens: typeof (usage as Record<string, unknown>).cache_read_input_tokens === "number"
      ? (usage as Record<string, unknown>).cache_read_input_tokens as number : 0,
    model: typeof (msg as Record<string, unknown>).model === "string"
      ? (msg as Record<string, unknown>).model as string : null,
  };
}
