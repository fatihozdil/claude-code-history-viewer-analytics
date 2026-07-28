import * as vscode from "vscode";
import { readBackup } from "../data/fileHistory.js";

/**
 * TextDocumentContentProvider that serves file-history backup blobs
 * through the claude-history-backup: URI scheme.
 *
 * Used by the native VS Code diff editor to show before/after for
 * files touched during a Claude Code session.
 *
 * URI format: claude-history-backup:<claudeDir>/<sessionId>/<backupFileName>/<originalFilePath>
 */
export class BackupContentProvider
  implements vscode.TextDocumentContentProvider
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Parse the path components from the URI path
    // Expect: /<base64urlClaudeDir>/sessionId/backupFileName/originalFilePath
    // claudeDir is base64url-encoded so its slashes don't become path separators.
    const pathParts = uri.path.split("/").filter(Boolean);
    if (pathParts.length < 3) {
      return "[claude-history] Invalid backup URI. Expected /claudeDir/sessionId/backupFileName/...";
    }

    const claudeDir = "/" + Buffer.from(pathParts[0], "base64url").toString("utf8");
    const sessionId = pathParts[1];
    const backupFileName = pathParts[2];
    // The rest of the path is informational (original file path)

    const content = await readBackup(claudeDir, sessionId, backupFileName);
    if (content === null) {
      return "[claude-history] Backup file not found.\n\nThis backup may have been cleaned up by Claude Code.";
    }

    return content;
  }
}

/** Build the backup URI for a session backup blob. */
export function buildBackupUri(
  claudeDir: string,
  sessionId: string,
  backupFileName: string,
  originalFilePath: string,
): vscode.Uri {
  // Encode the directory with base64url so slashes within it aren't treated
  // as path separators. (encodeURIComponent alone is fragile — some URI
  // parsers decode %2F before splitting the path.)
  const encodedDir = Buffer.from(claudeDir.replace(/^\/+/, "")).toString("base64url");
  return vscode.Uri.parse(
    `claude-history-backup:/${encodedDir}/${sessionId}/${backupFileName}/${encodeURIComponent(originalFilePath)}`,
  );
}

/**
 * Open the native VS Code diff editor comparing the backup blob (left)
 * against either another backup blob (right, when `after` is supplied) or
 * the current file on disk (right, default).
 *
 * Passing `after` scopes the diff to just this session's edits: it points
 * at the earliest backup of the next session that touched the file, i.e.
 * the file's state right after this session finished with it — instead of
 * the live file, which may include later unrelated edits.
 */
export async function openDiff(
  claudeDir: string,
  sessionId: string,
  backupFileName: string,
  originalFilePath: string,
  after?: { sessionId: string; backupFileName: string },
): Promise<void> {
  const backupUri = buildBackupUri(
    claudeDir,
    sessionId,
    backupFileName,
    originalFilePath,
  );
  const rightUri = after
    ? buildBackupUri(claudeDir, after.sessionId, after.backupFileName, originalFilePath)
    : vscode.Uri.file(originalFilePath);

  const title = after
    ? `${originalFilePath} (this chat's changes)`
    : `${originalFilePath} (session backup vs. current)`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    backupUri,
    rightUri,
    title,
  );
}
