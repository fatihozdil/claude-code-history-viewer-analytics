# Claude Code History Search Analytics

Browse, search, inspect, and resume Claude Code, OpenAI Codex,  and Antigravity AGY CLI conversations — directly inside VS Code.
---
You can support this project by giving a star on GitHub ⭐️ or by becoming an sponsor 💰

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/fatihozdil)


## Multi-provider session browser

- **Unified sidebar** shows sessions from every supported CLI grouped by project, each tagged with a color-coded provider badge (Claude, Codex, Antigravity, DeepSeek) so you can tell at a glance where a conversation came from
- **Provider filter** — narrow the list to "All Providers" or a single CLI directly from the toolbar dropdown

![](./media/provider-filter.png)



- **Session metadata cards** — message count, files modified, cost (when available), +/- lines changed
- **Sorting** — by date, message count, or recent activity; pinned sessions float to the top
![](./media/image4.png)

- **Project filtering** — scope the list to your current VS Code workspace or browse all projects
- **Compact view** — toggle between full metadata and a minimal title+timestamp view

![](./media/image5.png)

- **Archive + Pin** — archive old sessions out of sight; pin favorites to the top. Both persist across restarts.
![](./media/image3.png)
- **Full conversation viewer** with Markdown, syntax highlighting, and collapsible tool calls/outputs
- **Full-text search** across all indexed conversations
![](./media/search.png "Search")
![](./media/image-1.png)
- **Files changed panel** — every file touched during a session, with per-file +/- line counts, grouped into Project files vs Other (Claude/system), and native VS Code diffs on click
- **Branch, subagent & fork grouping** — sessions branched with `/branch` or forked via the app's "Fork conversation from here" are grouped under their parent, with expand/collapse toggles and dismissible "possible fork" links for heuristically detected forks
- **One-click resume** — resume through `claude --resume`, `codex resume`, or `agy --conversation`
![](./media/image2.png)

## Analytics dashboard

- **Provider Usage** — live quota cards for every provider that exposes limits (Claude 5-hour/7-day plan, Codex weekly limit, Antigravity per-model limits), plus session/token/cost totals for providers with local-history-only tracking like DeepSeek

![](./media/provider-usage.png)

- **By Provider breakdown** — sessions, tokens, and estimated cost rolled up per provider in one table

![](./media/analytics-by-provider.png)

- **Models breakdown** — token volume and estimated cost ranked by usage, across every model from every provider

![](./media/analytics-models.png)

- Active hours, weekly distribution, top modified files, and usage trends
![](./media/analytics.png "analytics")

## Quota status bar

- Track plan usage and reset windows at a glance from the VS Code status bar
![](./media/quota.png "quota")
- **Configurable providers** — choose which two providers show in the status bar; hover either one to see full usage and estimated API cost

![](./media/quota-settings.png)



## Design

- **Local-first** — all data stays on your machine. No cloud backend, no sync, no API calls.
- **Privacy-first** — no telemetry, no analytics, no accounts, no payment.
- **Multi-provider** — supports Claude Code, OpenAI Codex, Antigravity AGY CLI, and DeepSeek local history.

## Quick Start

1. Click the **Claude History** icon in the Activity Bar.
2. The extension automatically discovers Claude (`~/.claude/projects/`), Codex (`~/.codex/`), Antigravity (`~/.gemini/antigravity-cli/` or `~/.gemini/antigravity/`), and DeepSeek sessions.
3. Click any session to view it; use the search icon in the Search view to search across
   all conversations.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudeHistory.claudeDirPath` | `""` | Path to Claude directory. Leave empty for `~/.claude`. |
| `claudeHistory.codexDirPath` | `""` | Path to Codex directory. Leave empty for `$CODEX_HOME` or `~/.codex`. |
| `claudeHistory.agyDirPath` | `""` | Path to Antigravity data. Leave empty to auto-detect the installed Antigravity directory. |
| `claudeHistory.enableSearchIndexing` | `true` | Build and maintain the full-text search index. |
| `claudeHistory.maxIndexedFileSizeMB` | `50` | Skip indexing session files larger than this. |
| `claudeHistory.autoRefreshInterval` | `0` | Fallback polling interval (seconds). `0` = off. The file watcher handles live detection. |
| `claudeHistory.inheritTheme` | `true` | Conversation viewer follows the VS Code color theme. |
| `claudeHistory.defaultSort` | `"newest"` | Default sort order: newest, oldest, messages, activity. |
| `claudeHistory.defaultDisplayMode` | `"expanded"` | Default display density: expanded or compact. |
| `claudeHistory.showArchivedByDefault` | `false` | Show archived sessions in the list by default. |

## Feedback & Support

Found a bug or have a feature request? Use the **Feedback** button in the sidebar, or open an issue directly:
[github.com/fatihozdil/claude-code-history-viewer-analytics/issues](https://github.com/fatihozdil/claude-code-history-viewer-analytics/issues)

## Documentation

More details: [Usage Guide](https://github.com/fatihozdil/claude-code-history-viewer-analytics/blob/main/docs/USAGE.md), [Privacy Statement](https://github.com/fatihozdil/claude-code-history-viewer-analytics/blob/main/docs/PRIVACY.md), and [Changelog](https://github.com/fatihozdil/claude-code-history-viewer-analytics/blob/main/CHANGELOG.md).

## Contributing

Fork the repo, make your change, and open a pull request — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the build, test, and local-install steps.
Pull requests run the test suite automatically. Releases are cut by the maintainer.

## License

MIT — see [LICENSE](LICENSE).
