import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  resolveClaudeDir, resolveCodexDir, projectsDir,
  codexSessionsDir, codexArchivedSessionsDir, decodeProjectDirName,
  isCodexArchivedSessionPath,
} from "../src/discovery/paths.js";

test("resolveClaudeDir uses configured path when set", () => {
  assert.equal(resolveClaudeDir("/custom/.claude", "/home/me"), "/custom/.claude");
});

test("resolveClaudeDir defaults to ~/.claude", () => {
  assert.equal(resolveClaudeDir("", "/home/me"), path.join("/home/me", ".claude"));
});

test("projectsDir joins projects", () => {
  assert.equal(projectsDir("/home/me/.claude"), path.join("/home/me/.claude", "projects"));
});

test("resolveCodexDir uses configured path, then CODEX_HOME, then ~/.codex", () => {
  assert.equal(resolveCodexDir("/custom/codex", "/home/me", "/env/codex"), "/custom/codex");
  assert.equal(resolveCodexDir("", "/home/me", "/env/codex"), "/env/codex");
  assert.equal(resolveCodexDir("", "/home/me", undefined), path.join("/home/me", ".codex"));
});

test("Codex session directories resolve below the configured root", () => {
  assert.equal(codexSessionsDir("/codex"), path.join("/codex", "sessions"));
  assert.equal(codexArchivedSessionsDir("/codex"), path.join("/codex", "archived_sessions"));
});

test("detects native Codex archive paths without matching an ancestor name", () => {
  assert.equal(isCodexArchivedSessionPath("/home/me/.codex/archived_sessions/rollout.jsonl"), true);
  assert.equal(isCodexArchivedSessionPath("/home/archived_sessions/.codex/sessions/2026/rollout.jsonl"), false);
});

test("decodeProjectDirName reconstructs a plausible path", () => {
  assert.equal(decodeProjectDirName("-Users-me-proj"), "/Users/me/proj");
});
