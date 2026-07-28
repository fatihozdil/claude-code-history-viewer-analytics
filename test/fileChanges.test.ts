import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFileChanges, countLines } from "../src/claude/fileChanges.js";
import type { NormalizedMessage } from "../src/claude/types.js";

const messages: NormalizedMessage[] = [
  { index: 0, role: "assistant", timestamp: "t0", parts: [
    { kind: "tool_use", id: "1", name: "Read", input: { file_path: "/p/a.ts" } },
    { kind: "tool_use", id: "2", name: "Edit", input: { file_path: "/p/b.ts" } },
  ] },
  { index: 1, role: "assistant", timestamp: "t1", parts: [
    { kind: "tool_use", id: "3", name: "Bash", input: { command: "ls" } },
    { kind: "tool_use", id: "4", name: "Write", input: { file_path: "/p/c.ts" } },
    { kind: "tool_use", id: "5", name: "Read", input: {} },
  ] },
];

test("extracts only file tool calls with a file_path", () => {
  const changes = extractFileChanges(messages, "s1");
  assert.deepEqual(changes.map((c) => [c.operation, c.filePath, c.messageIndex]), [
    ["Read", "/p/a.ts", 0],
    ["Edit", "/p/b.ts", 0],
    ["Write", "/p/c.ts", 1],
  ]);
  assert.equal(changes[0].sessionId, "s1");
  assert.equal(changes[2].timestamp, "t1");
});

test("countLines counts newline-separated segments, 0 for empty", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\nb\nc"), 3);
});

test("Edit records added and removed line counts", () => {
  const msgs: NormalizedMessage[] = [{
    index: 0, role: "assistant", parts: [{
      kind: "tool_use", id: "1", name: "Edit",
      input: { file_path: "/f.ts", old_string: "x\ny", new_string: "x\ny\nz" },
    }],
  }];
  const [c] = extractFileChanges(msgs, "s1");
  assert.equal(c.linesRemoved, 2);
  assert.equal(c.linesAdded, 3);
});

test("Write counts content as added, nothing removed", () => {
  const msgs: NormalizedMessage[] = [{
    index: 0, role: "assistant", parts: [{
      kind: "tool_use", id: "1", name: "Write",
      input: { file_path: "/f.ts", content: "a\nb\nc\nd" },
    }],
  }];
  const [c] = extractFileChanges(msgs, "s1");
  assert.equal(c.linesAdded, 4);
  assert.equal(c.linesRemoved, 0);
});

test("MultiEdit sums all edits", () => {
  const msgs: NormalizedMessage[] = [{
    index: 0, role: "assistant", parts: [{
      kind: "tool_use", id: "1", name: "MultiEdit",
      input: { file_path: "/f.ts", edits: [
        { old_string: "a", new_string: "a\nb" },
        { old_string: "c\nd", new_string: "c" },
      ] },
    }],
  }];
  const [c] = extractFileChanges(msgs, "s1");
  assert.equal(c.linesAdded, 3);   // 2 + 1
  assert.equal(c.linesRemoved, 3); // 1 + 2
});
