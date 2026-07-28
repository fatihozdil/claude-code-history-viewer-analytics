import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// extension.ts imports the real `vscode` module, which only exists inside
// the extension host, so it can't be exercised by node:test directly (no
// vscode mock exists in this repo). Instead we assert, at the source level,
// that the status-bar quota path was rewired away from the ~6.5s
// buildAnalytics() scan and onto the cheap targeted aggregate — the same
// guarantee the runtime behavior needs, without a heavyweight vscode shim.
test("updateQuotaStatus no longer imports or calls buildAnalytics", async () => {
  const src = await fs.readFile(path.resolve(__dirname, "../../src/extension.ts"), "utf8");
  assert.doesNotMatch(src, /buildAnalytics/, "src/extension.ts must not reference buildAnalytics; use deepseekUsageSummary() instead");
  assert.match(src, /deepseekUsageSummary/, "src/extension.ts must derive the DeepSeek status-bar entry from deepseekUsageSummary()");
});

test("deactivate() returns the closeDb() promise instead of firing it and forgetting", async () => {
  const src = await fs.readFile(path.resolve(__dirname, "../../src/extension.ts"), "utf8");
  const match = src.match(/export function deactivate\([^)]*\)[^{]*\{[\s\S]*?\n\}/);
  assert.ok(match, "deactivate() function not found");
  const body = match![0];
  assert.match(body, /return closeDb\(\)/, "deactivate() must return closeDb()'s promise so VS Code awaits the flush before teardown");
  assert.doesNotMatch(body, /closeDb\(\)\.catch/, "deactivate() must not fire-and-forget closeDb()");
});
