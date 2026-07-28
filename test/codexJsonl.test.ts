import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "../src/codex/jsonl.js";

test("parseCodexJsonl preserves valid rollout entries in order", () => {
  const text = [
    { type: "session_meta", timestamp: "2026-07-01T10:00:00Z", payload: { id: "one" } },
    { type: "event_msg", timestamp: "2026-07-01T10:00:01Z", payload: { type: "user_message" } },
  ].map((entry) => JSON.stringify(entry)).join("\n");

  const entries = parseCodexJsonl(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, "session_meta");
  assert.equal(entries[1].type, "event_msg");
});

test("parseCodexJsonl tolerates a partial malformed final line", () => {
  const text = '{"type":"session_meta","payload":{"id":"one"}}\n'
    + '{"type":"event_msg","payload":{"type":"user_message"';

  const entries = parseCodexJsonl(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "session_meta");
});

test("parseCodexJsonl skips blank lines, primitives, and arrays", () => {
  const entries = parseCodexJsonl('\n42\n[]\n{"type":"world_state"}\n');
  assert.deepEqual(entries.map((entry) => entry.type), ["world_state"]);
});
