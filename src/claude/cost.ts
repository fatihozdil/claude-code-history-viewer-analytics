import type { RawEntry } from "./types.js";

/** Sum costUSD across entries (top-level or under `message`). Null if absent. */
export function extractCost(entries: RawEntry[]): number | null {
  let total = 0;
  let found = false;
  for (const e of entries) {
    const top = (e as Record<string, unknown>).costUSD;
    if (typeof top === "number") { total += top; found = true; }
    const msg = e.message as Record<string, unknown> | undefined;
    const nested = msg?.costUSD;
    if (typeof nested === "number") { total += nested; found = true; }
  }
  return found ? total : null;
}
