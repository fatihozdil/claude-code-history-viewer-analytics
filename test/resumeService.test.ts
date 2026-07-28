import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  buildResumeCommand,
  buildResumeInvocation,
  isNativeCodexArchive,
  type ResumeSession,
} from "../src/services/resumeService.js";

const NATIVE_ID = "123e4567-e89b-12d3-a456-426614174000";

function session(overrides: Partial<ResumeSession> = {}): ResumeSession {
  return {
    sessionId: `claude:${NATIVE_ID}`,
    nativeSessionId: NATIVE_ID,
    provider: "claude",
    projectPath: "",
    filePath: `/home/me/.claude/projects/project/${NATIVE_ID}.jsonl`,
    ...overrides,
  };
}

test("builds the Claude resume invocation from the native session id", () => {
  assert.deepEqual(buildResumeInvocation(session(), "linux"), {
    command: `claude --resume ${NATIVE_ID}`,
    terminalName: "Claude Resume",
    cwd: undefined,
  });
});

test("builds the Codex resume invocation and provider-specific terminal name", () => {
  assert.deepEqual(buildResumeInvocation(session({
    sessionId: `codex:${NATIVE_ID}`,
    provider: "codex",
  }), "linux"), {
    command: `codex resume ${NATIVE_ID}`,
    terminalName: "Codex Resume",
    cwd: undefined,
  });
});

test("builds the AGY CLI resume invocation", () => {
  assert.deepEqual(buildResumeInvocation(session({ provider: "agy", sessionId: `agy:${NATIVE_ID}` }), "linux"), {
    command: `agy --conversation ${NATIVE_ID}`,
    terminalName: "AGY Resume",
    cwd: undefined,
  });
});

test("unarchives a natively archived Codex rollout before resuming it", () => {
  const archived = session({
    sessionId: `codex:${NATIVE_ID}`,
    provider: "codex",
    filePath: `/home/me/.codex/archived_sessions/rollout-${NATIVE_ID}.jsonl`,
  });
  assert.equal(isNativeCodexArchive(archived), true);
  assert.equal(
    buildResumeInvocation(archived, "linux").command,
    `codex unarchive ${NATIVE_ID} && codex resume ${NATIVE_ID}`,
  );
});

test("does not confuse the extension's local archive flag with Codex native archive", () => {
  const active = session({
    sessionId: `codex:${NATIVE_ID}`,
    provider: "codex",
    filePath: `/home/me/.codex/sessions/2026/07/01/rollout-${NATIVE_ID}.jsonl`,
  });
  assert.equal(isNativeCodexArchive(active), false);
  assert.equal(buildResumeInvocation(active, "linux").command, `codex resume ${NATIVE_ID}`);
  assert.equal(isNativeCodexArchive({
    provider: "codex",
    filePath: `/home/archived_sessions/.codex/sessions/2026/07/01/rollout-${NATIVE_ID}.jsonl`,
  }), false);
});

test("resolves cwd without embedding it in the terminal command", () => {
  const projectPath = path.join(".", "workspace with spaces");
  assert.deepEqual(buildResumeInvocation(session({ projectPath }), "linux"), {
    command: `claude --resume ${NATIVE_ID}`,
    terminalName: "Claude Resume",
    cwd: path.resolve(projectPath),
  });
});

test("buildResumeCommand safely quotes cwd for clipboard use", () => {
  const projectPath = path.resolve("workspace's $project `name`");
  const safePath = `'${projectPath.replace(/'/g, `'\\''`)}'`;
  assert.equal(
    buildResumeCommand(session({ provider: "codex", projectPath }), "linux"),
    `cd ${safePath} && codex resume ${NATIVE_ID}`,
  );
});

test("uses an encoded PowerShell command for safe Windows paths and archive chaining", () => {
  const projectPath = "C:\\work\\a project's %folder% & files";
  const command = buildResumeCommand(session({
    sessionId: `codex:${NATIVE_ID}`,
    provider: "codex",
    projectPath,
    filePath: `C:\\Users\\me\\.codex\\archived_sessions\\rollout-${NATIVE_ID}.jsonl`,
  }), "win32");
  assert.match(command, /^powershell\.exe -NoProfile -EncodedCommand /);
  const encoded = command.split(" ").at(-1)!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /Set-Location -LiteralPath '.*project''s %folder% & files'/);
  assert.match(script, new RegExp(`codex unarchive ${NATIVE_ID}`));
  assert.match(script, new RegExp(`codex resume ${NATIVE_ID}`));
  assert.doesNotMatch(command, /%folder%|& files/);
});

test("rejects non-UUID native session ids instead of using the storage id", () => {
  assert.throws(
    () => buildResumeInvocation(session({ nativeSessionId: "abc; touch /tmp/nope" })),
    /Invalid session ID/,
  );
});

for (const projectPath of ["safe\0unsafe", "safe\nunsafe", "safe\runsafe"]) {
  test(`rejects unsafe cwd ${JSON.stringify(projectPath)}`, () => {
    assert.throws(
      () => buildResumeInvocation(session({ projectPath })),
      /Unsafe project path rejected/,
    );
  });
}

test("rejects an unknown provider at runtime", () => {
  assert.throws(
    () => buildResumeInvocation(session({ provider: "other" as "claude" })),
    /Unsupported session provider/,
  );
});
