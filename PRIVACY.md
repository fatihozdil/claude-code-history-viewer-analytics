# Privacy Statement

Claude Code History Viewer is designed to keep your data entirely on your machine.

## What the extension does

- Reads Claude Code session files from `~/.claude/projects/` (or a configured path).
- Builds a local search index stored in VS Code's global storage.
- Renders conversations in a webview panel inside VS Code.
- Shows file changes by reading tool-call data from session files.
- Provides diff views using file-history backup blobs stored by Claude Code.

## What the extension does NOT do

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

## Data stored locally

| Data | Location | Purpose |
|---|---|---|
| Session metadata cache | VS Code global storage: `history.sqlite` | Fast listing of projects/sessions |
| Search index | Inside `history.sqlite` (FTS5) | Full-text search |
| File change index | Inside `history.sqlite` | Per-session file change lists |

All data is derived from your existing `~/.claude/` directory. No conversation
content is persisted outside of what Claude Code already stores on disk. The
conversation viewer reads session files on demand — full message bodies are never
cached in the database.

## Webview security

The conversation viewer uses a VS Code Webview with a strict Content Security Policy:

- No remote content (`default-src 'none'`)
- Scripts run only with a cryptographic nonce
- Styles are allowed only from the extension's own CSS files
- Images are restricted to data URIs and local resources

## Data removal

Uninstalling the extension removes the `history.sqlite` database file from VS Code's
global storage. No data persists after uninstallation.

## Third-party libraries

The extension bundles:

- **sql.js** (WASM SQLite) — the database engine runs entirely in-memory and on-disk;
  no network access.
- **markdown-it** — client-side Markdown rendering; no network access.
- **highlight.js** — client-side syntax highlighting; no network access.

All dependencies are bundled into the extension and run locally.

## Questions

If you have questions about the extension's privacy properties, open an issue on this
repository. The extension is MIT licensed; the bundled dependency list is visible in
the published package's `package.json`.
