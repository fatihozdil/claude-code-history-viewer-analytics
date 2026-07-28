import { test } from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { priceForModel, costForTokens, MESSAGE_COST_SQL } from "../src/services/pricing.js";

test("priceForModel matches opus by substring", () => {
  assert.equal(priceForModel("claude-opus-4-8").input, 5);
  assert.equal(priceForModel("claude-opus-4-8").output, 25);
});

test("priceForModel distinguishes current and legacy Claude models", () => {
  assert.equal(priceForModel("claude-opus-4-1").output, 75);
  assert.equal(priceForModel("claude-opus-4-8").output, 25);
  assert.deepEqual(priceForModel("claude-sonnet-5"), { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
  assert.equal(priceForModel("claude-3-5-haiku-20241022").input, 0.8);
});

test("priceForModel matches sonnet and haiku", () => {
  assert.equal(priceForModel("claude-sonnet-4-6").input, 3);
  assert.equal(priceForModel("claude-haiku-4-5-20251001").input, 1);
});

test("priceForModel falls back to default for null or unrecognized claude model", () => {
  assert.equal(priceForModel(null).input, 3);
  assert.equal(priceForModel("claude-future-model-5").input, 3);
});

test("priceForModel covers OpenAI models used by Codex", () => {
  assert.deepEqual(priceForModel("gpt-5.3-codex"), { input: 1.75, output: 14, cacheWrite: 1.75, cacheRead: 0.175 });
  assert.equal(priceForModel("gpt-4o").output, 10);
});

test("priceForModel covers current GPT variants without generic fallback collisions", () => {
  assert.deepEqual(priceForModel("gpt-5.6-sol"), { input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 });
  assert.deepEqual(priceForModel("gpt-5.6-terra"), { input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 });
  assert.deepEqual(priceForModel("gpt-5.6-luna"), { input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 });
  assert.equal(priceForModel("gpt-5.4-mini").output, 4.5);
  assert.equal(priceForModel("gpt-5-mini").input, 0.25);
  assert.equal(priceForModel("gpt-5-nano").output, 0.4);
});

test("costForTokens computes dollar cost from token mix", () => {
  // 1M output opus = $25
  assert.equal(
    costForTokens("claude-opus-4-8", { input: 0, output: 1_000_000, cacheCreation: 0, cacheRead: 0 }),
    25,
  );
  // cache reads are cheap: 1M sonnet cache-read = $0.30
  assert.equal(
    costForTokens("claude-sonnet-4-6", { input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 }),
    0.3,
  );
});

test("costForTokens returns 0 for all-zero tokens", () => {
  assert.equal(
    costForTokens("claude-opus-4-8", { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }),
    0,
  );
});

test("priceForModel matches fable", () => {
  assert.equal(priceForModel("claude-fable").input, 10);
  assert.equal(priceForModel("claude-fable").output, 50);
});

test("priceForModel matches gemini models", () => {
  assert.equal(priceForModel("gemini-2.5-pro").output, 10);
  assert.equal(priceForModel("gemini-2.5-flash").output, 2.5);
  assert.equal(priceForModel("gemini-2.5-flash-lite").input, 0.1);
  assert.equal(priceForModel("gemini-2.0-flash").input, 0.1);
  assert.equal(priceForModel("gemini-2.0-flash-lite").input, 0.075);
  assert.equal(priceForModel("gemini-3.5-flash-high").output, 9);
  assert.equal(priceForModel("gemini-1.5-flash").input, 0.075);
});

test("priceForModel matches deepseek models", () => {
  // DeepSeek Pro
  assert.equal(priceForModel("deepseek-v4-pro").input, 0.435);
  assert.equal(priceForModel("deepseek-v4-pro-high-effort").output, 0.87);
  // DeepSeek Flash
  assert.equal(priceForModel("deepseek-v4-flash").input, 0.14);
  assert.equal(priceForModel("deepseek-v4-flash").output, 0.28);
});

test("analytics SQL stays identical to TypeScript pricing for supported models", async () => {
  const SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") });
  const db = new SQL.Database();
  db.run("CREATE TABLE messages(model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_creation_tokens INTEGER, cache_read_tokens INTEGER)");
  const models = [
    "claude-opus-4-8", "claude-opus-4-1", "claude-sonnet-5", "claude-sonnet-4-6",
    "claude-haiku-4-5", "claude-3-5-haiku-20241022", "claude-fable-5",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini",
    "gpt-5.3-codex", "gpt-5-mini", "gpt-4.1", "gpt-4o-mini",
    "gemini-3.5-flash", "gemini-3.1-pro", "gemini-3-flash", "gemini-2.5-pro",
    "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash",
    "deepseek-v4-pro", "deepseek-v4-flash",
  ];
  for (const model of models) {
    db.run("DELETE FROM messages");
    db.run("INSERT INTO messages VALUES (?, 1000000, 1000000, 1000000, 1000000)", [model]);
    const sqlCost = Number(db.exec(`SELECT ${MESSAGE_COST_SQL} AS cost FROM messages`)[0].values[0][0]);
    const tsCost = costForTokens(model, { input: 1_000_000, output: 1_000_000, cacheCreation: 1_000_000, cacheRead: 1_000_000 });
    assert.equal(sqlCost, tsCost, model);
  }
  db.close();
});
