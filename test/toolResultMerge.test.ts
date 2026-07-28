import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeToolResults } from "../src/services/toolResultMerge.js";
import type { SerializedMessage } from "../src/services/toolResultMerge.js";

test("attaches a matching tool_result onto its tool_use part and drops the now-empty message", () => {
  const messages: SerializedMessage[] = [
    {
      index: 0,
      role: "assistant",
      parts: [
        { kind: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      index: 1,
      role: "user",
      parts: [
        { kind: "tool_result", toolUseId: "t1", text: "file.txt", isError: false },
      ],
    },
  ];

  const result = mergeToolResults(messages);

  assert.equal(result.length, 1);
  assert.equal(result[0].index, 0);
  const toolUse = result[0].parts[0] as any;
  assert.equal(toolUse.kind, "tool_use");
  assert.deepEqual(toolUse.result, { text: "file.txt", isError: false, index: 1 });
});

test("pairs multiple parallel tool_use/tool_result parts by id and drops the result message", () => {
  const messages: SerializedMessage[] = [
    {
      index: 0,
      role: "assistant",
      parts: [
        { kind: "tool_use", id: "a", name: "Read", input: { file_path: "/x" } },
        { kind: "tool_use", id: "b", name: "Read", input: { file_path: "/y" } },
      ],
    },
    {
      index: 1,
      role: "user",
      parts: [
        { kind: "tool_result", toolUseId: "b", text: "y contents", isError: false },
        { kind: "tool_result", toolUseId: "a", text: "x contents", isError: false },
      ],
    },
  ];

  const result = mergeToolResults(messages);

  assert.equal(result.length, 1);
  const parts = result[0].parts as any[];
  assert.deepEqual(parts[0].result, { text: "x contents", isError: false, index: 1 });
  assert.deepEqual(parts[1].result, { text: "y contents", isError: false, index: 1 });
});

test("keeps an orphan tool_result (no matching tool_use) standalone, unmodified", () => {
  const messages: SerializedMessage[] = [
    {
      index: 0,
      role: "user",
      parts: [
        { kind: "tool_result", toolUseId: "missing", text: "orphan output", isError: false },
      ],
    },
  ];

  const result = mergeToolResults(messages);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parts, [
    { kind: "tool_result", toolUseId: "missing", text: "orphan output", isError: false },
  ]);
});

test("keeps a tool_use with no result yet (pending) without a result field", () => {
  const messages: SerializedMessage[] = [
    {
      index: 0,
      role: "assistant",
      parts: [{ kind: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 1" } }],
    },
  ];

  const result = mergeToolResults(messages);

  assert.equal(result.length, 1);
  const toolUse = result[0].parts[0] as any;
  assert.equal(toolUse.result, undefined);
});

test("a mixed user message keeps its text part and drops only the matched tool_result part", () => {
  const messages: SerializedMessage[] = [
    {
      index: 0,
      role: "assistant",
      parts: [{ kind: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
    },
    {
      index: 1,
      role: "user",
      parts: [
        { kind: "tool_result", toolUseId: "t1", text: "file.txt", isError: false },
        { kind: "text", text: "thanks!" },
      ],
    },
  ];

  const result = mergeToolResults(messages);

  assert.equal(result.length, 2);
  assert.deepEqual(result[1].parts, [{ kind: "text", text: "thanks!" }]);
  const toolUse = result[0].parts[0] as any;
  assert.deepEqual(toolUse.result, { text: "file.txt", isError: false, index: 1 });
});

test("propagates isError on the merged result", () => {
  const messages: SerializedMessage[] = [
    {
      index: 0,
      role: "assistant",
      parts: [{ kind: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }],
    },
    {
      index: 1,
      role: "user",
      parts: [{ kind: "tool_result", toolUseId: "t1", text: "command failed", isError: true }],
    },
  ];

  const result = mergeToolResults(messages);

  const toolUse = result[0].parts[0] as any;
  assert.deepEqual(toolUse.result, { text: "command failed", isError: true, index: 1 });
});
