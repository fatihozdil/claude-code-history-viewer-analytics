import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AgyScanOptions {
  knownMtimes?: ReadonlyMap<string, number>;
}

/** Cheap, stat-only listing of an AGY transcript file. No transcript content is read here. */
export interface AgyFileEntry {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** AGY conversation id (the brain/<id> directory name). */
  nativeSessionId: string;
}

export interface AgyScanResult {
  files: AgyFileEntry[];
  changedPaths: string[];
  complete: boolean;
}

/** Workspace path per AGY conversation id, read from the small history.jsonl index. */
export async function readAgyWorkspaces(agyDir: string): Promise<Map<string, string>> {
  const workspaces = new Map<string, string>();
  try {
    const history = await fs.readFile(path.join(agyDir, "history.jsonl"), "utf8");
    for (const line of history.split("\n")) {
      try {
        const row = JSON.parse(line) as { conversationId?: string; workspace?: string };
        if (row.conversationId && row.workspace) workspaces.set(row.conversationId, row.workspace);
      } catch { /* tolerate active partial line */ }
    }
  } catch { /* history is optional; transcripts remain usable */ }
  return workspaces;
}

/** Stat-only enumeration of every AGY transcript file. Never reads transcript contents. */
export async function scanAgySessions(agyDir: string, opts: AgyScanOptions = {}): Promise<AgyScanResult> {
  const brain = path.join(agyDir, "brain");
  let dirs;
  try {
    dirs = await fs.readdir(brain, { withFileTypes: true });
  } catch (error: any) {
    return { files: [], changedPaths: [], complete: error?.code === "ENOENT" };
  }
  const files: AgyFileEntry[] = [];
  const changedPaths: string[] = [];
  let complete = true;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const filePath = path.join(brain, dir.name, ".system_generated", "logs", "transcript.jsonl");
    try {
      const stat = await fs.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size, nativeSessionId: dir.name });
      if (opts.knownMtimes?.get(filePath) !== stat.mtimeMs) changedPaths.push(filePath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") complete = false;
    }
  }
  return { files, changedPaths, complete };
}
