import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveBackupRef } from "../src/data/fileHistory.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function hashOf(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

async function fixture(): Promise<string> {
  const claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cch-backup-"));
  await fs.mkdir(path.join(claudeDir, "file-history", SESSION_ID), { recursive: true });
  return claudeDir;
}

test("returns the lowest version when multiple backups exist for the file", async () => {
  const claudeDir = await fixture();
  const filePath = "/Users/me/proj/src/main.tsx";
  const hash = hashOf(filePath);
  const dir = path.join(claudeDir, "file-history", SESSION_ID);
  await fs.writeFile(path.join(dir, `${hash}@v1`), "before");
  await fs.writeFile(path.join(dir, `${hash}@v2`), "middle");
  const result = await resolveBackupRef(claudeDir, SESSION_ID, filePath);
  assert.equal(result, `${hash}@v1`);
});

test("returns null when no backup matches the file's hash", async () => {
  const claudeDir = await fixture();
  const dir = path.join(claudeDir, "file-history", SESSION_ID);
  await fs.writeFile(path.join(dir, `${hashOf("/other/file.ts")}@v1`), "x");
  const result = await resolveBackupRef(claudeDir, SESSION_ID, "/Users/me/proj/src/main.tsx");
  assert.equal(result, null);
});

test("returns null when the session has no backup directory at all", async () => {
  const claudeDir = await fixture();
  const result = await resolveBackupRef(claudeDir, "99999999-0000-0000-0000-000000000000", "/x.ts");
  assert.equal(result, null);
});
