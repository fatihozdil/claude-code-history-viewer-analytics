import * as vscode from "vscode";
import * as os from "node:os";
import { resolveClaudeDir, resolveCodexDir, resolveAgyDir, projectsDir } from "./discovery/paths.js";
import { initDb, closeDb, dbGet, restoreMigratedFlags } from "./storage/db.js";
import { rowToSession, SESSION_COLUMNS } from "./storage/schema.js";
import { setArchived, setPinned, initSessionFlags, seedFlagsFromDbIfEmpty, applyFlagsToDb } from "./services/sessionFlags.js";
import { incrementalIndex, reindexAll } from "./services/indexer.js";
import {
  copyResumeCommand,
  resumeInTerminal,
  resumeInClaudeTab,
  isNativeCodexArchive,
  unarchiveCodexInTerminal,
} from "./services/resumeService.js";
import { startWatcher, MIN_REFIRE_MS } from "./watch/watcher.js";
import { ListStateStore } from "./services/listState.js";
import { BrowserProvider } from "./webview/browserProvider.js";
import { ConversationPanel } from "./webview/conversationPanel.js";
import { AnalyticsPanel } from "./webview/analyticsPanel.js";
import { BackupContentProvider } from "./diff/backupContentProvider.js";
import type { SessionMeta } from "./claude/types.js";
import { resolveQuota, resolveUsagePollMs } from "./services/quota.js";
import { deepseekUsageSummary } from "./services/analytics.js";
import { readAgyUsage } from "./agy/usage.js";
import { readCodexUsage } from "./codex/usage.js";
import { OUTPUT } from "./logging.js";

let statusBar: vscode.StatusBarItem;
let pollInterval: ReturnType<typeof setTimeout> | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    OUTPUT.info("Claude & Codex History Viewer activating…");

  const config = vscode.workspace.getConfiguration("claudeHistory");
  const claudeDir = resolveClaudeDir(config.get("claudeDirPath", ""), os.homedir());
  const codexDir = resolveCodexDir(config.get("codexDirPath", ""), os.homedir());
  const agyDir = resolveAgyDir(config.get("agyDirPath", ""), os.homedir());
  const historyRoots = { claudeDir, codexDir, agyDir };
  OUTPUT.info(`Claude dir: ${claudeDir}`);
  OUTPUT.info(`Codex dir: ${codexDir}`);
  OUTPUT.info(`AGY dir: ${agyDir}`);
  const maxSizeMB = config.get("maxIndexedFileSizeMB", 50);
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  const autoRefreshSec = config.get("autoRefreshInterval", 0);
  const listDefaults = {
    sort: config.get("defaultSort", "newest") as any,
    display: config.get("defaultDisplayMode", "expanded") as any,
    showArchived: config.get("showArchivedByDefault", false),
    selectedProject: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    providerFilter: "all" as const,
  };
  const listState = new ListStateStore(context.globalState, listDefaults, context.workspaceState);

  // Status bar for indexing progress
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(sync~spin) Indexing coding sessions…";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Init DB
  await initDb(context);

  // Durable, multi-window-safe store for user flags (pinned/archived).
  // The sql.js DB is a shared, last-writer-wins cache; flags must not live
  // there as the source of truth. Seed once from any pre-existing DB flags.
  initSessionFlags(context.globalState);
  seedFlagsFromDbIfEmpty();
  applyFlagsToDb();

  // ---- Webview browser (replaces the three TreeViews) ----
  const browserProvider = new BrowserProvider(
    context.extensionUri,
    listState,
    () => incrementalIndex(historyRoots, maxSizeBytes),
    { codexDir, agyDir },
    context.globalState,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeHistory.browser", browserProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ---- Backup content provider for diff ----
  const backupProvider = new BackupContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "claude-history-backup",
      backupProvider,
    ),
  );

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.refresh", async () => {
      statusBar.text = "$(sync~spin) Refreshing…";
      statusBar.show();
      await incrementalIndex(historyRoots, maxSizeBytes);
      applyFlagsToDb();
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
      statusBar.text = "$(check) Ready";
      setTimeout(() => (statusBar.text = ""), 3000);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.reindex", async () => {
      statusBar.text = "$(sync~spin) Rebuilding search index…";
      statusBar.show();
      await reindexAll(historyRoots, maxSizeBytes, (p) => {
        statusBar.text = `$(sync~spin) Indexing ${p.scanned}/${p.total}…`;
      });
      applyFlagsToDb();
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
      AnalyticsPanel.current?.refresh({ silent: true });
      statusBar.text = "$(check) Index rebuilt";
      setTimeout(() => (statusBar.text = ""), 3000);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeHistory.openSession",
      async (meta: SessionMeta | { sessionId: string; filePath?: string }) => {
        if (!meta) return;
        const panel = ConversationPanel.createOrShow(context.extensionUri, claudeDir);

        // If only sessionId is passed (from search), look up filePath
        let filePath = (meta as SessionMeta).filePath;
        if (!filePath) {
          // Look up from DB
          const { dbGet } = await import("./storage/db.js");
          const row = dbGet(
            "SELECT file_path FROM sessions WHERE session_id = ?",
            [meta.sessionId],
          );
          filePath = row ? String(row.file_path) : "";
        }

        if (filePath) {
          const highlightTerm = (meta as any).highlightTerm;
          await panel.loadSession(filePath, typeof highlightTerm === "string" ? highlightTerm : undefined);

          // If we have an ordinal (from search), scroll to it
          const ordinal = (meta as any).msgOrdinal;
          if (typeof ordinal === "number") {
            panel.scrollToMessage(ordinal);
          }
        }
      },
    ),
  );


  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeHistory.openSubagent",
      async ({ filePath, title }: { filePath: string; title: string }) => {
        if (!filePath) return;
        const panel = ConversationPanel.createOrShow(context.extensionUri, claudeDir);
        await panel.loadSession(filePath);
        // Override the panel title with the subagent description if loadSession produced a generic one
        if (title) panel.setTitle(title);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.openAnalytics", () => {
      AnalyticsPanel.createOrShow(context.extensionUri, context.globalState);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Fatih-Ozdil.claude-code-history-search-analytics");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeHistory.openFile",
      (filePath: string) => {
        if (filePath) {
          vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeHistory.openDiff",
      async (change: {
        filePath: string;
        sessionId?: string;
        backupRef?: string;
        after?: { sessionId: string; backupFileName: string };
      }) => {
        if (!change || !change.filePath) return;
        if (change.backupRef && change.sessionId) {
          const { openDiff } = await import("./diff/backupContentProvider.js");
          await openDiff(
            claudeDir,
            change.sessionId,
            change.backupRef,
            change.filePath,
            change.after,
          );
        } else {
          // No backup available — open the file instead
          await vscode.commands.executeCommand(
            "vscode.open",
            vscode.Uri.file(change.filePath),
          );
        }
      },
    ),
  );

  // ---- Resume commands ----
  const resolveSessionMeta = (arg: SessionMeta | { sessionId: string }): SessionMeta | undefined => {
    if (
      "provider" in arg
      && "nativeSessionId" in arg
      && "projectPath" in arg
      && "filePath" in arg
    ) {
      return arg as SessionMeta;
    }
    const row = dbGet(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`,
      [arg.sessionId],
    );
    return row ? rowToSession(row) : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeHistory.resume.copy",
      async (arg: SessionMeta | { sessionId: string }) => {
        if (!arg) return;
        const meta = resolveSessionMeta(arg);
        if (meta) await copyResumeCommand(meta);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeHistory.resume.run",
      (arg: SessionMeta | { sessionId: string }) => {
        if (!arg) return;
        const meta = resolveSessionMeta(arg);
        if (meta) resumeInTerminal(meta);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeHistory.resume.openInClaudeTab",
      async (meta: SessionMeta) => {
        if (!meta) return;
        await resumeInClaudeTab(meta);
      },
    ),
  );

  // ---- Sort / scope / display commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.setSort", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Date (newest)", value: "newest" },
          { label: "Date (oldest)", value: "oldest" },
          { label: "Most messages", value: "messages" },
          { label: "Most recent activity", value: "activity" },
        ],
        { placeHolder: "Sort sessions by…" },
      );
      if (!pick) return;
      listState.set({ sort: pick.value as any });
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.toggleScope", () => {
      const cur = listState.get().selectedProject;
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      const next = cur ? null : workspacePath;
      listState.set({ selectedProject: next });
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
      vscode.window.setStatusBarMessage(
        `Coding History: showing ${next ? "current project" : "all projects"}`, 2000);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.toggleDisplay", () => {
      const cur = listState.get().display;
      listState.set({ display: cur === "expanded" ? "compact" : "expanded" });
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
    }),
  );

  // ---- Archive commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.archive", (meta: { sessionId: string }) => {
      if (!meta?.sessionId) return;
      setArchived(meta.sessionId, true);
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.unarchive", (arg: SessionMeta | { sessionId: string }) => {
      if (!arg?.sessionId) return;
      const meta = resolveSessionMeta(arg);
      if (meta && isNativeCodexArchive(meta)) {
        unarchiveCodexInTerminal(meta);
        return;
      }
      setArchived(arg.sessionId, false);
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.toggleArchived", () => {
      const cur = listState.get().showArchived;
      listState.set({ showArchived: !cur });
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
      vscode.window.setStatusBarMessage(
        `Coding History: ${!cur ? "showing archived sessions" : "showing active sessions"}`, 2000);
    }),
  );

  // ---- Pin / unpin commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.pin", (meta: { sessionId: string }) => {
      if (!meta?.sessionId) return;
      setPinned(meta.sessionId, true);
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeHistory.unpin", (meta: { sessionId: string }) => {
      if (!meta?.sessionId) return;
      setPinned(meta.sessionId, false);
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
    }),
  );

  // ---- File watcher ----
  const projectsRoot = projectsDir(claudeDir);
  const onHistoryChanged = () => {
    incrementalIndex(historyRoots, maxSizeBytes).then(() => {
      applyFlagsToDb();
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
      AnalyticsPanel.current?.refresh({ silent: true });
    });
  };
  context.subscriptions.push(
    startWatcher(projectsRoot, onHistoryChanged),
    // Watching the provider root also observes thread-name updates in
    // session_index.jsonl as well as active/archive rollout moves.
    startWatcher(codexDir, onHistoryChanged),
    startWatcher(agyDir, onHistoryChanged, 500, MIN_REFIRE_MS, "{**/*.jsonl,conversation_summaries.db}"),
  );

  // ---- Fallback polling (if configured) ----
  if (autoRefreshSec > 0) {
    pollInterval = setInterval(() => {
      incrementalIndex(historyRoots, maxSizeBytes).then(() => {
        applyFlagsToDb();
        browserProvider.refresh();
        updateQuotaStatus(quotaItem);
        AnalyticsPanel.current?.refresh({ silent: true });
      });
    }, autoRefreshSec * 1000);
  }

  // ---- Initial index ----
  incrementalIndex(historyRoots, maxSizeBytes, (p) => {
    if (p.phase === "scanning") {
      statusBar.text = "$(sync~spin) Scanning sessions…";
    } else if (p.phase === "indexing") {
      statusBar.text = `$(sync~spin) Indexing ${p.scanned}/${p.total}…`;
    } else if (p.phase === "complete") {
      statusBar.text = "$(check) Ready";
      restoreMigratedFlags();
      applyFlagsToDb();
      browserProvider.refresh();
      updateQuotaStatus(quotaItem);
      AnalyticsPanel.current?.refresh({ silent: true });
      setTimeout(() => (statusBar.text = ""), 5000);
    } else if (p.phase === "error") {
      statusBar.text = "$(error) Index error";
    }
  });

  // ---- Config change listener ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("claudeHistory.quota.statusBarProviders") ||
        e.affectsConfiguration("claudeHistory.quota.claudeUsagePollSeconds")
      ) {
        updateQuotaStatus(quotaItem);
      }
      if (e.affectsConfiguration("claudeHistory.autoRefreshInterval")) {
        const newInterval = vscode.workspace
          .getConfiguration("claudeHistory")
          .get("autoRefreshInterval", 0);
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        if (newInterval > 0) {
          pollInterval = setInterval(() => {
            incrementalIndex(historyRoots, maxSizeBytes).then(() => {
              browserProvider.refresh();
              updateQuotaStatus(quotaItem);
            });
          }, newInterval * 1000);
        }
      }
    }),
  );

  // ---- Quota status bar item ----
  const quotaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  quotaItem.command = "claudeHistory.openAnalytics";
  quotaItem.tooltip = "Provider API usage (local estimates)";
  quotaItem.show();
  context.subscriptions.push(quotaItem);
  let quotaUpdateGeneration = 0;

  async function updateQuotaStatus(item: vscode.StatusBarItem): Promise<void> {
    const generation = ++quotaUpdateGeneration;
    try {
      const quotaConfig = vscode.workspace.getConfiguration("claudeHistory.quota");
      const configuredProviders = quotaConfig.get<unknown[]>("statusBarProviders", ["claude", "codex"]);
      const providers = (Array.isArray(configuredProviders) ? configuredProviders : ["claude", "codex"])
        .filter((provider): provider is string => typeof provider === "string" && ["claude", "gemini", "codex", "deepseek", "agy"].includes(provider))
        .slice(0, 2);
      // The Claude entry is the only thing here that needs a live server
      // reading. When it is not on the status bar, or the user turned polling
      // off, resolve from cache/estimate instead of spending a request.
      const pollMs = resolveUsagePollMs(quotaConfig.get("claudeUsagePollSeconds", 300));
      const quota = await resolveQuota({
        ...(pollMs !== null ? { softTtlMs: pollMs } : {}),
        allowLive: pollMs !== null && providers.includes("claude"),
      });
      const agyUsage = providers.includes("agy") ? await readAgyUsage(agyDir) : null;
      const codexUsage = providers.includes("codex") ? await readCodexUsage(codexDir) : null;
      // The full analytics aggregation is a multi-second synchronous sql.js
      // scan on a warm DB; it is only needed here to derive the DeepSeek
      // entry, so skip it entirely unless DeepSeek is actually configured
      // for the status bar.
      const deepseekUsage = providers.includes("deepseek") ? deepseekUsageSummary() : { tokens: 0, cost: 0 };
      if (generation !== quotaUpdateGeneration) return;
      // Only surface providers that actually have data locally; a provider
      // configured but absent (no live limit / no indexed usage) is hidden
      // rather than shown as an empty "— " placeholder.
      const entries = providers.map((provider) => {
        if (provider === "claude") return `Claude ${quota.fiveHour.remainingPct}%/${quota.weekly.remainingPct}%`;
        if (provider === "agy") return agyUsage ? `AGY ${agyUsage.remainingPct}%` : null;
        if (provider === "codex") {
          if (!codexUsage) return null;
          const primary = Math.round(codexUsage.primaryRemainingPct);
          // Hide the secondary window when Codex has not reported it (avoids the
          // misleading "0%" that reads as a fully-exhausted weekly limit).
          return typeof codexUsage.secondaryRemainingPct === "number"
            ? `Codex ${primary}%/${Math.round(codexUsage.secondaryRemainingPct)}%`
            : `Codex ${primary}%`;
        }
        if (provider === "deepseek") return deepseekUsage.tokens > 0 ? `DeepSeek ${formatCostShort(deepseekUsage.cost)}` : null;
        return null;
      }).filter((entry): entry is string => entry !== null);
      item.text = `$(pulse) ${entries.join(" · ") || "—"}`;
      // A missing live reading has two very different causes now: the user is
      // not signed in, or the user (or the provider list) turned live polling
      // off. Say which one, otherwise the tooltip blames a sign-in problem for
      // a setting the user chose.
      const liveSuppressed = pollMs === null || !providers.includes("claude");
      const detail = quota.source !== "live"
        ? liveSuppressed
          ? "Claude live polling off · local API-cost estimates only"
          : "Claude quota unavailable · local API-cost estimates only"
        : quota.cachedAtMs !== undefined
          ? `live · cached ${fmtAge(Date.now() - quota.cachedAtMs)} ago`
          : "live · from claude.ai";
      item.tooltip = [
        `Provider API usage (${detail})`,
        ...(deepseekUsage.tokens > 0 ? [`DeepSeek API usage: ${formatTokensShort(deepseekUsage.tokens)} tokens · ${formatCostShort(deepseekUsage.cost)} estimated cost`] : []),
        ...(agyUsage ? [`AGY live quota: ${agyUsage.remainingPct}% remaining${agyUsage.resetsAt ? ` · resets ${fmtResetStamp(agyUsage.resetsAt)}` : ""}`] : []),
        ...(codexUsage ? [codexTooltipLine(codexUsage)] : []),
        ...(quota.source === "live" ? [
          `Claude 5h quota: ${quota.fiveHour.remainingPct}% remaining · resets in ${fmtDuration(quota.fiveHour.resetsIn)}`,
          `Claude 7d quota: ${quota.weekly.remainingPct}% remaining · resets in ${fmtDuration(quota.weekly.resetsIn)}`,
        ] : [liveSuppressed
          ? "Claude quota: live polling is off (claudeHistory.quota.claudeUsagePollSeconds)"
          : "Claude quota: unavailable (sign in to Claude Code for live limits)"]),
      ].join("\n");
    } catch {
      if (generation !== quotaUpdateGeneration) return;
      item.text = "$(pulse) —";
      item.tooltip = "Provider API usage unavailable";
    }
  }

  function fmtDuration(ms: number): string {
    if (ms <= 0) return "soon";
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m`;
  }

  /** Human window label from Codex's `window_minutes` (300 → "5h", 10080 → "7d"). */
  function codexWindowShort(min: number | undefined, fallback: string): string {
    if (typeof min !== "number" || min <= 0) return fallback;
    if (min % 10080 === 0) return `${(min / 10080) * 7}d`;
    if (min % 1440 === 0) return `${min / 1440}d`;
    if (min % 60 === 0) return `${min / 60}h`;
    return `${min}m`;
  }

  /** "resets in 2h 5m" from an epoch-seconds reset timestamp (empty when past/absent). */
  function fmtResetSeconds(resetsAt: number | undefined): string {
    if (typeof resetsAt !== "number") return "";
    const ms = resetsAt * 1000 - Date.now();
    return ms > 0 ? ` · resets in ${fmtDuration(ms)}` : "";
  }

  /** "resets in 2d 3h" from an ISO reset timestamp (falls back to the raw value). */
  function fmtResetStamp(iso: string): string {
    const ms = Date.parse(iso) - Date.now();
    return ms > 0 ? `in ${fmtDuration(ms)}` : iso;
  }

  function codexTooltipLine(u: Awaited<ReturnType<typeof readCodexUsage>>): string {
    if (!u) return "";
    const parts = [
      `${Math.round(u.primaryRemainingPct)}% remaining (${codexWindowShort(u.primaryWindowMinutes, "5h")})${fmtResetSeconds(u.primaryResetsAt)}`,
    ];
    if (typeof u.secondaryRemainingPct === "number") {
      parts.push(`${Math.round(u.secondaryRemainingPct)}% remaining (${codexWindowShort(u.secondaryWindowMinutes, "7d")})${fmtResetSeconds(u.secondaryResetsAt)}`);
    }
    return `Codex live rate limit: ${parts.join(" · ")}`;
  }

  function formatCostShort(cost: number): string {
    return cost < 0.01 && cost > 0 ? "<$0.01" : `$${cost.toFixed(2)}`;
  }

  function formatTokensShort(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return String(Math.round(tokens));
  }

  function fmtAge(ms: number): string {
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h`;
    if (m > 0) return `${m}m`;
    return "<1m";
  }

  updateQuotaStatus(quotaItem);

  const quotaTimer = setInterval(() => updateQuotaStatus(quotaItem), 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(quotaTimer) });

  } catch (err: any) {
    OUTPUT.error(`Activation failed: ${err?.message ?? err}`);
    vscode.window.showErrorMessage(`Claude & Codex History: ${err?.message ?? "activation failed"}`);
    throw err;
  }
}

export function deactivate(): Promise<void> {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  return closeDb();
}
