// src/webview/ui/components/EmptyState.tsx

interface Props {
  searchActive: boolean;
  /** True when a project or archive filter is narrowing the list. */
  filtered: boolean;
}

export function EmptyState({ searchActive, filtered }: Props) {
  const icon = searchActive ? "codicon-search" : "codicon-inbox";

  let primary: string;
  let secondary: string | null;
  if (searchActive) {
    primary = "No results match your search.";
    secondary = "Try a different term or clear the search.";
  } else if (filtered) {
    primary = "No sessions match the current filters.";
    secondary = "Try another project or toggle “Show archived”.";
  } else {
    primary = "No sessions found.";
    secondary = "Start a Claude Code or Codex session to see it here.";
  }

  return (
    <div class="empty-state">
      <span class={`empty-state__icon codicon ${icon}`} aria-hidden="true" />
      <span>{primary}</span>
      {secondary && <span class="empty-state__secondary">{secondary}</span>}
    </div>
  );
}
