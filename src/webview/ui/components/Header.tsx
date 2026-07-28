// src/webview/ui/components/Header.tsx

interface HeaderProps {
  onRefresh: () => void;
  onSettings: () => void;
}

export function Header({ onRefresh, onSettings }: HeaderProps) {
  return (
    <div class="header">
      <span class="header__icon codicon codicon-comment-discussion" aria-hidden="true" />
      <span class="header__title">Coding Session History</span>
      <button
        class="header__refresh codicon codicon-refresh"
        onClick={onRefresh}
        title="Refresh sessions"
        aria-label="Refresh sessions"
      />
      <button
        class="header__settings codicon codicon-settings-gear"
        onClick={onSettings}
        title="Open settings"
        aria-label="Open settings"
      />
    </div>
  );
}
