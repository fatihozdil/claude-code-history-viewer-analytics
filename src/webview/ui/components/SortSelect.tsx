// src/webview/ui/components/SortSelect.tsx
import type { SortMode } from "../types.js";
import { SORT_LABELS } from "../format.js";

interface Props {
  value: SortMode;
  onChange: (sort: SortMode) => void;
}

export function SortSelect({ value, onChange }: Props) {
  return (
    <select
      class="toolbar__sort"
      value={value}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value as SortMode)}
    >
      {Object.entries(SORT_LABELS).map(([k, label]) => (
        <option key={k} value={k}>{label}</option>
      ))}
    </select>
  );
}
