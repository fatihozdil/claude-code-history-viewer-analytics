import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  historyPresence, isStaleSession, resolveSessionCollisions, scanHistory,
} from "../src/discovery/historyScanner.js";

const SHARED_ID = "11111111-1111-4111-8111-111111111111";

test("one history snapshot lists Claude and Codex file entries with the same native id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-sources-"));
  const claudeDir = path.join(root, ".claude");
  const codexDir = path.join(root, ".codex");
  const claudeProject = path.join(claudeDir, "projects", "-repo");
  const codexDay = path.join(codexDir, "sessions", "2026", "07", "01");
  await fs.mkdir(claudeProject, { recursive: true });
  await fs.mkdir(codexDay, { recursive: true });

  await fs.writeFile(path.join(claudeProject, `${SHARED_ID}.jsonl`), JSON.stringify({
    type: "user",
    sessionId: SHARED_ID,
    cwd: "/repo",
    timestamp: "2026-07-01T10:00:00Z",
    message: { role: "user", content: "Claude prompt" },
  }));
  const codexPath = path.join(codexDay, `rollout-2026-07-01T10-00-00-${SHARED_ID}.jsonl`);
  await fs.writeFile(codexPath, [{
    type: "session_meta",
    timestamp: "2026-07-01T10:00:00Z",
    payload: { id: SHARED_ID, cwd: "/repo" },
  }, {
    type: "event_msg",
    timestamp: "2026-07-01T10:00:01Z",
    payload: { type: "user_message", message: "Codex prompt" },
  }].map((entry) => JSON.stringify(entry)).join("\n"));

  const first = await scanHistory({ claudeDir, codexDir });
  assert.equal(first.claudeFiles.length, 1);
  assert.equal(first.codexFiles.length, 1);
  assert.deepEqual([...first.completeProviders].sort(), ["claude", "codex"]);
  assert.equal(first.changedPaths.length, 2);

  const knownMtimes = new Map<string, number>([
    ...first.claudeFiles.map((f): [string, number] => [f.filePath, f.mtimeMs]),
    ...first.codexFiles.map((f): [string, number] => [f.filePath, f.mtimeMs]),
  ]);
  const unchanged = await scanHistory({ claudeDir, codexDir }, { knownMtimes });
  assert.deepEqual(unchanged.changedPaths, []);

  await fs.unlink(codexPath);
  const afterDelete = await scanHistory({ claudeDir, codexDir }, { knownMtimes });
  assert.equal(afterDelete.codexFiles.length, 0);
  assert.equal(afterDelete.claudeFiles.length, 1);
});

test("never reads any session file contents (stat-only across all providers)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-readonly-"));
  const claudeDir = path.join(root, ".claude");
  const codexDir = path.join(root, ".codex");
  const claudeProject = path.join(claudeDir, "projects", "-repo");
  const codexDay = path.join(codexDir, "sessions", "2026", "07", "01");
  await fs.mkdir(claudeProject, { recursive: true });
  await fs.mkdir(codexDay, { recursive: true });
  await fs.writeFile(path.join(claudeProject, `${SHARED_ID}.jsonl`), JSON.stringify({
    type: "user", sessionId: SHARED_ID, cwd: "/repo",
    timestamp: "2026-07-01T10:00:00Z", message: { role: "user", content: "hi" },
  }));
  await fs.writeFile(
    path.join(codexDay, `rollout-2026-07-01T10-00-00-${SHARED_ID}.jsonl`),
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-01T10:00:00Z", payload: { id: SHARED_ID, cwd: "/repo" } }),
  );

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rawFsp = require("node:fs/promises");
  const originalReadFile = rawFsp.readFile;
  const readPaths: string[] = [];
  rawFsp.readFile = (...args: unknown[]) => {
    readPaths.push(String(args[0]));
    return originalReadFile(...args);
  };
  try {
    await scanHistory({ claudeDir, codexDir });
  } finally {
    rawFsp.readFile = originalReadFile;
  }
  // session_index.jsonl (Codex title index) is the sole permitted read; it's optional
  // and absent here, so sql-js style ENOENT resolves without any real file being opened.
  assert.deepEqual(readPaths.filter((p) => !p.endsWith("session_index.jsonl")), []);
});

test("resolveSessionCollisions prefers the active copy, then the newest mtime", () => {
  const base = {
    nativeSessionId: "thread", projectPath: "", projectName: "", title: "",
    createdAt: "", updatedAt: "", messageCount: 0, cost: null,
    pinned: false, parentSessionId: null, subagentCount: 0,
  };
  const archivedOld = { ...base, provider: "codex" as const, sessionId: "codex:thread", filePath: "/archived/old.jsonl", mtimeMs: 5, archived: true };
  const activeNew = { ...base, provider: "codex" as const, sessionId: "codex:thread", filePath: "/active/new.jsonl", mtimeMs: 1, archived: false };
  const resolved = resolveSessionCollisions([archivedOld, activeNew]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].filePath, "/active/new.jsonl");

  const olderActive = { ...base, provider: "codex" as const, sessionId: "codex:thread", filePath: "/active/older.jsonl", mtimeMs: 1, archived: false };
  const newerActive = { ...base, provider: "codex" as const, sessionId: "codex:thread", filePath: "/active/newer.jsonl", mtimeMs: 2, archived: false };
  const resolved2 = resolveSessionCollisions([olderActive, newerActive]);
  assert.equal(resolved2.length, 1);
  assert.equal(resolved2[0].filePath, "/active/newer.jsonl");
});

test("stale pruning keeps moved sessions and rows from incomplete providers", () => {
  const meta = {
    provider: "codex" as const,
    sessionId: "codex:thread",
    nativeSessionId: "thread",
    filePath: "/codex/sessions/new.jsonl",
    projectPath: "",
    projectName: "",
    title: "",
    createdAt: "",
    updatedAt: "",
    mtimeMs: 1,
    messageCount: 0,
    cost: null,
    archived: false,
    pinned: false,
    parentSessionId: null,
    subagentCount: 0,
  };
  const movedRow = {
    provider: "codex" as const,
    sessionId: "codex:thread",
    filePath: "/codex/archived_sessions/old.jsonl",
  };
  const presence = historyPresence([meta]);
  assert.equal(isStaleSession(movedRow, presence, new Set(["codex"])), false);
  assert.equal(isStaleSession(
    { ...movedRow, sessionId: "codex:missing" },
    presence,
    new Set(),
  ), false);
  assert.equal(isStaleSession(
    { ...movedRow, sessionId: "codex:missing" },
    presence,
    new Set(["codex"]),
  ), true);
});
