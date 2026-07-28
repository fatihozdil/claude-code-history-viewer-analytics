import * as path from "node:path";
import * as vscode from "vscode";
import { loadConversation } from "../services/sessionService.js";
import { summarizeFileChanges, findScopedAfterBackup } from "../services/fileChangeService.js";
import { resolveBackupRef } from "../data/fileHistory.js";
import { filterLocalCommandMessages, mergeToolResults } from "../services/toolResultMerge.js";
import { getCustomTitle } from "../services/sessionFlags.js";
import { costForTokens } from "../services/pricing.js";
import type { SerializedMessage } from "../services/toolResultMerge.js";

/**
 * Singleton webview panel for rendering coding-agent conversations.
 * Uses VS Code theme variables so it inherits the current color theme.
 */
export class ConversationPanel {
  public static current: ConversationPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _claudeDir: string;
  private _sessionId = "";
  private _projectPath = "";
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    claudeDir: string,
  ): ConversationPanel {
    if (ConversationPanel.current) {
      ConversationPanel.current._panel.reveal();
      return ConversationPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeHistory.conversation",
      "Conversation",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    ConversationPanel.current = new ConversationPanel(panel, extensionUri, claudeDir);
    return ConversationPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, claudeDir: string) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._claudeDir = claudeDir;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleWebviewMessage(msg),
      null,
      this._disposables,
    );

    // Set initial HTML
    this._panel.webview.html = this._getHtml({ title: "Loading…" });
  }

  /** Load and render a conversation. `highlightTerm`, if set (from a search result), is
   *  echoed back to the webview so it can mark matching text inline. */
  async loadSession(filePath: string, highlightTerm?: string): Promise<void> {
    this._panel.webview.html = this._getHtml({ title: "Loading…" });

    try {
      const { meta, messages } = await loadConversation(filePath);
      this._sessionId = meta.sessionId;
      this._projectPath = meta.projectPath;
      const customTitle = getCustomTitle(meta.sessionId);
      const displayTitle = customTitle || meta.title || "Conversation";
      this._panel.title = displayTitle;
      this._panel.webview.html = this._getHtml({ title: displayTitle });

      // Serialize messages, then merge tool_use/tool_result pairs so results
      // render inside their tool card instead of as fake "user" messages.
      const serialized: SerializedMessage[] = messages.map((msg) => {
        const cost = msg.inputTokens || msg.outputTokens || msg.cacheCreationTokens || msg.cacheReadTokens
          ? costForTokens(msg.model, {
              input: msg.inputTokens ?? 0,
              output: msg.outputTokens ?? 0,
              cacheCreation: msg.cacheCreationTokens ?? 0,
              cacheRead: msg.cacheReadTokens ?? 0,
            })
          : undefined;

        return {
          index: msg.index,
          role: msg.role,
          timestamp: msg.timestamp,
          model: msg.model,
          cost,
          parts: msg.parts.map((p) => {
            if (p.kind === "text") return { kind: "text" as const, text: p.text };
            if (p.kind === "tool_use")
              return {
                kind: "tool_use" as const,
                id: p.id,
                name: p.name,
                input: p.input,
              };
            if (p.kind === "tool_result")
              return {
                kind: "tool_result" as const,
                toolUseId: p.toolUseId,
                text: p.text,
                isError: p.isError,
              };
            return p as never;
          }),
        };
      });
      const merged = filterLocalCommandMessages(mergeToolResults(serialized));
      const costedMessages = serialized.filter((message) => message.cost != null);
      const totalCost = costedMessages.length
        ? costedMessages.reduce((sum, message) => sum + (message.cost ?? 0), 0)
        : null;

      // Post in chunks so the webview stays responsive
      const CHUNK = 50;
      this._panel.webview.postMessage({ type: "clear", highlightTerm });
      this._panel.webview.postMessage({ type: "conversationCost", cost: totalCost });
      this._panel.webview.postMessage({
        type: "claudeTabAvailable",
        available: !!vscode.extensions.getExtension("anthropic.claude-code"),
      });
      this._panel.webview.postMessage({
        type: "fileChanges",
        files: summarizeFileChanges(meta.sessionId),
        projectPath: meta.projectPath,
      });
      for (let i = 0; i < merged.length; i += CHUNK) {
        const chunk = merged.slice(i, i + CHUNK);
        this._panel.webview.postMessage({ type: "messages", messages: chunk });
        await new Promise((r) => setTimeout(r, 0));
      }
      this._panel.webview.postMessage({ type: "done" });
    } catch (err) {
      this._panel.webview.html = this._getHtml({
        title: "Error",
        error: String(err),
      });
    }
  }

  /** Override the panel title (used for subagent sessions with no title in JSONL). */
  setTitle(title: string): void {
    if (title) this._panel.title = title;
  }

  /** Scroll to a specific message in the loaded conversation. */
  scrollToMessage(index: number): void {
    this._panel.webview.postMessage({ type: "scrollTo", index });
  }

  dispose(): void {
    ConversationPanel.current = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }

  /** Resolve a potentially-relative file path to absolute using the session's cwd. */
  private _resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath) || !this._projectPath) return filePath;
    return path.resolve(this._projectPath, filePath);
  }

  private async _handleWebviewMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.command !== "string") return;
    if (msg.command === "openFile" && typeof msg.filePath === "string") {
      const absPath = this._resolvePath(msg.filePath);
      await vscode.commands.executeCommand("claudeHistory.openFile", absPath);
    } else if (msg.command === "openDiff" && typeof msg.filePath === "string") {
      const absPath = this._resolvePath(msg.filePath);
      const backupRef = await resolveBackupRef(this._claudeDir, this._sessionId, absPath);
      const after = await findScopedAfterBackup(this._claudeDir, this._sessionId, absPath);
      await vscode.commands.executeCommand("claudeHistory.openDiff", {
        filePath: absPath,
        sessionId: this._sessionId,
        backupRef: backupRef ?? undefined,
        after: after ?? undefined,
      });
    } else if (msg.command === "openInClaudeTab") {
      await vscode.commands.executeCommand("claudeHistory.resume.openInClaudeTab", {
        sessionId: this._sessionId,
        projectPath: this._projectPath || undefined,
      });
    }
  }

  private _getHtml(opts: { title: string; error?: string }): string {
    const wv = this._panel.webview;
    const styleUri = wv.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "conversation.css"),
    );
    const scriptUri = wv.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "conversation.js"),
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${wv.cspSource} 'unsafe-inline'; script-src ${wv.cspSource} 'nonce-${nonce}'; img-src ${wv.cspSource} data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>${escapeHtml(opts.title)}</title>
</head>
<body>
  <div id="app">
    <div id="find-widget" style="display:none">
      <span class="find-icon">🔍</span>
      <input id="find-input" type="text" placeholder="Find in conversation" spellcheck="false" />
      <span id="find-counter" class="find-counter">0/0</span>
      <button id="find-prev" class="find-btn" title="Previous match (Shift+Enter)" aria-label="Previous match">‹</button>
      <button id="find-next" class="find-btn" title="Next match (Enter)" aria-label="Next match">›</button>
      <button id="find-close" class="find-btn" title="Close (Esc)" aria-label="Close find">✕</button>
    </div>
    <div id="panel-toolbar">
      <button id="open-in-claude-tab" style="display:none">Open in Claude Tab</button>
    </div>
    ${opts.error ? `<div class="error-banner">${escapeHtml(opts.error)}</div>` : ""}
    <div id="file-changes"></div>
    <div id="prompt-bar" style="display:none"></div>
    <div id="messages"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const { randomBytes } = require("node:crypto");
  return randomBytes(16).toString("base64");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
