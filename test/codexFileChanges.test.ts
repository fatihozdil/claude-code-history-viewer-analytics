import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCodexFileChanges } from "../src/codex/fileChanges.js";
import type { CodexEntry } from "../src/codex/types.js";
import type { NormalizedMessage } from "../src/claude/types.js";

test("extracts successful Codex patch events and unified-diff impact", () => {
  const entries: CodexEntry[] = [{
    type: "event_msg",
    timestamp: "2026-07-01T10:00:03Z",
    payload: {
      type: "patch_apply_end",
      success: true,
      changes: {
        "/repo/new.ts": {
          type: "add",
          unified_diff: "--- /dev/null\n+++ b/new.ts\n+one\n+two",
        },
        "/repo/old.ts": {
          type: "update",
          unified_diff: "--- a/old.ts\n+++ b/old.ts\n-old\n+new",
        },
      },
    },
  }];
  const messages: NormalizedMessage[] = [{
    index: 4,
    role: "assistant",
    timestamp: "2026-07-01T10:00:02Z",
    parts: [{ kind: "text", text: "Applying the patch" }],
  }];

  const changes = extractCodexFileChanges(entries, messages, "codex:thread");
  assert.deepEqual(changes.map(({ filePath, operation, linesAdded, linesRemoved, messageIndex }) => ({
    filePath, operation, linesAdded, linesRemoved, messageIndex,
  })), [
    { filePath: "/repo/new.ts", operation: "Write", linesAdded: 2, linesRemoved: 0, messageIndex: 4 },
    { filePath: "/repo/old.ts", operation: "Edit", linesAdded: 1, linesRemoved: 1, messageIndex: 4 },
  ]);
});

test("ignores failed or unrelated Codex events", () => {
  const changes = extractCodexFileChanges([{
    type: "event_msg",
    payload: { type: "patch_apply_end", success: false, changes: { "/repo/a": { type: "add" } } },
  }, {
    type: "world_state",
    payload: { changes: { "/repo/b": { type: "add" } } },
  }], [], "codex:thread");
  assert.deepEqual(changes, []);
});
