import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResumeCommand } from "../src/claude/resume.js";

test("builds cd + resume when project path is known", () => {
  assert.equal(
    buildResumeCommand({ sessionId: "abc-123", projectPath: "/home/me/proj" }),
    'cd "/home/me/proj" && claude --resume abc-123',
  );
});

test("omits cd when project path is empty", () => {
  assert.equal(
    buildResumeCommand({ sessionId: "abc-123", projectPath: "" }),
    "claude --resume abc-123",
  );
});

test("escapes quotes in project path", () => {
  assert.equal(
    buildResumeCommand({ sessionId: "x", projectPath: '/a/"weird"/p' }),
    'cd "/a/\\"weird\\"/p" && claude --resume x',
  );
});
