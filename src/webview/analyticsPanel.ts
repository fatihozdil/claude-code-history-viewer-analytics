import * as vscode from "vscode";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { buildAnalytics, type AnalyticsData } from "../services/analytics.js";
import { resolveQuota } from "../services/quota.js";
import { readCodexUsage } from "../codex/usage.js";
import { readAgyUsage } from "../agy/usage.js";
import { resolveAgyDir, resolveCodexDir } from "../discovery/paths.js";
import { PROVIDER_ICON_MARKUP } from "./providerIcons.js";
import { createPollTimer, ANALYTICS_REFRESH_MS, type PollTimer } from "../services/pollTimer.js";

/**
 * Singleton webview panel for the analytics dashboard.
 *
 * Modeled on ConversationPanel — same CSP, nonce, asWebviewUri pattern.
 * The last completed snapshot is persisted so reopening the dashboard never
 * has to wait for the live quota and aggregation pass before showing data.
 */
export class AnalyticsPanel {
  public static current: AnalyticsPanel | undefined;

  private static readonly CACHE_KEY = "claudeHistory.analyticsSnapshot.v1";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _state: vscode.Memento;
  private _disposables: vscode.Disposable[] = [];
  private _refreshPromise: Promise<void> | undefined;
  private _inFlightForce = false;
  private _pollTimer: PollTimer | undefined;

  public static createOrShow(extensionUri: vscode.Uri, state: vscode.Memento): AnalyticsPanel {
    if (AnalyticsPanel.current) {
      AnalyticsPanel.current._panel.reveal();
      return AnalyticsPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeHistory.analytics",
      "Usage Analytics",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    AnalyticsPanel.current = new AnalyticsPanel(panel, extensionUri, state);
    return AnalyticsPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, state: vscode.Memento) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._state = state;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables,
    );
    this._panel.webview.html = this._getHtml();

    // Mirrors the quota status bar's unconditional 5-minute timer. Owned by
    // the panel (rather than created at activation) so it stops when the tab
    // is closed. Non-forced, so it rides the same quota cache as the status
    // bar and costs almost nothing.
    this._pollTimer = createPollTimer(() => {
      void this.refresh({ silent: true });
    }, ANALYTICS_REFRESH_MS);
  }

  /**
   * Re-query the DB and push fresh data to the webview.
   *
   * `force` bypasses the quota module's 90s soft-TTL throttle (used by the
   * refresh button). `silent` marks a background pass: failures keep the
   * existing dashboard rather than replacing it with an error banner.
   */
  async refresh(opts: { force?: boolean; silent?: boolean } = {}): Promise<void> {
    const force = opts.force ?? false;
    const silent = opts.silent ?? false;

    if (this._refreshPromise) {
      // An in-flight pass satisfies this request only if it is at least as
      // strong. A forced button press must not be swallowed by a background
      // pass that is riding the cache instead of really fetching.
      if (!force || this._inFlightForce) return this._refreshPromise;
      await this._refreshPromise.catch(() => {});
      if (this._refreshPromise) return this._refreshPromise;
    }

    this._inFlightForce = force;
    this._refreshPromise = this._refresh(force, silent);
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = undefined;
      this._inFlightForce = false;
    }
  }

  private async _refresh(force: boolean, silent: boolean): Promise<void> {
    try {
      // Prefer real server-side utilization; falls back to cache then estimate.
      // An explicit refresh-button press forces past the short-TTL throttle.
      const quota = await resolveQuota({ force });
      const config = vscode.workspace.getConfiguration("claudeHistory");
      const home = os.homedir();
      const codexDir = resolveCodexDir(config.get("codexDirPath", ""), home);
      const agyDir = resolveAgyDir(config.get("agyDirPath", ""), home);
      const [codex, agy] = await Promise.all([readCodexUsage(codexDir), readAgyUsage(agyDir)]);
      const data = buildAnalytics(quota, undefined, {
        ...(codex ? { codex } : {}),
        ...(agy ? { agy } : {}),
      });
      const updatedAt = Date.now();
      await this._panel.webview.postMessage({ type: "data", payload: data, updatedAt });
      await this._state.update(AnalyticsPanel.CACHE_KEY, { data, updatedAt });
    } catch (err) {
      if (silent) {
        // A background refresh that fails leaves the last good dashboard in
        // place; surfacing a banner over data the user is reading is worse
        // than showing a slightly older number.
        return;
      }
      this._panel.webview.postMessage({
        type: "error",
        message: String(err),
      });
    }
  }

  private _handleMessage(msg: any): void {
    if (msg?.command === "openFile" && typeof msg.filePath === "string") {
      vscode.commands.executeCommand("claudeHistory.openFile", msg.filePath);
    } else if (msg?.command === "refresh") {
      this.refresh({ force: true });
    } else if (msg?.command === "ready") {
      const cached = this._state.get<{ data: AnalyticsData; updatedAt: number }>(
        AnalyticsPanel.CACHE_KEY,
      );
      if (cached?.data) {
        // Paint the previous result first; the fresh result replaces it when
        // the background refresh completes.
        this._panel.webview.postMessage({
          type: "data",
          payload: cached.data,
          updatedAt: cached.updatedAt,
          cached: true,
        });
        // Something is already painted, so a failed refresh should leave it
        // alone rather than swap it for an error banner.
        this.refresh({ silent: true });
      } else {
        this._panel.webview.postMessage({ type: "loading" });
        // Nothing is painted yet: staying silent here would leave the loading
        // spinner running forever, so this failure must surface.
        this.refresh();
      }
    }
  }

  dispose(): void {
    this._pollTimer?.dispose();
    this._pollTimer = undefined;
    AnalyticsPanel.current = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }

  private _getHtml(): string {
    const wv = this._panel.webview;
    const styleUri = wv.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "analytics.css"),
    );
    const scriptUri = wv.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "analytics.js"),
    );
    const codiconUri = wv.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "codicon.css"),
    );

    const nonce = randomBytes(16).toString("base64");
    const providerIcons = JSON.stringify(PROVIDER_ICON_MARKUP);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${wv.cspSource} 'unsafe-inline'; script-src ${wv.cspSource} 'nonce-${nonce}'; font-src ${wv.cspSource};">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Usage Analytics</title>
</head>
<body>
  <div id="app">
    <div id="error-banner" class="error-banner hidden"></div>
    <div id="loading" class="loading"><span class="loading-spinner"></span><span>Loading analytics…</span></div>
    <div id="content" class="hidden">
      <div id="page-header">
        <h1>Usage Analytics</h1>
        <div id="refresh-controls">
          <span id="last-updated" class="table-count"></span>
          <button id="refresh-btn" class="btn">⟳ Refresh</button>
        </div>
      </div>

      <section id="metric-cards" class="card-row"></section>

      <section id="provider-usage-section">
        <div class="section-heading"><div><h2>Provider Usage</h2><p class="section-copy">Live limits where the CLI exposes them, plus local history for every provider.</p></div></div>
        <div id="provider-usage-cards" class="provider-usage-grid"></div>
      </section>

      <section id="heatmap-section">
        <h2>Activity (last 84 days)</h2>
        <div id="heatmap"></div>
      </section>

      <section id="session-metrics-section">
        <h2>Session Metrics</h2>
        <div class="metrics-row">
          <div class="metrics-card">
            <h3>Active Hours</h3>
            <div id="hours-chart"></div>
          </div>
          <div class="metrics-card">
            <h3>Weekly Distribution</h3>
            <div id="weekday-chart"></div>
          </div>
        </div>
        <div class="card-row">
          <div class="card">
            <div class="card-label">Avg messages/session</div>
            <div id="avg-messages-card" class="card-number"></div>
          </div>
          <div class="card">
            <div class="card-label">Avg tokens/message</div>
            <div id="avg-tokens-card" class="card-number"></div>
          </div>
        </div>
      </section>

      <section id="daily-section">
        <h2>Daily Usage</h2>
        <div id="daily-controls">
          <button id="show-all-btn" class="btn">Show all</button>
          <span id="daily-count" class="table-count"></span>
        </div>
        <div class="table-wrap">
          <table id="daily-table">
            <thead>
              <tr>
                <th data-col="date" class="sortable sorted-desc">Date</th>
                <th data-col="sessions" class="sortable">Sessions</th>
                <th data-col="messages" class="sortable">Messages</th>
                <th data-col="tokens" class="sortable">Tokens</th>
                <th data-col="cost" class="sortable">Est. cost</th>
              </tr>
            </thead>
            <tbody id="daily-body"></tbody>
          </table>
        </div>
      </section>

      <section id="projects-section">
        <h2>By Project</h2>
        <div class="table-wrap">
          <table id="projects-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Sessions</th>
                <th>Tokens</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody id="projects-body"></tbody>
          </table>
        </div>
      </section>

      <section id="providers-section">
        <h2>By Provider</h2>
        <div class="table-wrap"><table><thead><tr><th>Provider</th><th>Sessions</th><th>Tokens</th><th>Est. cost</th></tr></thead><tbody id="providers-body"></tbody></table></div>
      </section>

      <section id="models-section">
        <div class="section-heading"><div><h2>Models</h2><p class="section-copy">Token volume and estimated cost, ranked by usage.</p></div></div>
        <div id="models-body" class="model-list"></div>
      </section>

      <section id="files-section">
        <h2>Top Modified Files</h2>
        <div class="table-wrap">
          <table id="files-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Sessions</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody id="files-body"></tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
  <div id="chart-tooltip" class="chart-tooltip hidden"></div>
  <script nonce="${nonce}">window.__providerIcons = ${providerIcons};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
