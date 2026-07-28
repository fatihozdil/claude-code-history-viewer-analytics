import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readAgyWorkspaces, scanAgySessions } from "../src/discovery/agyScanner.js";

async function fixture(): Promise<{ root: string; id: string; transcriptPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-scan-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const logs = path.join(root, "brain", id, ".system_generated", "logs");
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(root, "history.jsonl"), JSON.stringify({ conversationId: id, workspace: "/work/app" }));
  const transcriptPath = path.join(logs, "transcript.jsonl");
  await fs.writeFile(transcriptPath, JSON.stringify({ source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-01-01T00:00:00Z", content: "<USER_REQUEST>Hello AGY</USER_REQUEST>" }));
  return { root, id, transcriptPath };
}

test("enumerates AGY transcripts as a stat-only listing", async () => {
  const { root, id, transcriptPath } = await fixture();
  const result = await scanAgySessions(root);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].nativeSessionId, id);
  assert.equal(result.files[0].filePath, transcriptPath);
  assert.ok(result.files[0].sizeBytes > 0);
  assert.equal(result.changedPaths.length, 1);
});

test("never reads transcript file contents", async () => {
  const { root } = await fixture();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rawFsp = require("node:fs/promises");
  const originalReadFile = rawFsp.readFile;
  let readCalls = 0;
  rawFsp.readFile = (...args: unknown[]) => {
    readCalls += 1;
    return originalReadFile(...args);
  };
  try {
    await scanAgySessions(root);
  } finally {
    rawFsp.readFile = originalReadFile;
  }
  assert.equal(readCalls, 0);
});

test("readAgyWorkspaces resolves workspace history separately", async () => {
  const { root, id } = await fixture();
  const workspaces = await readAgyWorkspaces(root);
  assert.equal(workspaces.get(id), "/work/app");
});
