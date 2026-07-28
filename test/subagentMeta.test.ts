import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSubagents } from "../src/claude/subagentMeta.js";

function makeTempSubagentsDir(sessionId: string, agents: Array<{ name: string; content: object }>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-test-"));
  const subagentsDir = path.join(tmpDir, sessionId, "subagents");
  fs.mkdirSync(subagentsDir, { recursive: true });
  for (const a of agents) {
    fs.writeFileSync(
      path.join(subagentsDir, `${a.name}.meta.json`),
      JSON.stringify(a.content),
    );
    fs.writeFileSync(path.join(subagentsDir, `${a.name}.jsonl`), "");
  }
  return tmpDir;
}

test("readSubagents returns empty array when no subagents dir", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-test-"));
  const result = readSubagents("no-such-session", path.join(tmpDir, "no-such-session.jsonl"));
  assert.deepEqual(result, []);
});

test("readSubagents reads meta.json files and builds SubagentMeta[]", () => {
  const sessionId = "abc123";
  const tmpDir = makeTempSubagentsDir(sessionId, [
    {
      name: "agent-aaa",
      content: { agentType: "general-purpose", description: "Review code", toolUseId: "tool1", spawnDepth: 1 },
    },
  ]);
  const filePath = path.join(tmpDir, `${sessionId}.jsonl`);
  const result = readSubagents(sessionId, filePath);
  assert.equal(result.length, 1);
  assert.equal(result[0].agentId, "agent-aaa");
  assert.equal(result[0].description, "Review code");
  assert.equal(result[0].agentType, "general-purpose");
  assert.equal(result[0].isFork, false);
  assert.equal(result[0].spawnDepth, 1);
  assert.equal(result[0].jsonlPath, path.join(tmpDir, sessionId, "subagents", "agent-aaa.jsonl"));
});

test("readSubagents handles fork agents", () => {
  const sessionId = "fork-session";
  const tmpDir = makeTempSubagentsDir(sessionId, [
    {
      name: "agent-bbb",
      content: { agentType: "fork", isFork: true, name: "my-fork", description: "do a thing", spawnDepth: 1 },
    },
  ]);
  const filePath = path.join(tmpDir, `${sessionId}.jsonl`);
  const result = readSubagents(sessionId, filePath);
  assert.equal(result[0].isFork, true);
  assert.equal(result[0].agentType, "fork");
});

test("readSubagents skips malformed meta.json files", () => {
  const sessionId = "bad-json";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-test-"));
  const subagentsDir = path.join(tmpDir, sessionId, "subagents");
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(subagentsDir, "agent-broken.meta.json"), "not json");
  const result = readSubagents(sessionId, path.join(tmpDir, `${sessionId}.jsonl`));
  assert.deepEqual(result, []);
});

test("countSubagents returns 0 when no subagents dir", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-test-"));
  const { countSubagents } = await import("../src/claude/subagentMeta.js");
  assert.equal(countSubagents("none", path.join(tmpDir, "none.jsonl")), 0);
});

test("countSubagents counts meta.json files", async () => {
  const sessionId = "count-test";
  const tmpDir = makeTempSubagentsDir(sessionId, [
    { name: "agent-a1", content: { agentType: "general-purpose", description: "a", spawnDepth: 1 } },
    { name: "agent-a2", content: { agentType: "general-purpose", description: "b", spawnDepth: 1 } },
  ]);
  const { countSubagents } = await import("../src/claude/subagentMeta.js");
  assert.equal(countSubagents(sessionId, path.join(tmpDir, `${sessionId}.jsonl`)), 2);
});
