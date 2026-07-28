import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPossibleForks } from "../src/services/forkHeuristics.js";
import type { ForkCandidate } from "../src/services/forkHeuristics.js";

function makeCandidate(
  overrides: Partial<ForkCandidate> & { sessionId: string },
): ForkCandidate {
  return {
    provider: "claude",
    projectPath: "/p",
    createdAt: "2026-01-01T00:00:00Z",
    messageCount: 10,
    parentSessionId: null,
    userPrefix: [],
    ...overrides,
  };
}

test("deep fork: 2+ shared leading user messages links child to parent", () => {
  // IDE fork copies parent messages verbatim (same timestamps), so createdAt ties;
  // the longer session is the parent.
  const parent = makeCandidate({
    sessionId: "parent",
    messageCount: 40,
    userPrefix: [
      { ts: "2026-06-30T10:37:56Z", text: "read through this" },
      { ts: "2026-06-30T10:39:00Z", text: "i mean i have tested it" },
      { ts: "2026-06-30T10:41:00Z", text: "dont use em dashes" },
    ],
  });
  const child = makeCandidate({
    sessionId: "child",
    messageCount: 18,
    userPrefix: [
      { ts: "2026-06-30T10:37:56Z", text: "read through this" },
      { ts: "2026-06-30T10:39:00Z", text: "i mean i have tested it" },
      { ts: "2026-07-01T09:00:00Z", text: "something new after fork" },
    ],
  });
  const links = detectPossibleForks([parent, child]);
  assert.equal(links.get("child"), "parent");
  assert.equal(links.has("parent"), false);
});

test("shallow fork: child whose only user message matches parent's first is linked", () => {
  // Fork-at-first-message re-timestamps the copied message, so only text matches.
  const parent = makeCandidate({
    sessionId: "parent",
    createdAt: "2026-07-01T19:17:27Z",
    messageCount: 4,
    userPrefix: [
      { ts: "2026-07-01T19:17:27Z", text: "test" },
      { ts: "2026-07-01T19:17:29Z", text: "test test" },
    ],
  });
  const child = makeCandidate({
    sessionId: "child",
    createdAt: "2026-07-01T19:17:50Z",
    messageCount: 1,
    userPrefix: [{ ts: "2026-07-01T19:17:50Z", text: "test" }],
  });
  const links = detectPossibleForks([parent, child]);
  assert.equal(links.get("child"), "parent");
});

test("one shared message with differing timestamps and both diverging is NOT linked", () => {
  // Two unrelated sessions that merely start with the same prompt.
  const a = makeCandidate({
    sessionId: "a",
    userPrefix: [
      { ts: "2026-01-01T00:00:00Z", text: "test" },
      { ts: "2026-01-01T00:01:00Z", text: "fix the parser" },
    ],
  });
  const b = makeCandidate({
    sessionId: "b",
    createdAt: "2026-01-02T00:00:00Z",
    userPrefix: [
      { ts: "2026-01-02T00:00:00Z", text: "test" },
      { ts: "2026-01-02T00:01:00Z", text: "write a changelog" },
    ],
  });
  const links = detectPossibleForks([a, b]);
  assert.equal(links.size, 0);
});

test("one shared message with identical timestamp IS linked (copied record)", () => {
  const a = makeCandidate({
    sessionId: "a",
    messageCount: 30,
    userPrefix: [
      { ts: "2026-01-01T00:00:00.123Z", text: "hello" },
      { ts: "2026-01-01T00:01:00Z", text: "continue" },
    ],
  });
  const b = makeCandidate({
    sessionId: "b",
    messageCount: 6,
    userPrefix: [
      { ts: "2026-01-01T00:00:00.123Z", text: "hello" },
      { ts: "2026-01-03T00:00:00Z", text: "other direction" },
    ],
  });
  const links = detectPossibleForks([a, b]);
  assert.equal(links.get("b"), "a");
});

test("sessions in different projects are never linked", () => {
  const a = makeCandidate({
    sessionId: "a",
    projectPath: "/p1",
    userPrefix: [{ ts: "t1", text: "test" }],
  });
  const b = makeCandidate({
    sessionId: "b",
    projectPath: "/p2",
    createdAt: "2026-01-02T00:00:00Z",
    messageCount: 1,
    userPrefix: [{ ts: "t2", text: "test" }],
  });
  assert.equal(detectPossibleForks([a, b]).size, 0);
});

test("sessions of different providers are never linked, even in the same project", () => {
  // "Fork from here" is a Claude-app-only feature; a Codex/agy session can never
  // be the fork parent of a Claude session. A shared first message (e.g. a
  // "test message" seed reused across CLIs) must not cross the provider boundary.
  const codexParent = makeCandidate({
    sessionId: "codex:1",
    provider: "codex",
    createdAt: "2026-01-01T00:00:00Z",
    userPrefix: [{ ts: "t1", text: "test message\n" }],
  });
  const claudeChild = makeCandidate({
    sessionId: "claude:1",
    provider: "claude",
    createdAt: "2026-01-02T00:00:00Z",
    messageCount: 1,
    userPrefix: [{ ts: "t2", text: "test message" }],
  });
  assert.equal(detectPossibleForks([codexParent, claudeChild]).size, 0);
});

test("session with an exact forkedFrom parent is not heuristically re-linked", () => {
  const parent = makeCandidate({
    sessionId: "parent",
    messageCount: 8,
    userPrefix: [{ ts: "t1", text: "test" }, { ts: "t2", text: "more" }],
  });
  const exactChild = makeCandidate({
    sessionId: "exact-child",
    parentSessionId: "somewhere-else",
    createdAt: "2026-01-02T00:00:00Z",
    messageCount: 1,
    userPrefix: [{ ts: "t3", text: "test" }],
  });
  assert.equal(detectPossibleForks([parent, exactChild]).size, 0);
});

test("empty user prefixes never link", () => {
  const a = makeCandidate({ sessionId: "a", userPrefix: [] });
  const b = makeCandidate({ sessionId: "b", userPrefix: [] });
  assert.equal(detectPossibleForks([a, b]).size, 0);
});

test("parent direction: earlier createdAt wins regardless of input order", () => {
  const later = makeCandidate({
    sessionId: "later",
    createdAt: "2026-02-01T00:00:00Z",
    messageCount: 50,
    userPrefix: [
      { ts: "x1", text: "alpha" },
      { ts: "x2", text: "beta" },
      { ts: "x3", text: "diverge-later" },
    ],
  });
  const earlier = makeCandidate({
    sessionId: "earlier",
    createdAt: "2026-01-01T00:00:00Z",
    messageCount: 5,
    userPrefix: [
      { ts: "x1", text: "alpha" },
      { ts: "x2", text: "beta" },
      { ts: "x4", text: "diverge-earlier" },
    ],
  });
  const links = detectPossibleForks([later, earlier]);
  assert.equal(links.get("later"), "earlier");
  assert.equal(links.has("earlier"), false);
});

test("child picks the candidate with the longest shared prefix", () => {
  const grandparent = makeCandidate({
    sessionId: "grandparent",
    createdAt: "2026-01-01T00:00:00Z",
    messageCount: 40,
    userPrefix: [
      { ts: "t1", text: "one" },
      { ts: "t2", text: "two" },
      { ts: "t5", text: "gp-diverges" },
    ],
  });
  const parent = makeCandidate({
    sessionId: "parent",
    createdAt: "2026-01-02T00:00:00Z",
    messageCount: 30,
    userPrefix: [
      { ts: "t1", text: "one" },
      { ts: "t2", text: "two" },
      { ts: "t3", text: "three" },
      { ts: "t6", text: "p-diverges" },
    ],
  });
  const child = makeCandidate({
    sessionId: "child",
    createdAt: "2026-01-03T00:00:00Z",
    messageCount: 20,
    userPrefix: [
      { ts: "t1", text: "one" },
      { ts: "t2", text: "two" },
      { ts: "t3", text: "three" },
      { ts: "t7", text: "c-diverges" },
    ],
  });
  const links = detectPossibleForks([grandparent, parent, child]);
  assert.equal(links.get("child"), "parent");
  assert.equal(links.get("parent"), "grandparent");
});

test("synthetic local-command messages are ignored when matching prefixes", () => {
  // Two unrelated sessions that each start by running /model produce identical
  // injected messages; they must not count toward the shared prefix.
  const caveat = "<local-command-caveat>Caveat: generated by the user...</local-command-caveat>";
  const command = "<command-name>/model</command-name>\n<command-message>model</command-message>";
  const stdout = "<local-command-stdout>Set model to claude-opus-4-8</local-command-stdout>";
  const a = makeCandidate({
    sessionId: "a",
    userPrefix: [
      { ts: "t1", text: caveat },
      { ts: "t2", text: command },
      { ts: "t3", text: stdout },
      { ts: "t4", text: "fix the parser" },
    ],
  });
  const b = makeCandidate({
    sessionId: "b",
    createdAt: "2026-01-02T00:00:00Z",
    userPrefix: [
      { ts: "t5", text: caveat },
      { ts: "t6", text: command },
      { ts: "t7", text: stdout },
      { ts: "t8", text: "write a changelog" },
    ],
  });
  assert.equal(detectPossibleForks([a, b]).size, 0);
});

test("local-command noise does not break alignment of real messages", () => {
  // A fork's parent ran /model mid-history; after dropping synthetic messages
  // the real user messages still line up and link.
  const parent = makeCandidate({
    sessionId: "parent",
    messageCount: 20,
    userPrefix: [
      { ts: "t1", text: "read through this" },
      { ts: "t2", text: "<command-name>/model</command-name>" },
      { ts: "t3", text: "dont use em dashes" },
      { ts: "t4", text: "parent-diverges" },
    ],
  });
  const child = makeCandidate({
    sessionId: "child",
    createdAt: "2026-01-02T00:00:00Z",
    messageCount: 8,
    userPrefix: [
      { ts: "t5", text: "read through this" },
      { ts: "t6", text: "dont use em dashes" },
      { ts: "t7", text: "child-diverges" },
    ],
  });
  const links = detectPossibleForks([parent, child]);
  assert.equal(links.get("child"), "parent");
});

test("equal-length prefixes tie-break to the closest (latest-created) parent", () => {
  // Forks are made near their parent in time; an old session that merely
  // started with the same prompt must lose to the one forked seconds ago.
  const old = makeCandidate({
    sessionId: "old",
    createdAt: "2026-01-01T00:00:00Z",
    messageCount: 3,
    userPrefix: [{ ts: "t1", text: "test" }, { ts: "t2", text: "old stuff" }],
  });
  const recent = makeCandidate({
    sessionId: "recent",
    createdAt: "2026-07-01T19:17:27Z",
    messageCount: 4,
    userPrefix: [{ ts: "t3", text: "test" }, { ts: "t4", text: "test test" }],
  });
  const child = makeCandidate({
    sessionId: "child",
    createdAt: "2026-07-01T19:17:50Z",
    messageCount: 1,
    userPrefix: [{ ts: "t5", text: "test" }],
  });
  const links = detectPossibleForks([old, recent, child]);
  assert.equal(links.get("child"), "recent");
});

test("a dismissed child is never linked, but others still are", () => {
  const parent = makeCandidate({
    sessionId: "parent",
    messageCount: 20,
    userPrefix: [
      { ts: "t1", text: "one" },
      { ts: "t2", text: "two" },
      { ts: "t3", text: "p-diverges" },
    ],
  });
  // Created after "kept" so it can never be picked as kept's parent.
  const dismissed = makeCandidate({
    sessionId: "dismissed",
    createdAt: "2026-01-03T00:00:00Z",
    messageCount: 5,
    userPrefix: [
      { ts: "t1", text: "one" },
      { ts: "t2", text: "two" },
      { ts: "t4", text: "d-diverges" },
    ],
  });
  const kept = makeCandidate({
    sessionId: "kept",
    createdAt: "2026-01-02T00:00:00Z",
    messageCount: 5,
    userPrefix: [
      { ts: "t1", text: "one" },
      { ts: "t2", text: "two" },
      { ts: "t5", text: "k-diverges" },
    ],
  });
  const links = detectPossibleForks([parent, dismissed, kept], new Set(["dismissed"]));
  assert.equal(links.has("dismissed"), false);
  assert.equal(links.get("kept"), "parent");
});

test("text comparison trims whitespace", () => {
  const a = makeCandidate({
    sessionId: "a",
    messageCount: 9,
    userPrefix: [
      { ts: "t1", text: "  hello \n" },
      { ts: "t2", text: "world" },
    ],
  });
  const b = makeCandidate({
    sessionId: "b",
    createdAt: "2026-01-02T00:00:00Z",
    messageCount: 4,
    userPrefix: [
      { ts: "t1", text: "hello" },
      { ts: "t2", text: "world" },
    ],
  });
  const links = detectPossibleForks([a, b]);
  assert.equal(links.get("b"), "a");
});
