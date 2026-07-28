import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ScanOptions {
  knownMtimes?: ReadonlyMap<string, number>;
}

/** Cheap, stat-only listing of a Claude session file. No file content is read here. */
export interface ClaudeFileEntry {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Encoded project directory name, for the projectName fallback when a file has no cwd. */
  projDirName: string;
  /** Session id derived from the filename, used when the file's own id can't be parsed. */
  fallbackId: string;
}

export interface ScanResult {
  files: ClaudeFileEntry[];
  changedPaths: string[];
  complete: boolean;
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function listProjectDirs(projectsDirPath: string): Promise<{ names: string[]; complete: boolean }> {
  let entries;
  try {
    entries = await fs.readdir(projectsDirPath, { withFileTypes: true });
  } catch (error) {
    return { names: [], complete: isNotFound(error) };
  }
  return {
    names: entries.filter((e) => e.isDirectory()).map((e) => e.name),
    complete: true,
  };
}

async function listSessionFiles(dir: string): Promise<{ paths: string[]; complete: boolean }> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return { paths: [], complete: isNotFound(error) };
  }
  return {
    paths: entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(dir, e.name)),
    complete: true,
  };
}

/** Stat-only enumeration of every Claude session file. Never reads file contents. */
export async function scanProjects(
  projectsDirPath: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const files: ClaudeFileEntry[] = [];
  const changedPaths: string[] = [];
  const projectDirs = await listProjectDirs(projectsDirPath);
  let complete = projectDirs.complete;

  for (const projDirName of projectDirs.names) {
    const projDir = path.join(projectsDirPath, projDirName);
    const sessionFiles = await listSessionFiles(projDir);
    complete &&= sessionFiles.complete;
    for (const filePath of sessionFiles.paths) {
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if (!isNotFound(error)) complete = false;
        continue;
      }
      const mtimeMs = stat.mtimeMs;
      const fallbackId = path.basename(filePath, ".jsonl");

      if (opts.knownMtimes?.get(filePath) !== mtimeMs) changedPaths.push(filePath);

      files.push({
        filePath,
        mtimeMs,
        sizeBytes: stat.size,
        projDirName,
        fallbackId,
      });
    }
  }
  return { files, changedPaths, complete };
}
