// src/webview/ui/components/ArchiveToggle.tsx

interface Props {
  active: boolean;
  onClick: () => void;
}

export function ArchiveToggle({ active, onClick }: Props) {
  return (
    <button
      class={`toolbar__toggle codicon codicon-archive${active ? " toolbar__toggle--active" : ""}`}
      onClick={onClick}
      title={active ? "Showing archived" : "Show archived"}
    />
  );
}
