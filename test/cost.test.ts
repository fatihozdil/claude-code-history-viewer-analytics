import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCost } from "../src/claude/cost.js";
import type { RawEntry } from "../src/claude/types.js";

test("returns null when no costUSD anywhere", () => {
  const entries: RawEntry[] = [
    { type: "assistant", message: { usage: { input_tokens: 5 } } } as unknown as RawEntry,
  ];
  assert.equal(extractCost(entries), null);
});

test("sums costUSD across entries", () => {
  const entries: RawEntry[] = [
    { type: "assistant", costUSD: 0.1 } as RawEntry,
    { type: "assistant", costUSD: 0.25 } as RawEntry,
  ];
  assert.equal(extractCost(entries), 0.35);
});

test("reads costUSD nested under message", () => {
  const entries: RawEntry[] = [
    { type: "assistant", message: { costUSD: 0.5 } } as unknown as RawEntry,
  ];
  assert.equal(extractCost(entries), 0.5);
});
