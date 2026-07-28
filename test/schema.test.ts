import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_SQL, SCHEMA_VERSION, sessionToRow, rowToSession, fileChangeToRow,
} from "../src/storage/schema.js";
import type { SessionMeta } from "../src/claude/types.js";

test("schema creates the three tables idempotently", () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS sessions/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS messages/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS file_changes/);
});

test("session round-trips through row mapping", () => {
  const meta: SessionMeta = {
    sessionId: "s1", nativeSessionId: "s1", provider: "claude",
    projectPath: "/p", projectName: "p", title: "t",
    createdAt: "c", updatedAt: "u", filePath: "/p/s1.jsonl", mtimeMs: 123, messageCount: 4,
    cost: null, archived: false, pinned: false, parentSessionId: null,
    subagentCount: 0,
  };
  const row = sessionToRow(meta);
  const obj = Object.fromEntries(
    ["session_id","native_session_id","provider","project_path","project_name","title","created_at","updated_at","file_path","file_mtime","file_size","message_count","git_branch","version","cost","archived","pinned","parent_session_id","subagent_count"]
      .map((c, i) => [c, row[i]]));
  assert.deepEqual(rowToSession(obj), meta);
});

test("SCHEMA_VERSION is 5", () => {
  assert.equal(SCHEMA_VERSION, 5);
});

test("rowToSession reads cost, archived, and pinned", () => {
  const meta = rowToSession({
    session_id: "codex:s1", native_session_id: "s1", provider: "codex",
    project_path: "/p", project_name: "p", title: "t",
    created_at: "2026-01-01", updated_at: "2026-01-02", file_path: "/f.jsonl",
    file_mtime: 5, message_count: 3, cost: 0.42, archived: 1, pinned: 1,
  });
  assert.equal(meta.cost, 0.42);
  assert.equal(meta.archived, true);
  assert.equal(meta.pinned, true);
  assert.equal(meta.sessionId, "codex:s1");
  assert.equal(meta.nativeSessionId, "s1");
  assert.equal(meta.provider, "codex");
});

test("rowToSession defaults cost null, archived/pinned false", () => {
  const meta = rowToSession({ session_id: "s1", file_path: "/f.jsonl" });
  assert.equal(meta.cost, null);
  assert.equal(meta.archived, false);
  assert.equal(meta.pinned, false);
  assert.equal(meta.subagentCount, 0);
});

test("sessionToRow serializes cost null, archived and pinned flags", () => {
  const row = sessionToRow({
    sessionId: "s1", nativeSessionId: "s1", provider: "claude",
    projectPath: "/p", projectName: "p", title: "t",
    createdAt: "", updatedAt: "", filePath: "/f.jsonl", mtimeMs: 0,
    messageCount: 0, cost: null, archived: true, pinned: true, parentSessionId: null,
    subagentCount: 3,
  });
  assert.equal(row[row.length - 1], 3);    // subagent_count → 3
  assert.equal(row[row.length - 2], null); // parent_session_id → null
  assert.equal(row[row.length - 3], 1);    // pinned → 1
  assert.equal(row[row.length - 4], 1);    // archived → 1
  assert.equal(row[row.length - 5], null); // cost → null
});

test("fileChangeToRow serializes line counts", () => {
  const row = fileChangeToRow({
    sessionId: "s1", filePath: "/f", operation: "Edit",
    timestamp: "", messageIndex: 0, linesAdded: 10, linesRemoved: 3,
  });
  assert.equal(row[row.length - 2], 10); // lines_added
  assert.equal(row[row.length - 1], 3);  // lines_removed
});

test("schema has parent_session_id column", () => {
  assert.match(SCHEMA_SQL, /parent_session_id TEXT/);
});

test("session round-trips parentSessionId null", () => {
  const meta: SessionMeta = {
    sessionId: "s1", nativeSessionId: "s1", provider: "claude",
    projectPath: "/p", projectName: "p", title: "t",
    createdAt: "c", updatedAt: "u", filePath: "/p/s1.jsonl", mtimeMs: 123,
    messageCount: 4, cost: null, archived: false, pinned: false,
    parentSessionId: null, subagentCount: 0,
  };
  const row = sessionToRow(meta);
  const cols = "session_id,native_session_id,provider,project_path,project_name,title,created_at,updated_at,file_path,file_mtime,file_size,message_count,git_branch,version,cost,archived,pinned,parent_session_id,subagent_count".split(",");
  const obj = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
  assert.deepEqual(rowToSession(obj), meta);
});

test("session round-trips parentSessionId string", () => {
  const meta: SessionMeta = {
    sessionId: "s1", nativeSessionId: "s1", provider: "claude",
    projectPath: "/p", projectName: "p", title: "t",
    createdAt: "c", updatedAt: "u", filePath: "/p/s1.jsonl", mtimeMs: 123,
    messageCount: 4, cost: null, archived: false, pinned: false,
    parentSessionId: "parent-123", subagentCount: 0,
  };
  const row = sessionToRow(meta);
  const cols = "session_id,native_session_id,provider,project_path,project_name,title,created_at,updated_at,file_path,file_mtime,file_size,message_count,git_branch,version,cost,archived,pinned,parent_session_id,subagent_count".split(",");
  const obj = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
  assert.equal(rowToSession(obj).parentSessionId, "parent-123");
});
