import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanCodexSessions } from "../src/discovery/codexScanner.js";

const ACTIVE_ID = "11111111-1111-4111-8111-111111111111";
const ARCHIVED_ID = "22222222-2222-4222-8222-222222222222";
const FILE_NAME_ID = "33333333-3333-4333-8333-333333333333";

function rollout(id: string, cwd: string, message: string): string {
  return [
    {
      type: "session_meta",
      timestamp: "2026-07-01T10:00:00Z",
      payload: { id, cwd, model_provider: "openai" },
    },
    {
      type: "event_msg",
      timestamp: "2026-07-01T10:00:01Z",
      payload: { type: "user_message", message },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n");
}

async function fixture(): Promise<{ root: string; activePath: string; archivedPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cch-codex-scan-"));
  const activeDir = path.join(root, "sessions", "2026", "07", "01");
  const archivedDir = path.join(root, "archived_sessions");
  await fs.mkdir(activeDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });

  const activePath = path.join(activeDir, `rollout-2026-07-01T10-00-00-${FILE_NAME_ID}.jsonl`);
  const archivedPath = path.join(archivedDir, `rollout-2026-06-30T10-00-00-${ARCHIVED_ID}.jsonl`);
  await fs.writeFile(activePath, rollout(ACTIVE_ID, "/home/me/active-project", "Active prompt"));
  await fs.writeFile(archivedPath, rollout(ARCHIVED_ID, "/home/me/archived-project", "Archived prompt"));
  await fs.writeFile(
    path.join(root, "session_index.jsonl"),
    `${JSON.stringify({ id: ACTIVE_ID, thread_name: "Named active thread", updated_at: "2026-07-01T10:00:02Z" })}\n{"partial"`,
  );
  return { root, activePath, archivedPath };
}

test("recursively enumerates active and archived Codex rollouts as a stat-only listing", async () => {
  const { root, activePath, archivedPath } = await fixture();
  const result = await scanCodexSessions(root);

  assert.equal(result.files.length, 2);
  assert.equal(result.changedPaths.length, 2);
  assert.equal(result.titleBySessionId.get(ACTIVE_ID), "Named active thread");

  const active = result.files.find((f) => f.filePath === activePath);
  assert.ok(active);
  assert.equal(active.archived, false);
  // The rollout's real session id (ACTIVE_ID) differs from its filename (FILE_NAME_ID);
  // the filename-derived fallback id is still surfaced for the indexer's fallback parse.
  assert.equal(active.fallbackNativeSessionId, FILE_NAME_ID);
  assert.ok(active.mtimeMs > 0);
  assert.ok(active.sizeBytes > 0);

  const archived = result.files.find((f) => f.filePath === archivedPath);
  assert.ok(archived);
  assert.equal(archived.archived, true);
});

test("never reads rollout file contents (only the small session_index.jsonl)", async () => {
  const { root } = await fixture();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rawFsp = require("node:fs/promises");
  const originalReadFile = rawFsp.readFile;
  const readPaths: string[] = [];
  rawFsp.readFile = (...args: unknown[]) => {
    readPaths.push(String(args[0]));
    return originalReadFile(...args);
  };
  try {
    await scanCodexSessions(root);
  } finally {
    rawFsp.readFile = originalReadFile;
  }
  assert.deepEqual(readPaths, [path.join(root, "session_index.jsonl")]);
});

test("returns no changed paths when all Codex mtimes are known", async () => {
  const { root } = await fixture();
  const first = await scanCodexSessions(root);
  const knownMtimes = new Map(first.files.map((f) => [f.filePath, f.mtimeMs]));
  const second = await scanCodexSessions(root, { knownMtimes });
  assert.equal(second.files.length, 2);
  assert.deepEqual(second.changedPaths, []);
});

test("a session_index rename marks only that Codex session changed, given the DB's known native id", async () => {
  const { root, activePath } = await fixture();
  const first = await scanCodexSessions(root);
  const knownMtimes = new Map(first.files.map((f) => [f.filePath, f.mtimeMs]));
  // Once indexed, the DB knows the rollout's real session id (parsed from content),
  // not the filename-derived fallback — this is what lets the effectiveMtime title
  // lookup find the right entry in session_index.jsonl.
  const knownNativeSessionIds = new Map([[activePath, ACTIVE_ID]]);

  await fs.appendFile(path.join(root, "session_index.jsonl"), `\n${JSON.stringify({
    id: ACTIVE_ID,
    thread_name: "Renamed thread",
    updated_at: "2099-01-01T00:00:00Z",
  })}\n`);
  const second = await scanCodexSessions(root, { knownMtimes, knownNativeSessionIds });
  assert.equal(second.changedPaths.length, 1);
  assert.equal(second.changedPaths[0], activePath);
});

test("missing Codex session directories return an empty scan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cch-codex-empty-"));
  const result = await scanCodexSessions(root);
  assert.deepEqual(result, { files: [], changedPaths: [], titleBySessionId: new Map(), complete: true });
});

test("marks a Codex scan incomplete when a session root cannot be enumerated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cch-codex-error-"));
  await fs.writeFile(path.join(root, "sessions"), "not a directory");
  const result = await scanCodexSessions(root);
  assert.equal(result.complete, false);
});
