# Changelog

All notable changes to this extension are documented in this file.

## [Unreleased]

### Fixed
- **Sorting now works on search results** — Switching between Newest, Oldest, Most messages, Recent activity, Cost or Impact while a search was active left the result list untouched: search results were emitted in raw match order and a sort change only refreshed the unfiltered list the webview was not showing. The sort is now applied to search results and re-runs the active search. Cost sorting keeps sessions without a recorded cost after real $0 ones, matching the SQL ordering.

## [1.13.3] - 2026-07-28

### Added
- **Usage Analytics refreshes itself in the background** — The analytics dashboard now stays current on its own, updating whenever your history changes and on a 5-minute timer, matching how the quota status bar already worked. Opening the panel no longer shows stale numbers, and there is no need to press "⟳ Refresh".

### Changed
- **Now open source under the MIT license** — The extension was previously distributed under proprietary "all rights reserved" terms. It is now MIT licensed, so you are free to use, modify, and redistribute it.

### Fixed
- **Daily Usage table state survives a refresh** — The table's sort column, "Show all" expansion, and your scroll position are now preserved when the dashboard updates, instead of being reset back to defaults.

## [1.13.2] - 2026-07-16

### Fixed
- **Pin/Rename now update search results immediately** — Pinning or renaming a session from a filtered search results view previously updated the underlying data but left the results list showing stale state (no pin indicator, old title) until the search was cleared. Both actions now refresh the active search results in place.

### Added
- **"Don't Show Again" option for the rename cache notice** — The notification explaining that a provider's tab caches titles until reload can now be permanently dismissed.

## [1.13.0] - 2026-07-15

### Added
- **Ungroup/Regroup branch action** — Branch children nested under their parent in the sidebar can now be pulled out to display as top-level sessions via a context menu action, and regrouped back under their parent at any time.

## [1.12.3] - 2026-07-14

No user-facing changes; version bump only.

## [1.12.2] - 2026-07-14

### Fixed
- **High CPU usage from background scanning** — The background session-list refresh was scanning the entire local history on every update, which could spike CPU usage and cause VS Code to become unresponsive. The refresh now only scans for new or changed sessions instead of re-reading the entire history.
- **Search box no longer cleared by background refresh** — Background session-list refreshes could wipe out text you were actively typing into the search box; the reducer now preserves an active search instead of clobbering it with a stale query echo.
- **Renaming a conversation now updates the right title store** — Renames are written to each provider's own native title location (`custom-title` line for Claude, `thread_name` in Codex's session index, `title` in Antigravity's conversation summaries DB) instead of only the Claude-specific format, so Codex and Antigravity sessions actually show their new name.

## [1.12.1] - 2026-07-13

— Updated the Marketplace display name and description to clearly identify support for browsing, searching, analyzing, and resuming Codex and Antigravity conversations.

## [1.12.0] - 2026-07-13

### Added
- **Unified multi-provider history** — Browse Claude Code, OpenAI Codex, and Antigravity AGY CLI conversations together in one sidebar, with provider badges and automatic local-history discovery.
- **Provider filtering** — Focus the session browser and search results on a single provider or view conversations from all providers.
- **Cross-provider analytics** — Compare sessions, tokens, and estimated API costs by provider and model from the analytics dashboard.
- **Live provider usage** — View available Claude, Codex, and Antigravity quota windows alongside local usage totals.
- **Configurable quota status bar** — Choose up to two providers to display and open the new extension settings shortcut directly from the sidebar.
- **Provider-aware resume actions** — Resume conversations with the appropriate `claude --resume`, `codex resume`, or `agy --conversation` command.

### Changed
- **More relevant search results** — Conversation-title matches now rank above message-only matches, with one result per matching conversation title.
- **Expanded model pricing** — Added and refined pricing rules across Anthropic, OpenAI, Google, and DeepSeek models for more accurate local cost estimates.

### Fixed
- **Database recovery** — Corrupted local indexes are preserved for diagnosis and rebuilt automatically so the extension can recover cleanly.

## [1.10.5] - 2026-07-06

### Added
- **Model Name & Cost in Chat View** — Enabled the chat/conversation view to display the model name (e.g. `claude-3-5-sonnet`, `gemini-3.5-flash`, `deepseek-v4-pro`) and the calculated cost in USD for each assistant message turn.
- **Model Pricing Support** — Added pricing support for Gemini (Pro and Flash) and DeepSeek (V4 Pro and Flash) models, including high-effort thinking modes.
- **Antigravity / `agy` Subagent Recognition** — Recognized subagents and plugins run via Google's Antigravity CLI, rendering them with a rocket icon (`rocket`) and customized purple styling in the session card sidebar.

### Changed
- **Token-based Fallback Cost Calculation** — When log files don't specify pre-computed `costUSD` (such as in newer versions of Claude Code), the extension now automatically calculates the session cost by summing per-message token counts across the session based on model pricing.

## [1.10.4] - 2026-07-05

### Fixed
- **Support subdirectory projects** — Enabled sessions run in subdirectories of the current VS Code workspace folder to be listed and searched correctly. Previously, strict equality path filtering hid sessions that were executed in subdirectories (such as monorepos or subfolders).

## [1.10.3] - 2026-07-02

### Fixed
- **Fixed missing sessions in the main list** — Resolved a bug where some branched sessions and their parent sessions would unexpectedly disappear from the sidebar.
- **Support ungrouping from search view** — Enabled the "Not a Fork (Ungroup)" context menu option when right-clicking sessions directly within the search results panel.
- **Improved branch naming** — Session branches no longer get stuck with placeholder names like "Untitled session". The sidebar now correctly updates to show the latest renamed title.
- **Smarter conversation grouping** — Filtered out generic IDE context messages (like opening the same file) from the fork detector, preventing unrelated chats from being incorrectly grouped together.
- **Better chronological sorting** — Branch sessions whose parent chats are not in the current sidebar view are now sorted in their correct chronological position instead of being pushed to the bottom of the list.

## [1.10.2] - 2026-07-02

### Fixed
- **Hide command-only sessions** — conversations that contain only local command runs (such as `/clear`) without any real message content are now hidden from the session browser.
- **Prevent command titles** — slash commands and internal XML tags (like `<command-name>`) are no longer used as conversation titles. The extension now uses the first actual user message or the AI-generated title instead.

## [1.10.1] - 2026-07-02

### Added
- **In-viewer find widget** — press Cmd/Ctrl+F to open a find bar pinned to the top-right of the conversation panel. Navigate matches with Enter / Shift+Enter or the ‹ › buttons, see your position in the match counter, and dismiss with Esc. The widget auto-opens when a search result matches more than once in the conversation, so you can jump straight to subsequent hits.
- **Markdown table rendering** — GFM pipe tables in assistant messages are now rendered as styled HTML tables with header rows, striped body rows, and column alignment (left/center/right).

### Changed
- **Theme font consistency** — the conversation panel now respects VS Code's configured font family and font size (`editor.fontFamily` / `editor.fontSize`) instead of hardcoded system defaults.

### Fixed
- **Search project scoping** — the search bar now correctly scopes results to the currently selected project, rather than searching across all projects regardless of the active filter.
- **Scroll-to-bottom on open** — opening a conversation now reliably scrolls to the bottom (most recent messages) using `window.scrollTo`, fixing a regression where `#messages` was incorrectly treated as the scroll container.

## [1.10.0] - 2026-07-01

### Added
- **Possible IDE fork detection** — sessions created via the official app's "Fork conversation from here" (which writes no fork metadata, unlike CLI `/branch`) are now heuristically detected by matching shared leading messages and grouped under their likely parent as "possible forks".
- **Fork dismissal** — a context menu action lets you mark a detected link as "not a fork," excluding it from future grouping.

### Changed
- **Branch and subagent counts** — now rendered as an interactive `CountBadge` component with hover/focus feedback, replacing the previous static badges.
- **Session list layout** — branch and subagent expand/collapse state is now tracked independently, and branch cards render in a tinted group panel for clearer visual separation from the parent session.

## [1.9.0] - 2026-07-01

### Added
- **Local command message filtering** — messages generated by local slash commands (e.g. `/clear`, `/mcp`) are no longer shown in the conversation view, keeping the panel focused on actual conversation content.
- **Subagent group panel** — subagents now appear in a visually distinct panel below their parent session instead of as standalone indented cards.

### Changed
- **Session card layout** — cards now maintain consistent alignment across the list, so toggles and badges no longer cause rows to shift.
- **Subagent badge** — the subagent count badge is now an interactive pill with theme-appropriate styling and a built-in expand/collapse toggle, available in both expanded and compact views.
- **Branch indentation** — branch sessions now have clearer visual separation from their parent, and collapsing a parent correctly hides all descendant branches at every depth.

![](media/image.png)

## [1.8.0] - 2026-06-26

### Added
- **Search term highlighting in conversation view** — opening a search result now highlights the matching term inside the conversation panel, making it easier to spot the hit in context.

## [1.7.1] - 2026-06-26

### Fixed
- **Multi-level branch descendants** — a branch-of-a-branch (e.g. `root → branchA → branchB`) is now collected under the ultimate root ancestor instead of being orphaned. Previously only direct children were grouped; now `collectAllDescendants` recursively resolves all branches at any depth, and `branchCount` recomputation maps every descendant to the ultimate root so the collapse count is accurate across the whole tree.

## [1.7.0] - 2026-06-26

### Added
- **Subagent session display** — sessions that spawned subagents now show a `⚡ N subagents` badge in the session card metadata. Click the `▶` toggle to expand the list of subagents inline below the parent.
- Each subagent card shows its description as the title, with agent type and spawn depth as subtitle. Regular agents use a robot icon; fork agents use a branch icon.
- Click a subagent card to open its full conversation in the conversation panel.
- Subagent lists start collapsed by default; expanding fetches agent metadata on demand from disk.

### Changed
- Database schema bumped to v4 (adds `subagent_count` column; triggers a one-time reindex on upgrade).
- Sessions with both branch children and subagents now show both collapse toggles independently.

## [1.6.0] - 2026-06-26

### Added
- **Branch session display** — sessions created via Claude Code's `/branch` command now appear indented directly below their parent session, with a `⎇` branch icon and a left-accent border. Branch titles (e.g. "test (Branch)") are read from the `custom-title` JSONL entry written by the CLI.
- **Collapse/expand branches** — parent sessions with branches show a `▼`/`▶` toggle. Clicking it hides or reveals the child branch cards without opening the session.
- Branches whose parent is not visible in the current view (e.g. parent is archived or in a different project) are shown as plain, unindented cards.
- Branch counts are computed from the visible filtered session list, so the collapse toggle only appears when there are actually visible branches to collapse.

### Changed
- Database schema bumped to v3 (adds `parent_session_id` column; triggers a one-time reindex on upgrade).

## [1.4.0] - 2026-06-25

### Added
- **Custom session titles** — click the pencil icon on a session card to rename it inline. Titles are persisted across VS Code windows.

### Changed
- Removed "cost n/a" from the SummaryBar for cleaner display.

### Fixed
- Conversation panel now displays the custom title (when set) in open tabs instead of the auto-generated label.

## [1.3.0] - 2026-06-24

### Added
- **Conversation panel restyle** — tool calls now render as distinct cards with a role-colored dot+label header, replacing bare text. Bash tool cards show collapsible **IN** (input) and **OUT** (output) sections with red/green tinting that mirrors Claude Code's own display.
- **Tool-result merge** — tool results are now merged into their originating tool card instead of appearing as separate fake-USER message bubbles, matching the native Claude Code conversation view.
- **Sticky header stack** — the toolbar, project files panel, and current-prompt label now stick to the top during scroll, keeping context always visible. The stack height is computed dynamically so it adapts to which panels are open.
- **Collapsed consecutive headers** — adjacent messages from the same role now collapse into a single header label, reducing visual noise in long conversations.

### Changed
- Refined padding, font sizes, and the color palette across the conversation panel for improved readability and consistency.

### Fixed
- `scrollToMessage` now correctly accounts for the sticky header stack height, so scrolled-to messages aren't hidden behind it.

## [1.2.0] - 2026-06-23

### Added
- **Open in Claude Tab** action — resume a session directly in an editor tab via the official Claude Code extension, replacing the old "Open Terminal with Resume Command" prefill flow.
- The chat list now defaults its project filter to the current workspace folder instead of showing all projects.

### Changed
- **Scoped diffs** — the diff button now shows only the selected session's edits by comparing its post-edit backup against the next session's pre-edit backup, rather than diffing against the live file on disk (which may include later unrelated changes).
- Files with only read operations are now excluded from the Files changed panel, keeping the list focused on actual edits.

### Fixed
- "Resume in Terminal" and "Copy Resume Command" no longer fail with a `TypeError` when the webview didn't have a project path on hand — the project path is now resolved from the session before running the command.
- The selected project filter is now scoped per workspace, so a filter chosen in one window no longer leaks into another.
- **Durable session flags** — pinned and archived flags now persist reliably across multiple VS Code windows.

## [1.1.0] - 2026-06-23

### Added
- **Files changed panel** in the conversation viewer — see every file touched during a session, with per-file added/removed line counts.
- Files are grouped into **Project files** vs **Other (Claude/system)**, with the project group expanded by default.
- Click a changed file to open a native VS Code diff against its pre-session backup, or open the file directly.

### Fixedz
- File paths in the Files changed list now show the basename prominently with a truncated directory for readability.
- Relative file paths from the conversation viewer now resolve correctly when opening a diff or file.
- Backup URI encoding now uses base64url so file diffs open reliably regardless of the Claude data directory path.

## [1.0.2] - 2026-06-19

### Fixed
- Various stability and metadata fixes following the marketplace release.

## [1.0.1] - 2026-06-19

### Added
- Active Hours and Weekly Distribution analytics views.
- Cost/impact-aware sorting and a session summary bar.
- Project filter, state-aware menu, and keyboard navigation improvements.

### Changed
- Token/quota usage caching to reduce overhead (~34% → ~26%).

## [1.0.0] - 2026-06-19

### Added
- Initial release: sidebar session browser grouped by project, full conversation viewer with Markdown and syntax highlighting, full-text search, archive/pin, and one-click `claude --resume`.
