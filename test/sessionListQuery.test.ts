import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionListSql, groupWithBranches, computeBranchCounts } from "../src/services/sessionListQuery.js";
import type { SessionCard } from "../src/services/sessionListQuery.js";

test("hides archived by default", () => {
  const { sql, params } = buildSessionListSql({ sort: "newest", showArchived: false });
  assert.match(sql, /archived = 0/);
  assert.match(sql, /ORDER BY pinned DESC, updated_at DESC/);
  assert.deepEqual(params, []);
});

test("archived-only when showArchived true", () => {
  const { sql } = buildSessionListSql({ sort: "newest", showArchived: true });
  assert.match(sql, /archived = 1/);
});

test("filters by project path with a param", () => {
  const { sql, params } = buildSessionListSql({ projectPath: "/p", sort: "oldest", showArchived: false });
  assert.match(sql, /project_path = \? OR s\.project_path LIKE \?/);
  assert.deepEqual(params, ["/p", "/p/%"]);
  assert.match(sql, /ORDER BY pinned DESC, updated_at ASC/);
});

test("sort modes map to columns", () => {
  assert.match(buildSessionListSql({ sort: "messages", showArchived: false }).sql, /message_count DESC/);
  assert.match(buildSessionListSql({ sort: "activity", showArchived: false }).sql, /file_mtime DESC/);
  assert.match(buildSessionListSql({ sort: "cost", showArchived: false }).sql, /cost DESC/);
  assert.match(buildSessionListSql({ sort: "impact", showArchived: false }).sql, /\(lines_added \+ lines_removed\) DESC/);
});

test("pinned sessions float to the top of every sort", () => {
  const { sql } = buildSessionListSql({ sort: "newest", showArchived: false });
  assert.match(sql, /ORDER BY pinned DESC, updated_at DESC/);
});

test("filters session cards by Codex, Claude, or DeepSeek", () => {
  assert.match(buildSessionListSql({ sort: "newest", showArchived: false, providerFilter: "codex" }).sql, /s\.provider = 'codex'/);
  assert.match(buildSessionListSql({ sort: "newest", showArchived: false, providerFilter: "claude" }).sql, /NOT EXISTS/);
  assert.match(buildSessionListSql({ sort: "newest", showArchived: false, providerFilter: "deepseek" }).sql, /LIKE '%deepseek%'/);
});

test("selects aggregate columns", () => {
  const { sql } = buildSessionListSql({ sort: "newest", showArchived: false });
  assert.match(sql, /files_modified/);
  assert.match(sql, /lines_added/);
  assert.match(sql, /lines_removed/);
});

function makeCard(overrides: Partial<SessionCard> & { sessionId: string }): SessionCard {
  return {
    provider: "claude", nativeSessionId: overrides.sessionId,
    projectPath: "/p", projectName: "p", title: overrides.sessionId,
    filePath: `/p/${overrides.sessionId}.jsonl`,
    mtimeMs: 0,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 1, cost: null, archived: false, pinned: false,
    filesModified: 0, linesAdded: 0, linesRemoved: 0,
    parentSessionId: null, possibleParentId: null, branchCount: 0, subagentCount: 0,
    ...overrides,
  };
}

test("groupWithBranches places branch directly after parent", () => {
  const parent = makeCard({ sessionId: "parent", branchCount: 1 });
  const branch = makeCard({ sessionId: "branch", parentSessionId: "parent", updatedAt: "2026-01-02T00:00:00Z" });
  const other = makeCard({ sessionId: "other" });
  // Input: [other, parent, branch] — mixed order
  const result = groupWithBranches([other, parent, branch]);
  assert.equal(result[0].sessionId, "other");
  assert.equal(result[1].sessionId, "parent");
  assert.equal(result[2].sessionId, "branch");
});

test("groupWithBranches sorts multiple branches by updatedAt ascending", () => {
  const parent = makeCard({ sessionId: "parent", branchCount: 2 });
  const b1 = makeCard({ sessionId: "b1", parentSessionId: "parent", updatedAt: "2026-01-03T00:00:00Z" });
  const b2 = makeCard({ sessionId: "b2", parentSessionId: "parent", updatedAt: "2026-01-02T00:00:00Z" });
  const result = groupWithBranches([parent, b1, b2]);
  assert.equal(result[1].sessionId, "b2");  // earlier updatedAt first
  assert.equal(result[2].sessionId, "b1");
});

test("groupWithBranches preserves order of orphaned branches", () => {
  const branch = makeCard({ sessionId: "orphan", parentSessionId: "missing-parent" });
  const other = makeCard({ sessionId: "other" });
  const result = groupWithBranches([branch, other]);
  assert.equal(result[0].sessionId, "orphan");
  assert.equal(result[1].sessionId, "other");
});

test("groupWithBranches handles no branches", () => {
  const a = makeCard({ sessionId: "a" });
  const b = makeCard({ sessionId: "b" });
  const result = groupWithBranches([a, b]);
  assert.equal(result.length, 2);
  assert.equal(result[0].sessionId, "a");
});

test("groupWithBranches collects multi-level descendants under the ultimate root", () => {
  const root = makeCard({ sessionId: "root", branchCount: 2 });
  const branchA = makeCard({ sessionId: "branchA", parentSessionId: "root", updatedAt: "2026-01-02T00:00:00Z" });
  const branchB = makeCard({ sessionId: "branchB", parentSessionId: "branchA", updatedAt: "2026-01-03T00:00:00Z" });
  // branch-of-branch should appear under the root at the same level, not orphaned
  const result = groupWithBranches([branchA, root, branchB]);
  assert.equal(result[0].sessionId, "root");
  assert.equal(result[1].sessionId, "branchA");
  assert.equal(result[2].sessionId, "branchB"); // grandchild right after its parent, same level
});

test("groupWithBranches groups a possible fork under its heuristic parent", () => {
  const parent = makeCard({ sessionId: "parent" });
  const possible = makeCard({
    sessionId: "possible",
    possibleParentId: "parent",
    updatedAt: "2026-01-02T00:00:00Z",
  });
  const other = makeCard({ sessionId: "other" });
  const result = groupWithBranches([other, possible, parent]);
  assert.equal(result[0].sessionId, "other");
  assert.equal(result[1].sessionId, "parent");
  assert.equal(result[2].sessionId, "possible");
});

test("exact parentSessionId takes precedence over possibleParentId for grouping", () => {
  const exactParent = makeCard({ sessionId: "exact-parent" });
  const heuristicParent = makeCard({ sessionId: "heuristic-parent" });
  const child = makeCard({
    sessionId: "child",
    parentSessionId: "exact-parent",
    possibleParentId: "heuristic-parent",
    updatedAt: "2026-01-02T00:00:00Z",
  });
  const result = groupWithBranches([heuristicParent, exactParent, child]);
  const childIdx = result.findIndex((c) => c.sessionId === "child");
  const exactIdx = result.findIndex((c) => c.sessionId === "exact-parent");
  assert.equal(childIdx, exactIdx + 1);
});

test("computeBranchCounts counts exact and possible forks under the ultimate root", () => {
  const root = makeCard({ sessionId: "root" });
  const exact = makeCard({ sessionId: "exact", parentSessionId: "root" });
  const possible = makeCard({ sessionId: "possible", possibleParentId: "exact" });
  const cards = [root, exact, possible];
  computeBranchCounts(cards);
  assert.equal(cards.find((c) => c.sessionId === "root")!.branchCount, 2);
  assert.equal(cards.find((c) => c.sessionId === "exact")!.branchCount, 0);
  assert.equal(cards.find((c) => c.sessionId === "possible")!.branchCount, 0);
});

test("groupWithBranches treats an ungrouped branch as a root", () => {
  const parent = makeCard({ sessionId: "parent", branchCount: 1 });
  const branch = makeCard({ sessionId: "branch", parentSessionId: "parent", updatedAt: "2026-01-02T00:00:00Z" });
  const result = groupWithBranches([parent, branch], new Set(["branch"]));
  // Order preserved (branch trails parent since it's not collected as a descendant)
  assert.deepEqual(result.map((c) => c.sessionId), ["parent", "branch"]);
});

test("groupWithBranches keeps an ungrouped branch's own children nested under it", () => {
  const parent = makeCard({ sessionId: "parent" });
  const mid = makeCard({ sessionId: "mid", parentSessionId: "parent", updatedAt: "2026-01-02T00:00:00Z" });
  const grandchild = makeCard({ sessionId: "grand", parentSessionId: "mid", updatedAt: "2026-01-03T00:00:00Z" });
  const result = groupWithBranches([parent, mid, grandchild], new Set(["mid"]));
  assert.deepEqual(result.map((c) => c.sessionId), ["parent", "mid", "grand"]);
});

test("computeBranchCounts does not count an ungrouped branch toward its old root", () => {
  const parent = makeCard({ sessionId: "parent" });
  const branch = makeCard({ sessionId: "branch", parentSessionId: "parent" });
  const grouped = groupWithBranches([parent, branch], new Set(["branch"]));
  computeBranchCounts(grouped, new Set(["branch"]));
  const byId = new Map(grouped.map((c) => [c.sessionId, c]));
  assert.equal(byId.get("parent")!.branchCount, 0);
  assert.equal(byId.get("branch")!.branchCount, 0);
});
