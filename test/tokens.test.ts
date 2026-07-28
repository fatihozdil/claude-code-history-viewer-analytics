import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMessageUsage } from "../src/claude/tokens.js";
import type { RawEntry } from "../src/claude/types.js";

test("returns usage from an assistant entry with full token data", () => {
  const entry: RawEntry = {
    type: "assistant",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 10025,
        cache_creation_input_tokens: 2680,
        cache_read_input_tokens: 8105,
        output_tokens: 583,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    },
  } as unknown as RawEntry;

  const result = extractMessageUsage(entry);
  assert.notEqual(result, null);
  assert.equal(result!.inputTokens, 10025);
  assert.equal(result!.outputTokens, 583);
  assert.equal(result!.cacheCreationTokens, 2680);
  assert.equal(result!.cacheReadTokens, 8105);
  assert.equal(result!.model, "claude-opus-4-8");
});

test("returns null for a user entry", () => {
  const entry: RawEntry = {
    type: "user",
    message: { content: "Hello" },
  } as unknown as RawEntry;

  assert.equal(extractMessageUsage(entry), null);
});

test("returns null when message is missing", () => {
  const entry: RawEntry = { type: "assistant" };
  assert.equal(extractMessageUsage(entry), null);
});

test("returns null when message.usage is missing", () => {
  const entry: RawEntry = {
    type: "assistant",
    message: { model: "claude-sonnet-4-8", content: "Hello" },
  } as unknown as RawEntry;

  assert.equal(extractMessageUsage(entry), null);
});

test("handles assistant entry with usage but no model", () => {
  const entry: RawEntry = {
    type: "assistant",
    message: {
      usage: { input_tokens: 50, output_tokens: 10 },
    },
  } as unknown as RawEntry;

  const result = extractMessageUsage(entry);
  assert.notEqual(result, null);
  assert.equal(result!.inputTokens, 50);
  assert.equal(result!.outputTokens, 10);
  assert.equal(result!.cacheCreationTokens, 0);
  assert.equal(result!.cacheReadTokens, 0);
  assert.equal(result!.model, null);
});

test("handles system entry (non-assistant) returning null", () => {
  const entry: RawEntry = {
    type: "system",
    message: { content: "You are helpful." },
  } as unknown as RawEntry;

  assert.equal(extractMessageUsage(entry), null);
});
