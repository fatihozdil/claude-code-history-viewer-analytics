# Installation Guide

## Prerequisites

- **VS Code** 1.85.0 or later
- macOS, Linux, or Windows
- Existing Claude Code and/or Codex history to browse
- The relevant CLI only if you want to resume sessions:
  - Claude Code: `claude --version`
  - Codex: `codex --version`

You can install the extension with only one provider present. A missing history
directory is treated as an empty provider, not an activation error.

## Install from VS Code Marketplace

1. Open the Extensions view (`Cmd+Shift+X`).
2. Search for **Claude Code History Search Analytics**.
3. Click **Install**.

## Alternative: Install from VSIX

If you'd rather install manually (e.g. before a marketplace release, or to pin a specific version):

1. Download the `.vsix` file from the [GitHub Releases page](https://github.com/fatihozdil/claude-code-history-viewer-analytics/releases).
2. Install it:
   ```bash
   code --install-extension claude-code-history-search-analytics-<version>.vsix
   ```
3. Reload VS Code (`Cmd+Shift+P` → **Developer: Reload Window**).

## Verify Installation

The extension discovers both providers automatically:

| Provider | Location |
|---|---|
| Claude Code | `~/.claude/projects/` |
| Active Codex sessions | `$CODEX_HOME/sessions/`, or `~/.codex/sessions/` when `CODEX_HOME` is unset |
| Natively archived Codex sessions | `$CODEX_HOME/archived_sessions/`, or `~/.codex/archived_sessions/` |

Use `claudeHistory.claudeDirPath` or `claudeHistory.codexDirPath` when your data
lives elsewhere. Each setting expects the provider's data directory itself—for
example `~/.codex`, not its `sessions` child. When `codexDirPath` is empty, the
extension honors `CODEX_HOME` before falling back to `~/.codex`.

Reload the VS Code window after changing a directory setting so the live file
watchers are recreated for the new location.

## Verify installation

- Open **Claude & Codex History** from the Activity Bar.
- The unified browser should show stored sessions within a few seconds.
- Every session card has a **Claude** or **Codex** provider badge.
- Use **Show Archived** to see locally archived sessions and Codex rollouts found
  in Codex's native `archived_sessions` directory.

If nothing appears, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Updating

Install the new `.vsix` with `--force` or update from the Marketplace, then reload
VS Code. A schema change may rebuild the local derived index; original provider
session files are not modified.

## Uninstalling

1. Open the Extensions view.
2. Find **Claude Code History Search Analytics**.
3. Click **Uninstall**.

The extension never deletes the original Claude Code or Codex history. Its derived
`history.sqlite` index lives in the extension's VS Code global-storage directory.
