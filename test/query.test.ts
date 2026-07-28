import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchSql } from "../src/search/query.js";

test("builds a LIKE query with lowercased escaped term", () => {
  const { sql, params } = buildSearchSql({ term: "Parse_Bug" });
  assert.match(sql, /LOWER\(m\.search_text\) LIKE \? ESCAPE/);
  assert.match(sql, /OR LOWER\(COALESCE\(s\.title, ''\)\) LIKE \? ESCAPE/);
  assert.equal(params[0], "%parse\\_bug%");
  assert.equal(params[1], "%parse\\_bug%");
  assert.equal(params[2], "%parse\\_bug%");
});

test("adds project and session filters", () => {
  const { sql, params } = buildSearchSql({ term: "x", projectPath: "/p", sessionId: "s1" });
  assert.match(sql, /s\.project_path = \? OR s\.project_path LIKE \?/);
  assert.match(sql, /s\.session_id = \?/);
  assert.deepEqual(params, ["%x%", "%x%", "%x%", "/p", "/p/%", "s1", "%x%"]);
});

test("ranks title matches ahead of newer content-only matches", () => {
  const { sql, params } = buildSearchSql({ term: "auth token refresh" });
  assert.match(sql, /ORDER BY CASE WHEN LOWER\(COALESCE\(s\.title, ''\)\) LIKE \?.*THEN 0 ELSE 1 END/);
  assert.equal(params.at(-1), "%auth token refresh%");
});

test("limits a title hit to one result row per conversation", () => {
  const { sql } = buildSearchSql({ term: "auth token refresh" });
  assert.match(sql, /m\.ordinal = \(SELECT MIN\(first_message\.ordinal\)/);
});

test("preserves provider and archived-only filters", () => {
  const { sql } = buildSearchSql({ term: "x", archivedOnly: true, providerFilter: "codex" });
  assert.match(sql, /s\.archived = 1/);
  assert.match(sql, /s\.provider = 'codex'/);
});
