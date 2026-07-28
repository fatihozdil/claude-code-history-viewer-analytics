import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgyTranscript } from "../src/agy/session.js";

test("normalizes AGY transcript user, assistant, model and tool calls", () => {
  const text = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-07-12T01:00:00Z", content: "<USER_REQUEST>\nFix it\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (Low). No need.\n</USER_SETTINGS_CHANGE>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-07-12T01:00:01Z", content: "Done", tool_calls: [{ name: "view_file", args: { AbsolutePath: "/tmp/a" } }] },
    { step_index: 2, source: "MODEL", type: "VIEW_FILE", content: "noisy result" },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const { meta, messages } = normalizeAgyTranscript(text, "11111111-1111-4111-8111-111111111111", "/tmp/project");
  assert.equal(meta.provider, "agy");
  assert.equal(meta.sessionId, "agy:11111111-1111-4111-8111-111111111111");
  assert.equal(meta.projectName, "project");
  assert.equal(meta.title, "Fix it");
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  assert.equal(messages[1].model, "Gemini 3.5 Flash (Low)");
  assert.equal(messages[2].parts[0].kind, "tool_use");
});

test("parses custom-title entries from AGY transcript rollouts", () => {
  const text = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-07-12T01:00:00Z", content: "hello" },
    { type: "custom-title", sessionId: "agy-id", customTitle: "My AGY Custom Name" }
  ].map((entry) => JSON.stringify(entry)).join("\n");
  
  const { meta } = normalizeAgyTranscript(text, "agy-id", "/tmp/project");
  assert.equal(meta.title, "My AGY Custom Name");
});

test("uses title from titleBySessionId map if provided in options", () => {
  const text = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-07-12T01:00:00Z", content: "hello" }
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const titleBySessionId = new Map([["agy-id", "External SQLite Name"]]);
  const { meta } = normalizeAgyTranscript(text, "agy-id", "/tmp/project", { titleBySessionId });
  assert.equal(meta.title, "External SQLite Name");
});
