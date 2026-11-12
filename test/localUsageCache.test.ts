import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CODEX_USAGE_TTL_MS, AGY_USAGE_TTL_MS } from "../src/services/localUsageCache.js";

// extension.ts and analyticsPanel.ts import the real `vscode` module, which only
// exists inside the extension host, so the wiring is asserted at the source
// level. The cache semantics themselves are covered by test/ttlCache.test.ts.
async function source(rel: string): Promise<string> {
  const src = await fs.readFile(path.resolve(__dirname, "../../", rel), "utf8");
  return src.replace(/\r\n/g, "\n");
}

test("Codex and Antigravity TTLs are positive and Antigravity's is the shorter", () => {
  assert.ok(CODEX_USAGE_TTL_MS > 0);
  assert.ok(AGY_USAGE_TTL_MS > 0);
  assert.ok(AGY_USAGE_TTL_MS <= CODEX_USAGE_TTL_MS);
});

test("status-bar quota path reads Codex and Antigravity through the cache", async () => {
  const src = await source("src/extension.ts");
  assert.match(src, /readCodexUsageCached\(codexDir, \{ fresh \}\)/);
  assert.match(src, /readAgyUsageCached\(agyDir, \{ fresh \}\)/);
  assert.doesNotMatch(src, /await readCodexUsage\(/, "status bar must not call the uncached Codex reader");
  assert.doesNotMatch(src, /await readAgyUsage\(/, "status bar must not call the uncached Antigravity reader");
});

test("ordinary repaints stay cached; live polls and explicit refreshes are fresh", async () => {
  const src = await source("src/extension.ts");
  assert.match(src, /const fresh = opts\?\.live === true \|\| opts\?\.fresh === true;/);
  assert.match(src, /updateQuotaStatus\(quotaItem, \{ fresh: true \}\);[\s\S]*?\$\(check\) Ready/, "claudeHistory.refresh must request a fresh reading");
  assert.match(src, /updateQuotaStatus\(quotaItem, \{ fresh: true \}\);\s*AnalyticsPanel\.current\?\.refresh\(\{ silent: true \}\);\s*statusBar\.text = "\$\(check\) Index rebuilt"/, "reindex must request a fresh reading");
});

test("analytics panel always requests a fresh local reading", async () => {
  const src = await source("src/webview/analyticsPanel.ts");
  assert.match(src, /readCodexUsageCached\(codexDir, \{ fresh: true \}\)/);
  assert.match(src, /readAgyUsageCached\(agyDir, \{ fresh: true \}\)/);
  assert.doesNotMatch(src, /\breadCodexUsage\(/, "panel must not use the uncached reader directly");
});
