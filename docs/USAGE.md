# Usage Guide

## Sidebar (Browser)

The **Claude History** icon in the Activity Bar opens a single sidebar panel with everything you need to browse sessions:

- **Header** — title and a **Refresh** button (forces a full re-scan of `~/.claude/projects/`).
- **Project filter** — dropdown to scope the list to a single project or show all.
- **Search** — type in the search box to run a full-text search across all indexed conversations; results are grouped by project and session, with the matching message highlighted. Clear the box to return to the normal list.
- **Sort** — dropdown with **Date (newest)**, **Date (oldest)**, **Most messages**, **Most recent activity**. Pinned sessions always float to the top regardless of sort.
- **Compact toggle** — collapses each session row to just its title and relative timestamp.
- **Archive toggle** — shows archived sessions instead of the normal list.

### Session cards

Each card shows:

- **Title** and **relative time** (e.g. "3h ago")
- **Message count**
- **Files modified** — distinct files touched (shown when > 0)
- **Cost** — shown when the session's JSONL includes `costUSD` data (not estimated from tokens)
- **Lines changed** — `+added / -removed` from file-editing tool calls

**Click a card** to open the conversation viewer. **Right-click** (or use the hover icons) for:

- **Open Conversation**
- **Resume in Terminal** — opens a new integrated terminal and runs `claude --resume`
- **Open Terminal with Resume** — opens a terminal and pastes the command (you press Enter)
- **Copy Resume Command** — copies `claude --resume <sessionId>` to your clipboard
- **Pin / Unpin** — pinned sessions float to the top of every sort and persist across restarts
- **Archive / Unarchive** — archived sessions disappear from the normal list and from search results; persists across restarts

Both locations are watched. New active sessions and appended turns normally appear
after the short watcher debounce without restarting VS Code. A thread name from
Codex's local `session_index.jsonl` is used when available; otherwise the first user
message becomes the title.

Opens in its own panel and renders:

The viewer supports both providers and renders:

Search results scroll you directly to the matching message with a highlight animation.

## Analytics Dashboard

Run **Claude History: Open Analytics Dashboard** (`Cmd+Shift+P`) to open a separate panel with:

- **Plan Usage** — quota cards per plan tier
- **Activity heatmap** — last 84 days
- **Session Metrics** — Active Hours and Weekly Distribution charts, plus average messages/tokens per session
- **Daily Usage** — per-day table (cost, tokens, sessions)
- **By Project** — usage broken down by project
- **Top Modified Files** — most-touched files across all sessions; **click a row** to open the file directly in the editor

A small **⟳ Refresh** button re-pulls the underlying usage cache.

## Quota Status Bar

A status bar item shows your current plan usage and reset window at a glance. It refreshes periodically without any manual action.

## Refresh & Indexing

- The extension **watches** `~/.claude/projects/` for changes. New sessions appear automatically within ~1 second of being created.
- Click the **Refresh** button in the sidebar header to force a full re-scan.
- Run **Claude History: Rebuild Search Index** (`Cmd+Shift+P`) to rebuild the search index from scratch.

## Feedback

Click the **Feedback** button in the sidebar to open a GitHub issue against the project — useful for bug reports or feature requests.

## Configuration

Open Settings and search for `claudeHistory`. This namespace is retained for
backward compatibility even though both providers are supported.

| Setting | Default | Purpose |
|---|---|---|
| `claudeHistory.claudeDirPath` | `""` | Claude Code data directory; empty uses `~/.claude`. |
| `claudeHistory.codexDirPath` | `""` | Codex data directory; empty uses `$CODEX_HOME`, then `~/.codex`. |
| `claudeHistory.maxIndexedFileSizeMB` | `50` | Maximum session size indexed. |
| `claudeHistory.autoRefreshInterval` | `0` | Optional fallback polling interval in seconds. |
| `claudeHistory.inheritTheme` | `true` | Follow the current VS Code theme. |
| `claudeHistory.defaultSort` | `"newest"` | Initial sort order. |
| `claudeHistory.defaultDisplayMode` | `"expanded"` | Initial row density. |
| `claudeHistory.showArchivedByDefault` | `false` | Start in the archived list. |

Reload the VS Code window after changing a provider directory so its watchers use
the new path.
