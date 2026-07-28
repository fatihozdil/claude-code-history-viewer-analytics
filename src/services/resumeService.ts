import * as path from "node:path";
import type * as VSCode from "vscode";
import type { SessionMeta } from "../claude/types.js";
import { isCodexArchivedSessionPath } from "../discovery/paths.js";

/** Session IDs are UUIDs: hex chars and hyphens only. */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type ResumeSession = Pick<
  SessionMeta,
  "sessionId" | "nativeSessionId" | "provider" | "projectPath" | "filePath"
>;

export interface ResumeInvocation {
  command: string;
  terminalName: "Claude Resume" | "Codex Resume" | "AGY Resume";
  cwd: string | undefined;
}

function providerCommands(meta: ResumeSession): string[] {
  validateSessionId(meta.nativeSessionId);
  if (meta.provider === "claude") {
    return [`claude --resume ${meta.nativeSessionId}`];
  }
  if (meta.provider === "codex") {
    const resume = `codex resume ${meta.nativeSessionId}`;
    return isNativeCodexArchive(meta)
      ? [`codex unarchive ${meta.nativeSessionId}`, resume]
      : [resume];
  }
  if (meta.provider === "agy") return [`agy --conversation ${meta.nativeSessionId}`];
  throw new Error(`Unsupported session provider "${String(meta.provider)}".`);
}

function powershellSequence(commands: string[], cwd?: string): string {
  const invoke = (command: string) => `& ${command}`;
  let sequence = invoke(commands[0]);
  for (const command of commands.slice(1)) {
    sequence += `; if ($LASTEXITCODE -eq 0) { ${invoke(command)} }`;
  }
  if (cwd) {
    const literal = cwd.replace(/'/g, "''");
    sequence = `Set-Location -LiteralPath '${literal}'; if ($?) { ${sequence} }`;
  }
  return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(sequence, "utf16le").toString("base64")}`;
}

function joinCommands(commands: string[], platform: NodeJS.Platform): string {
  if (commands.length === 1) return commands[0];
  return platform === "win32" ? powershellSequence(commands) : commands.join(" && ");
}

/** Keep the VS Code runtime dependency out of the pure command-building path. */
function getVscode(): typeof VSCode {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("vscode") as typeof VSCode;
}

function validateSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(
      `Invalid session ID "${id}". Expected a UUID.`,
    );
  }
}

/**
 * Reject paths containing NUL bytes or newlines (cannot be valid cwds).
 * A missing/empty path is allowed — the terminal simply opens without a cwd.
 */
function rejectUnsafePath(p: string | undefined | null): void {
  if (!p) return;
  if (p.includes("\0") || p.includes("\n") || p.includes("\r")) {
    throw new Error(`Unsafe project path rejected.`);
  }
}

/** True when Codex itself has moved the rollout into its native archive. */
export function isNativeCodexArchive(
  meta: Pick<ResumeSession, "provider" | "filePath">,
): boolean {
  return meta.provider === "codex" && isCodexArchivedSessionPath(meta.filePath);
}

/** Resolve the provider-specific CLI command and terminal options. */
export function buildResumeInvocation(
  meta: ResumeSession,
  platform: NodeJS.Platform = process.platform,
): ResumeInvocation {
  rejectUnsafePath(meta.projectPath);
  const commands = providerCommands(meta);
  return {
    command: joinCommands(commands, platform),
    terminalName: meta.provider === "claude" ? "Claude Resume" : meta.provider === "agy" ? "AGY Resume" : "Codex Resume",
    cwd: meta.projectPath ? path.resolve(meta.projectPath) : undefined,
  };
}

/** Restore a rollout that Codex itself archived, in a visible terminal. */
export function unarchiveCodexInTerminal(meta: ResumeSession): void {
  if (!isNativeCodexArchive(meta)) {
    throw new Error("Session is not in the Codex native archive.");
  }
  validateSessionId(meta.nativeSessionId);
  const vscode = getVscode();
  const terminal = vscode.window.createTerminal({ name: "Codex Unarchive" });
  terminal.show();
  terminal.sendText(`codex unarchive ${meta.nativeSessionId}`);
}

/** Command contributed by the official Claude Code extension ("Open in New Tab"). */
const CLAUDE_TAB_COMMAND = "claude-vscode.editor.open";

/** Build a shell-safe resume command for clipboard use (single-quote escaping). */
export function buildResumeCommand(
  meta: ResumeSession,
  platform: NodeJS.Platform = process.platform,
): string {
  const invocation = buildResumeInvocation(meta, platform);
  if (!invocation.cwd) return invocation.command;
  if (platform === "win32") {
    return powershellSequence(providerCommands(meta), invocation.cwd);
  }
  // Single-quote escaping: ' + resolve + ' with embedded single quotes escaped.
  // This prevents $, backtick, and whitespace interpolation.
  const safePath = `'${invocation.cwd.replace(/'/g, `'\\''`)}'`;
  return `cd ${safePath} && ${invocation.command}`;
}

/** Copy resume command to clipboard. */
export async function copyResumeCommand(
  meta: ResumeSession,
): Promise<void> {
  const vscode = getVscode();
  const cmd = buildResumeCommand(meta);
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage("Resume command copied to clipboard.");
}

/** Resume in a new integrated terminal. Uses cwd to avoid shell injection. */
export function resumeInTerminal(
  meta: ResumeSession,
): void {
  const vscode = getVscode();
  const invocation = buildResumeInvocation(meta);
  const terminal = vscode.window.createTerminal({
    name: invocation.terminalName,
    cwd: invocation.cwd,
  });
  terminal.show();
  terminal.sendText(invocation.command);
}

/**
 * Resume a session inside a Claude Code editor tab via the official extension's
 * `claude-vscode.editor.open` command, which accepts a session id as its first
 * argument. Falls back to a helpful message if that extension isn't installed.
 */
export async function resumeInClaudeTab(
  meta: Pick<SessionMeta, "sessionId">,
): Promise<void> {
  const vscode = getVscode();
  validateSessionId(meta.sessionId);
  const installed = vscode.extensions.getExtension("anthropic.claude-code");
  if (!installed) {
    vscode.window.showWarningMessage(
      "Opening in a Claude tab requires the official Claude Code extension. Install it from the Marketplace, or use “Resume in Terminal” instead.",
    );
    return;
  }
  try {
    await vscode.commands.executeCommand(CLAUDE_TAB_COMMAND, meta.sessionId);
  } catch {
    vscode.window.showErrorMessage(
      "Could not open the session in a Claude tab. Try updating the Claude Code extension, or use “Resume in Terminal” instead.",
    );
  }
}
