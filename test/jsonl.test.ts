import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonl } from "../src/claude/jsonl.js";

test("parses valid JSONL lines in order", () => {
  const text = '{"type":"user","uuid":"a"}\n{"type":"assistant","uuid":"b"}\n';
  const entries = parseJsonl(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].uuid, "a");
  assert.equal(entries[1].type, "assistant");
});

test("skips blank lines and malformed JSON without throwing", () => {
  const text = '{"uuid":"a"}\n\n   \nnot json{\n{"uuid":"b"}';
  const entries = parseJsonl(text);
  assert.deepEqual(entries.map((e) => e.uuid), ["a", "b"]);
});

test("handles CRLF line endings", () => {
  const text = '{"uuid":"a"}\r\n{"uuid":"b"}\r\n';
  assert.equal(parseJsonl(text).length, 2);
});

test("returns empty array for empty input", () => {
  assert.deepEqual(parseJsonl(""), []);
});
