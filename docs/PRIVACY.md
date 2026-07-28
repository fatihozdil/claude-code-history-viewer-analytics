# Privacy Statement

Claude Code History Search Analytics is designed to keep your data entirely on your machine.

## Local history access

The extension reads:

- Claude Code sessions from `~/.claude/projects/` or the configured Claude directory
- Active Codex rollouts from `$CODEX_HOME/sessions/` or `~/.codex/sessions/`
- Natively archived Codex rollouts from the corresponding `archived_sessions/` directory
- Codex's local `session_index.jsonl` for thread titles when available
- Claude Code file-history backup blobs when opening a supported Claude diff

- **No network requests from the extension itself.** The extension does not call any
  external API, server, or cloud service, and contains zero HTTP client code. The one
  exception is the **Feedback** button, which opens a GitHub issues page in your default
  browser via VS Code's `openExternal` API — this is a manual, user-initiated action, not
  a background request, and no data is sent automatically.
- **No telemetry.** No usage data, error reports, or analytics are collected or sent
  anywhere. VS Code's built-in telemetry settings are respected but the extension does
  not add its own.
- **No data upload.** Your prompts, responses, file contents, diffs, and session metadata
  never leave your machine through this extension.
- **No accounts or authentication.** There is no login, no user profile, no OAuth flow.
- **No payment or licensing.** All features are available to all users without
  registration, subscription, or license key.
- **No cloud synchronization.** The local database is stored in VS Code's global storage
  directory on your filesystem. It is not synced to any cloud service.

## Local data stored by the extension

| Data | Location | Purpose |
|---|---|---|
| Session metadata | VS Code extension global storage, `history.sqlite` | Fast lists, project filters, provider identity, pins, and archive state |
| Searchable message/tool text | `history.sqlite` | Local keyword search and result snippets |
| Extracted file-change metadata | `history.sqlite` | Claude tool impact, structured Codex patch impact, and supported Claude diff actions |
| Claude live-usage cache | `~/.claude/.cc-history-usage-cache.json` | Reuse the last successful quota reading while its window is valid |

The full conversation viewer reads the original JSONL file on demand. The search
index stores normalized searchable text, not just metadata, so deleting original
history alone does not immediately erase already indexed snippets. Refresh or rebuild
the index after deleting provider history, or remove the extension's global-storage
database.

## Network behavior

Browsing, search, resume-command generation, and Codex support do not require an
extension backend and continue to work offline.

To populate the **Claude Usage** indicator, the extension may read an existing Claude
Code OAuth credential from the platform credential store (or Claude's local credential
file) and send an authenticated request to Anthropic's Claude usage endpoint. That
request contains the credential required for authentication but does **not** include
prompts, responses, files, diffs, search terms, session metadata, or Codex data. The
response contains quota utilization and reset times. If it cannot be fetched, the
extension uses a still-valid cache or a local Claude-only estimate.

The extension does not send telemetry, analytics events, crash reports, or
conversation data to its publisher. It has no cloud index or synchronization service.

## Accounts and authentication

The extension has no separate account, login screen, subscription, payment, or
license system. Reading an existing Claude Code credential for the usage indicator
does not create an extension account. The extension does not read Codex credentials.

## Webview security

Conversation content is rendered in a VS Code webview with a Content Security Policy:

- Remote content is blocked by `default-src 'none'`
- Scripts load only from the extension with a per-page nonce
- Styles and fonts load from extension resources
- Images are restricted to extension resources and data URIs

## Data removal

Uninstalling does not touch `~/.claude`, `~/.codex`, or `CODEX_HOME`. To remove all
derived extension data manually, delete its VS Code global-storage directory and the
optional `~/.claude/.cc-history-usage-cache.json` file.

## Bundled libraries

- **sql.js** provides the local SQLite-compatible database.
- **markdown-it** renders Markdown locally.
- **highlight.js** performs local syntax highlighting.
- **Preact** renders the sidebar UI.

- **sql.js** (WASM SQLite) — the database engine runs entirely in-memory and on-disk;
  no network access.
- **markdown-it** — client-side Markdown rendering; no network access.
- **highlight.js** — client-side syntax highlighting; no network access.

All dependencies are bundled into the extension and run locally.

## Questions

If you have questions about the extension's privacy properties, check `package.json`
for the full dependency list, or open an issue on the repository.
