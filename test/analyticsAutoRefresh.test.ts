import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// analyticsPanel.ts and extension.ts both import the real `vscode` module,
// which only exists inside the extension host, and this repo has no vscode
// mock (see test/extensionQuotaBar.test.ts). So the wiring is asserted at the
// source level; the timer semantics themselves are covered properly by
// test/pollTimer.test.ts against the vscode-free helper.
function repoFile(rel: string): Promise<string> {
  return fs.readFile(path.resolve(__dirname, "../../", rel), "utf8");
}

test("AnalyticsPanel starts a poll timer and clears it on dispose", async () => {
  const src = await repoFile("src/webview/analyticsPanel.ts");
  assert.match(src, /createPollTimer/, "panel must use the testable createPollTimer helper");
  assert.match(src, /ANALYTICS_REFRESH_MS/, "panel must use the shared 5-minute cadence constant");

  const disposeBody = src.match(/\n  dispose\(\): void \{[\s\S]*?\n  \}/);
  assert.ok(disposeBody, "dispose() not found");
  assert.match(
    disposeBody![0],
    /_pollTimer/,
    "dispose() must stop the poll timer or it keeps firing after the tab closes",
  );
});

test("AnalyticsPanel refresh takes an options object with force and silent", async () => {
  const src = await repoFile("src/webview/analyticsPanel.ts");
  assert.match(
    src,
    /async refresh\(\s*opts:\s*\{\s*force\?:\s*boolean;\s*silent\?:\s*boolean\s*\}/,
    "refresh() must accept { force?, silent? }",
  );
});

test("a silent refresh failure keeps the dashboard instead of posting an error", async () => {
  const src = await repoFile("src/webview/analyticsPanel.ts");
  const refreshBody = src.match(/private async _refresh\([\s\S]*?\n  \}/);
  assert.ok(refreshBody, "_refresh() not found");
  assert.match(
    refreshBody![0],
    /if \(silent\)/,
    "_refresh must branch on `silent` in its catch so background failures do not replace the dashboard with an error banner",
  );
});

test("the first open with no cached snapshot refreshes loudly", async () => {
  const src = await repoFile("src/webview/analyticsPanel.ts");
  const readyBranch = src.match(/command === "ready"\)[\s\S]*?\n    \}\n  \}/);
  assert.ok(readyBranch, "the `ready` message branch was not found");

  // With a cached snapshot painted, a failed refresh must not replace it.
  assert.match(
    readyBranch![0],
    /cached: true,[\s\S]*?refresh\(\{\s*silent:\s*true\s*\}\)/,
    "when a cached snapshot is painted, the follow-up refresh must be silent",
  );
  // With nothing painted, the webview is showing its loading spinner; a silent
  // failure there would spin forever, so that path must surface the error.
  assert.match(
    readyBranch![0],
    /type: "loading" \}\);[\s\S]*?this\.refresh\(\);/,
    "with nothing painted yet the refresh must be loud so a failure surfaces instead of spinning forever",
  );
});

test("the refresh button still forces past the quota throttle", async () => {
  const src = await repoFile("src/webview/analyticsPanel.ts");
  assert.match(
    src,
    /command === "refresh"[\s\S]{0,120}refresh\(\{\s*force:\s*true\s*\}\)/,
    "the manual refresh button must still pass force: true",
  );
});

test("every data-changed path that updates the quota status bar also refreshes the analytics panel", async () => {
  const src = await repoFile("src/extension.ts");

  // The panel is a singleton that is undefined until opened, so the optional
  // call is free when the user never opens analytics.
  const hooks = src.match(/AnalyticsPanel\.current\?\.refresh\(\{\s*silent:\s*true\s*\}\)/g) ?? [];
  assert.ok(
    hooks.length >= 4,
    `expected the analytics refresh hook in at least 4 data-changed paths (watcher, fallback poll, initial index, reindex), found ${hooks.length}`,
  );

  // The watcher path specifically — this is what keeps the panel fresher than
  // the 5-minute timer alone.
  const watcherBody = src.match(/const onHistoryChanged = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(watcherBody, "onHistoryChanged not found");
  assert.match(
    watcherBody![0],
    /AnalyticsPanel\.current\?\.refresh/,
    "the file watcher path must refresh the analytics panel",
  );
});

test("extension.ts never forces the analytics refresh", async () => {
  const src = await repoFile("src/extension.ts");
  assert.doesNotMatch(
    src,
    /AnalyticsPanel\.current\?\.refresh\(\{[^}]*force:\s*true/,
    "background refreshes must stay non-forced so they share the quota cache",
  );
});

test("renderAll does not reset the user's table state on an unattended repaint", async () => {
  const src = await repoFile("media/analytics.js");
  const body = src.match(/function renderAll\(data\) \{[\s\S]*?\n  \}/);
  assert.ok(body, "renderAll() not found");

  assert.doesNotMatch(
    body![0],
    /showAllDays\s*=\s*false/,
    "renderAll must not collapse an expanded daily table on a background refresh",
  );
  assert.doesNotMatch(
    body![0],
    /dailySortState\s*=\s*\{/,
    "renderAll must not reset the user's chosen column sort on a background refresh",
  );
  assert.match(
    body![0],
    /scrollY/,
    "renderAll must preserve scroll position across the repaint",
  );
});

test("the daily table state variables still default correctly at load", async () => {
  const src = await repoFile("media/analytics.js");
  // With the resets removed from renderAll, the initial declarations are the
  // only thing establishing first-render defaults.
  assert.match(src, /var showAllDays = false;/, "showAllDays must default to false at load");
  assert.match(
    src,
    /var dailySortState = \{ col: "date", dir: "desc" \};/,
    'dailySortState must default to { col: "date", dir: "desc" } at load',
  );
});
