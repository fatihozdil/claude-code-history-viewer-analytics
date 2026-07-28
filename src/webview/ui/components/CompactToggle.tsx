// src/webview/ui/components/CompactToggle.tsx

interface Props {
  active: boolean;
  onClick: () => void;
}

export function CompactToggle({ active, onClick }: Props) {
  return (
    <button
      class={`toolbar__toggle codicon codicon-list-flat${active ? " toolbar__toggle--active" : ""}`}
      onClick={onClick}
      title="Compact mode"
    />
  );
}
