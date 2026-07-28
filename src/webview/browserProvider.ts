import * as vscode from "vscode";
import { ListStateStore } from "../services/listState.js";
import { listSessionCards, type SessionCard } from "../services/sessionListQuery.js";
import { listProjects } from "../services/sessionService.js";
import {
  setArchived, setPinned, setCustomTitle, getCustomTitles, setForkDismissed, getDismissedForks,
  setBranchUngrouped, getUngroupedBranches,
  writeCustomTitleToSessionFile, writeCodexThreadName, writeAgyConversationTitle,
} from "../services/sessionFlags.js";
import { readSubagents } from "../claude/subagentMeta.js";
import { dbGet } from "../storage/db.js";
import { OUTPUT } from "../logging.js";

const SUPPRESS_RENAME_CACHE_NOTICE_KEY = "claudeHistory.suppressRenameCacheNotice";

export class BrowserProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _activeSearchQuery: string | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _listState: ListStateStore,
    private readonly _refreshIndex: () => Promise<void>,
    private readonly _roots: { codexDir: string; agyDir?: string },
    private readonly _globalState: vscode.Memento,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "media")],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
  }

  /** Push current state to the webview (called after filters change or data updates). */
  refresh(): void {
    this._pushState();
  }

  // ── HTML ──────────────────────────────────────────────

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "browser.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "browser.css"),
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "codicon.css"),
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Claude &amp; Codex History</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // ── Message handler ───────────────────────────────────

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    const cmd = msg.command as string;
    const sid = msg.sessionId as string | undefined;
    const recvAt = Date.now();

    switch (cmd) {
      case "ready":
        this._pushState();
        break;

      case "setProject": {
        const projectPath = (msg.projectPath ?? null) as string | null;
        this._listState.set({ selectedProject: projectPath });
        this._pushState();
        break;
      }

      case "setProvider": {
        OUTPUT.info(`[perf] setProvider(${msg.providerFilter}) received`);
        this._listState.set({ providerFilter: msg.providerFilter as any });
        this._pushState(recvAt);
        break;
      }

      case "search": {
        const query = (msg.query as string) || "";
        if (!query) {
          this._activeSearchQuery = null;
          this._pushState();
          break;
        }
        this._activeSearchQuery = query;
        await this._runSearch(query);
        break;
      }

      case "clearSearch":
        this._activeSearchQuery = null;
        this._view?.webview.postMessage({ type: "searchCleared" });
        this._pushState();
        break;

      case "setSort":
        this._listState.set({ sort: msg.sort as any });
        this._pushState();
        break;

      case "toggleCompact": {
        const cur = this._listState.get().display;
        this._listState.set({ display: cur === "expanded" ? "compact" : "expanded" });
        this._pushState();
        break;
      }

      case "toggleArchived": {
        const cur = this._listState.get().showArchived;
        this._listState.set({ showArchived: !cur });
        this._pushState();
        break;
      }

      case "openSession":
        if (sid) {
          const msgOrdinal = msg.msgOrdinal as number | undefined;
          const highlightTerm = msg.highlightTerm as string | undefined;
          vscode.commands.executeCommand("claudeHistory.openSession", {
            sessionId: sid,
            ...(msgOrdinal !== undefined ? { msgOrdinal } : {}),
            ...(highlightTerm ? { highlightTerm } : {}),
          });
        }
        break;

      case "archive":
        if (sid) {
          setArchived(sid, true);
          this._pushState();
        }
        break;

      case "unarchive":
        if (sid) {
          await vscode.commands.executeCommand("claudeHistory.unarchive", { sessionId: sid });
        }
        break;

      case "pin":
        if (sid) {
          setPinned(sid, true);
          await this._refreshView();
        }
        break;

      case "unpin":
        if (sid) {
          setPinned(sid, false);
          await this._refreshView();
        }
        break;

      case "dismissFork":
        if (sid) {
          setForkDismissed(sid, true);
          this._pushState();
        }
        break;

      case "restoreFork":
        if (sid) {
          setForkDismissed(sid, false);
          this._pushState();
        }
        break;

      case "ungroupBranch":
        if (sid) {
          setBranchUngrouped(sid, true);
          this._pushState();
        }
        break;

      case "regroupBranch":
        if (sid) {
          setBranchUngrouped(sid, false);
          this._pushState();
        }
        break;

      case "refresh": {
        await this._refreshIndex();
        const { applyFlagsToDb } = await import("../services/sessionFlags.js");
        applyFlagsToDb();
        this._pushState();
        break;
      }

      case "openSettings":
        await vscode.commands.executeCommand("claudeHistory.openSettings");
        break;

      case "resume.copy":
        if (sid) {
          vscode.commands.executeCommand("claudeHistory.resume.copy", await this._resumeMeta(sid));
        }
        break;

      case "resume.run":
        if (sid) {
          vscode.commands.executeCommand("claudeHistory.resume.run", await this._resumeMeta(sid));
        }
        break;

      case "resume.openInClaudeTab":
        if (sid) {
          vscode.commands.executeCommand("claudeHistory.resume.openInClaudeTab", await this._resumeMeta(sid));
        }
        break;

      case "rename":
        if (sid && typeof msg.title === "string") {
          await setCustomTitle(sid, msg.title);
          const row = dbGet("SELECT provider, file_path, native_session_id FROM sessions WHERE session_id = ?", [sid]);
          const provider = row ? String(row.provider) : "";
          const filePath = row ? String(row.file_path) : "";
          const nativeId = row ? String(row.native_session_id ?? "") : "";
          // Each tool derives its own displayed title from a different store, and
          // none of them read the Claude `custom-title` line: Claude reads it from
          // the transcript, Codex from session_index.jsonl's thread_name, and agy
          // from conversation_summaries.db. Write to the right one per provider so
          // the rename shows up in that tool's own CLI/extension.
          try {
            if (provider === "codex" && nativeId) {
              await writeCodexThreadName(this._roots.codexDir, nativeId, msg.title);
            } else if (provider === "agy" && nativeId && this._roots.agyDir) {
              await writeAgyConversationTitle(this._roots.agyDir, nativeId, msg.title);
            } else if (filePath) {
              await writeCustomTitleToSessionFile(filePath, sid, msg.title);
            }
          } catch (err) {
            OUTPUT.appendLine(`Failed to propagate rename to ${provider} store: ${err}`);
          }
          await this._refreshView();

          let extName = "";
          let extId = "";
          if (provider === "claude") {
            extName = "Claude";
            extId = "anthropic.claude-code";
          } else if (provider === "codex") {
            extName = "Codex";
            extId = "openai.chatgpt";
          } else if (provider === "agy") {
            extName = "Antigravity";
            extId = vscode.extensions.getExtension("google.antigravity")
              ? "google.antigravity"
              : "google.agy";
          }

          const suppressNotice = this._globalState.get<boolean>(SUPPRESS_RENAME_CACHE_NOTICE_KEY, false);
          if (extId && vscode.extensions.getExtension(extId) && !suppressNotice) {
            vscode.window.showInformationMessage(
              `Renamed conversation to “${msg.title}”. (VS Code's ${extName} tab caches titles. Close the tab and reload the window to update it.)`,
              "Reload Window",
              "Don't Show Again",
            ).then((selection) => {
              if (selection === "Reload Window") {
                vscode.commands.executeCommand("workbench.action.reloadWindow");
              } else if (selection === "Don't Show Again") {
                this._globalState.update(SUPPRESS_RENAME_CACHE_NOTICE_KEY, true);
              }
            });
          }
        }
        break;

      case "getSubagents": {
        const sessionId = msg.sessionId as string;
        if (!sessionId) break;
        // Look up the session file path from DB
        const row = dbGet("SELECT file_path FROM sessions WHERE session_id = ?", [sessionId]);
        const filePath = row ? String(row.file_path) : "";
        const subagents = filePath ? readSubagents(sessionId, filePath) : [];
        this._view?.webview.postMessage({
          type: "subagentsLoaded",
          sessionId,
          subagents,
        });
        break;
      }

      case "openSubagent": {
        const filePath = msg.filePath as string;
        const title = msg.title as string;
        if (filePath) {
          vscode.commands.executeCommand("claudeHistory.openSubagent", { filePath, title });
        }
        break;
      }
    }
  }

  // ── Resume helpers ────────────────────────────────────

  /**
   * Hydrate a resume command argument from a session id. The webview only knows
   * the id, but the resume/terminal commands need the session's project path so
   * the terminal opens in the right working directory.
   */
  private async _resumeMeta(sessionId: string): Promise<{ sessionId: string; projectPath?: string }> {
    try {
      const { getSessionCardsByIds } = await import("../services/sessionListQuery.js");
      const card = getSessionCardsByIds([sessionId])[0];
      if (card?.projectPath) return { sessionId, projectPath: card.projectPath };
    } catch {
      // Fall through to id-only meta; commands tolerate a missing project path.
    }
    return { sessionId };
  }

  // ── State push ────────────────────────────────────────

  /** Re-run the active search (if any) so results reflect the latest data, else push the unfiltered list. */
  private async _refreshView(): Promise<void> {
    if (this._activeSearchQuery) {
      await this._runSearch(this._activeSearchQuery);
    } else {
      this._pushState();
    }
  }

  private async _runSearch(query: string): Promise<void> {
    // Run FTS via the search service
    try {
      const { search: runSearch } = await import("../services/searchService.js");
      const { getSessionCardsByIds, annotatePossibleForks, applyUngrouped } = await import(
        "../services/sessionListQuery.js"
      );
      const { showArchived, selectedProject, providerFilter } = this._listState.get();
      const results = runSearch({
        term: query,
        projectPath: selectedProject ?? undefined,
        includeArchived: showArchived,
        providerFilter,
      });
      // Collapse per-message hits down to one entry per session: keep the
      // first (best) ordinal/snippet and a running count of all matches.
      const ordinalBySessionId = new Map<string, number>();
      const snippetBySessionId = new Map<string, typeof results[number]["snippetParts"]>();
      const countBySessionId = new Map<string, number>();
      const orderedIds: string[] = [];
      for (const r of results) {
        if (!ordinalBySessionId.has(r.sessionId)) {
          ordinalBySessionId.set(r.sessionId, r.msgOrdinal);
          snippetBySessionId.set(r.sessionId, r.snippetParts);
          orderedIds.push(r.sessionId);
        }
        countBySessionId.set(r.sessionId, (countBySessionId.get(r.sessionId) ?? 0) + 1);
      }
      // Hydrate deduplicated ids with real card metadata, preserving match order.
      const cards: SessionCard[] = getSessionCardsByIds(orderedIds);
      annotatePossibleForks(cards, getDismissedForks());
      applyUngrouped(cards, getUngroupedBranches());
      const customTitles = getCustomTitles();
      for (const card of cards) {
        const ordinal = ordinalBySessionId.get(card.sessionId);
        if (ordinal !== undefined) {
          card.matchOrdinal = ordinal;
        }
        card.matchCount = countBySessionId.get(card.sessionId);
        card.matchSnippet = snippetBySessionId.get(card.sessionId);
        const ct = customTitles[card.sessionId];
        if (ct) card.title = ct;
      }
      this._view?.webview.postMessage({
        type: "searchResults",
        sessions: cards,
        query,
      });
    } catch {
      this._view?.webview.postMessage({ type: "searchCleared" });
    }
  }

  private _pushState(triggeredAt?: number): void {
    if (!this._view) return;
    const t0 = Date.now();

    const st = this._listState.get();
    const selectedProject = st.selectedProject;

    const cards: SessionCard[] = listSessionCards({
      projectPath: selectedProject ?? undefined,
      sort: st.sort,
      showArchived: st.showArchived,
      providerFilter: st.providerFilter,
    }, getDismissedForks(), getUngroupedBranches());
    const t1 = Date.now();

    // Overlay custom titles onto cards
    const customTitles = getCustomTitles();
    if (Object.keys(customTitles).length > 0) {
      for (const card of cards) {
        const ct = customTitles[card.sessionId];
        if (ct) card.title = ct;
      }
    }

    // Fetch project list for the dropdown
    listProjects().then((projects) => {
      const t2 = Date.now();
      if (triggeredAt !== undefined) {
        OUTPUT.info(
          `[perf] listSessionCards=${t1 - t0}ms listProjects=${t2 - t1}ms total-since-message=${t2 - triggeredAt}ms (sessions=${cards.length})`,
        );
      }
      this._view?.webview.postMessage({
        type: "state",
        sessions: cards,
        projects: projects.map((p) => ({ path: p.path, name: p.name })),
        sort: st.sort,
        compact: st.display === "compact",
        showArchived: st.showArchived,
        selectedProject,
        providerFilter: st.providerFilter,
      });
    });
  }
}

function getNonce(): string {
  const { randomBytes } = require("node:crypto");
  return randomBytes(16).toString("base64");
}
