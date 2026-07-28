import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "../src/codex/jsonl.js";
import {
  normalizeCodexSession,
  parseAndNormalizeCodexSession,
} from "../src/codex/session.js";

const OWN_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222222";

const rollout = [
  {
    type: "session_meta",
    timestamp: "2026-07-01T10:00:00Z",
    payload: {
      id: OWN_ID,
      session_id: PARENT_ID,
      cwd: "/home/me/project",
      parent_thread_id: PARENT_ID,
    },
  },
  // Forked/subagent rollouts can contain inherited parent metadata later. The
  // first session_meta belongs to the file itself and must win.
  {
    type: "session_meta",
    timestamp: "2026-07-01T10:00:00Z",
    payload: { id: PARENT_ID, cwd: "/wrong/project" },
  },
  {
    type: "turn_context",
    timestamp: "2026-07-01T10:00:00Z",
    payload: { model: "gpt-test" },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:00Z",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "injected instructions" }],
    },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:01Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "injected environment" }],
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-07-01T10:00:02Z",
    payload: { type: "user_message", message: "Add Codex support" },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:03Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I am working on it." }],
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-07-01T10:00:03Z",
    payload: { type: "agent_message", message: "I am working on it." },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:04Z",
    payload: { type: "reasoning", summary: [] },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:05Z",
    payload: {
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"path":"/home/me/project/a.ts"}',
    },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:06Z",
    payload: {
      type: "function_call_output",
      call_id: "call-1",
      output: [{ type: "text", text: "file contents" }],
    },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:07Z",
    payload: {
      type: "custom_tool_call",
      call_id: "call-2",
      name: "exec",
      input: "git status --short",
    },
  },
  {
    type: "response_item",
    timestamp: "2026-07-01T10:00:08Z",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call-2",
      output: { text: "clean", isError: false },
    },
  },
  {
    type: "world_state",
    timestamp: "2026-07-01T10:00:09Z",
    payload: { full: true },
  },
].map((entry) => JSON.stringify(entry)).join("\n");

test("normalizes clean Codex messages and skips injected or duplicate records", () => {
  const { meta, messages } = normalizeCodexSession(parseCodexJsonl(rollout), "fallback");

  assert.equal(meta.provider, "codex");
  assert.equal(meta.nativeSessionId, OWN_ID);
  assert.equal(meta.sessionId, `codex:${OWN_ID}`);
  assert.equal(meta.projectPath, "/home/me/project");
  assert.equal(meta.projectName, "project");
  assert.equal(meta.title, "Add Codex support");
  assert.equal(meta.createdAt, "2026-07-01T10:00:00Z");
  assert.equal(meta.updatedAt, "2026-07-01T10:00:09Z");

  assert.equal(messages.length, 6);
  assert.deepEqual(messages.map((message) => message.role), [
    "user", "assistant", "assistant", "system", "assistant", "system",
  ]);
  assert.equal((messages[0].parts[0] as any).text, "Add Codex support");
  assert.equal((messages[1].parts[0] as any).text, "I am working on it.");
  assert.equal(messages[1].model, "gpt-test");
  assert.equal(meta.messageCount, messages.length);
});

test("normalizes Codex function and custom tool calls and results", () => {
  const { messages } = parseAndNormalizeCodexSession(rollout, "fallback");

  const functionCall = messages[2].parts[0];
  assert.equal(functionCall.kind, "tool_use");
  assert.equal((functionCall as any).id, "call-1");
  assert.equal((functionCall as any).name, "read_file");
  assert.equal((functionCall as any).input.path, "/home/me/project/a.ts");

  const functionResult = messages[3].parts[0];
  assert.equal(functionResult.kind, "tool_result");
  assert.equal((functionResult as any).toolUseId, "call-1");
  assert.equal((functionResult as any).text, "file contents");
  assert.equal((functionResult as any).isError, false);

  const customCall = messages[4].parts[0];
  assert.equal(customCall.kind, "tool_use");
  assert.equal((customCall as any).input.input, "git status --short");
  const customResult = messages[5].parts[0];
  assert.equal((customResult as any).text, "clean");
});

test("uses session_index title override and native archive state", () => {
  const { meta } = parseAndNormalizeCodexSession(rollout, "fallback", {
    archived: true,
    titleBySessionId: new Map([[OWN_ID, "Named Codex thread"]]),
  });
  assert.equal(meta.title, "Named Codex thread");
  assert.equal(meta.archived, true);
});

test("falls back to the rollout filename id when session metadata is absent", () => {
  const text = JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-01T10:00:00Z",
    payload: { type: "user_message", message: "Hello" },
  });
  const { meta } = parseAndNormalizeCodexSession(text, "fallback-id");
  assert.equal(meta.nativeSessionId, "fallback-id");
  assert.equal(meta.sessionId, "codex:fallback-id");
  assert.equal(meta.projectName, "Unknown project");
});

test("removes rolled-back Codex turns from visible history", () => {
  const text = [
    { type: "event_msg", timestamp: "2026-07-01T10:00:00Z", payload: { type: "user_message", message: "Keep me" } },
    { type: "response_item", timestamp: "2026-07-01T10:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Kept" }] } },
    { type: "event_msg", timestamp: "2026-07-01T10:01:00Z", payload: { type: "user_message", message: "Remove me" } },
    { type: "response_item", timestamp: "2026-07-01T10:01:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Removed" }] } },
    { type: "event_msg", timestamp: "2026-07-01T10:02:00Z", payload: { type: "thread_rolled_back", num_turns: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n");

  const { meta, messages } = parseAndNormalizeCodexSession(text, "fallback");
  assert.deepEqual(messages.map((message) => (message.parts[0] as any).text), ["Keep me", "Kept"]);
  assert.equal(meta.messageCount, 2);
  assert.equal(meta.title, "Keep me");
});

test("attaches cumulative Codex token-count deltas to assistant messages", () => {
  const text = [
    { type: "turn_context", payload: { model: "gpt-5.3-codex" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "one" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } } } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "two" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 180, cached_input_tokens: 50, output_tokens: 40, reasoning_output_tokens: 10 } } } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const { messages } = parseAndNormalizeCodexSession(text, "tokens");
  assert.deepEqual(
    messages.map(({ inputTokens, cacheReadTokens, outputTokens }) => ({ inputTokens, cacheReadTokens, outputTokens })),
    [
      { inputTokens: 60, cacheReadTokens: 40, outputTokens: 25 },
      { inputTokens: 70, cacheReadTokens: 10, outputTokens: 25 },
    ],
  );
});

test("parses custom-title entries from Codex session rollouts", () => {
  const text = [
    { type: "session_meta", payload: { id: "s-codex", cwd: "/project" } },
    { type: "event_msg", payload: { type: "user_message", message: "hello" } },
    { type: "custom-title", sessionId: "s-codex", customTitle: "My Codex Custom Name" }
  ].map((entry) => JSON.stringify(entry)).join("\n");
  
  const { meta } = parseAndNormalizeCodexSession(text, "s-codex");
  assert.equal(meta.title, "My Codex Custom Name");
});
