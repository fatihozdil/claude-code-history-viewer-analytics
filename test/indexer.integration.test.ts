import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs from "sql.js";
import { incrementalIndex, reindexAll } from "../src/services/indexer.js";
import { buildAnalytics } from "../src/services/analytics.js";
import { computeQuota } from "../src/services/quota.js";
import { search } from "../src/services/searchService.js";
import { loadConversation } from "../src/services/sessionService.js";
import { closeDb, dbAll, dbExec, initDb } from "../src/storage/db.js";

const ID = "11111111-1111-4111-8111-111111111111";
const REPO_ROOT = path.resolve(__dirname, "../..");

async function fixture(): Promise<{
  root: string;
  claudeDir: string;
  codexDir: string;
  codexPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-indexer-"));
  const claudeDir = path.join(root, ".claude");
  const codexDir = path.join(root, ".codex");
  const claudeProject = path.join(claudeDir, "projects", "-repo");
  const codexDay = path.join(codexDir, "sessions", "2026", "07", "01");
  await fs.mkdir(claudeProject, { recursive: true });
  await fs.mkdir(codexDay, { recursive: true });
  await fs.writeFile(path.join(claudeProject, `${ID}.jsonl`), JSON.stringify({
    type: "user",
    sessionId: ID,
    cwd: "/repo",
    timestamp: "2026-07-01T10:00:00Z",
    message: { role: "user", content: "Claude prompt" },
  }));
  const codexPath = path.join(codexDay, `rollout-2026-07-01T10-00-00-${ID}.jsonl`);
  await fs.writeFile(codexPath, [{
    type: "session_meta",
    timestamp: "2026-07-01T10:00:00Z",
    payload: { id: ID, cwd: "/repo" },
  }, {
    type: "event_msg",
    timestamp: "2026-07-01T10:00:01Z",
    payload: { type: "user_message", message: "Codex prompt" },
  }].map((entry) => JSON.stringify(entry)).join("\n"));
  return { root, claudeDir, codexDir, codexPath };
}

async function openTestDb(root: string): Promise<void> {
  await initDb({
    extensionPath: REPO_ROOT,
    globalStorageUri: { fsPath: path.join(root, "storage") },
  } as any);
}

test("combined index, rebuild, archive move, and deletion preserve provider state", async () => {
  const data = await fixture();
  await openTestDb(data.root);
  try {
    const roots = { claudeDir: data.claudeDir, codexDir: data.codexDir };
    await incrementalIndex(roots, 1024 * 1024);
    assert.deepEqual(
      dbAll("SELECT session_id, provider FROM sessions ORDER BY provider"),
      [{ session_id: ID, provider: "claude" }, { session_id: `codex:${ID}`, provider: "codex" }],
    );
    assert.equal(search({ term: "Codex prompt" })[0]?.sessionId, `codex:${ID}`);
    const loaded = await loadConversation(data.codexPath);
    assert.equal(loaded.meta.provider, "codex");
    assert.equal((loaded.messages[0].parts[0] as any).text, "Codex prompt");
    const analytics = buildAnalytics(computeQuota({
      claudeConfig: {},
      settingsOverrides: { fiveHour: 1, weekly: 1 },
      queryDb: () => ({ total: 0 }),
    }));
    assert.equal(analytics.totals.sessions, 2);
    assert.equal(analytics.totals.messages, 2);

    dbExec("UPDATE sessions SET archived = 1, pinned = 1 WHERE session_id = ?", [`codex:${ID}`]);
    await reindexAll(roots, 1024 * 1024);
    assert.deepEqual(
      dbAll("SELECT archived, pinned FROM sessions WHERE session_id = ?", [`codex:${ID}`])[0],
      { archived: 1, pinned: 1 },
    );
    await closeDb();
    await openTestDb(data.root);
    assert.deepEqual(
      dbAll("SELECT archived, pinned FROM sessions WHERE session_id = ?", [`codex:${ID}`])[0],
      { archived: 1, pinned: 1 },
    );

    const archiveDir = path.join(data.codexDir, "archived_sessions");
    await fs.mkdir(archiveDir, { recursive: true });
    const archivedPath = path.join(archiveDir, path.basename(data.codexPath));
    await fs.rename(data.codexPath, archivedPath);
    await incrementalIndex(roots, 1024 * 1024);
    const moved = dbAll(
      "SELECT file_path, archived, pinned FROM sessions WHERE session_id = ?",
      [`codex:${ID}`],
    );
    assert.deepEqual(moved, [{ file_path: archivedPath, archived: 1, pinned: 1 }]);

    await fs.unlink(archivedPath);
    await incrementalIndex(roots, 1024 * 1024);
    assert.deepEqual(
      dbAll("SELECT session_id FROM sessions ORDER BY session_id"),
      [{ session_id: ID }],
    );
  } finally {
    await closeDb();
  }
});

test("a warm DB performs zero session-file reads when nothing changed, and exactly one read+parse for a changed file", async () => {
  const data = await fixture();
  await openTestDb(data.root);
  try {
    const roots = { claudeDir: data.claudeDir, codexDir: data.codexDir };
    const claudePath = (await fs.readdir(path.join(data.claudeDir, "projects", "-repo")))
      .map((name) => path.join(data.claudeDir, "projects", "-repo", name))[0];

    // Prime the DB (nothing is "known" yet, so this pass parses both files).
    await incrementalIndex(roots, 1024 * 1024);
    assert.equal(
      dbAll("SELECT COUNT(*) AS n FROM sessions")[0]?.n,
      2,
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
      // Nothing on disk changed: incremental pass must not read either session file.
      await incrementalIndex(roots, 1024 * 1024);
      const sessionFileReads = readPaths.filter(
        (p) => p === claudePath || p === data.codexPath,
      );
      assert.deepEqual(sessionFileReads, []);

      // Touch only the Codex file's content: exactly one read+parse of that file,
      // and zero reads of the untouched Claude file.
      readPaths.length = 0;
      await fs.appendFile(data.codexPath, `\n${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-01T10:00:02Z",
        payload: { type: "user_message", message: "Second Codex prompt" },
      })}`);
      await incrementalIndex(roots, 1024 * 1024);
      const codexReads = readPaths.filter((p) => p === data.codexPath);
      const claudeReads = readPaths.filter((p) => p === claudePath);
      assert.equal(codexReads.length, 1);
      assert.equal(claudeReads.length, 0);
    } finally {
      rawFsp.readFile = originalReadFile;
    }
  } finally {
    await closeDb();
  }
});

test("a non-ENOENT read failure on a changed file never prunes its existing row", async () => {
  const data = await fixture();
  await openTestDb(data.root);
  try {
    const roots = { claudeDir: data.claudeDir, codexDir: data.codexDir };
    const claudePath = path.join(data.claudeDir, "projects", "-repo", `${ID}.jsonl`);

    await incrementalIndex(roots, 1024 * 1024);
    assert.equal(dbAll("SELECT COUNT(*) AS n FROM sessions")[0]?.n, 2);

    // Make the Claude file "changed" (future mtime) so the indexer must re-read it,
    // then fail that read with EACCES (not ENOENT: the file still exists on disk).
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(claudePath, future, future);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFsp = require("node:fs/promises");
    const originalReadFile = rawFsp.readFile;
    rawFsp.readFile = (...args: unknown[]) => {
      if (String(args[0]) === claudePath) {
        const err: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        err.code = "EACCES";
        return Promise.reject(err);
      }
      return originalReadFile(...args);
    };
    try {
      await incrementalIndex(roots, 1024 * 1024);
    } finally {
      rawFsp.readFile = originalReadFile;
    }

    // The unreadable-but-existing session must survive the pass.
    assert.deepEqual(
      dbAll("SELECT session_id FROM sessions WHERE provider = 'claude'"),
      [{ session_id: ID }],
    );
  } finally {
    await closeDb();
  }
});

test("reindexAll keeps Codex effectiveMtime bookkeeping so the next incremental pass reads nothing", async () => {
  // Rollout whose filename UUID differs from its content session id, plus a
  // session_index entry (keyed by the content id) with a far-future updated_at.
  const FILE_ID = "44444444-4444-4444-8444-444444444444";
  const CONTENT_ID = "55555555-5555-4555-8555-555555555555";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-force-mtime-"));
  const claudeDir = path.join(root, ".claude");
  const codexDir = path.join(root, ".codex");
  const codexDay = path.join(codexDir, "sessions", "2026", "07", "01");
  await fs.mkdir(path.join(claudeDir, "projects"), { recursive: true });
  await fs.mkdir(codexDay, { recursive: true });
  const rolloutPath = path.join(codexDay, `rollout-2026-07-01T10-00-00-${FILE_ID}.jsonl`);
  await fs.writeFile(rolloutPath, [{
    type: "session_meta",
    timestamp: "2026-07-01T10:00:00Z",
    payload: { id: CONTENT_ID, cwd: "/repo" },
  }, {
    type: "event_msg",
    timestamp: "2026-07-01T10:00:01Z",
    payload: { type: "user_message", message: "Codex prompt" },
  }].map((entry) => JSON.stringify(entry)).join("\n"));
  await fs.writeFile(
    path.join(codexDir, "session_index.jsonl"),
    JSON.stringify({ id: CONTENT_ID, thread_name: "Renamed", updated_at: "2099-01-01T00:00:00Z" }),
  );

  await openTestDb(root);
  try {
    const roots = { claudeDir, codexDir };
    // Prime twice: the second pass settles the stored mtime on the boosted value
    // (the first pass can't know the content id before its one parse).
    await incrementalIndex(roots, 1024 * 1024);
    await incrementalIndex(roots, 1024 * 1024);

    // Force rebuild must preserve the identity/mtime bookkeeping...
    await reindexAll(roots, 1024 * 1024);

    // ...so a follow-up no-op incremental pass reads no session files at all.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFsp = require("node:fs/promises");
    const originalReadFile = rawFsp.readFile;
    const readPaths: string[] = [];
    rawFsp.readFile = (...args: unknown[]) => {
      readPaths.push(String(args[0]));
      return originalReadFile(...args);
    };
    try {
      await incrementalIndex(roots, 1024 * 1024);
    } finally {
      rawFsp.readFile = originalReadFile;
    }
    assert.deepEqual(readPaths.filter((p) => p === rolloutPath), []);
  } finally {
    await closeDb();
  }
});

test("large files get a placeholder meta and are never fully read", async () => {
  const data = await fixture();
  await openTestDb(data.root);
  try {
    const roots = { claudeDir: data.claudeDir, codexDir: data.codexDir };
    const tinyMax = 10; // both fixture files are well over 10 bytes

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFsp = require("node:fs/promises");
    const originalReadFile = rawFsp.readFile;
    const fullReads: string[] = [];
    rawFsp.readFile = (...args: unknown[]) => {
      fullReads.push(String(args[0]));
      return originalReadFile(...args);
    };

    try {
      await incrementalIndex(roots, tinyMax);
    } finally {
      rawFsp.readFile = originalReadFile;
    }

    // The full-file read path must never be taken for oversized files. Codex's
    // small session_index.jsonl title lookup (fs.readFile, ENOENT here) and its
    // 64KB metadata-prefix read (fs.open/handle.read, a separate code path) are
    // both exempt.
    assert.deepEqual(fullReads.filter((p) => !p.endsWith("session_index.jsonl")), []);

    const rows = dbAll("SELECT session_id, title, message_count FROM sessions ORDER BY provider");
    assert.deepEqual(rows, [
      { session_id: ID, title: "(large session — not indexed)", message_count: 0 },
      { session_id: `codex:${ID}`, title: "(large session — not indexed)", message_count: 0 },
    ]);
    assert.deepEqual(dbAll("SELECT * FROM messages"), []);
  } finally {
    await closeDb();
  }
});

test("an incomplete provider scan never prunes its existing rows", async () => {
  const data = await fixture();
  await openTestDb(data.root);
  try {
    const roots = { claudeDir: data.claudeDir, codexDir: data.codexDir };
    await incrementalIndex(roots, 1024 * 1024);
    await fs.unlink(data.codexPath);
    await fs.rm(path.join(data.codexDir, "sessions"), { recursive: true });
    await fs.writeFile(path.join(data.codexDir, "sessions"), "not a directory");
    await incrementalIndex(roots, 1024 * 1024);
    assert.deepEqual(
      dbAll("SELECT session_id FROM sessions WHERE provider = 'codex'"),
      [{ session_id: `codex:${ID}` }],
    );
  } finally {
    await closeDb();
  }
});

test("schema v2 migration preserves flags for reindex and upgrades the schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-migration-"));
  const storage = path.join(root, "storage");
  await fs.mkdir(storage, { recursive: true });
  const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
  const legacy = new SQL.Database();
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '2');
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, project_path TEXT, project_name TEXT, title TEXT,
      created_at TEXT, updated_at TEXT, file_path TEXT NOT NULL,
      file_mtime REAL NOT NULL DEFAULT 0, file_size INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0, git_branch TEXT, version TEXT,
      cost REAL, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (session_id TEXT NOT NULL, uuid TEXT PRIMARY KEY, parent_uuid TEXT,
      role TEXT NOT NULL, entry_type TEXT, ts TEXT, ordinal INTEGER NOT NULL,
      search_text TEXT NOT NULL DEFAULT '', input_tokens INTEGER, output_tokens INTEGER,
      cache_creation_tokens INTEGER, cache_read_tokens INTEGER, model TEXT);
    CREATE TABLE file_changes (session_id TEXT NOT NULL, message_uuid TEXT, file_path TEXT NOT NULL,
      operation TEXT NOT NULL, ts TEXT, msg_index INTEGER NOT NULL DEFAULT 0, backup_ref TEXT,
      lines_added INTEGER NOT NULL DEFAULT 0, lines_removed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, last_activity TEXT);
    INSERT INTO sessions (session_id, file_path, archived, pinned)
      VALUES ('${ID}', '/legacy.jsonl', 1, 1);
  `);
  const legacyRow = legacy.exec("SELECT session_id, archived, pinned FROM sessions")[0];
  assert.deepEqual(legacyRow?.values, [[ID, 1, 1]]);
  const exported = legacy.export();
  await fs.writeFile(path.join(storage, "history.sqlite"), Buffer.from(exported));
  legacy.close();

  await initDb({ extensionPath: REPO_ROOT, globalStorageUri: { fsPath: storage } } as any);
  try {
    assert.deepEqual(dbAll("SELECT value FROM meta WHERE key = 'schema_version'"), [{ value: "5" }]);
    assert.deepEqual(
      dbAll("SELECT session_id, archived, pinned FROM _migration_flags"),
      [{ session_id: ID, archived: 1, pinned: 1 }],
    );
  } finally {
    await closeDb();
  }
});

test("corrupt database is preserved and replaced with a fresh index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-corrupt-"));
  const storage = path.join(root, "storage");
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, "history.sqlite"), Buffer.from("not a sqlite database"));

  await initDb({ extensionPath: REPO_ROOT, globalStorageUri: { fsPath: storage } } as any);
  try {
    assert.deepEqual(dbAll("SELECT value FROM meta WHERE key = 'schema_version'"), [{ value: "5" }]);
    const files = await fs.readdir(storage);
    const backup = files.find((name) => name.startsWith("history.sqlite.corrupt-"));
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(storage, backup), "utf8"), "not a sqlite database");
  } finally {
    await closeDb();
  }
});

test("indexing a tool_use with a multi-MB input string bounds the search fragment and never materializes the full serialization", async () => {
  const data = await fixture();
  await openTestDb(data.root);
  try {
    // 3MB string with a distinctive marker placed AFTER character 2000, so the
    // marker must never survive the truncating serialization.
    const marker = "MARKER_THAT_SHOULD_NOT_APPEAR";
    const largeString =
      "x".repeat(2500) + marker + "y".repeat(3 * 1024 * 1024 - 2500 - marker.length);

    const sessionId = "22222222-2222-4222-8222-222222222222";
    const claudePath = path.join(data.claudeDir, "projects", "-repo", `${sessionId}.jsonl`);
    await fs.writeFile(claudePath, [
      JSON.stringify({
        type: "user",
        sessionId,
        cwd: "/repo",
        timestamp: "2026-07-01T10:00:00Z",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        cwd: "/repo",
        timestamp: "2026-07-01T10:00:01Z",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            name: "edit_file",
            id: "tool1",
            input: { file_path: "/some/file.ts", content: largeString, other_data: "hello" },
          }],
        },
      }),
    ].join("\n"));

    // Spy on JSON.stringify while the indexer runs: the DB output is identical
    // whether or not the fix is present (both are 2000-char prefixes), so the
    // regression is only observable in the size of intermediate serializations.
    // Without the truncating replacer the indexer produces a ~3MB string here.
    const originalStringify = JSON.stringify;
    let maxStringifyLength = 0;
    (JSON as { stringify: typeof JSON.stringify }).stringify = function (
      ...args: Parameters<typeof JSON.stringify>
    ) {
      const out = originalStringify.apply(JSON, args);
      if (typeof out === "string" && out.length > maxStringifyLength) {
        maxStringifyLength = out.length;
      }
      return out;
    } as typeof JSON.stringify;

    const roots = { claudeDir: data.claudeDir, codexDir: data.codexDir };
    try {
      // 16MB cap: the fixture file is ~3MB and must NOT hit the
      // "(large session — not indexed)" placeholder path.
      await incrementalIndex(roots, 16 * 1024 * 1024);
    } finally {
      (JSON as { stringify: typeof JSON.stringify }).stringify = originalStringify;
    }

    // The stored fragment is bounded: tool name + file_path + 2000-char JSON
    // fragment joined with separators — well under 2200 total for this message.
    const rows = dbAll(
      "SELECT search_text FROM messages WHERE role = 'assistant' AND session_id = ?",
      [sessionId],
    );
    assert.equal(rows.length, 1, "expected the assistant tool_use message to be indexed");
    const searchText = String(rows[0].search_text);
    assert.ok(
      searchText.length <= 2200,
      `search_text length ${searchText.length} should be ≤ 2200`,
    );
    assert.ok(
      !searchText.includes(marker),
      "search_text must not contain the marker placed after character 2000",
    );

    // No intermediate serialization during indexing may approach the size of
    // the raw input string: this is what fails if the fix is reverted.
    assert.ok(
      maxStringifyLength < 64 * 1024,
      `largest JSON.stringify output during indexing was ${maxStringifyLength} chars; ` +
        "the full multi-MB tool input was materialized",
    );
  } finally {
    await closeDb();
  }
});
