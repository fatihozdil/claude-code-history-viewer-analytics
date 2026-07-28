import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeFileChangeRows } from "../src/services/fileChangeService.js";
import type { FileChangeWithBackup } from "../src/services/fileChangeService.js";

function row(overrides: Partial<FileChangeWithBackup>): FileChangeWithBackup {
  return {
    sessionId: "s1",
    filePath: "/p/a.ts",
    operation: "Edit",
    messageIndex: 0,
    linesAdded: 0,
    linesRemoved: 0,
    ...overrides,
  };
}

test("sums lines added/removed across multiple operations on the same file", () => {
  const rows: FileChangeWithBackup[] = [
    row({ filePath: "/p/a.ts", operation: "Edit", messageIndex: 0, linesAdded: 2, linesRemoved: 1 }),
    row({ filePath: "/p/a.ts", operation: "Edit", messageIndex: 3, linesAdded: 5, linesRemoved: 0 }),
  ];
  const [summary] = summarizeFileChangeRows(rows);
  assert.equal(summary.filePath, "/p/a.ts");
  assert.equal(summary.linesAdded, 7);
  assert.equal(summary.linesRemoved, 1);
  assert.equal(summary.lastMessageIndex, 3);
});

test("collects unique operations in first-seen order", () => {
  const rows: FileChangeWithBackup[] = [
    row({ filePath: "/p/a.ts", operation: "Read", messageIndex: 0 }),
    row({ filePath: "/p/a.ts", operation: "Edit", messageIndex: 1, linesAdded: 1 }),
    row({ filePath: "/p/a.ts", operation: "Edit", messageIndex: 2, linesAdded: 1 }),
  ];
  const [summary] = summarizeFileChangeRows(rows);
  assert.deepEqual(summary.operations, ["Read", "Edit"]);
});

test("canDiff is false for Read-only files, true if any modifying op occurred", () => {
  const readOnly = summarizeFileChangeRows([row({ filePath: "/p/a.ts", operation: "Read" })]);
  assert.equal(readOnly[0].canDiff, false);

  const written = summarizeFileChangeRows([row({ filePath: "/p/b.ts", operation: "Write", linesAdded: 3 })]);
  assert.equal(written[0].canDiff, true);
});

test("groups separate files independently and sorts by lastMessageIndex", () => {
  const rows: FileChangeWithBackup[] = [
    row({ filePath: "/p/b.ts", operation: "Write", messageIndex: 5, linesAdded: 4 }),
    row({ filePath: "/p/a.ts", operation: "Edit", messageIndex: 1, linesAdded: 1 }),
  ];
  const result = summarizeFileChangeRows(rows);
  assert.deepEqual(result.map((r) => r.filePath), ["/p/a.ts", "/p/b.ts"]);
});

test("empty input returns empty array", () => {
  assert.deepEqual(summarizeFileChangeRows([]), []);
});
