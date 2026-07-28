import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSession } from "../src/claude/session.js";
import { parseJsonl } from "../src/claude/jsonl.js";
import { sessionKey } from "../src/claude/types.js";

const lines = [
  { type: "summary", summary: "Fix the parser bug" },
  { type: "user", sessionId: "s1", cwd: "/home/me/proj", timestamp: "2026-06-01T10:00:00Z",
    message: { role: "user", content: "hello there" } },
  { type: "assistant", timestamp: "2026-06-01T10:00:05Z",
    message: { role: "assistant", content: [
      { type: "text", text: "Reading the file." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/home/me/proj/a.ts" } }
    ] } },
  { type: "user", timestamp: "2026-06-01T10:00:06Z",
    message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "file contents", is_error: false }
    ] } },
].map((o) => JSON.stringify(o)).join("\n");

test("derives meta from entries", () => {
  const { meta } = normalizeSession(parseJsonl(lines), "fallback-id");
  assert.equal(meta.sessionId, "s1");
  assert.equal(meta.nativeSessionId, "s1");
  assert.equal(meta.provider, "claude");
  assert.equal(meta.projectPath, "/home/me/proj");
  assert.equal(meta.projectName, "proj");
  assert.equal(meta.title, "Fix the parser bug");
  assert.equal(meta.createdAt, "2026-06-01T10:00:00Z");
  assert.equal(meta.updatedAt, "2026-06-01T10:00:06Z");
  assert.equal(meta.messageCount, 3);
});

test("falls back to first user text for title when no summary", () => {
  const noSummary = parseJsonl(lines).filter((e) => e.type !== "summary");
  const { meta } = normalizeSession(noSummary, "fallback-id");
  assert.equal(meta.title, "hello there");
});

test("uses fallback id when entries lack sessionId", () => {
  const { meta } = normalizeSession([{ type: "user", message: { content: "hi" } }], "fb");
  assert.equal(meta.sessionId, "fb");
  assert.equal(meta.projectName, "Unknown project");
  assert.equal(meta.title, "hi");
});

test("provider keys cannot collide for the same native session id", () => {
  assert.equal(sessionKey("claude", "same-id"), "same-id");
  assert.equal(sessionKey("codex", "same-id"), "codex:same-id");
  assert.notEqual(sessionKey("claude", "same-id"), sessionKey("codex", "same-id"));
});

test("normalizes content parts including tool_use and tool_result", () => {
  const { messages } = normalizeSession(parseJsonl(lines), "fb");
  assert.equal(messages[0].parts[0].kind, "text");
  const asst = messages[1];
  assert.equal(asst.role, "assistant");
  assert.equal(asst.parts[1].kind, "tool_use");
  assert.equal((asst.parts[1] as any).name, "Read");
  const result = messages[2].parts[0];
  assert.equal(result.kind, "tool_result");
  assert.equal((result as any).text, "file contents");
  assert.equal((result as any).isError, false);
});

test("extracts parentSessionId from forkedFrom field", () => {
  const entries = [
    {
      type: "attachment",
      sessionId: "branch-session",
      cwd: "/home/me/proj",
      timestamp: "2026-06-26T10:00:00Z",
      forkedFrom: { sessionId: "parent-session-id", messageUuid: "abc-123" },
    },
    {
      type: "user",
      sessionId: "branch-session",
      timestamp: "2026-06-26T10:00:01Z",
      message: { role: "user", content: "hello from branch" },
      forkedFrom: { sessionId: "parent-session-id", messageUuid: "abc-456" },
    },
  ];
  const { meta } = normalizeSession(entries, "branch-session");
  assert.equal(meta.parentSessionId, "parent-session-id");
});

test("sets parentSessionId null when no forkedFrom", () => {
  const entries = [
    { type: "user", sessionId: "s1", timestamp: "2026-06-26T10:00:00Z",
      message: { role: "user", content: "hi" } },
  ];
  const { meta } = normalizeSession(entries, "s1");
  assert.equal(meta.parentSessionId, null);
});

test("reads custom-title as session title", () => {
  const entries = [
    { type: "custom-title", customTitle: "test (Branch)", sessionId: "s1" },
    { type: "user", sessionId: "s1", timestamp: "2026-06-26T10:00:00Z",
      message: { role: "user", content: "hello" } },
  ];
  const { meta } = normalizeSession(entries, "s1");
  assert.equal(meta.title, "test (Branch)");
});

test("filters out local-command only messages and ignores them for titles", () => {
  const entries = [
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-06-26T10:00:00Z",
      message: {
        role: "user",
        content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>"
      }
    },
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-06-26T10:00:01Z",
      message: {
        role: "user",
        content: "real user prompt"
      }
    }
  ];
  const { meta, messages } = normalizeSession(entries, "s1");
  assert.equal(meta.title, "real user prompt");
  assert.equal(meta.messageCount, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].parts[0].kind, "text");
  assert.equal((messages[0].parts[0] as any).text, "real user prompt");
});

test("returns 0 messages if session only has local-command messages", () => {
  const entries = [
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-06-26T10:00:00Z",
      message: {
        role: "user",
        content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>"
      }
    }
  ];
  const { meta, messages } = normalizeSession(entries, "s1");
  assert.equal(meta.messageCount, 0);
  assert.equal(messages.length, 0);
});

test("calculates fallback session cost from message token counts and model pricing", () => {
  const entries = [
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-06-26T10:00:00Z",
      message: { role: "user", content: "hello" }
    },
    {
      type: "assistant",
      sessionId: "s1",
      timestamp: "2026-06-26T10:00:01Z",
      message: {
        role: "assistant",
        content: "hi there",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 100_000,
          output_tokens: 200_000,
          cache_creation_input_tokens: 50_000,
          cache_read_input_tokens: 10_000
        }
      }
    }
  ];
  const { meta } = normalizeSession(entries, "s1");
  // Sonnet pricing: input=3/1M, output=15/1M, cacheWrite=3.75/1M, cacheRead=0.3/1M
  // Cost = (100000*3 + 200000*15 + 50000*3.75 + 10000*0.3) / 1000000 = 3.4905
  assert.ok(meta.cost !== null);
  assert.equal(meta.cost.toFixed(4), "3.4905");
});

