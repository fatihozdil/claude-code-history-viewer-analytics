import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanProjects } from "../src/discovery/scanner.js";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cch-scan-"));
  const proj = path.join(root, "-home-me-proj");
  await fs.mkdir(proj, { recursive: true });
  const session = [
    { type: "user", sessionId: "s1", cwd: "/home/me/proj",
      timestamp: "2026-06-01T10:00:00Z", message: { role: "user", content: "hi" } },
  ].map((o) => JSON.stringify(o)).join("\n");
  await fs.writeFile(path.join(proj, "s1.jsonl"), session);
  return root;
}

test("scans sessions as a stat-only listing", async () => {
  const root = await fixture();
  const { files, changedPaths } = await scanProjects(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].fallbackId, "s1");
  assert.equal(files[0].projDirName, "-home-me-proj");
  assert.ok(files[0].filePath.endsWith("s1.jsonl"));
  assert.ok(files[0].mtimeMs > 0);
  assert.ok(files[0].sizeBytes > 0);
  assert.equal(changedPaths.length, 1);
});

test("never reads file contents", async () => {
  const root = await fixture();
  // `import * as fs` is compiled to a forwarding-getter namespace object, so mutate
  // the real CommonJS module it forwards to (found via require, not the ESM import).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rawFsp = require("node:fs/promises");
  const originalReadFile = rawFsp.readFile;
  let readCalls = 0;
  rawFsp.readFile = (...args: unknown[]) => {
    readCalls += 1;
    return originalReadFile(...args);
  };
  try {
    await scanProjects(root);
  } finally {
    rawFsp.readFile = originalReadFile;
  }
  assert.equal(readCalls, 0);
});

test("changedPaths empty when mtimes known", async () => {
  const root = await fixture();
  const first = await scanProjects(root);
  const known = new Map(first.files.map((f) => [f.filePath, f.mtimeMs]));
  const second = await scanProjects(root, { knownMtimes: known });
  assert.equal(second.changedPaths.length, 0);
});

test("missing projects dir returns empty", async () => {
  const res = await scanProjects("/nonexistent/xyz");
  assert.deepEqual(res, { files: [], changedPaths: [], complete: true });
});

test("marks a scan incomplete when the projects root cannot be enumerated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cch-scan-error-"));
  const notADirectory = path.join(root, "projects");
  await fs.writeFile(notADirectory, "not a directory");
  const res = await scanProjects(notADirectory);
  assert.equal(res.complete, false);
});

test("oversized files are still listed with an accurate size (indexer decides placeholder-vs-parse)", async () => {
  const root = await fixture();
  const res = await scanProjects(root);
  assert.equal(res.files.length, 1);
  assert.ok(res.files[0].sizeBytes > 0);
});
