import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";

export function resolveClaudeDir(configuredPath: string, homeDir: string = os.homedir()): string {
  const trimmed = configuredPath.trim();
  return trimmed !== "" ? trimmed : path.join(homeDir, ".claude");
}

export function resolveCodexDir(
  configuredPath: string,
  homeDir: string = os.homedir(),
  codexHome: string | undefined = process.env.CODEX_HOME,
): string {
  const trimmed = configuredPath.trim();
  if (trimmed !== "") return trimmed;
  const envDir = codexHome?.trim();
  return envDir ? envDir : path.join(homeDir, ".codex");
}

export function resolveAgyDir(configuredPath: string, homeDir: string = os.homedir()): string {
  const trimmed = configuredPath.trim();
  if (trimmed) return trimmed;
  const cliDir = path.join(homeDir, ".gemini", "antigravity-cli");
  if (existsSync(cliDir)) return cliDir;
  return path.join(homeDir, ".gemini", "antigravity");
}

export function projectsDir(claudeDir: string): string {
  return path.join(claudeDir, "projects");
}

export function codexSessionsDir(codexDir: string): string {
  return path.join(codexDir, "sessions");
}

export function codexArchivedSessionsDir(codexDir: string): string {
  return path.join(codexDir, "archived_sessions");
}

export function isCodexArchivedSessionPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]+/);
  return segments.lastIndexOf("archived_sessions") > segments.lastIndexOf("sessions");
}

export function decodeProjectDirName(name: string): string {
  const slashed = name.replace(/-/g, "/");
  return slashed.startsWith("//") ? slashed.slice(1) : slashed;
}
