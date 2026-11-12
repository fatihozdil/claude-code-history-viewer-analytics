import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClickAction } from "../src/services/sessionClickAction.js";

test("defaults to the viewer when nothing is configured", () => {
  assert.equal(resolveClickAction(undefined, "claude"), "viewer");
  assert.equal(resolveClickAction("viewer", "claude"), "viewer");
});

test("claudeTab applies to Claude sessions", () => {
  assert.equal(resolveClickAction("claudeTab", "claude"), "claudeTab");
});

test("claudeTab falls back to the viewer for providers that have no Claude tab", () => {
  assert.equal(resolveClickAction("claudeTab", "codex"), "viewer");
  assert.equal(resolveClickAction("claudeTab", "agy"), "viewer");
});

test("terminal applies to every provider", () => {
  assert.equal(resolveClickAction("terminal", "claude"), "terminal");
  assert.equal(resolveClickAction("terminal", "codex"), "terminal");
  assert.equal(resolveClickAction("terminal", "agy"), "terminal");
});

test("unknown or hand-edited values fall back to the viewer", () => {
  assert.equal(resolveClickAction("nonsense", "claude"), "viewer");
  assert.equal(resolveClickAction(42, "claude"), "viewer");
  assert.equal(resolveClickAction(null, "claude"), "viewer");
});
