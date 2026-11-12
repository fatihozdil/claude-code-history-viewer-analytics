import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildSearchSql } from "../src/search/query.js";

// browserProvider.ts imports the real `vscode` module, which only exists inside
// the extension host, so its message handling is asserted at the source level
// (the same approach as test/extensionQuotaBar.test.ts). The scope semantics it
// relies on are checked against the real SQL builder below.
async function providerSource(): Promise<string> {
  const src = await fs.readFile(path.resolve(__dirname, "../../src/webview/browserProvider.ts"), "utf8");
  return src.replace(/\r\n/g, "\n");
}

/** Body of one `case "<name>":` in _handleMessage, up to the next case label. */
function caseBody(src: string, name: string): string {
  const start = src.indexOf(`      case "${name}"`);
  assert.notEqual(start, -1, `case "${name}" not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n      (case "|default:)/);
  return src.slice(start, next === -1 ? undefined : start + 1 + next);
}

// Every action that changes what the list shows must re-run an active search.
// A plain _pushState() leaves the webview's search results in place, so the
// action appears to do nothing while a search is on (issue #17).
const REFRESHING_CASES = [
  "setProject",
  "setProvider",
  "toggleArchived",
  "archive",
  "dismissFork",
  "restoreFork",
  "ungroupBranch",
  "regroupBranch",
];

for (const name of REFRESHING_CASES) {
  test(`case "${name}" re-runs the active search via _refreshView`, async () => {
    const body = caseBody(await providerSource(), name);
    assert.match(body, /await this\._refreshView\(/, `${name} must call _refreshView`);
    assert.doesNotMatch(body, /this\._pushState\(/, `${name} must not use a plain _pushState`);
  });
}

test("_runSearch scopes archived results the same way the list does", async () => {
  const src = await providerSource();
  assert.match(src, /archivedOnly: showArchived/, "search must use archivedOnly, matching listSessionCards");
  assert.doesNotMatch(src, /includeArchived: showArchived/, "search must not mix archived and active results");
});

test("archived-only search SQL matches the list's archived filter", () => {
  const { sql } = buildSearchSql({ term: "x", archivedOnly: true });
  assert.match(sql, /s\.archived = 1/);
  assert.doesNotMatch(sql, /s\.archived = 0/);
});

test("default search SQL still excludes archived sessions", () => {
  const { sql } = buildSearchSql({ term: "x" });
  assert.match(sql, /s\.archived = 0/);
});

test("a plain session click dispatches through activateSession and the click-action setting", async () => {
  const src = await providerSource();
  assert.match(src, /case "activateSession"/, "provider must handle activateSession");
  const body = caseBody(src, "activateSession");
  assert.match(body, /_activateSession\(sid\)/);
  const method = src.slice(src.indexOf("private async _activateSession"));
  assert.match(method, /get<string>\("defaultClickAction", "viewer"\)/, "click action must read claudeHistory.defaultClickAction");
  assert.match(method, /resolveClickAction\(/);
  assert.match(method, /claudeHistory\.resume\.openInClaudeTab/);
  assert.match(method, /claudeHistory\.resume\.run/);
  assert.match(method, /claudeHistory\.openSession/);
});
