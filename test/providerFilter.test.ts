import { test } from "node:test";
import assert from "node:assert/strict";
import { providerFilterSql } from "../src/services/providerFilter.js";

test("provider filter buckets are mutually exclusive", () => {
  assert.match(providerFilterSql("codex"), /s\.provider = 'codex'/);
  assert.match(providerFilterSql("agy"), /s\.provider = 'agy'/);
  assert.match(providerFilterSql("deepseek"), /s\.provider = 'claude'/);
  assert.match(providerFilterSql("deepseek"), /EXISTS/);
  assert.match(providerFilterSql("claude"), /NOT EXISTS/);
  assert.equal(providerFilterSql("all"), "1 = 1");
});
