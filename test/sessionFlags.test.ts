import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs from "sql.js";
import {
  writeCustomTitleToSessionFile,
  writeCodexThreadName,
  writeAgyConversationTitle,
  initSessionFlags,
  setBranchUngrouped,
  getUngroupedBranches,
} from "../src/services/sessionFlags.js";
import { readExternalSqliteTitles } from "../src/storage/db.js";
import { normalizeSession } from "../src/claude/session.js";
import { parseJsonl } from "../src/claude/jsonl.js";

test("writeCustomTitleToSessionFile appends a custom-title entry the official extension's format can read back", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-flags-test-"));
  const filePath = path.join(dir, "s1.jsonl");
  const existing = [
    { type: "user", sessionId: "s1", cwd: "/home/me/proj", timestamp: "2026-06-01T10:00:00Z",
      message: { role: "user", content: "hello there" } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  await fs.writeFile(filePath, existing, "utf8");

  await writeCustomTitleToSessionFile(filePath, "s1", "Renamed conversation");

  const raw = await fs.readFile(filePath, "utf8");
  const entries = parseJsonl(raw);
  const { meta } = normalizeSession(entries, "s1");
  assert.equal(meta.title, "Renamed conversation");

  await fs.rm(dir, { recursive: true, force: true });
});

test("writeCodexThreadName rewrites the matching thread_name in session_index.jsonl and leaves other lines intact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-index-test-"));
  const indexPath = path.join(dir, "session_index.jsonl");
  const original = [
    { id: "aaa", thread_name: "First task", updated_at: "2026-07-13T00:00:00Z" },
    { id: "bbb", thread_name: "Add test message", updated_at: "2026-07-13T01:00:00Z" },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  await fs.writeFile(indexPath, original, "utf8");

  await writeCodexThreadName(dir, "bbb", "Add test message 1");

  const lines = (await fs.readFile(indexPath, "utf8")).split("\n").filter((l) => l.trim());
  const byId = new Map(lines.map((l) => { const e = JSON.parse(l); return [e.id, e]; }));
  assert.equal(byId.get("aaa").thread_name, "First task", "unrelated line preserved");
  assert.equal(byId.get("bbb").thread_name, "Add test message 1", "renamed line updated");

  await fs.rm(dir, { recursive: true, force: true });
});

test("writeCodexThreadName appends an index entry when the session is not yet indexed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-index-test-"));
  const indexPath = path.join(dir, "session_index.jsonl");
  await fs.writeFile(indexPath, JSON.stringify({ id: "aaa", thread_name: "Existing" }) + "\n", "utf8");

  await writeCodexThreadName(dir, "ccc", "Brand new title");

  const lines = (await fs.readFile(indexPath, "utf8")).split("\n").filter((l) => l.trim());
  const byId = new Map(lines.map((l) => { const e = JSON.parse(l); return [e.id, e.thread_name]; }));
  assert.equal(byId.get("aaa"), "Existing");
  assert.equal(byId.get("ccc"), "Brand new title");

  await fs.rm(dir, { recursive: true, force: true });
});

test("writeAgyConversationTitle updates the title column in conversation_summaries.db", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-db-test-"));
  const dbPath = path.join(dir, "conversation_summaries.db");
  const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
  const seed = new SQL.Database();
  seed.exec(`
    CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "");
    INSERT INTO conversation_summaries (conversation_id, title) VALUES ('conv-1', 'test 1');
    INSERT INTO conversation_summaries (conversation_id, title) VALUES ('conv-2', 'other');
  `);
  await fs.writeFile(dbPath, Buffer.from(seed.export()));
  seed.close();

  await writeAgyConversationTitle(dir, "conv-1", "test again 1");

  const titles = await readExternalSqliteTitles(dbPath, "conversation_summaries", "conversation_id", "title");
  assert.equal(titles.get("conv-1"), "test again 1", "renamed conversation updated");
  assert.equal(titles.get("conv-2"), "other", "unrelated conversation preserved");

  await fs.rm(dir, { recursive: true, force: true });
});

test("setBranchUngrouped persists to globalState and getUngroupedBranches reflects it", () => {
  const store = new Map<string, unknown>();
  const memento = {
    get: (key: string, def?: unknown) => (store.has(key) ? store.get(key) : def),
    update: async (key: string, value: unknown) => { store.set(key, value); },
  } as any;
  initSessionFlags(memento);

  assert.deepEqual(getUngroupedBranches(), new Set());

  setBranchUngrouped("s1", true);
  assert.deepEqual(getUngroupedBranches(), new Set(["s1"]));

  setBranchUngrouped("s2", true);
  assert.deepEqual(getUngroupedBranches(), new Set(["s1", "s2"]));

  setBranchUngrouped("s1", false);
  assert.deepEqual(getUngroupedBranches(), new Set(["s2"]));
});
