import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAnalytics, deepseekUsageSummary } from "../src/services/analytics.js";
import { computeQuota } from "../src/services/quota.js";
import { closeDb, dbExec, initDb } from "../src/storage/db.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

test("DeepSeek analytics includes only DeepSeek model messages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "analytics-scope-"));
  await initDb({ extensionPath: REPO_ROOT, globalStorageUri: { fsPath: path.join(root, "storage") } } as any);
  try {
    dbExec("INSERT INTO sessions (session_id, provider, file_path, project_name, created_at) VALUES (?, 'claude', ?, ?, ?)", ["mixed", "/tmp/mixed.jsonl", "test", "2026-07-12T10:00:00Z"]);
    dbExec("INSERT INTO messages (session_id, uuid, role, ordinal, model, input_tokens, output_tokens) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", ["mixed", "deepseek", 0, "deepseek-v4-pro", 1_000_000, 0]);
    dbExec("INSERT INTO messages (session_id, uuid, role, ordinal, model, input_tokens, output_tokens) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", ["mixed", "claude", 1, "claude-sonnet-4-5", 20_000_000, 0]);
    const quota = computeQuota({ claudeConfig: {}, settingsOverrides: { fiveHour: 1, weekly: 1 }, queryDb: () => ({ total: 0 }) });
    const all = buildAnalytics(quota);
    const deepseek = buildAnalytics(quota, "deepseek");
    const deepseekRow = all.byProvider.find((row) => row.provider === "deepseek");
    assert.equal(deepseekRow?.tokens, 1_000_000);
    assert.equal(deepseek.totals.totalTokens, 1_000_000);
    assert.equal(deepseek.totals.totalCost, 0.435);
  } finally {
    await closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deepseekUsageSummary matches buildAnalytics's deepseek byProvider row on a mixed-provider DB", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "analytics-deepseek-summary-"));
  await initDb({ extensionPath: REPO_ROOT, globalStorageUri: { fsPath: path.join(root, "storage") } } as any);
  try {
    // A Claude session routed partly through DeepSeek.
    dbExec("INSERT INTO sessions (session_id, provider, file_path, project_name, created_at) VALUES (?, 'claude', ?, ?, ?)", ["mixed", "/tmp/mixed.jsonl", "test", "2026-07-12T10:00:00Z"]);
    dbExec("INSERT INTO messages (session_id, uuid, role, ordinal, model, input_tokens, output_tokens) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", ["mixed", "deepseek", 0, "deepseek-v4-pro", 1_000_000, 0]);
    dbExec("INSERT INTO messages (session_id, uuid, role, ordinal, model, input_tokens, output_tokens) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", ["mixed", "claude", 1, "claude-sonnet-4-5", 20_000_000, 0]);
    // A plain Codex session, and a pure Claude session, to make sure other
    // providers don't leak into the DeepSeek aggregate.
    dbExec("INSERT INTO sessions (session_id, provider, file_path, project_name, created_at) VALUES (?, 'codex', ?, ?, ?)", ["codex-only", "/tmp/codex.jsonl", "test", "2026-07-12T10:00:00Z"]);
    dbExec("INSERT INTO messages (session_id, uuid, role, ordinal, model, input_tokens, output_tokens) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", ["codex-only", "codex-msg", 0, "gpt-5.4", 5_000_000, 0]);
    dbExec("INSERT INTO sessions (session_id, provider, file_path, project_name, created_at) VALUES (?, 'claude', ?, ?, ?)", ["claude-only", "/tmp/claude-only.jsonl", "test", "2026-07-12T10:00:00Z"]);
    dbExec("INSERT INTO messages (session_id, uuid, role, ordinal, model, input_tokens, output_tokens) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", ["claude-only", "claude-msg", 0, "claude-sonnet-4-5", 3_000_000, 0]);

    const quota = computeQuota({ claudeConfig: {}, settingsOverrides: { fiveHour: 1, weekly: 1 }, queryDb: () => ({ total: 0 }) });
    const all = buildAnalytics(quota);
    const deepseekRow = all.byProvider.find((row) => row.provider === "deepseek");
    const summary = deepseekUsageSummary();

    assert.equal(summary.tokens, deepseekRow?.tokens ?? 0);
    assert.equal(summary.cost, deepseekRow?.cost ?? 0);
    assert.equal(summary.tokens, 1_000_000);
  } finally {
    await closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
});
